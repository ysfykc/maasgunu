// firebase-messaging-sw.js
// Maaş Günü — Uygulama kapalıyken FCM push bildirimlerini yakalar.
// Bu dosya repo KÖKÜNDE olmalı: https://ysfykc.github.io/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyADpIRNLQEIer_gplTgwKi_EKkfcyrYoqY",
  authDomain: "maasgunu-bd353.firebaseapp.com",
  projectId: "maasgunu-bd353",
  storageBucket: "maasgunu-bd353.firebasestorage.app",
  messagingSenderId: "485904329467",
  appId: "1:485904329467:web:579d932ae8f25958901e5e"
});

const messaging = firebase.messaging();

// Arka planda (uygulama kapalı/arka planda) mesaj gelince bildirim göster
messaging.onBackgroundMessage((payload) => {
  const baslik = payload.notification?.title || payload.data?.title || 'Maaş Günü';
  const secenekler = {
    body: payload.notification?.body || payload.data?.body || '',
    icon: '/16379.png',
    badge: '/16379.png',
    tag: payload.data?.tag || 'maasgunu-bildirim',
    data: { url: payload.data?.url || 'https://ysfykc.github.io/' },
    vibrate: [200, 100, 200]
  };
  return self.registration.showNotification(baslik, secenekler);
});

// Bildirime tıklanınca uygulamayı aç
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://ysfykc.github.io/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
      for (const client of liste) {
        if (client.url.includes('ysfykc.github.io') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
