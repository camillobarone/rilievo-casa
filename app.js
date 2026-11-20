// Pagina del rilievo: pianta, tocco sui muri, misure, annulla. La logica sta in geometria.js.
import { creaGeometria, muriAlTocco } from './geometria.js';
import { leggiStato, scriviStato, chiediConservazione, casaDalLink, casaValida, scriviFoto, tutteLeFoto, scriviImmagine, leggiImmagine, scriviFotoMolte } from './archivio.js';
import { preparaPacchetti, muriRilievo, sha256, improntaInsieme, ricevutaDalLink } from './pacchetto.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const svg = $('pianta');
const foglio = $('foglio');
const fmt = (v) => v.toFixed(2).replace('.', ',');
const LATO_OPPOSTO = { ovest: 'est', est: 'ovest', nord: 'sud', sud: 'nord' };
const ASSE_NOME = { x: '↔ da sinistra a destra', y: "↕ dall'alto in basso" }; // come si vede sulla pianta, niente punti cardinali

let stato = null;      // { casa, operazioni: [...] } — salvato per intero a ogni conferma
let geo = null;
let ris = null;        // ultimo risultato di geo.risolvi
let vb = null;         // viewBox corrente {x, y, w, h}
let scelto = null;     // muro evidenziato
let spostaFoto = null; // id della foto in attesa della parete di destinazione
let quote = [];        // misure scritte sulla pianta che si possono toccare: {x, y, asse, stanza, k}
const QUOTA_DAL_MURO = 0.3; // metri fra la faccia del muro e la misura scritta
const SEGNO_LATO = { ovest: '+', nord: '+', est: '-', sud: '-' };

// ------------------------------------------------------------------ stato e operazioni
const misure = () => stato.operazioni.filter((o) => o.tipo === 'misura').map((o) => o.misura);
const opzioni = () => ({
  bloccati: attivi('blocca'),
  liberi: attivi('libero'),
});
function attivi(tipo) { // blocca/libero si accendono e spengono: conta l'ultima operazione per muro
  const s = new Map();
  for (const o of stato.operazioni) if (o.tipo === tipo) s.set(o.muro, o.acceso);
  return [...s].filter(([, v]) => v).map(([k]) => k);
}

async function registra(op) {
  stato.operazioni.push({ ...op, data: new Date().toISOString() });
  await scriviStato(stato);
  disegna();
}

const fotoCasa = async () => (await tutteLeFoto()).filter((f) => f.casa === stato.casa.id);
function statoOp(o) {
  if (stato.ultimaRicevuta && o.data <= stato.ultimaRicevuta) return 'arrivata';
  if (stato.ultimoInvio && o.data <= stato.ultimoInvio) return 'inviata';
  return 'da_inviare';
}
// le operazioni gia' prese citano muri per id: sulla pianta nuova devono esistere tutti e dare una pianta coerente
function compatibile(casa, operazioni) {
  const ids = new Set(casa.muri.map((m) => m.id));
  for (const o of operazioni) {
    const m = o.misura || {};
    for (const id of [o.muro, m.muroA, m.muroB, m.muove, m.muro, m.riferimento]) if (id && !ids.has(id)) return false;
  }
  const g = creaGeometria(casa);
  const st = { operazioni };
  const sel = (t) => [...new Map(st.operazioni.filter((o) => o.tipo === t).map((o) => [o.muro, o.acceso]))].filter(([, v]) => v).map(([k]) => k);
  return g.risolvi(operazioni.filter((o) => o.tipo === 'misura').map((o) => o.misura), { bloccati: sel('blocca'), liberi: sel('libero') }).ok;
}

async function nonArrivati() {
  const c = await contaStati();
  return c.da_inviare + c.inviata;
}
async function contaStati() {
  const c = { da_inviare: 0, inviata: 0, arrivata: 0, persa: 0 };
  for (const f of await fotoCasa()) c[f.stato_invio]++;
  for (const o of stato.operazioni) c[statoOp(o)]++;
  return c;
}
async function aggiornaConti() {
  const c = await contaStati();
  $('conti').textContent = `Misure prese: ${misure().length} · da inviare: ${c.da_inviare} · in attesa: ${c.inviata} · arrivati: ${c.arrivata}`;
  return c;
}

async function annulla() {
  if (!stato?.operazioni.length) return;
  if (statoOp(stato.operazioni[stato.operazioni.length - 1]) !== 'da_inviare') {
    alert('L\'ultima operazione e\' gia\' stata inviata al PC: non si annulla. Per correggere una misura, rimisura quel lato.');
    return;
  }
  stato.operazioni.pop();
  await scriviStato(stato);
  chiudiFoglio();
  disegna();
}

// ------------------------------------------------------------------ avvio
async function avvia() {
  chiediConservazione();
  let salvato = null;
  try { salvato = await leggiStato(); } catch (e) {
    console.error(e);
    $('avvio').hidden = false;
    svg.style.display = 'none';
    $('avvio').innerHTML = `<p><b>Non riesco a leggere i dati salvati nel telefono.</b> Non tocco niente: chiudi l'app e riaprila.
      Se il messaggio torna, non aprire link di case e chiamami.</p><p class="nota">${esc(e?.message || e)}</p>`;
    return;
  }
  let dalLink = null;
  try { dalLink = casaDalLink(location.hash); } catch (e) { alert(`Il link della casa non si legge: ${e.message}`); }
  if (dalLink && salvato && salvato.casa.id === dalLink.id && salvato.casa.impronta !== dalLink.impronta) {
    stato = salvato; // stessa casa, pianta aggiornata dal PC: si cambia solo se niente aspetta di arrivare
    if (await nonArrivati()) alert('Il link ha una pianta aggiornata, ma ci sono dati non ancora arrivati al PC: prima «Invia al PC», poi riapri il link.');
    else if (!compatibile(dalLink, salvato.operazioni)) alert('La pianta nuova non va d\'accordo con le misure gia\' prese: tengo quella vecchia. Chiamami.');
    else { salvato = { ...salvato, casa: dalLink }; await scriviStato(salvato); } // da qui in poi lo stato e' quello nuovo
    stato = null;
  }
  if (dalLink && (!salvato || salvato.casa.id !== dalLink.id)) {
    stato = salvato;
    const n = salvato ? await nonArrivati() : 0;
    stato = null;
    if (salvato && !confirm(`Nel telefono c'e' la casa «${salvato.casa.nome}»${n ? ` con ${n} dati NON ancora arrivati al PC` : ''}. Aprire «${dalLink.nome}» al suo posto?`)) dalLink = null;
    else { stato = { casa: dalLink, operazioni: [] }; await scriviStato(stato); }
  }
  if (!stato) stato = salvato;
  let ricevuta = null;
  try { ricevuta = ricevutaDalLink(location.hash); } catch (e) { alert(e.message); }
  if (location.hash.includes('casa=') || location.hash.includes('ricevuto=')) history.replaceState(null, '', location.pathname);
  if (ricevuta && !stato) alert('Ricevuta aperta in un\'app senza la casa: aprila dall\'app installata con «Ricevuta».');
  if (ricevuta && stato) await applicaRicevuta(ricevuta);
  if (!stato) { $('avvio').hidden = false; svg.style.display = 'none'; return; }
  pronto();
}

function pronto() {
  $('avvio').hidden = true;
  svg.style.display = '';
  geo = creaGeometria(stato.casa);
  $('titolo').textContent = stato.casa.nome;
  inquadra();
  disegna();
}

async function apriFile(file) {
  try {
    const c = casaValida(JSON.parse(await file.text()));
    if (stato && stato.casa.id === c.id) { alert('Questa casa e\' gia\' aperta.'); return; }
    if (stato && !confirm(`Sostituire «${stato.casa.nome}» (${stato.operazioni.length} operazioni) con «${c.nome}»?`)) return;
    stato = { casa: c, operazioni: [] };
    await scriviStato(stato);
    pronto();
  } catch (e) { alert(e.message); }
}

// ------------------------------------------------------------------ disegno
function inquadra() {
  const xs = [], ys = [];
  for (const m of stato.casa.muri) {
    const [u0, u1] = [m.pos - m.spessore / 2, m.pos + m.spessore / 2];
    if (m.asse === 'x') { xs.push(u0, u1); ys.push(m.da, m.a); } else { ys.push(u0, u1); xs.push(m.da, m.a); }
  }
  const x0 = Math.min(...xs) - 0.5, y0 = Math.min(...ys) - 0.5;
  vb = { x: x0, y: y0, w: Math.max(...xs) + 0.5 - x0, h: Math.max(...ys) + 0.5 - y0 };
}

function pxPerM() {
  const r = svg.getBoundingClientRect();
  return Math.min(r.width / vb.w, r.height / vb.h);
}
function aSchermo(x, y) { // metri -> pixel della pagina (preserveAspectRatio xMidYMid meet)
  const r = svg.getBoundingClientRect(), s = pxPerM();
  return [r.left + (r.width - vb.w * s) / 2 + (x - vb.x) * s, r.top + (r.height - vb.h * s) / 2 + (y - vb.y) * s];
}
function daSchermo(px, py) {
  const r = svg.getBoundingClientRect(), s = pxPerM();
  return [vb.x + (px - r.left - (r.width - vb.w * s) / 2) / s, vb.y + (py - r.top - (r.height - vb.h * s) / 2) / s];
}

function el(tag, attr, padre) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attr)) e.setAttribute(k, v);
  padre?.appendChild(e);
  return e;
}

function disegna() {
  quote = [];
  ris = geo.risolvi(misure(), opzioni());
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.replaceChildren();
  $('annulla').disabled = !stato.operazioni.length;
  aggiornaConti();
  if (!ris.ok) { // non dovrebbe succedere: le misure entrano solo dopo proponi
    $('conti').textContent = 'ATTENZIONE: misure in conflitto, usa Annulla';
    return;
  }
  for (const s of ris.stanze) {
    const tipo = stato.casa.stanze.find((x) => x.id === s.id).tipo;
    for (const r of s.rettangoli) el('rect', { class: `stanza ${tipo}`, x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] }, svg);
  }
  const bloccati = new Set(opzioni().bloccati);
  for (const m of ris.muri) {
    const base = geo.muro(m.id);
    const mosso = Math.abs(m.pos - base.pos) > 1e-6 || Math.abs(m.spessore - base.spessore) > 1e-6;
    const cls = ['muro', mosso && 'mosso', bloccati.has(m.id) && 'bloccato', scelto === m.id && 'scelto'].filter(Boolean).join(' ');
    const [u0, v0, du, dv] = [m.pos - m.spessore / 2, Math.min(m.da, m.a), m.spessore, Math.abs(m.a - m.da)];
    el('rect', m.asse === 'x' ? { class: cls, x: u0, y: v0, width: du, height: dv } : { class: cls, x: v0, y: u0, width: dv, height: du }, svg).dataset.muro = m.id;
  }
  for (const s of ris.stanze) {
    const r = s.rettangoli[0];
    el('text', { class: 'nome', x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 }, svg).textContent = s.nome;
    const casaS = stato.casa.stanze.find((x) => x.id === s.id);
    s.rettangoli.forEach(([x0, y0, x1, y1], k) => {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, sopra = cy - (y1 - y0) / 4; // di lato: piu' in alto del nome
      // lungo un muro in alto o in basso si legge la misura da sinistra a destra, lungo uno di lato quella dall'alto in basso;
      // come in una planimetria quotata la stessa misura compare su tutti e due i muri opposti
      const posti = { nord: [cx, y0 + QUOTA_DAL_MURO, 'x'], sud: [cx, y1 - QUOTA_DAL_MURO, 'x'],
        ovest: [x0 + QUOTA_DAL_MURO, sopra, 'y'], est: [x1 - QUOTA_DAL_MURO, sopra, 'y'] };
      const spazio = { x: y1 - y0, y: x1 - x0 }; // quanto e' profonda la stanza davanti al muro
      for (const [lato, [x, y, asse]] of Object.entries(posti)) {
        if (!casaS.lati.some((l) => l.rett === k && l.lato === lato && l.tratti.length)) continue; // lato aperto: niente muro
        if (spazio[asse] < 2 * QUOTA_DAL_MURO + 0.2) continue; // striscia troppo sottile: il numero non ci sta
        const m = s.misure[k][asse];
        if (m.valore < 0.6) continue; // muro piu' corto del numero
        const attr = { class: `quota ${m.stato}`, x, y };
        if (asse === 'y') attr.transform = `rotate(-90 ${x} ${y})`;
        el('text', attr, svg).textContent = fmt(m.valore);
        if (latoDa(casaS, k, asse)) quote.push({ x, y, asse, stanza: casaS, k });
      }
    });
  }
}
// tocco su una misura scritta: solo se si legge (ingrandita almeno a 8 px), sul testo piu' 6 px di margine;
// a pianta intera i numeri sono troppo piccoli e un tocco largo ruberebbe quello sulla stanza. Con s >= 40 px/m
// la zona arriva a 0,12 + 6/40 = 0,27 m dal centro del numero, che sta a QUOTA_DAL_MURO = 0,3 m dal muro:
// un tocco sul muro non cade mai su un numero. Se due zone si toccano vince il numero piu' vicino.
function quotaAlTocco([x, y]) {
  const s = pxPerM();
  if (0.2 * s < 8) return null;
  const lungo = 0.32 + 6 / s, corto = 0.12 + 6 / s;
  const dentro = quote.filter((q) => {
    const [mx, my] = q.asse === 'x' ? [lungo, corto] : [corto, lungo];
    return Math.abs(x - q.x) <= mx && Math.abs(y - q.y) <= my;
  });
  return dentro.sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0] || null;
}

// ------------------------------------------------------------------ fogli (pannelli in basso)
function apriFoglio(html) { foglio.innerHTML = html; foglio.hidden = false; }
// Il telefono manda un clic anche dopo un tocco sulla pianta: se il pannello appena aperto copre quel punto,
// il clic premerebbe il bottone che sta li' sotto. Si scarta il clic nello stesso punto del tocco, subito dopo.
let ultimoTocco = { x: -99, y: -99, t: 0 };
foglio.addEventListener('click', (e) => {
  if (performance.now() - ultimoTocco.t < 800 && Math.hypot(e.clientX - ultimoTocco.x, e.clientY - ultimoTocco.y) < 12) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);
function chiudiFoglio() { foglio.hidden = true; foglio.innerHTML = ''; scelto = null; disegna(); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const nomeStanza = (id) => stato.casa.stanze.find((s) => s.id === id).nome;

function stanzeDelMuro(muroId) { // [{stanza, lato}] che hanno questo muro su un loro lato
  const out = [];
  for (const s of stato.casa.stanze) for (const l of s.lati) if (l.tratti.some((t) => t.muro === muroId)) out.push({ stanza: s, lato: l });
  return out;
}

function foglioMuro(muroId) {
  scelto = muroId;
  disegna();
  const vicine = stanzeDelMuro(muroId);
  const blocc = opzioni().bloccati.includes(muroId);
  const lib = opzioni().liberi.includes(muroId);
  const titolo = vicine.length ? `Muro ${vicine.map((v) => v.stanza.nome).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}` : 'Muro';
  const bott = vicine.map((v, i) => `<button class="primario" data-i="${i}">Misura ${esc(v.stanza.nome)} (${ASSE_NOME[v.lato.asse]})</button>`).join('');
  const facce = vicine.filter((v, i, a) => a.findIndex((w) => w.stanza.id === v.stanza.id) === i);
  const sposta = spostaFoto ? `<div class="righe"><b>Metti qui la foto:</b>${facce.map((v, i) => `<button class="primario" data-qui="${i}">Parete di ${esc(v.stanza.nome)}</button>`).join('')}</div>` : '';
  const bottFoto = facce.map((v, i) => `<button data-foto="${i}">📷 Foto ${esc(v.stanza.nome)}</button><button data-gal="${i}">Dalla galleria</button>`).join('');
  apriFoglio(`<h2>${esc(titolo)}</h2>${sposta}
    <div class="bottoni">${bottFoto}</div>
    <div class="righe" id="elencoFoto"></div>
    <p class="nota">${geo.esterno(muroId) ? 'Muro del perimetro: non si sposta mai.' : 'Muro interno: puo\' spostarsi quando misuri una stanza accanto.'}
    Spessore ${fmt(ris.muri.find((m) => m.id === muroId).spessore * 100).replace(',00', '')} cm.</p>
    <div class="righe">${bott}</div>
    <div class="bottoni">
      ${geo.esterno(muroId) ? '' : `<button data-az="blocca">${blocc ? 'Sblocca' : 'Blocca'} questo muro</button>`}
      <button data-az="libero">${lib ? 'Spessore come da progetto' : 'Spessore diverso dal progetto'}</button>
      <button data-az="chiudi">Chiudi</button>
    </div>`);
  elencaFoto(muroId);
  foglio.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.i !== undefined) return chiediMisura(vicine[+b.dataset.i], muroId);
    if (b.dataset.foto !== undefined) return prendiFoto(facce[+b.dataset.foto], muroId, true);
    if (b.dataset.gal !== undefined) return prendiFoto(facce[+b.dataset.gal], muroId, false);
    if (b.dataset.qui !== undefined) return metti(facce[+b.dataset.qui], muroId);
    if (b.dataset.sposta) { spostaFoto = b.dataset.sposta; chiudiFoglio(); $('conti').textContent = 'Tocca il muro dove va la foto'; return; }
    if (b.dataset.az === 'blocca' || b.dataset.az === 'libero') {
      const tipo = b.dataset.az, acceso = tipo === 'blocca' ? !blocc : !lib;
      const o = opzioni();
      const lista = new Set(tipo === 'blocca' ? o.bloccati : o.liberi);
      if (acceso) lista.add(muroId); else lista.delete(muroId);
      if (!geo.risolvi(misure(), { ...o, [tipo === 'blocca' ? 'bloccati' : 'liberi']: [...lista] }).ok) {
        alert('Non si puo\': questo muro e\' gia\' stato spostato da una misura. Prima annulla o rimisura quel lato.');
        return;
      }
      await registra({ tipo, muro: muroId, acceso });
      return foglioMuro(muroId);
    }
    chiudiFoglio();
  };
}

async function elencaFoto(muroId) {
  const box = $('elencoFoto');
  if (!box) return;
  const qui = (await fotoCasa()).filter((f) => f.muro === muroId).sort((a, b) => a.scattata.localeCompare(b.scattata));
  box.innerHTML = qui.length ? `<b>Foto di questo muro: ${qui.length}</b>` + qui.map((f) =>
    `<div>${esc(nomeStanza(f.stanza))} · ${new Date(f.scattata).toLocaleString('it-IT')} · ${f.stato_invio.replace('_', ' ')} <button data-sposta="${f.id}">Sposta</button></div>`).join('') : '';
}

// una o piu' foto (fotocamera o galleria) legate alla faccia del muro rivolta alla stanza
function prendiFoto({ stanza, lato }, muroId, fotocamera) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  if (fotocamera) inp.setAttribute('capture', 'environment'); else inp.multiple = true;
  inp.onchange = async () => {
    for (const file of inp.files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = crypto.randomUUID();
      await scriviImmagine(id, bytes); // prima l'immagine: una scheda senza immagine sarebbe una foto persa
      await scriviFoto(id, { id, casa: stato.casa.id, stanza: stanza.id, muro: muroId, faccia: SEGNO_LATO[lato.lato],
        scattata: new Date(fotocamera ? Date.now() : file.lastModified || Date.now()).toISOString(),
        origine: fotocamera ? 'fotocamera' : 'galleria', nome_file: file.name, tipo: file.type,
        impronta: await sha256(bytes), stato_invio: 'da_inviare' });
    }
    await aggiornaConti();
    foglioMuro(muroId);
  };
  document.body.appendChild(inp);
  inp.click();
  inp.remove();
}

async function metti({ stanza, lato }, muroId) {
  const f = (await fotoCasa()).find((x) => x.id === spostaFoto);
  spostaFoto = null;
  if (f) await scriviFoto(f.id, { ...f, stanza: stanza.id, muro: muroId, faccia: SEGNO_LATO[lato.lato] });
  foglioMuro(muroId);
}

// ------------------------------------------------------------------ invio al PC e ricevuta
async function inviaAlPC() {
  if (!stato) return;
  if (!ris?.ok) { alert('Le misure sono in conflitto: usa Annulla sull\'ultima, poi invia.'); return; }
  apriFoglio('<h2>Preparo i file…</h2><p class="nota">Un momento.</p>');
  try {
    const tutte = await fotoCasa();
    const daMandare = [];
    for (const f of tutte.filter((x) => x.stato_invio !== 'arrivata' && x.stato_invio !== 'persa')) {
      const bytes = await leggiImmagine(f.id);
      if (!bytes) { // scheda senza immagine: la foto e' persa, lo si dice e non blocca piu' niente
        alert(`La foto del ${new Date(f.scattata).toLocaleString('it-IT')} non si trova piu' nel telefono: la segno come persa.`);
        await scriviFoto(f.id, { ...f, stato_invio: 'persa' });
        continue;
      }
      daMandare.push({ ...f, bytes });
    }
    const esportato = new Date().toISOString();
    const parti = preparaPacchetti({ stato, tutteFoto: tutte, daMandare, muri: muriRilievo(geo, ris), esportato });
    const file = parti.map((p) => new File([p.bytes], p.nome, { type: 'application/zip' }));
    // Chrome su Android non condivide i .zip (canShare falso) e rifiuta una condivisione partita troppo dopo il
    // tocco: per questo «Condividi» e' un bottone a se', e «Scarica» c'e' sempre.
    let condivisibile = false;
    try { condivisibile = !!(navigator.canShare && navigator.canShare({ files: file })); } catch { condivisibile = false; }
    const url = file.map((f) => URL.createObjectURL(f));
    let segnato = false;
    const segna = async () => { // inviati (in attesa della ricevuta) solo quando escono davvero dal telefono
      if (segnato) return;
      segnato = true;
      await scriviFotoMolte(daMandare.filter((f) => f.stato_invio === 'da_inviare').map(({ bytes, ...f }) => ({ ...f, stato_invio: 'inviata' })));
      stato.invii = { ...(stato.invii || {}), [esportato]: daMandare.map((f) => f.id) };
      stato.ultimoInvio = esportato;
      await scriviStato(stato);
      await aggiornaConti();
    };
    apriFoglio(`<h2>Pronti ${file.length} file da mandare al PC</h2>
      <p class="nota">${condivisibile ? 'Tocca «Condividi» e scegli Gmail, Drive o WhatsApp, oppure scaricali.' : 'Scaricali qui sotto, poi mandali al PC: per esempio da Gmail, allegandoli a una mail a te stesso (si trovano in «Download» del telefono).'}
      Sul PC vanno nella cartella Download, poi doppio clic su «Importa rilievo».</p>
      ${condivisibile ? '<div class="righe"><button class="primario" data-az="condividi">Condividi</button></div>' : ''}
      <div class="righe">${file.map((f, i) => `<a href="${url[i]}" download="${esc(f.name)}"><button class="${condivisibile ? '' : 'primario'}" tabindex="-1">Scarica pezzo ${i + 1} di ${file.length}</button></a>`).join('')}</div>
      <div class="bottoni"><button data-az="chiudi">Fatto</button></div>`);
    foglio.onclick = async (e) => {
      if (e.target.closest('a[download]')) { segna(); return; } // il download parte da solo col tocco
      const b = e.target.closest('button[data-az]');
      if (!b) return;
      if (b.dataset.az !== 'condividi') return chiudiFoglio();
      try {
        await navigator.share({ files: file, title: `Rilievo ${stato.casa.nome}` });
        await segna();
        alert(`Mandati ${file.length} file. Sul PC: doppio clic su «Importa rilievo», poi inquadra il QR con il telefono.`);
      } catch (err) {
        if (err.name !== 'AbortError') alert(`La condivisione non e' riuscita (${err.name}). Usa «Scarica».`);
      }
    };
  } catch (e) {
    console.error(e);
    apriFoglio(`<h2 style="color:var(--conflitto)">Invio non riuscito</h2><p class="nota">Niente e' stato segnato come inviato.
      Mandami una foto di questo messaggio: <b>${esc(e?.name || 'Errore')}: ${esc(e?.message || e)}</b></p>
      <div class="bottoni"><button data-az="chiudi">Chiudi</button></div>`);
    foglio.onclick = (ev) => { if (ev.target.closest('button[data-az]')) chiudiFoglio(); };
  }
}

async function applicaRicevuta(r) {
  if (r.casa !== stato.casa.id) { alert('La ricevuta e\' di un\'altra casa.'); return; }
  const inclusi = stato.invii?.[r.esportato];
  if (!inclusi) { alert('Questa ricevuta non corrisponde a nessun invio fatto da questo telefono.'); return; }
  const tutte = await fotoCasa();
  const mancanti = new Set(r.mancanti ?? inclusi); // null: troppe mancanti per il QR, si rimandano tutte
  const arrivate = tutte.filter((f) => inclusi.includes(f.id) && !mancanti.has(f.id));
  if (await improntaInsieme(arrivate) !== r.impronta) {
    await scriviFotoMolte(tutte.filter((f) => inclusi.includes(f.id) && f.stato_invio !== 'arrivata').map((f) => ({ ...f, stato_invio: 'da_inviare' })));
    alert('La ricevuta non coincide con le foto del telefono: le rimetto tutte fra quelle da inviare.');
    return;
  }
  await scriviFotoMolte([...arrivate.map((f) => ({ ...f, stato_invio: 'arrivata' })),
    ...tutte.filter((f) => mancanti.has(f.id)).map((f) => ({ ...f, stato_invio: 'da_inviare' }))]);
  if (r.rilievo && (!stato.ultimaRicevuta || r.esportato > stato.ultimaRicevuta)) stato.ultimaRicevuta = r.esportato;
  await scriviStato(stato);
  alert(`Arrivati sul PC: ${arrivate.length} foto${r.rilievo ? ' e le misure' : ''}.${mancanti.size ? ` Da rimandare: ${mancanti.size}.` : ''}`);
}

// misura del lato di una stanza fra il muro toccato e quello di fronte
function chiediMisura({ stanza, lato }, muroToccato, valoreIniziale = '') {
  const k = lato.rett;
  const opposti = stanza.lati.filter((l) => l.rett === k && l.lato === LATO_OPPOSTO[lato.lato] && l.tratti.length);
  if (!opposti.length) { alert('Di fronte a questo muro non c\'e\' un muro: qui la misura non si puo\' prendere.'); return; }
  const trattiOpposti = opposti.flatMap((l) => l.tratti);
  const facce = [...new Set(trattiOpposti.map((t) => t.faccia.toFixed(3)))];
  if (facce.length > 1) {
    apriFoglio(`<h2>Fino a quale tratto hai misurato?</h2><p class="nota">Il lato di fronte e' fatto di piu' pezzi di muro.</p>
      <div class="righe">${trattiOpposti.map((t, i) => `<button data-i="${i}">Tratto da ${fmt(t.da)} a ${fmt(t.a)} m</button>`).join('')}</div>
      <div class="bottoni"><button data-az="chiudi">Annulla</button></div>`);
    foglio.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.az) return chiudiFoglio();
      inserisciValore(stanza, lato, muroToccato, trattiOpposti[+b.dataset.i].muro, valoreIniziale);
    };
    return;
  }
  inserisciValore(stanza, lato, muroToccato, trattiOpposti[0].muro, valoreIniziale);
}

function inserisciValore(stanza, lato, muroToccato, muroOpposto, valoreIniziale) {
  const basso = lato.lato === 'ovest' || lato.lato === 'nord';
  const misura = { tipo: 'distanza', stanza: stanza.id, rett: lato.rett, asse: lato.asse,
    muroA: basso ? muroToccato : muroOpposto, muroB: basso ? muroOpposto : muroToccato };
  const attuale = ris.stanze.find((s) => s.id === stanza.id).misure[lato.rett][lato.asse];
  apriFoglio(`<h2>${esc(stanza.nome)}: misura ${ASSE_NOME[lato.asse]}</h2>
    <p class="nota">Oggi in pianta: <b>${fmt(attuale.valore)} m</b> (${attuale.stato.replace('_', ' ')}). Scrivi la misura vera, da muro a muro.</p>
    <input id="valore" inputmode="decimal" autocomplete="off" placeholder="es. 3,52" value="${esc(valoreIniziale)}">
    <div class="bottoni"><button class="primario" data-az="ok">OK</button><button data-az="chiudi">Annulla</button></div>`);
  const inp = $('valore');
  inp.focus();
  const conferma = () => controllaValore(inp.value, misura);
  inp.onkeydown = (e) => { if (e.key === 'Enter') conferma(); };
  foglio.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.az === 'ok') conferma(); else chiudiFoglio();
  };
}

function controllaValore(testo, misura) {
  const v = Number(String(testo).trim().replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) { alert('Scrivi un numero in metri, per esempio 3,52.'); return; }
  const ok = (x) => x >= 0.3 && x <= 20;
  if (!ok(v)) {
    const forse = v / 100;
    if (ok(forse)) {
      apriFoglio(`<h2>Intendevi ${fmt(forse)} m?</h2><p class="nota">Hai scritto ${esc(testo)}: in metri sarebbe fuori misura.</p>
        <div class="bottoni"><button class="primario" data-v="${forse}">Sì, ${fmt(forse)} m</button><button data-az="chiudi">No, riscrivo</button></div>`);
      foglio.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.v) applica({ ...misura, valore: +b.dataset.v }); else chiudiFoglio();
      };
      return;
    }
    if (!confirm(`${fmt(v)} m e' una misura insolita. La confermi?`)) return;
  }
  applica({ ...misura, valore: Math.round(v * 1000) / 1000 });
}

async function applica(misura) {
  const p = geo.proponi(misura, misure(), opzioni());
  // il pannello si chiude PRIMA di salvare: dopo l'attesa potrebbe esserci gia' un pannello nuovo aperto da un tocco
  if (p.muove) { chiudiFoglio(); await registra({ tipo: 'misura', misura: { ...misura, muove: p.muove, id: crypto.randomUUID() } }); return; }
  if (p.conferma) { chiudiFoglio(); await registra({ tipo: 'misura', misura: { ...misura, muove: null, id: crypto.randomUUID() } }); return; }
  if (p.scegli) return chiediQualeMuro(misura, p.scegli);
  return mostraConflitto(misura, p.conflitto);
}

function chiediQualeMuro(misura, muri) {
  const descr = (muroId) => {
    const altre = stanzeDelMuro(muroId).map((v) => v.stanza).filter((s) => s.id !== misura.stanza);
    return altre.length ? `Sposto il muro verso ${altre.map((s) => s.nome).join(' / ')} (cambia ${altre.map((s) => s.nome).join(' / ')})` : 'Sposto questo muro';
  };
  scelto = null;
  apriFoglio(`<h2>Quale muro si sposta?</h2><p class="nota">${esc(nomeStanza(misura.stanza))} ha due muri liberi: scegli quale resta fermo.</p>
    <div class="righe">${muri.map((m, i) => `<button data-i="${i}">${esc(descr(m))}</button>`).join('')}</div>
    <div class="bottoni"><button data-az="chiudi">Annulla</button></div>`);
  foglio.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.az) return chiudiFoglio();
    chiudiFoglio();
    await registra({ tipo: 'misura', misura: { ...misura, muove: muri[+b.dataset.i], id: crypto.randomUUID() } });
  };
}

function mostraConflitto(misura, c) {
  if (c.differenza === undefined) { alert('Le misure gia\' prese sono in conflitto: usa Annulla.'); return; }
  const cmDiff = Math.round(c.differenza * 1000) / 10;
  const contro = (c.misure || []).map((m) => `${nomeStanza(m.stanza)} ${fmt(m.valore)} m`).join(', ');
  const muriLiberabili = [misura.muroA, misura.muroB].filter((m) => !opzioni().liberi.includes(m));
  apriFoglio(`<h2 style="color:var(--conflitto)">Non torna di ${String(Math.abs(cmDiff)).replace('.', ',')} cm</h2>
    <p class="nota">Con questa misura (${fmt(misura.valore)} m) la ${esc(nomeStanza(misura.stanza))} sarebbe ${cmDiff > 0 ? 'piu\' lunga' : 'piu\' corta'} di quanto permettono
    ${contro ? `le misure gia' prese (${esc(contro)}) e ` : ''}i muri del perimetro. Nessuna misura e' stata cambiata.</p>
    <div class="righe">
      <button class="primario" data-az="correggi">Correggi questa misura</button>
      ${muriLiberabili.map((m) => `<button data-libero="${m}">Il muro ${esc(stanzeDelMuro(m).map((v) => v.stanza.nome).join(' / '))} ha uno spessore diverso</button>`).join('')}
      <button data-az="chiudi">Lascia stare</button>
    </div>`);
  foglio.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.libero) {
      const o = opzioni();
      const prova = geo.proponi(misura, misure(), { ...o, liberi: [...o.liberi, b.dataset.libero] });
      if (prova.conflitto) { alert('Neanche cosi\' torna: controlla la misura.'); return; }
      chiudiFoglio();
      await registra({ tipo: 'libero', muro: b.dataset.libero, acceso: true });
      return applica(misura);
    }
    if (b.dataset.az === 'correggi') {
      const s = stato.casa.stanze.find((x) => x.id === misura.stanza);
      const l = s.lati.find((x) => x.rett === misura.rett && x.tratti.some((t) => t.muro === misura.muroA) && (x.lato === 'ovest' || x.lato === 'nord'));
      return inserisciValore(s, l, misura.muroA, misura.muroB, fmt(misura.valore));
    }
    chiudiFoglio();
  };
}

// una misura (asse x o y del rettangolo k) si corregge se ha muri su entrambi i lati; si parte dal lato fatto
// di una faccia sola, cosi' chiediMisura chiede «fino a quale tratto» se e' l'altro ad averne piu' d'una
function latoDa(casaS, k, asse) {
  const nomi = asse === 'x' ? ['ovest', 'est'] : ['nord', 'sud'];
  const pezzi = nomi.map((n) => casaS.lati.filter((l) => l.rett === k && l.lato === n && l.tratti.length));
  if (pezzi.some((p) => !p.length)) return null;
  const una = pezzi.find((p) => new Set(p.flatMap((l) => l.tratti).map((t) => t.faccia.toFixed(3))).size === 1);
  return una ? una[0] : null;
}
function correggi(casaS, k, asse) {
  const l = latoDa(casaS, k, asse);
  return chiediMisura({ stanza: casaS, lato: l }, l.tratti[0].muro);
}

function foglioStanza(stanzaId) {
  const s = ris.stanze.find((x) => x.id === stanzaId);
  const alt = [...stato.operazioni].reverse().find((o) => o.tipo === 'altezza' && o.stanza === stanzaId);
  const casaS = stato.casa.stanze.find((x) => x.id === stanzaId);
  const voce = (m, k, asse) => {
    const testo = `${ASSE_NOME[asse]} <b class="${m[asse].stato}">${fmt(m[asse].valore)}</b> m`;
    return latoDa(casaS, k, asse) ? `<button data-k="${k}" data-asse="${asse}">✏️ ${testo}</button>` : `<div>${testo}</div>`;
  };
  const righe = s.misure.map((m, k) => `${s.misure.length > 1 ? `<div><b>Parte ${k + 1}</b></div>` : ''}${voce(m, k, 'x')}${voce(m, k, 'y')}`).join('');
  apriFoglio(`<h2>${esc(s.nome)}</h2><div class="righe">${righe}
    <div>Superficie ${fmt(s.area)} m²</div>
    <div>Altezza <b class="${alt ? 'misurato' : 'da_progetto'}">${fmt(alt ? alt.valore : casaS.altezza)}</b> m</div></div>
    <p class="nota">Tocca una misura per correggerla.</p>
    <div class="bottoni"><button data-az="altezza">Misura altezza</button><button data-az="chiudi">Chiudi</button></div>`);
  foglio.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.asse) {
      return correggi(casaS, +b.dataset.k, b.dataset.asse);
    }
    if (b.dataset.az !== 'altezza') return chiudiFoglio();
    apriFoglio(`<h2>Altezza di ${esc(s.nome)}</h2><input id="valore" inputmode="decimal" placeholder="es. 2,90">
      <div class="bottoni"><button class="primario" data-az="ok">OK</button><button data-az="chiudi">Annulla</button></div>`);
    $('valore').focus();
    foglio.onclick = async (e2) => {
      const b2 = e2.target.closest('button');
      if (!b2) return;
      if (b2.dataset.az !== 'ok') return chiudiFoglio();
      const v = Number($('valore').value.trim().replace(',', '.'));
      if (!(v >= 1.5 && v <= 6)) { alert('Altezza fuori misura: scrivi i metri, per esempio 2,90.'); return; }
      await registra({ tipo: 'altezza', stanza: stanzaId, valore: Math.round(v * 1000) / 1000 });
      foglioStanza(stanzaId);
    };
  };
}

// ------------------------------------------------------------------ tocco, trascinamento, zoom
const tocchi = new Map();
let gesto = null;
svg.addEventListener('pointerdown', (e) => {
  svg.setPointerCapture(e.pointerId);
  tocchi.set(e.pointerId, [e.clientX, e.clientY]);
  gesto = { inizio: [e.clientX, e.clientY], vb: { ...vb }, mosso: false, dist: tocchi.size === 2 ? distanza() : null };
});
svg.addEventListener('pointermove', (e) => {
  if (!tocchi.has(e.pointerId) || !gesto) return;
  tocchi.set(e.pointerId, [e.clientX, e.clientY]);
  if (tocchi.size === 2 && gesto.dist) { zoomA(gesto.dist / distanza(), gesto.vb); gesto.mosso = true; return; }
  const dx = e.clientX - gesto.inizio[0], dy = e.clientY - gesto.inizio[1];
  if (!gesto.mosso && Math.hypot(dx, dy) < 8) return;
  gesto.mosso = true;
  const s = pxPerM();
  vb = { ...gesto.vb, x: gesto.vb.x - dx / s, y: gesto.vb.y - dy / s };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
});
svg.addEventListener('pointerup', (e) => {
  tocchi.delete(e.pointerId);
  if (!gesto || gesto.mosso || tocchi.size) { if (!tocchi.size) gesto = null; return; }
  gesto = null;
  tocco(e.clientX, e.clientY);
});
svg.addEventListener('pointercancel', (e) => { tocchi.delete(e.pointerId); gesto = null; });
function distanza() { const [a, b] = [...tocchi.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function zoomA(f, da = vb) {
  const cx = da.x + da.w / 2, cy = da.y + da.h / 2;
  const w = Math.min(60, Math.max(1, da.w * f)), h = da.h * (w / da.w);
  vb = { x: cx - w / 2, y: cy - h / 2, w, h };
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

function tocco(px, py) {
  ultimoTocco = { x: px, y: py, t: performance.now() };
  if (!ris?.ok) return;
  const p = daSchermo(px, py);
  const q = quotaAlTocco(p);
  if (q) return correggi(q.stanza, q.k, q.asse);
  const vicini = muriAlTocco(ris.muri, p, pxPerM());
  const s = ris.stanze.find((x) => x.rettangoli.some((r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]));
  if (vicini.length === 1) return foglioMuro(vicini[0]);
  if (vicini.length > 1) { // stanza piccola o angolo: i muri e, se il tocco e' dentro una stanza, la stanza stessa
    apriFoglio(`<h2>Quale muro?</h2><div class="righe">${s ? `<button class="primario" data-az="stanza">Stanza ${esc(s.nome)}: misure</button>` : ''}${vicini.map((m, i) => `<button data-i="${i}">Muro ${esc(stanzeDelMuro(m).map((v) => v.stanza.nome).filter((v, j, a) => a.indexOf(v) === j).join(' / ') || m)}</button>`).join('')}</div>
      <div class="bottoni"><button data-az="chiudi">Annulla</button></div>`);
    foglio.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.az === 'stanza') return foglioStanza(s.id);
      if (b.dataset.az) return chiudiFoglio();
      foglioMuro(vicini[+b.dataset.i]);
    };
    return;
  }
  if (s) return foglioStanza(s.id);
  if (!foglio.hidden) chiudiFoglio();
}

$('zoomPiu').onclick = () => zoomA(0.7);
$('zoomMeno').onclick = () => zoomA(1 / 0.7);
$('annulla').onclick = annulla;
$('invia').onclick = inviaAlPC;
$('ricevuta').onclick = async () => {
  const t = prompt('Incolla qui il link della ricevuta (dal QR sul PC):');
  if (!t || !stato) return;
  try { const r = ricevutaDalLink(t.slice(t.indexOf('#'))); if (r) { await applicaRicevuta(r); await aggiornaConti(); } else alert('Non e\' un link di ricevuta.'); }
  catch (e) { alert(e.message); }
};
window.addEventListener('hashchange', async () => {
  if (!stato || !location.hash.includes('ricevuto=')) return;
  try { const r = ricevutaDalLink(location.hash); history.replaceState(null, '', location.pathname); if (r) { await applicaRicevuta(r); await aggiornaConti(); } }
  catch (e) { alert(e.message); }
});
$('apriFile').onclick = $('apriFile2').onclick = () => $('fileCasa').click();
$('fileCasa').onchange = (e) => { if (e.target.files[0]) apriFile(e.target.files[0]); e.target.value = ''; };

// gancio per i collaudi automatici (sola lettura)
window.__rilievo = { aSchermo, pxPerM, stato: () => stato, risultato: () => ris, quote: () => quote };

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
avvia();
