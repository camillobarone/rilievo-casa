// Funzionamento senza internet: i file dell'app restano in cache; la casa e le foto stanno in IndexedDB.
// Cambiare VERSIONE a ogni pubblicazione, cosi' il telefono prende i file nuovi.
const VERSIONE = 'rilievo-5';
const FILE = ['./', 'index.html', 'app.js', 'geometria.js', 'archivio.js', 'pacchetto.js', 'vendor/fflate.js', 'manifest.webmanifest', 'icona.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSIONE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // prima la rete (file aggiornati), poi la cache (cantiere senza internet)
  // in cantiere la rete puo' esserci ma lentissima: per la pagina, dopo 4 s si usa la copia in cache
  const rete = fetch(e.request).then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(VERSIONE).then((c) => c.put(e.request, copia)); } // mai salvare un errore
    return r;
  });
  const cache = () => caches.match(e.request, { ignoreSearch: true });
  if (e.request.mode !== 'navigate') { e.respondWith(rete.catch(cache)); return; } // moduli: mai versioni mescolate
  const lenta = new Promise((ok) => setTimeout(ok, 4000)).then(cache);
  e.respondWith(Promise.race([rete.catch(cache), lenta.then((c) => c || rete)]).then((r) => r || rete));
});
