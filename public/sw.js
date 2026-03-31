self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Always network-first, no caching — ensures latest version always loads
self.addEventListener('fetch', () => {});
