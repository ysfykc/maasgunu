self.addEventListener('push', function(e) {
  const d = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(d.title || 'Maaş Günü', {
    body: d.body || '',
    icon: '/16379.png',
    badge: '/16379.png',
    tag: d.tag || 'maas-gunu',
    renotify: true,
    data: d
  }));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
