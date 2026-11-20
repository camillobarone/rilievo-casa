// Pacchetti da mandare al PC e ricevute che tornano (contratti `pacchetto` e `ricevuta`, research R2).
// Ogni invio contiene tutto il rilievo (rilievo.json) ma solo le foto non ancora arrivate, in pezzi da max 20 MB.
import { zipSync, strToU8 } from './vendor/fflate.js';

export const LIMITE = 20 * 1024 * 1024;

const due = (n) => String(n).padStart(2, '0');
export function timbro(d) { // ora locale del telefono: AAAAMMGG-HHMMSS
  return `${d.getFullYear()}${due(d.getMonth() + 1)}${due(d.getDate())}-${due(d.getHours())}${due(d.getMinutes())}${due(d.getSeconds())}`;
}

export async function sha256(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// impronta di un insieme di foto: sha256 di "id:impronta" ordinati, uniti da \n (uguale in importa.py)
export async function improntaInsieme(foto) {
  const righe = foto.map((f) => `${f.id}:${f.impronta}`).sort().join('\n');
  return sha256(strToU8(righe));
}

// spostamenti dei muri rispetto al progetto, per costruisci_casa.py (contratto `muri-rilievo`)
export function muriRilievo(geo, ris) {
  const muri = [];
  for (const m of ris.muri) {
    const b = geo.muro(m.id);
    const cm = (v) => Math.round(v * 100000) / 1000;
    const d = { pos: cm(m.pos - b.pos), spessore: cm(m.spessore - b.spessore), da: cm(m.da - b.da), a: cm(m.a - b.a) };
    if (Object.values(d).some((v) => v !== 0)) muri.push({ id: m.id, asse: m.asse, sposta_cm: d.pos, spessore_cm: d.spessore, da_cm: d.da, a_cm: d.a });
  }
  return { formato: 'muri-rilievo', versione: 1, muri };
}

const meta = ({ blob, bytes, ...resto }) => resto; // dati della foto senza l'immagine

// foto: [{id, impronta, ..., bytes: Uint8Array}] gia' filtrate (solo quelle da mandare)
export function preparaPacchetti({ stato, tutteFoto, daMandare, muri, esportato }) {
  const ts = timbro(new Date(esportato));
  const rilievo = { formato: 'rilievo', versione: 1, casa: stato.casa.id, nome: stato.casa.nome,
    versione_progetto: stato.casa.versione_progetto, esportato, operazioni: stato.operazioni,
    foto: tutteFoto.map(meta), inclusi: daMandare.map((f) => f.id) };
  const json = (o) => strToU8(JSON.stringify(o, null, 1));
  const gruppi = [[]];
  let peso = json(rilievo).length + json(muri).length;
  for (const f of daMandare) {
    if (peso + f.bytes.length > LIMITE && gruppi[gruppi.length - 1].length) { gruppi.push([]); peso = 0; }
    gruppi[gruppi.length - 1].push(f);
    peso += f.bytes.length;
  }
  return gruppi.map((g, i) => {
    const file = { 'parte.json': [json({ formato: 'parte', versione: 1, casa: stato.casa.id, esportato, n: i + 1, N: gruppi.length }), {}] };
    if (i === 0) { file['rilievo.json'] = [json(rilievo), {}]; file['muri-rilievo.json'] = [json(muri), {}]; }
    for (const f of g) file[`foto/${f.id}.jpg`] = [f.bytes, { level: 0 }]; // le foto sono gia' compresse
    return { nome: `rilievo-${stato.casa.id}-${ts}-${i + 1}di${gruppi.length}.zip`, bytes: zipSync(file), foto: g.map((f) => f.id) };
  });
}

// #ricevuto=<base64url di JSON> -> ricevuta validata; null se il link non ce l'ha
export function ricevutaDalLink(hash) {
  const m = /[#&]ricevuto=([A-Za-z0-9_-]+)/.exec(hash || '');
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const r = JSON.parse(decodeURIComponent(escape(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))));
  if (r.formato !== 'ricevuta' || r.versione !== 1) throw new Error('Ricevuta non riconosciuta: aggiorna l\'app.');
  return r;
}
