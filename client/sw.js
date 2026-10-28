// Service worker: lets the app install and open quickly. Scores and picks always come live from the server.
const VERSION = 'pickem-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // never cache account data or scores
  if (req.mode === 'navigate') {
    // Always try for the newest page first; fall back to the saved copy when offline.
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('/', copy)); } return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
