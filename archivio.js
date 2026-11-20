// Salvataggio nel telefono (IndexedDB) e lettura della casa dal link o da file (contratto `casa`).
// Lo stato si riscrive per intero a ogni conferma: casa + elenco delle operazioni (misure, blocchi, spessori liberi).
import { gunzipSync, strFromU8 } from './vendor/fflate.js';

const DB = 'rilievo-casa';
const VERSIONE_DB = 2; // 2: le immagini stanno in 'immagini', in 'foto' solo i dati (leggere tutte le foto non carica i MB)

function apri() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, VERSIONE_DB);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (ev.oldVersion < 1) { db.createObjectStore('stato'); db.createObjectStore('foto'); }
      if (ev.oldVersion < 2) {
        const imm = db.createObjectStore('immagini');
        const foto = r.transaction.objectStore('foto');
        foto.openCursor().onsuccess = (e) => { // sposta i byte delle foto della versione 1
          const c = e.target.result;
          if (!c) return;
          if (c.value.bytes) { const { bytes, ...resto } = c.value; imm.put(bytes, c.key); c.update(resto); }
          c.continue();
        };
      }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

async function op(store, modo, fn) {
  const db = await apri();
  return new Promise((ok, ko) => {
    const tx = db.transaction(store, modo);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); ok(req?.result); };
    tx.onerror = () => { db.close(); ko(tx.error); };
    tx.onabort = () => { db.close(); ko(tx.error); };
  });
}

export const leggiStato = () => op('stato', 'readonly', (s) => s.get('corrente'));
export const scriviStato = (stato) => op('stato', 'readwrite', (s) => s.put(stato, 'corrente'));
export const scriviFoto = (id, rec) => op('foto', 'readwrite', (s) => s.put(rec, id));
export const leggiFoto = (id) => op('foto', 'readonly', (s) => s.get(id));
// piu' foto in una sola transazione: o cambiano tutte o nessuna (una ricevuta interrotta non lascia stati a meta')
export const scriviFotoMolte = (recs) => op('foto', 'readwrite', (s) => { for (const r of recs) s.put(r, r.id); });
export const tutteLeFoto = () => op('foto', 'readonly', (s) => s.getAll());
export const scriviImmagine = (id, bytes) => op('immagini', 'readwrite', (s) => s.put(bytes, id));
export const leggiImmagine = (id) => op('immagini', 'readonly', (s) => s.get(id));

// Chiede al browser di non cancellare i dati da solo (su iPhone non garantito: lo dice il collaudo).
export async function chiediConservazione() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

export function casaValida(c) {
  if (!c || c.formato !== 'casa') throw new Error('Il file non e\' una casa del rilievo.');
  if (c.versione !== 1) throw new Error(`Versione della casa ${c.versione} non conosciuta: aggiorna l'app.`);
  if (!Array.isArray(c.muri) || !Array.isArray(c.stanze)) throw new Error('Casa senza muri o stanze.');
  return c;
}

// #casa=<gzip base64url> -> oggetto casa; null se il link non ha la casa
export function casaDalLink(hash) {
  const m = /[#&]casa=([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const u8 = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return casaValida(JSON.parse(strFromU8(gunzipSync(u8))));
}
