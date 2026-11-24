/* Service Worker: solo guarda los recursos de la PWA HTTPS, nunca los del servidor LAN. */
const CACHE = 'sombras-lab-shell-v02';
const ASSETS = ['./','./index.html','./app.js','./styles.css','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/favicon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('sombras-lab-') && k !== CACHE).map(k => caches.delete(k)))),self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request, {ignoreSearch:true}).then(hit => hit || fetch(event.request)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'PING_SW') event.source?.postMessage({type:'PONG_SW',version:CACHE});
});
