// Geometria della casa e ricalcolo delle misure con perimetro fermo (specs/001, research R3).
// Logica pura: nessun accesso a pagina, archivio o rete. Unita': metri; x verso est, y verso sud.
//
// Ogni muro dritto appartiene a un "gruppo" (tratti allineati, a contatto, stesso spessore e altezza) che si
// sposta tutto insieme lungo il suo asse. Ogni misura e' un vincolo esatto fra due facce e dice quale muro si
// sposta ("muove"): quel muro prende la posizione che rende la misura esatta, l'altro fa da riferimento.
// I gruppi col perimetro esterno non si spostano mai. "Spessore libero" su un muro divide il suo gruppo in
// due facce indipendenti: lo spessore diventa l'incognita che assorbe la differenza.

const EPS = 1e-6;          // m: sotto questa differenza due posizioni sono uguali (un millesimo di millimetro)
const CONFERMA = 0.005;    // m: una misura che coincide con la pianta entro mezzo centimetro la conferma, non la cambia
const ALLINEATI = 0.0101;  // m: assi entro 1 cm = stesso allineamento
const SEGNO_LATO = { ovest: '+', nord: '+', est: '-', sud: '-' }; // faccia del muro rivolta alla stanza

export function creaGeometria(casa) {
  const muri = new Map(casa.muri.map((m) => [m.id, m]));
  const lati = new Map(casa.muri.map((m) => [m.id, new Set()])); // lati del muro con una stanza interna
  for (const s of casa.stanze) {
    if (s.tipo !== 'int') continue;
    for (const l of s.lati) for (const t of l.tratti) lati.get(t.muro).add(SEGNO_LATO[l.lato]);
  }
  const esterno = (id) => lati.get(id).size < 2;

  // gruppi: union-find su tratti allineati e a contatto con stesso spessore e altezza
  const padre = new Map(casa.muri.map((m) => [m.id, m.id]));
  const radice = (id) => (padre.get(id) === id ? id : radice(padre.get(id)));
  for (const a of casa.muri) {
    for (const b of casa.muri) {
      if (a.id >= b.id || a.asse !== b.asse) continue;
      if (Math.abs(a.pos - b.pos) > ALLINEATI || a.spessore !== b.spessore || a.altezza !== b.altezza) continue;
      if (Math.min(a.a, b.a) < Math.max(a.da, b.da) - EPS) continue; // non si toccano
      padre.set(radice(a.id), radice(b.id));
    }
  }
  const gruppoDi = (id) => radice(id);
  const membri = new Map();
  for (const m of casa.muri) {
    const g = gruppoDi(m.id);
    if (!membri.has(g)) membri.set(g, []);
    membri.get(g).push(m.id);
  }

  // giunti: estremita' di un muro appoggiata su un muro perpendicolare (la segue quando quello si sposta)
  const giunti = [];
  for (const m of casa.muri) {
    for (const estremo of ['da', 'a']) {
      const v = m[estremo];
      for (const w of casa.muri) {
        if (w.asse === m.asse) continue;
        if (Math.abs(v - w.pos) <= w.spessore / 2 + 0.011 && m.pos >= w.da - EPS - w.spessore && m.pos <= w.a + EPS + w.spessore) {
          const segno = v >= w.pos ? 1 : -1;
          giunti.push({ muro: m.id, estremo, su: w.id, segno, scarto: v - (w.pos + segno * w.spessore / 2) });
          break;
        }
      }
    }
  }

  function nodo(muroId, segno, liberi) {
    const g = gruppoDi(muroId);
    return membri.get(g).some((x) => liberi.has(x)) ? `${g}:${segno}` : g;
  }
  function fisso(n, bloccati) {
    const [g, segno] = n.split(':');
    const ids = membri.get(g);
    if (ids.some((x) => bloccati.has(x))) return true;
    if (!segno) return ids.some(esterno);
    return ids.some((x) => !lati.get(x).has(segno)); // la faccia che da' sull'esterno resta ferma
  }
  const facciaBase = (muroId, segno) => {
    const m = muri.get(muroId);
    return m.pos + (segno === '+' ? 1 : -1) * m.spessore / 2;
  };

  // vincolo di una misura di distanza: d(mobile) = d(riferimento) + c
  function vincolo(mi, liberi) {
    const nA = nodo(mi.muroA, '+', liberi);
    const nB = nodo(mi.muroB, '-', liberi);
    const base = facciaBase(mi.muroB, '-') - facciaBase(mi.muroA, '+');
    const c = mi.valore - base; // dB - dA
    if (mi.muove === mi.muroB) return { mobile: nB, rif: nA, c };
    if (mi.muove === mi.muroA) return { mobile: nA, rif: nB, c: -c };
    throw new Error(`misura ${mi.id ?? ''}: "muove" deve essere muroA o muroB`);
  }

  function risolvi(tutte, opz = {}) {
    const misure = ultimePerLato(tutte);
    const liberi = new Set(opz.liberi ?? []);
    const bloccati = new Set(opz.bloccati ?? []);
    const det = new Map(); // nodo -> {rif, c, misura}
    const conflitti = [];
    for (const mi of misure) {
      if (mi.tipo !== 'distanza' || !mi.muove) continue; // senza "muove" e' una conferma: non sposta niente
      const v = vincolo(mi, liberi);
      if (fisso(v.mobile, bloccati)) { conflitti.push({ misura: mi, motivo: 'muro fermo' }); continue; }
      if (det.has(v.mobile)) { conflitti.push({ misura: mi, motivo: 'muro gia\' fissato', altra: det.get(v.mobile).misura }); continue; }
      det.set(v.mobile, { ...v, misura: mi });
    }
    const memo = new Map();
    const d = (n, visti = new Set()) => {
      if (memo.has(n)) return memo.get(n);
      if (!det.has(n)) return 0;
      if (visti.has(n)) throw new Error('ciclo');
      visti.add(n);
      const x = det.get(n);
      const val = d(x.rif, visti) + x.c;
      memo.set(n, val);
      return val;
    };
    let ciclo = false;
    try { for (const n of det.keys()) d(n); } catch { ciclo = true; }
    if (ciclo) conflitti.push({ motivo: 'ciclo di misure' });
    if (conflitti.length) return { ok: false, conflitti };

    const spost = (muroId, segno) => d(nodo(muroId, segno, liberi));
    const out = casa.muri.map((m) => {
      const fp = m.pos + m.spessore / 2 + spost(m.id, '+');
      const fm = m.pos - m.spessore / 2 + spost(m.id, '-');
      return { id: m.id, asse: m.asse, pos: (fp + fm) / 2, spessore: fp - fm, da: m.da, a: m.a, altezza: m.altezza };
    });
    const perId = new Map(out.map((m) => [m.id, m]));
    for (const gi of giunti) {
      const su = perId.get(gi.su);
      perId.get(gi.muro)[gi.estremo] = su.pos + gi.segno * su.spessore / 2 + gi.scarto;
    }
    for (const mi of misure) {
      if (mi.tipo !== 'moncone') continue;
      const stub = perId.get(mi.muro);
      const rif = perId.get(mi.riferimento);
      const segno = muri.get(mi.muro)[mi.estremo] > muri.get(mi.riferimento).pos ? 1 : -1;
      stub[mi.estremo] = rif.pos + segno * (rif.spessore / 2 + mi.valore);
    }

    const stanze = casa.stanze.map((s) => {
      const rett = s.rettangoli.map((r, k) => {
        const lato = (nome) => s.lati.find((l) => l.rett === k && l.lato === nome && l.tratti.length);
        const misurato = (asse) => misure.find((mi) => mi.tipo === 'distanza' && mi.stanza === s.id && mi.rett === k && mi.asse === asse);
        // lato misurato: il bordo e' la faccia vera del muro misurato (puo' differire dal rettangolo disegnato,
        // es. Bagno 1 ovest: tratto m0 a 5,55 contro 5,57); lato non misurato: il rettangolo segue il suo muro
        const bordo = (nome, base) => {
          const mi = misurato(nome === 'ovest' || nome === 'est' ? 'x' : 'y');
          if (mi) {
            const w = perId.get(nome === 'ovest' || nome === 'nord' ? mi.muroA : mi.muroB);
            return w.pos + (SEGNO_LATO[nome] === '+' ? 1 : -1) * w.spessore / 2;
          }
          const l = lato(nome);
          return base + (l ? spost(l.tratti[0].muro, SEGNO_LATO[nome]) : 0);
        };
        return [bordo('ovest', r[0]), bordo('nord', r[1]), bordo('est', r[2]), bordo('sud', r[3])];
      });
      const misureStanza = rett.map((r, k) => {
        const stato = (asse, nuovo, vecchio) => {
          if (misure.some((mi) => mi.tipo === 'distanza' && mi.stanza === s.id && mi.rett === k && mi.asse === asse)) return 'misurato';
          return Math.abs(nuovo - vecchio) > EPS ? 'ricalcolato' : 'da_progetto';
        };
        const r0 = s.rettangoli[k];
        const x = r[2] - r[0], y = r[3] - r[1];
        return { x: { valore: x, stato: stato('x', x, r0[2] - r0[0]) }, y: { valore: y, stato: stato('y', y, r0[3] - r0[1]) } };
      });
      const area = rett.reduce((t, r) => t + (r[2] - r[0]) * (r[3] - r[1]), 0);
      return { id: s.id, nome: s.nome, rettangoli: rett, misure: misureStanza, area };
    });
    return { ok: true, muri: out, stanze };
  }

  function proponi(mi, tutte, opz = {}) {
    const misure = ultimePerLato(tutte).filter((x) => chiaveLato(x) !== chiaveLato(mi)); // la nuova sostituisce
    const liberi = new Set(opz.liberi ?? []);
    const bloccati = new Set(opz.bloccati ?? []);
    const prima = risolvi(misure, opz);
    if (!prima.ok) return { conflitto: { motivo: 'le misure gia\' inserite sono in conflitto', ...prima } };
    const det = new Map();
    for (const x of misure) if (x.tipo === 'distanza' && x.muove) det.set(vincolo(x, liberi).mobile, x);
    const cand = [[mi.muroA, '+'], [mi.muroB, '-']];
    const liberiCand = cand.filter(([id, s]) => {
      const n = nodo(id, s, liberi);
      return !fisso(n, bloccati) && !det.has(n) && risolvi([...misure, { ...mi, muove: id }], opz).ok;
    });
    if (liberiCand.length === 1) return { muove: liberiCand[0][0] };
    if (liberiCand.length === 2) return { scegli: liberiCand.map((c) => c[0]) };
    const m = (id) => prima.muri.find((x) => x.id === id);
    const attuale = (m(mi.muroB).pos - m(mi.muroB).spessore / 2) - (m(mi.muroA).pos + m(mi.muroA).spessore / 2);
    const coinvolte = cand.map(([id, s]) => det.get(nodo(id, s, liberi))).filter(Boolean);
    if (Math.abs(mi.valore - attuale) < CONFERMA) return { conferma: true };
    return { conflitto: { differenza: Math.round((mi.valore - attuale) * 1e5) / 1e5, attuale, misure: coinvolte } };
  }

  return { casa, muro: (id) => muri.get(id), esterno, gruppoDi, risolvi, proponi };
}

const chiaveLato = (mi) => (mi.tipo === 'distanza' ? `${mi.stanza}|${mi.rett}|${mi.asse}` : `${mi.tipo}|${mi.muro}|${mi.estremo}`);
// rimisurare un lato lo corregge: conta solo l'ultima misura per lato (e per estremita' di moncone)
export function ultimePerLato(misure) {
  const ultime = new Map();
  for (const mi of misure) ultime.set(chiaveLato(mi), mi);
  return [...ultime.values()];
}

// Muri vicini a un tocco. tolleranzaPx e' quanto un polpastrello; pxPerM e' lo zoom del momento.
// Un muro solo -> [id]; piu' muri dentro la tolleranza -> tutti (l'app chiede quale); nessuno -> [].
export function muriAlTocco(muri, [x, y], pxPerM, tolleranzaPx = 24) {
  const toll = tolleranzaPx / pxPerM;
  const dist = (m) => {
    const [u, v] = m.asse === 'x' ? [x, y] : [y, x]; // u attraverso il muro, v lungo il muro
    const du = Math.max(0, Math.abs(u - m.pos) - m.spessore / 2);
    const dv = Math.max(0, m.da - v, v - m.a);
    return Math.hypot(du, dv);
  };
  const vicini = muri.map((m) => [dist(m), m.id]).filter(([dd]) => dd <= toll).sort((a, b) => a[0] - b[0]);
  const dentro = vicini.filter(([dd]) => dd === 0);
  if (dentro.length) return dentro.map((v) => v[1]);
  return vicini.map((v) => v[1]);
}
