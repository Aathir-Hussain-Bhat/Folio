/* ============================================================
   PDF Lite — optional service worker
   ------------------------------------------------------------
   OPTIONAL: place this file NEXT TO index.html on your host
   (same folder). PDF Lite works without it, but with it you get:
     1. Full offline support (app + PDF.js engine are cached)
     2. "Share -> PDF Lite" from other Android apps (share target)

   NOTE: bump VERSION whenever you ship a new app shell or a new
   PDF.js build, otherwise clients keep the old cached engine.
   ============================================================ */
'use strict';

const VERSION = 'pdf-lite-v1';
const CORE = ['./'];
const MAX_SHARE_BYTES = 200 * 1024 * 1024; // 200 MB hard cap per share

/* ---------- install / activate / lifecycle ---------- */

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(CORE.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') e.waitUntil(self.skipWaiting());
});

/* ---------- share target: receive PDFs from other apps ---------- */

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pdf-lite', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('share')) d.createObjectStore('share');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function looksLikePdf(f) {
  const t = (f.type || '').toLowerCase();
  const n = (f.name || '').toLowerCase();
  return t === 'application/pdf' || t === '' || n.endsWith('.pdf');
}

async function handleShare(request) {
  const form = await request.formData();

  const files = [...form.values()]
    .filter(v => v && typeof v === 'object' && 'size' in v && v.size > 0)
    .filter(looksLikePdf)
    .filter(f => f.size <= MAX_SHARE_BYTES);

  if (!files.length) throw new Error('No valid PDF in share payload');

  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction('share', 'readwrite');
    const st = tx.objectStore('share');
    st.clear();
    files.forEach((f, i) =>
      st.put({ name: f.name || ('shared-' + (i + 1) + '.pdf'), blob: f }, 'f' + i)
    );
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- fetch routing ---------- */

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  const shell = new URL('./', self.registration.scope);

  /* 1) Share target POST -> stash files in IndexedDB, then open the app */
  if (req.method === 'POST' && url.searchParams.get('shared') === '1') {
    e.respondWith((async () => {
      let qs = 'shared=1';
      try {
        await handleShare(req);
      } catch (err) {
        qs = 'shared=1&share_error=1';
      }
      return Response.redirect(new URL('./?' + qs, self.registration.scope).href, 303);
    })());
    return;
  }

  /* 2) Navigations: network-first, offline fallback to cached app shell */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);

        if (res && res.ok && url.pathname === shell.pathname && url.search === '') {
          const put = caches.open(VERSION)
            .then(c => c.put('./', res.clone()))
            .catch(() => {});
          e.waitUntil(put);
        }
        return res;
      } catch (err) {
        const cache = await caches.open(VERSION);
        return (await cache.match('./'))
            || (await cache.match(req))
            || new Response('PDF Lite is offline and has no cached copy yet.', {
                 status: 503, headers: { 'Content-Type': 'text/plain' }
               });
      }
    })());
    return;
  }

  /* 3) PDF.js engine + other cross-origin assets: stale-while-revalidate */
  const isPdfJsAsset =
    /pdf(\.worker)?\.min\.(m?js|map)|pdfjs-dist|cmaps|standard_fonts/i.test(url.href);

  if (isPdfJsAsset || url.origin !== location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreVary: true });

      const network = fetch(req).then(res => {
        if (res && (res.type === 'opaque' ||
                   (res.status === 200 && (res.type === 'cors' || res.type === 'basic')))) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);

      e.waitUntil(network);

      return hit || (await network) || Response.error();
    })());
  }
});
