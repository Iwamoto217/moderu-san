// 一度開いた端末なら、電波がなくても画面を開けるようにする（記録の送受信はキャッシュしない）
const CACHE = "moderu-v2";
const SHELL = ["./", "index.html", "app.css", "app.js", "config.js", "manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.hostname.endsWith("script.google.com") || url.hostname.endsWith("googleusercontent.com")) return;
  // 新しい版を優先し、つながらないときだけ保存してある版を使う
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
