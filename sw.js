/* Service Worker — Controle da Horta
   Como o app é um único arquivo HTML (sem backend), o cache aqui é bem
   simples: guarda o próprio app para abrir mesmo sem internet. */

const CACHE = 'horta-v37';
const ARQUIVOS = ['./manifest.json', './icons/icon-192.png', './icons/icon-512.png', './fundo-inicio.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const ehHtml = event.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname.endsWith('/');
  if (ehHtml) {
    // Network-first pro HTML: sempre tenta buscar a versão nova primeiro,
    // e só cai pro cache guardado se estiver offline.
    event.respondWith(
      fetch(event.request).then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return resp;
      }).catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
