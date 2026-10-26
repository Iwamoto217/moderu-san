/* 藻出ルさん — モデル当日管理
 * 記録は「出来事（イベント）」を追記するだけ。各モデルの状態は名簿＋イベントを古い順に再生して求める。
 * どの端末もイベントをまず localStorage に保存し、Googleスプレッドシート（GAS）へ送る。送れなかった分は再送し続ける。 */

const REASONS = ["お手洗い", "飲み物・買い出し", "電話", "タバコ", "その他"];
const LS = { mode: "moderu.mode", pending: "moderu.pending", snap: "moderu.snap", device: "moderu.device", api: "moderu.api" };
const EV = {
  arrive: ["到着", "in"], out: ["外出", "out"], in: ["戻り", "in"], done: ["完了", "done"],
  unarrive: ["到着取消", "absent"], undone: ["完了取消", "absent"], reset: ["全員リセット", "absent"]
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};

// サーバーURLは公開リポジトリに書かず、配布リンクの ?api= で渡す。一度開いた端末は覚えておく
const API = (() => {
  const fromLink = new URLSearchParams(location.search).get("api");
  if (fromLink) { ls.set(LS.api, fromLink); history.replaceState(null, "", location.pathname); return fromLink; }
  return ls.get(LS.api, "") || (window.MODERU_CONFIG && window.MODERU_CONFIG.apiUrl) || "";
})();
const DEVICE = ls.get(LS.device, null) || (() => { const d = "d" + Math.random().toString(36).slice(2, 8); ls.set(LS.device, d); return d; })();

let snap = ls.get(LS.snap, { models: [], events: [], settings: { limitMin: 15 }, at: 0 });
let pending = ls.get(LS.pending, { events: [], roster: null, settings: null });
let mode = ls.get(LS.mode, "admin");
let net = { ok: null, lastSync: snap.at || 0, error: "" };
let pushing = false, pulling = false, overlayTimer = null, confirmReset = false, confirmClear = false, clearMsg = "";
let filter = "all", query = "";

function savePending() { if (!ls.set(LS.pending, pending)) net.error = "この端末に保存できません（プライベートブラウズ？）"; }

/* ---------- 状態の導出 ---------- */
function allEvents() {
  const seen = new Set(snap.events.map(e => e.id));
  const from = Number(settings().clearedAt) || 0;  // 「記録を全部消す」より前の記録は使わない
  return [...snap.events, ...pending.events.filter(e => !seen.has(e.id))]
    .filter(e => e.at >= from)
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}
function roster() { return pending.roster || snap.models || []; }
function settings() { return { limitMin: 15, ...(snap.settings || {}), ...(pending.settings || {}) }; }
const limitMs = () => (Number(settings().limitMin) || 15) * 60000;

function fresh(r) {
  return { id: "m" + r.no, no: Number(r.no), name: String(r.name), payType: r.payType === "agency" ? "agency" : "free",
    arrived: false, arrivedAt: 0, status: "in", since: 0, reason: "", outCount: 0, done: false, doneAt: 0 };
}
function models() {
  const map = new Map(roster().map(r => [String(r.no), fresh(r)]));
  for (const e of allEvents()) {
    if (e.type === "reset") { for (const [k, m] of map) map.set(k, fresh(m)); continue; }
    const m = map.get(String(e.no)); if (!m) continue;
    const t = e.at;
    if (e.type === "arrive") Object.assign(m, { arrived: true, arrivedAt: t, status: "in", since: t });
    else if (e.type === "unarrive") Object.assign(m, { arrived: false, arrivedAt: 0, status: "in", reason: "" });
    else if (e.type === "out") Object.assign(m, { status: "out", since: t, reason: e.reason || "", outCount: m.outCount + 1 });
    else if (e.type === "in") Object.assign(m, { status: "in", since: t, reason: "" });
    else if (e.type === "done") Object.assign(m, { done: true, doneAt: t, status: "in", reason: "" });
    else if (e.type === "undone") Object.assign(m, { done: false, doneAt: 0 });
  }
  return [...map.values()].sort((a, b) => a.no - b.no);
}
const isAgency = m => m.payType === "agency";
function phase(m) {
  if (m.done) return "done";
  if (!m.arrived) return "absent";
  if (m.status === "out") return Date.now() - m.since > limitMs() ? "late" : "out";
  return "in";
}

/* ---------- 記録 ---------- */
function act(m, type, reason) {
  const now = Date.now();
  pending.events.push({ id: now.toString(36) + "-" + DEVICE + "-" + Math.random().toString(36).slice(2, 6),
    at: now, no: m ? m.no : "*", name: m ? m.name : "", type, reason: reason || "", by: mode === "kiosk" ? "self" : "staff", device: DEVICE });
  savePending(); render(); push();
}

/* ---------- 同期（GAS） ---------- */
async function api(body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = body
      ? await fetch(API, { method: "POST", body: JSON.stringify(body), signal: ctl.signal })
      : await fetch(API + (API.includes("?") ? "&" : "?") + "action=state&t=" + Date.now(), { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j && j.ok === false) throw new Error(j.error || "server error");
    return j;
  } finally { clearTimeout(t); }
}
async function push() {
  if (!API || pushing) return;
  if (!pending.events.length && !pending.roster && !pending.settings) return;
  pushing = true;
  try {
    if (pending.roster) {
      const sent = pending.roster;
      await api({ action: "roster", models: sent });
      if (pending.roster === sent) { snap.models = sent; pending.roster = null; }
    }
    if (pending.settings) {
      const sent = pending.settings;
      await api({ action: "settings", settings: sent });
      if (pending.settings === sent) { snap.settings = { ...snap.settings, ...sent }; pending.settings = null; }
    }
    while (pending.events.length) {
      const batch = pending.events.slice(0, 50);
      const r = await api({ action: "events", events: batch });
      const okIds = new Set(r.ids || batch.map(e => e.id));
      const have = new Set(snap.events.map(e => e.id));
      for (const e of batch) if (okIds.has(e.id) && !have.has(e.id)) snap.events.push(e);
      pending.events = pending.events.filter(e => !okIds.has(e.id));
      savePending(); ls.set(LS.snap, snap);
    }
    savePending(); ls.set(LS.snap, snap);
    net = { ok: true, lastSync: Date.now(), error: "" };
  } catch (e) { net.ok = false; net.error = "送信できませんでした（電波が戻ると自動で再送）"; }
  finally { pushing = false; renderSync(); }
}
async function pull() {
  if (!API || pulling) return;
  pulling = true;
  try {
    const s = await api(null);
    snap = { models: s.models || [], events: s.events || [], settings: s.settings || { limitMin: 15 }, at: Date.now() };
    ls.set(LS.snap, snap);
    // サーバーに届いたイベントは送信待ちから外す
    const have = new Set(snap.events.map(e => e.id));
    const from = Number(snap.settings.clearedAt) || 0;
    const before = pending.events.length;
    pending.events = pending.events.filter(e => !have.has(e.id) && e.at >= from);
    if (before !== pending.events.length) savePending();
    net = { ok: true, lastSync: Date.now(), error: "" };
    liveRender();
  } catch (e) { net.ok = false; net.error = "サーバーに接続できません（端末内に記録中）"; renderSync(); }
  finally { pulling = false; }
}
setInterval(push, 3000);
setInterval(pull, 5000);
window.addEventListener("online", () => { push(); pull(); });

/* ---------- 表示 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = t => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const hms = t => new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const mins = t => Math.max(0, Math.floor((Date.now() - t) / 60000));
const doneLabel = m => isAgency(m) ? "完了（手渡しなし）" : "ギャラ受け渡し済み";

function renderSync() {
  const dot = $("#dot"), tx = $("#syncText");
  const n = pending.events.length + (pending.roster ? 1 : 0) + (pending.settings ? 1 : 0);
  if (!API) { dot.className = "dot err"; tx.textContent = "サーバー未設定：運営から配られたリンクで開き直してください（今は端末内だけに記録中）"; return; }
  if (net.ok === false) { dot.className = "dot err"; tx.textContent = `${net.error}${n ? `・未送信 ${n}件` : ""}`; return; }
  if (n) { dot.className = "dot wait"; tx.textContent = `送信中 ${n}件`; return; }
  if (net.ok) { dot.className = "dot"; tx.textContent = `同期済み ${hms(net.lastSync)}`; return; }
  dot.className = "dot off"; tx.textContent = "接続を確認中…";
}

function render() {
  renderSync();
  document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  mode === "kiosk" ? renderKiosk() : renderAdmin();
}
function liveRender() { const t = document.activeElement?.tagName; if (t === "TEXTAREA" || t === "INPUT" || !$("#ov").hidden) { renderSync(); return; } render(); }

function renderKiosk() {
  const ms = models();
  const st = { absent: "受付前", in: "楽屋にいます", done: "お疲れさまでした" };
  $("#view").innerHTML = `
    <div style="display:grid;gap:16px">
      <div class="lead">出るとき・戻ったとき、自分の番号をタッチ<small>楽屋の外に出るときは必ず記録してください。戻ったらもう一度タッチ。</small></div>
      ${ms.length ? `<div class="grid">${ms.map(m => {
        const p = phase(m);
        const label = p === "out" || p === "late" ? `外出中 ${mins(m.since)}分・${esc(m.reason)}` : st[p];
        return `<button class="pass ${p} ${p === "late" ? "out" : ""}" data-id="${esc(m.id)}" id="p-${esc(m.id)}">
          <span class="no num">${esc(m.no)}</span><span class="nm">${esc(m.name)}</span>
          <span class="st">${label}</span></button>`;
      }).join("")}</div>` : `<p class="empty">まだモデルが登録されていません。上の「運営ボード」から名簿を登録してください。</p>`}
    </div>`;
  $("#view").querySelectorAll(".pass").forEach(b => b.addEventListener("click", () => openSheet(b.dataset.id)));
}

function openSheet(id) {
  const m = models().find(x => x.id === id); if (!m) return;
  const sheet = $("#sheet"), p = phase(m);
  const who = `<div class="who"><span class="num">${esc(m.no)}</span><b>${esc(m.name)}</b></div>`;
  const close = `<button class="ghost" id="btnCancel">閉じる</button>`;
  if (p === "absent") {
    sheet.innerHTML = `${who}<p>まだ受付が済んでいません。先に受付でチェックインしてください。</p>${close}`;
  } else if (p === "done") {
    sheet.innerHTML = `${who}<p>本日の受け取りまで完了しています。お疲れさまでした。</p>${close}`;
  } else if (p === "out" || p === "late") {
    sheet.innerHTML = `${who}<p>${hm(m.since)} に外出（${mins(m.since)}分経過・${esc(m.reason)}）</p>
      <button class="big inb" id="btnIn">楽屋に戻りました</button>
      <button class="ghost" id="btnCancel">まちがえた・閉じる</button>`;
    sheet.querySelector("#btnIn").onclick = () => { act(m, "in"); thanks(m, "in"); };
  } else {
    sheet.innerHTML = `${who}<p>楽屋の外に出ますか？ 行き先を選んでください。</p>
      <div class="reasons">${REASONS.map((r, i) => `<button class="big outb" id="rs-${i}" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>
      <button class="ghost" id="btnCancel">まちがえた・閉じる</button>`;
    sheet.querySelectorAll("[data-r]").forEach(b => b.onclick = () => { act(m, "out", b.dataset.r); thanks(m, "out"); });
  }
  sheet.querySelector("#btnCancel").onclick = closeSheet;
  $("#ov").hidden = false;
  clearTimeout(overlayTimer); overlayTimer = setTimeout(closeSheet, 20000);
}
function thanks(m, type) {
  const lim = Number(settings().limitMin) || 15;
  $("#sheet").innerHTML = `<div class="done-msg"><span class="num">${esc(m.no)}</span><b>${type === "out" ? "いってらっしゃい" : "おかえりなさい"}</b>
    <p>${hm(Date.now())} ${type === "out" ? `外出を記録しました。${lim}分以内に戻ってください。` : "戻りを記録しました。"}</p></div>`;
  clearTimeout(overlayTimer); overlayTimer = setTimeout(closeSheet, 2200);
}
function closeSheet() { clearTimeout(overlayTimer); $("#ov").hidden = true; render(); }

function rowHtml(m) {
  const p = phase(m);
  const chip = {
    absent: `<span class="chip absent">未到着</span>`,
    in: `<span class="chip in">楽屋</span>`,
    out: `<span class="chip out">外出中 ${mins(m.since)}分</span>`,
    late: `<span class="chip late">外出中 ${mins(m.since)}分</span>`,
    done: `<span class="chip done">${doneLabel(m)}</span>`
  }[p];
  const meta = [
    m.arrived ? `${hm(m.arrivedAt)} 到着` : "",
    p === "out" || p === "late" ? `${hm(m.since)} 外出・${esc(m.reason)}` : "",
    m.done ? `${hm(m.doneAt)} 完了` : "",
    m.outCount ? `外出${m.outCount}回` : ""
  ].filter(Boolean).join("・");
  const id = esc(m.id);
  let acts = "";
  if (p === "absent") acts = `<button class="act" data-a="arrive" data-id="${id}" id="a-${id}">到着</button>`;
  else if (p === "out" || p === "late") acts = `<button class="act back" data-a="in" data-id="${id}" id="i-${id}">戻ったことにする</button>`;
  else if (p === "in") acts = `<button class="act pay" data-a="done" data-id="${id}" id="d-${id}">${isAgency(m) ? "完了にする" : "ギャラを渡した"}</button>
      <button class="mini" data-a="unarrive" data-id="${id}" id="u-${id}">到着を取消</button>`;
  else acts = `<button class="mini" data-a="undone" data-id="${id}" id="ud-${id}">完了を取消</button>`;
  return `<div class="row">
    <span class="num">${esc(m.no)}</span>
    <div style="min-width:0"><b>${esc(m.name)}</b> ${chip} ${isAgency(m) ? `<span class="chip agency">事務所・手渡しなし</span>` : ""}
      <div class="meta">${meta || "&nbsp;"}</div></div>
    <div class="acts">${acts}</div>
  </div>`;
}

function renderAdmin() {
  const ms = models();
  const ph = ms.map(m => [m, phase(m)]);
  const count = k => ph.filter(([, p]) => k.includes(p)).length;
  const ev = allEvents().reverse().slice(0, 150);
  const rosterText = ms.map(m => `${m.no} ${m.name}${isAgency(m) ? " 事務所" : ""}`).join("\n");
  const FILTERS = [["all", "全員", ms.length], ["absent", "未到着", count(["absent"])], ["in", "楽屋", count(["in"])],
    ["out", "外出中", count(["out", "late"])], ["done", "完了", count(["done"])]];
  const q = query.trim().toLowerCase();
  const order = { late: 0, out: 1, in: 2, absent: 3, done: 4 };
  const list = ph.filter(([m, p]) => filter === "all" || (filter === "out" ? p === "out" || p === "late" : p === filter))
    .filter(([m]) => !q || String(m.no) === q || m.name.toLowerCase().includes(q))
    .sort((a, b) => order[a[1]] - order[b[1]] || (a[1] === "out" || a[1] === "late" ? a[0].since - b[0].since : a[0].no - b[0].no))
    .map(([m]) => m);

  $("#view").innerHTML = `
    <div style="display:grid;gap:20px">
      <div class="sum">
        <div class="k a"><span class="num">${count(["absent"])}</span><span>未到着</span></div>
        <div class="k"><span class="num">${count(["in"])}</span><span>楽屋</span></div>
        <div class="k o"><span class="num">${count(["out", "late"])}</span><span>外出中</span></div>
        <div class="k l"><span class="num">${count(["late"])}</span><span>うち${esc(settings().limitMin)}分超え</span></div>
        <div class="k d"><span class="num">${count(["done"])}</span><span>完了</span></div>
        <div class="k"><span class="num">${ms.length}</span><span>登録人数</span></div>
      </div>
      <section class="card"><h2>モデル一覧 <small>対応が必要な人ほど上に表示</small></h2>
        <div class="filters">
          ${FILTERS.map(([k, l, n]) => `<button class="fbtn" aria-pressed="${filter === k}" data-f="${k}" id="f-${k}">${l} ${n}</button>`).join("")}
          <input class="search" id="q" type="search" placeholder="番号か名前で探す" value="${esc(query)}">
        </div>
        <div class="rows">${list.length ? list.map(rowHtml).join("") : `<p class="empty">${ms.length ? "当てはまるモデルはいません。" : "名簿が空です。下の「モデル名簿」に貼り付けて保存してください。"}</p>`}</div>
      </section>
      <div class="cols">
        <section class="card"><h2>記録 <small>新しい順・最新150件</small></h2>
          ${ev.length ? `<div class="log">${ev.map(e => {
            const [l, c] = EV[e.type] || [e.type, "absent"];
            const m = ms.find(x => String(x.no) === String(e.no));
            const label = e.type === "done" ? (m && isAgency(m) ? "完了" : "受け渡し") : l;
            return `<span class="t">${hm(e.at)}</span><span class="chip ${c}">${label}</span>
            <span>${e.no === "*" ? "全員" : `${esc(e.no)} ${esc(e.name)}`}${e.reason ? `・${esc(e.reason)}` : ""}${(e.type === "out" || e.type === "in") && e.by === "staff" ? "（運営操作）" : ""}</span>`;
          }).join("")}</div>`
            : `<p class="empty">到着・外出・戻り・受け渡しが、ここに時刻つきで並びます。</p>`}
          <div class="tools"><button class="mini" id="csv">記録をCSVで保存</button><span class="note">本番の最後に1回保存しておくと安心です。</span></div>
        </section>
        <section class="card"><h2>設定</h2>
          <h2 style="margin-top:6px">外出の目安時間</h2>
          <div class="tools"><input type="number" id="limit" min="1" max="180" value="${esc(settings().limitMin)}"><span>分を超えたら赤表示</span><button class="mini" id="saveLimit">保存</button></div>
          <h2 style="margin-top:6px">リセット</h2>
          ${confirmReset ? `<div class="confirm">全員を「未到着」に戻します。これまでの記録は消えずに残ります。<button class="danger" id="doReset">リセットする</button><button class="mini" id="noReset">やめる</button></div>`
            : `<div class="tools"><button class="mini" id="askReset">全員を未到着に戻す</button></div>`}
          <h2 style="margin-top:6px">記録を全部消す <small>リハーサルのあとに</small></h2>
          ${confirmClear ? `<div class="confirm">記録を全部消して、全員を未到着に戻します。消した記録はスプレッドシートの「削除済み」シートに移るので、あとから見ることはできます。<button class="danger" id="doClear">消す</button><button class="mini" id="noClear">やめる</button></div>`
            : `<div class="tools"><button class="mini" id="askClear">記録を全部消す</button></div>`}
          ${clearMsg ? `<p class="note">${esc(clearMsg)}</p>` : ""}
          <p class="note">この端末のID：${esc(DEVICE)}</p>
        </section>
      </div>
      <section class="card"><h2>モデル名簿 <small>1行に1人「番号 名前」。事務所モデルは行末に「事務所」</small></h2>
        <textarea id="roster" placeholder="1 山田花子&#10;2 佐藤ゆい 事務所&#10;3 …">${esc(rosterText)}</textarea>
        <div class="tools"><button class="primary" id="saveRoster">名簿を保存</button><span class="note" id="rosterMsg">スプレッドシートの「名簿」シートを直接書き換えてもOKです。</span></div>
      </section>
    </div>`;

  $("#view").querySelectorAll("[data-a]").forEach(b => b.onclick = () => { const m = models().find(x => x.id === b.dataset.id); if (m) act(m, b.dataset.a); });
  $("#view").querySelectorAll("[data-f]").forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
  const qi = $("#q");
  qi.oninput = () => { query = qi.value; const c = qi.selectionStart; render(); const n = $("#q"); n.focus(); n.setSelectionRange(c, c); };
  $("#saveLimit").onclick = () => { pending.settings = { limitMin: Math.max(1, Math.min(180, Number($("#limit").value) || 15)) }; savePending(); render(); push(); };
  if ($("#askReset")) $("#askReset").onclick = () => { confirmReset = true; render(); };
  if ($("#noReset")) $("#noReset").onclick = () => { confirmReset = false; render(); };
  if ($("#doReset")) $("#doReset").onclick = () => { confirmReset = false; act(null, "reset"); };
  if ($("#askClear")) $("#askClear").onclick = () => { confirmClear = true; clearMsg = ""; render(); };
  if ($("#noClear")) $("#noClear").onclick = () => { confirmClear = false; render(); };
  if ($("#doClear")) $("#doClear").onclick = clearAll;
  $("#saveRoster").onclick = saveRoster;
  $("#csv").onclick = exportCsv;
}

async function clearAll() {
  confirmClear = false;
  if (!API) { clearMsg = "サーバーにつながっていないので消せません。"; render(); return; }
  clearMsg = "消しています…"; render();
  try {
    const r = await api({ action: "clear" });
    snap.events = []; snap.settings = { ...snap.settings, clearedAt: r.clearedAt };
    pending.events = pending.events.filter(e => e.at >= r.clearedAt);
    ls.set(LS.snap, snap); savePending();
    clearMsg = r.archived ? `記録${r.archived}件を「${r.sheet}」シートに移しました。` : "消す記録はありませんでした。";
  } catch (e) {
    clearMsg = /unknown action/.test(String(e.message)) ? "サーバー（GAS）の更新がまだです。新しい Code.gs を貼ってデプロイし直してください。"
      : "電波がないので消せませんでした。つながってからもう一度押してください。";
  }
  render();
}

function saveRoster() {
  const lines = $("#roster").value.split(/\n/).map(s => s.trim()).filter(Boolean);
  const next = new Map(); let auto = 1;
  for (const line of lines) {
    const mt = line.match(/^(\d+)[\s.:：、,]+(.+)$/);
    const no = mt ? Number(mt[1]) : auto;
    let name = (mt ? mt[2] : line).trim();
    const agency = /[\s　]事務所$/.test(name);
    if (agency) name = name.replace(/[\s　]事務所$/, "").trim();
    auto = no + 1;
    next.set(no, { no, name, payType: agency ? "agency" : "free" });
  }
  const gone = models().filter(m => m.arrived && !next.has(m.no));
  if (gone.length) { $("#rosterMsg").textContent = `到着済みのため消せません：${gone.map(m => m.no + " " + m.name).join("、")}`; return; }
  pending.roster = [...next.values()].sort((a, b) => a.no - b.no);
  savePending(); render(); push();
  $("#rosterMsg").textContent = `${next.size}人を保存しました。`;
}

function exportCsv() {
  const ms = models();
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["時刻", "番号", "名前", "出来事", "行き先", "操作", "端末"]];
  for (const e of allEvents()) rows.push([new Date(e.at).toLocaleString("ja-JP"), e.no === "*" ? "全員" : e.no, e.name, (EV[e.type] || [e.type])[0], e.reason, e.by === "self" ? "本人" : "運営", e.device]);
  rows.push([]); rows.push(["番号", "名前", "区分", "状態", "到着", "外出回数", "完了"]);
  for (const m of ms) rows.push([m.no, m.name, isAgency(m) ? "事務所" : "フリー", { absent: "未到着", in: "楽屋", out: "外出中", late: "外出中", done: "完了" }[phase(m)],
    m.arrived ? hm(m.arrivedAt) : "", m.outCount, m.done ? hm(m.doneAt) : ""]);
  const csv = "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const d = new Date(); a.download = `藻出ルさん_記録_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- 画面の切り替え ---------- */
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
  mode = b.dataset.mode; ls.set(LS.mode, mode); closeSheet(); wake(); render(); window.scrollTo(0, 0);
}));
$("#ov").addEventListener("click", e => { if (e.target.id === "ov") closeSheet(); });

/* ---------- 画面スリープ防止 ---------- */
let lock = null;
async function wake() { try { if (mode === "kiosk" && navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => lock = null); } } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { wake(); pull(); } });

/* ---------- 経過時間の更新（表示だけ） ---------- */
setInterval(liveRender, 30000);

/* ---------- オフラインでも開けるように ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

render(); wake(); pull(); push();
