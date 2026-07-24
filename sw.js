// Service worker — notificaciones push del Plan de Recompensas COSÉTIKA
self.addEventListener('push', function(e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(err) { d = { title: 'COSÉTIKA', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'COSÉTIKA Recompensas', {
    body: d.body || '',
    tag: d.tag || 'recompensas',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Ccircle%20cx%3D%2232%22%20cy%3D%2232%22%20r%3D%2232%22%20fill%3D%22%23A0684A%22/%3E%3Ctext%20x%3D%2232%22%20y%3D%2244%22%20font-family%3D%22Georgia%2C%20serif%22%20font-style%3D%22italic%22%20font-weight%3D%22700%22%20font-size%3D%2234%22%20fill%3D%22%23ffffff%22%20text-anchor%3D%22middle%22%3EC%3C/text%3E%3C/svg%3E',
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(lista) {
    for (const c of lista) { if ('focus' in c) return c.focus(); }
    return clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  }));
});
