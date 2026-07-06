export default {
  // ─────────────────────────────────────────────
  // HTTP İSTEKLERİ (mevcut push gönderimi + test)
  // ─────────────────────────────────────────────
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // Test ucu: secret'ların doğru girildiğini kontrol etmek için
    if (request.method === 'GET' && url.pathname === '/test') {
      try {
        await getAccessToken(env);
        return json({ ok: true, message: 'Google ile bağlantı başarılı, secretlar doğru.' }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, cors);
      }
    }

    // Manuel cron tetikleme (test için): GET /cron-test
    if (request.method === 'GET' && url.pathname === '/cron-test') {
      try {
        const sonuc = await zamanlanmisBildirimleriCalistir(env);
        return json({ ok: true, ...sonuc }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500, cors);
      }
    }

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'Geçersiz JSON' }, 400, cors); }

    const { token, title, body, url: linkUrl, icon } = payload;
    if (!token || !title || !body) return json({ error: 'token, title, body zorunlu' }, 400, cors);

    try {
      const accessToken = await getAccessToken(env);
      const result = await fcmGonder(env, accessToken, token, title, body, linkUrl, icon);
      if (!result.ok) return json({ error: result.data }, result.status, cors);
      return json({ success: true, result: result.data }, 200, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  },

  // ─────────────────────────────────────────────
  // CRON TETİKLEYİCİ (zamanlanmış bildirimler)
  // ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(zamanlanmisBildirimleriCalistir(env));
  }
};

// ═══════════════════════════════════════════════
// ZAMANLANMIŞ BİLDİRİM MANTIĞI
// ═══════════════════════════════════════════════
async function zamanlanmisBildirimleriCalistir(env) {
  const accessToken = await getAccessToken(env);

  // Türkiye saatine göre bugünün günü (UTC+3)
  const simdi = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const bugunGun = simdi.getUTCDate();        // Ayın kaçı (1-31)
  const bugunStr = simdi.toISOString().split('T')[0]; // YYYY-MM-DD

  // Tüm Maaş Günü kullanıcılarının FCM token'larını çek
  // users/{uid}/fcm/token dökümanlarını collectionGroup ile topluyoruz
  const tokenlar = await firestoreCollectionGroup(env, accessToken, 'fcm');

  let gonderildi = 0, atlandi = 0, hata = 0;
  const detaylar = [];

  for (const tokenDoc of tokenlar) {
    try {
      const fcmToken = tokenDoc.fields?.fcmToken?.stringValue;
      if (!fcmToken) { atlandi++; continue; }

      // Döküman yolu: users/{uid}/fcm/token → uid'yi çıkar
      const yolParcalari = tokenDoc.name.split('/');
      const uidIndex = yolParcalari.indexOf('users') + 1;
      const uid = yolParcalari[uidIndex];
      if (!uid) { atlandi++; continue; }

      // Kullanıcının ana verisini oku: users/{uid}/masaygunu2/ana
      const veriDoc = await firestoreGetDoc(env, accessToken, `users/${uid}/masaygunu2/ana`);
      if (!veriDoc || !veriDoc.fields?.json?.stringValue) { atlandi++; continue; }

      const veri = JSON.parse(veriDoc.fields.json.stringValue);
      const prefs = veri.bildirimPrefs || { fatura: true, borc: true, maas: true };
      const mesajlar = [];

      // ── 1. MAAŞ GÜNÜ ──
      if (prefs.maas !== false) {
        const maasGunu = veri.ayarlar?.maasGunu || 15;
        if (maasGunu === bugunGun) {
          mesajlar.push({
            title: '💰 Maaş Günü Geldi!',
            body: 'Bugün maaş günün. Bütçeni planlamayı unutma!',
            tag: 'maas-gunu'
          });
        }
      }

      // ── 2. FATURA/GİDER HATIRLATICI ──
      if (prefs.fatura !== false) {
        const ayId = bugunStr.substring(0, 7); // YYYY-MM
        const ayVeri = veri.aylar?.[ayId];
        if (ayVeri?.giderler) {
          for (const g of ayVeri.giderler) {
            if (g.odendi) continue;
            const odemeGunu = parseInt(g.not);
            if (!odemeGunu) continue;
            // Ödeme gününe 2 gün kala veya o gün hatırlat
            const kalan = odemeGunu - bugunGun;
            if (kalan === 2 || kalan === 0) {
              const neZaman = kalan === 0 ? 'bugün' : '2 gün sonra';
              mesajlar.push({
                title: '🗓️ Ödeme Hatırlatıcı',
                body: `${g.ad} ödemesi ${neZaman} (₺${(g.tutar||0).toLocaleString('tr-TR')})`,
                tag: 'fatura-' + (g.id || odemeGunu)
              });
            }
          }
        }
      }

      // ── 3. BORÇ HATIRLATICI ──
      if (prefs.borc !== false && Array.isArray(veri.borclar)) {
        for (const b of veri.borclar) {
          // odemeTarihi alanı aslında "ayın kaçı" bilgisini tutar (1-31)
          const odemeGunu = parseInt(b.odemeTarihi);
          if (!odemeGunu) continue;
          // Kalan borç: toplam miktar - yapılan ödemeler
          const odenenToplam = (b.odemeler || []).reduce((s, o) => s + (o.miktar || 0), 0);
          const kalan = Math.max(0, (b.miktar || 0) - odenenToplam);
          if (kalan <= 0) continue; // Borç tamamen kapanmış
          const gunFarki = odemeGunu - bugunGun;
          if (gunFarki === 2 || gunFarki === 0) {
            const neZaman = gunFarki === 0 ? 'bugün' : '2 gün sonra';
            mesajlar.push({
              title: '💳 Borç Ödeme Hatırlatıcı',
              body: `${b.ad} borç ödemesi ${neZaman}`,
              tag: 'borc-' + (b.id || odemeGunu)
            });
          }
        }
      }

      // Mesajları gönder
      for (const m of mesajlar) {
        const r = await fcmGonder(env, accessToken, fcmToken, m.title, m.body, 'https://ysfykc.github.io/', null);
        if (r.ok) { gonderildi++; detaylar.push({ uid, mesaj: m.title }); }
        else { hata++; detaylar.push({ uid, hata: r.data }); }
      }

    } catch (e) {
      hata++;
      detaylar.push({ hata: e.message });
    }
  }

  return { bugunGun, toplamToken: tokenlar.length, gonderildi, atlandi, hata, detaylar };
}

// ═══════════════════════════════════════════════
// FCM GÖNDERİM
// ═══════════════════════════════════════════════
async function fcmGonder(env, accessToken, token, title, body, linkUrl, icon) {
  const ICON = icon || 'https://ysfykc.github.io/16379.png';
  const fcmRes = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body, image: ICON },
        webpush: {
          fcm_options: { link: linkUrl || 'https://ysfykc.github.io/' },
          notification: { icon: ICON }
        }
      }
    })
  });
  const data = await fcmRes.json();
  return { ok: fcmRes.ok, status: fcmRes.status, data };
}

// ═══════════════════════════════════════════════
// FİRESTORE REST API (service account ile okuma)
// ═══════════════════════════════════════════════

// collectionGroup sorgusu: tüm users/*/fcm/* dökümanlarını çeker
async function firestoreCollectionGroup(env, accessToken, collectionId) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId, allDescendants: true }]
      }
    })
  });
  if (!res.ok) throw new Error('Firestore sorgu hatası: ' + await res.text());
  const data = await res.json();
  // runQuery bir dizi döner; her elemanda .document var
  return data.filter(d => d.document).map(d => d.document);
}

// Tek döküman oku
async function firestoreGetDoc(env, accessToken, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore okuma hatası: ' + await res.text());
  return await res.json();
}

// ═══════════════════════════════════════════════
// YARDIMCILAR
// ═══════════════════════════════════════════════
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiry > now + 60) return cachedToken;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    // İki scope: FCM gönderimi + Firestore okuma
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const encHeader = base64url(JSON.stringify(header));
  const encClaim = base64url(JSON.stringify(claimSet));
  const signInput = `${encHeader}.${encClaim}`;

  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signInput)
  );
  const jwt = `${signInput}.${base64urlFromBuffer(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!res.ok) throw new Error('OAuth token alınamadı: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedTokenExpiry = now + data.expires_in;
  return cachedToken;
}

function base64url(str) {
  return base64urlFromBuffer(new TextEncoder().encode(str));
}
function base64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\\n/g, '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}
