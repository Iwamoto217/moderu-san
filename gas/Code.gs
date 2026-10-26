/**
 * 藻出ルさん — 記録用サーバー（Google Apps Script）
 * スプレッドシートに紐づけて使う。シート「名簿」「記録」「設定」を自動で作る。
 * 記録は追記のみ。同じIDのイベントは二重に書かない（再送しても安全）。
 */

const SHEETS = {
  roster: { name: '名簿', header: ['番号', '名前', '区分'] },
  events: { name: '記録', header: ['ID', '時刻(ms)', '時刻', '番号', '名前', '出来事', '行き先', '操作', '端末'] },
  settings: { name: '設定', header: ['項目', '値'] },
};

function setup() {
  Object.keys(SHEETS).forEach(function (k) { sheet_(k); });
  const s = sheet_('settings');
  if (s.getLastRow() < 2) s.appendRow(['limitMin', 15]);
}

function sheet_(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const def = SHEETS[key];
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.appendRow(def.header);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function rows_(key) {
  const sh = sheet_(key);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, SHEETS[key].header.length).getValues();
}

function state_() {
  const models = rows_('roster')
    .filter(function (r) { return r[0] !== '' && r[1] !== ''; })
    .map(function (r) { return { no: Number(r[0]), name: String(r[1]), payType: String(r[2]).indexOf('事務所') >= 0 ? 'agency' : 'free' }; });
  const events = rows_('events')
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      return { id: String(r[0]), at: Number(r[1]), no: r[3] === '*' ? '*' : Number(r[3]), name: String(r[4]),
        type: String(r[5]), reason: String(r[6]), by: String(r[7]), device: String(r[8]) };
    });
  const settings = { limitMin: 15, clearedAt: clearedAt_() };
  rows_('settings').forEach(function (r) { if (r[0] === 'limitMin') settings.limitMin = Number(r[1]) || 15; });
  return { ok: true, models: models, events: events, settings: settings };
}

function setSetting_(key, value) {
  const sh = sheet_('settings');
  const i = rows_('settings').findIndex(function (r) { return r[0] === key; });
  if (i >= 0) sh.getRange(i + 2, 2).setValue(value); else sh.appendRow([key, value]);
}

// 「記録を全部消す」をした時刻。これより前の記録は受け付けない（オフラインだった端末からの古い再送を防ぐ）
function clearedAt_() {
  let v = 0;
  rows_('settings').forEach(function (r) { if (r[0] === 'clearedAt') v = Number(r[1]) || 0; });
  return v;
}

function doGet() {
  try { return json_(state_()); }
  catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const body = JSON.parse(e.postData.contents);

    if (body.action === 'events') {
      const sh = sheet_('events');
      const have = {};
      rows_('events').forEach(function (r) { have[String(r[0])] = true; });
      const add = [];
      const ids = [];
      const from = clearedAt_();
      (body.events || []).forEach(function (ev) {
        ids.push(ev.id);
        if (have[ev.id] || Number(ev.at) < from) return;
        have[ev.id] = true;
        add.push([ev.id, ev.at, new Date(ev.at), ev.no, ev.name, ev.type, ev.reason || '', ev.by || '', ev.device || '']);
      });
      if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, add[0].length).setValues(add);
      return json_({ ok: true, ids: ids, added: add.length });
    }

    if (body.action === 'roster') {
      const sh = sheet_('roster');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
      const rows = (body.models || []).map(function (m) { return [m.no, m.name, m.payType === 'agency' ? '事務所' : 'フリー']; });
      if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
      return json_({ ok: true, count: rows.length });
    }

    if (body.action === 'settings') {
      setSetting_('limitMin', Number(body.settings && body.settings.limitMin) || 15);
      return json_({ ok: true });
    }

    // 記録を全部消す：完全には消さず「削除済み_日時」シートへ移してから空にする
    if (body.action === 'clear') {
      const sh = sheet_('events');
      const n = sh.getLastRow() - 1;
      const now = Date.now();
      let name = '';
      if (n > 0) {
        const vals = sh.getRange(2, 1, n, SHEETS.events.header.length).getValues();
        name = '削除済み_' + Utilities.formatDate(new Date(now), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
        const arc = SpreadsheetApp.getActiveSpreadsheet().insertSheet(name);
        arc.getRange(1, 1, 1, SHEETS.events.header.length).setValues([SHEETS.events.header]);
        arc.getRange(2, 1, n, SHEETS.events.header.length).setValues(vals);
        sh.deleteRows(2, n);
      }
      setSetting_('clearedAt', now);
      return json_({ ok: true, clearedAt: now, archived: Math.max(n, 0), sheet: name });
    }

    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
