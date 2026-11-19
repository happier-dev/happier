// Frame arithmetic extracted from the atmosphere lab mo-scenes.js / mo-scenes2.js.
// Frames describe paint operations only. Platform owners supply drawing, matrices, images and clocks.
import { createPlanetScene, PLANET_PALETTES, PLANET_SCENE_RENDERER } from './planet.mjs';
import { glyphDotRadii, placedGlyphLayer } from './glyph-scene.mjs';
const { resolve, brandDots, sceneHash: hash, digitOf, sstep, easeOut, easeInOut, crit } = PLANET_SCENE_RENDERER;
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const BODY = PLANET_PALETTES.dark.body;
const MONO = '"PlexMono", "IBM Plex Mono", ui-monospace, monospace';
const COOL = [[0, [158, 185, 255]], [0.5, [169, 140, 245]], [1, [109, 148, 255]]];
function ramp(stops, t) { t = clamp(t); for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i]; const k = (t - a) / (b - a || 1); return [mix(ca[0], cb[0], k), mix(ca[1], cb[1], k), mix(ca[2], cb[2], k)]; } return stops[stops.length - 1][1].slice(); }
const rgba = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

// Preserve the lab's drawing order as serializable data; no canvas or DOM is accessed here.
function recording() {
  const commands = []; let gradient = 0;
  const c = new Proxy({}, {
    set(_target, key, value) { commands.push(['set', key, value && typeof value === 'object' && 'gradient' in value ? { gradient: value.gradient } : value]); return true; },
    get(_target, key) {
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return (...args) => {
        const id = gradient++; commands.push([key, id, ...args]);
        return { gradient: id, addColorStop: (...stop) => commands.push(['addColorStop', id, ...stop]) };
      };
      return (...args) => commands.push([key, ...args]);
    },
  });
  return { c, commands };
}
const M = { BODY, COOL, MONO, ramp, digitOf, planet: (c, o) => c.planet(o) };
const INK = [20, 18, 24];
/** The full fine-pitch planet shared by QR folding, scan end and pairing handoff/rest. */
export const PAIRING_PLANET_LOOK = Object.freeze({ fullness: 1, style: 'balanced', pitch: 2 });
export const pairingGlyphCell = Object.freeze([6, 7]);

/** Keep the paper and modules on their original sides of the planet during the scan fold. */
export function createPairingGlyphSampler() {
  let previousKey, layer;
  return (commands, view, dpr) => {
    const index = commands.findIndex(([kind]) => kind === 'planet');
    if (index < 0) return { behind: commands, planet: null, ahead: [] };
    const { alpha = 1, ...look } = commands[index][1];
    const key = JSON.stringify([look, view.w, view.h, dpr]);
    if (key !== previousKey) {
      const { body, haze, cells } = createPlanetScene({ ...look, view, dpr });
      const packed = new Float32Array((body.length + haze.length + cells.length) * 7);
      let offset = 0;
      const append = (x, y, glyph, rgb, opacity) => {
        packed[offset++] = x; packed[offset++] = y; packed[offset++] = glyph;
        packed[offset++] = rgb[0]; packed[offset++] = rgb[1]; packed[offset++] = rgb[2]; packed[offset++] = opacity;
      };
      const dotTile = (r) => glyphDotRadii.reduce((best, radius, i) => Math.abs(radius - r) < Math.abs(glyphDotRadii[best] - r) ? i : best, 0);
      const dots = (points) => {
        for (const dot of points) {
          const tile = dotTile(dot.r);
          append(dot.x, dot.y, 21 + tile, dot.rgb, Math.min(1, dot.opacity * (dot.r / glyphDotRadii[tile]) ** 2));
        }
      };
      const digits = (over) => {
        for (const digit of cells) {
          if (digit.over !== over) continue;
          append(digit.x, digit.y, Number(digit.ch), digit.rgb, over ? Math.min(1, digit.a * (digit.cut ? 1.6 : 3.2)) : digit.a);
        }
      };
      dots(body); digits(true); dots(haze); digits(false);
      layer = placedGlyphLayer(packed);
      previousKey = key;
    }
    return { behind: commands.slice(0, index), planet: { layer, opacity: alpha }, ahead: commands.slice(index + 1) };
  };
}
export function planetCollapseCells(o) {
  const P = resolve({ cx: 0, cy: 0, ...o, ...PAIRING_PLANET_LOOK, field: 0 }, 1, { w: 1e5, h: 1e5 }); P.x0 = -Math.ceil(P.R * 1.1); P.y0 = P.x0; P.W = P.H = -2 * P.x0; P.CX = 0; P.CY = 0; P.cx = 0; P.cy = 0;
  return brandDots(P).filter((d) => !d.halo).map((d) => ({ x: d.x, y: d.y, e: 1, col: d.rgb, i: d.i + 4096, j: d.j + 4096, r: Math.hypot(d.px, d.py) }));
}
const fold = (v, lo, hi) => { if (v < lo) v = lo + (lo - v); if (v > hi) v = hi - (v - hi); return clamp(v, lo, hi); };
const QR = { T: 0.92, FLY: 0.5, SPREAD: 0.22, EYE0: 0.56, EYE: 0.32, BREAK: 0.32 };
const logo = 'happier-mark';
export function qrMomentModel(matrix, S, dpr = 1) {
  const { text, size: N, data } = matrix;
  const m = 14; const cellD = Math.floor((S - 2 * m) * dpr / N); const cell = cellD / dpr; const ox = Math.round((S - N * cell) / 2 * dpr) / dpr;
  const half = (N - 1) / 2; const hole = N >= 33 ? 3 : 2; // a 7×7 (or 5×5) centre for the Happier mark: Q (25 %) covers it
  const eye = (x, y) => (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
  const mods = []; const S2 = S;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!data[y * N + x] || eye(x, y) || (Math.abs(x - half) <= hole && Math.abs(y - half) <= hole)) continue;
    const dx = ox + (x + 0.5) * cell, dy = ox + (y + 0.5) * cell; const i = mods.length;
    // a scatter spot near its module (gaussian-ish, 30 % of the code), so flights are short and the field looks random
    const g1 = (hash(x * 3 + 1, y * 5 + 2) + hash(x + 9, y + 4) + hash(y, x + 33) - 1.5) * 0.48 * N * cell;
    const g2 = (hash(x * 7 + 3, y + 21) + hash(x + 2, y * 3 + 8) + hash(y + 5, x * 2) - 1.5) * 0.48 * N * cell;
    const sx = fold(dx + g1, 9, S2 - 9), sy = fold(dy + g2, 9, S2 - 9);
    // planet colour by position: lit gold top-right → ember → rose → blue bottom-left, like the PNG's light
    const tcol = clamp(0.12 + 0.78 * ((sy / S2) * 0.6 + (1 - sx / S2) * 0.4));
    mods.push({ x, y, dx, dy, sx, sy, d: hash(x + 13, y + 17), bit: hash(x, y + 99) < 0.5 ? '0' : '1', col: M.ramp(M.BODY, tcol), i });
  }
  // extra digits that are never modules: the field is a little denser than the code, and they evaporate
  const extra = []; for (let k = 0; k < Math.round(mods.length * 0.35); k++) { const sx = 8 + hash(k, 3) * (S2 - 16), sy = 8 + hash(k, 7) * (S2 - 16); extra.push({ sx, sy, d: hash(k, 11), bit: hash(k, 5) < 0.5 ? '0' : '1', col: M.ramp(M.BODY, clamp(0.12 + 0.78 * ((sy / S2) * 0.6 + (1 - sx / S2) * 0.4))) }); }
  const eyes = [[0, 0], [N - 7, 0], [0, N - 7]].map(([x, y]) => ({ cx: ox + (x + 3.5) * cell, cy: ox + (y + 3.5) * cell }));
  return { N, cell, ox, mods, extra, eyes, half, hole, text };
}
function paper(c, S, a = 1) { if (a <= 0) return; c.save(); c.globalAlpha = a; c.fillStyle = '#fff'; c.beginPath(); c.roundRect(0, 0, S, S, 18); c.fill(); c.restore(); }
function digit(c, ch, x, y, size, col, a) { if (a <= 0.004) return; c.font = `500 ${size}px ${M.MONO}`; c.fillStyle = rgba(col, a); c.fillText(ch, x, y); }
function sq(c, x, y, s, col, a, r = 0.22) { if (a <= 0.004 || s <= 0.2) return; c.fillStyle = rgba(col, a); c.beginPath(); c.roundRect(x - s / 2, y - s / 2, s, s, s * r); c.fill(); }
function eyeShape(c, cx, cy, cell, scale, a) {
  if (a <= 0.004) return; c.save(); c.globalAlpha = a; c.translate(cx, cy); c.scale(scale, scale); c.fillStyle = rgba(INK);
  const o = 3.5 * cell; c.beginPath(); c.roundRect(-o, -o, 2 * o, 2 * o, cell * 1.5); c.roundRect(-o + cell, -o + cell, 2 * o - 2 * cell, 2 * o - 2 * cell, cell * 0.8); c.fill('evenodd');
  c.beginPath(); c.roundRect(-1.5 * cell, -1.5 * cell, 3 * cell, 3 * cell, cell * 0.7); c.fill(); c.restore();
}
function mark(c, Q, a) {
  if (a <= 0.004) return; const S = (Q.hole * 2 + 1) * Q.cell; const cx = Q.ox + (Q.half + 0.5) * Q.cell;
  c.save(); c.globalAlpha = a; const m = S * 0.78; c.drawImage(logo, cx - m / 2, cx - m / 2, m, m); c.restore();
}
// the exact held code: pixel-snapped, nothing in flight
function qrStatic(c, Q) { for (const m of Q.mods) sq(c, m.dx, m.dy, Q.cell, INK, 1, 0.2); for (const e of Q.eyes) eyeShape(c, e.cx, e.cy, Q.cell, 1, 1); mark(c, Q, 1); }
const DIGIT_A = 0.5; // faint 0/1s on the paper
function qrAssemble(c, Q, t, srcOf) {
  if (t >= QR.T) { qrStatic(c, Q); return; }
  const cell = Q.cell; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const e of Q.extra) { const k = sstep(0.05 + e.d * 0.2, 0.35 + e.d * 0.25, t); digit(c, e.bit, e.sx, e.sy, cell * 1.55, e.col, DIGIT_A * 0.8 * (1 - k)); }
  for (const m of Q.mods) {
    const [sx, sy] = srcOf ? srcOf(m) : [m.sx, m.sy];
    const u = (t - m.d * QR.SPREAD) / QR.FLY; const k = crit(u, 6.5); const mm = sstep(0.42, 0.86, u);
    const x = mix(sx, m.dx, k), y = mix(sy, m.dy, k);
    digit(c, m.bit, x, y, cell * mix(1.55, 1, k), m.col, DIGIT_A * (1 - mm) + (1 - mm) * 0.35 * sstep(0, 0.4, u));
    sq(c, x, y, cell * mix(0.35, 1, mm), [mix(m.col[0], INK[0], mm), mix(m.col[1], INK[1], mm), mix(m.col[2], INK[2], mm)], mm);
  }
  // the finder eyes land last, whole and solid: what a scanner locks onto arrives in one piece
  const ue = (t - QR.EYE0) / QR.EYE; for (const e of Q.eyes) eyeShape(c, e.cx, e.cy, cell, mix(1.16, 1, crit(ue, 6)), sstep(0, 0.22, ue));
  mark(c, Q, sstep(0.66, 0.9, t));
}
function qrBreak(c, Q, t) { // the expiring code breaks back into digits at its scatter spots
  const cell = Q.cell; c.textAlign = 'center'; c.textBaseline = 'middle'; const u0 = t / QR.BREAK;
  for (const m of Q.mods) { const u = clamp((u0 - m.d * 0.25) / 0.75); const k = crit(u, 6); const x = mix(m.dx, m.sx, k), y = mix(m.dy, m.sy, k); const mm = 1 - sstep(0.05, 0.6, u);
    sq(c, x, y, cell * mix(0.35, 1, mm), [mix(m.col[0], INK[0], mm), mix(m.col[1], INK[1], mm), mix(m.col[2], INK[2], mm)], mm); digit(c, m.bit, x, y, cell * mix(1, 1.55, k), m.col, DIGIT_A * sstep(0.3, 1, u)); }
  for (const e of Q.eyes) eyeShape(c, e.cx, e.cy, cell, mix(1, 0.86, easeOut(u0 * 1.6)), 1 - sstep(0, 0.6, u0));
  mark(c, Q, 1 - sstep(0, 0.4, u0));
}
// the scan was observed: modules fold into the planet; the paper gives way to the card; the real planet takes over
const SCAN = { FOLD: 0.56, T: 0.9 };
function qrScan(c, Q, t, S, th, look, targets) {
  const R = S * 0.29; const cx = S / 2, cy = S / 2;
  const cells = targets || planetCollapseCells({ R, theme: th });
  // the paper contracts into the planet's disc and dissolves (no grey wash over a dark card)
  const pk = easeInOut(sstep(0.12, 0.6, t)); const pa = 1 - sstep(0.3, 0.62, t);
  if (pa > 0) { const ins = mix(0, S / 2 - R * 1.02, pk); c.save(); c.globalAlpha = pa; c.fillStyle = '#fff'; c.beginPath(); c.roundRect(ins, ins, S - 2 * ins, S - 2 * ins, mix(18, R, pk)); c.fill(); c.restore(); }
  const cross = sstep(0.5, SCAN.T, t);
  if (cross > 0) M.planet(c, { cx, cy, R, theme: th, alpha: cross, field: 0.85, ...look });
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const m of Q.mods) {
    const cl = cells[(m.i * 7919) % cells.length]; const dist = Math.hypot(m.dx - cx, m.dy - cy) / (S / 2);
    const u = clamp((t - (m.d * 0.12 + dist * 0.12)) / SCAN.FOLD); const k = crit(u, 6);
    const x = mix(m.dx, cx + cl.x, k), y = mix(m.dy, cy + cl.y, k);
    const col = [mix(INK[0], cl.col[0], sstep(0.2, 0.9, u)), mix(INK[1], cl.col[1], sstep(0.2, 0.9, u)), mix(INK[2], cl.col[2], sstep(0.2, 0.9, u))];
    sq(c, x, y, mix(Q.cell, 2.2, k), col, 1 - cross, mix(0.22, 0.1, k));
  }
  for (const e of Q.eyes) { const u = clamp(t / 0.46); const k = crit(u, 6); c.save(); c.translate(mix(e.cx, cx, k) - e.cx, mix(e.cy, cy, k) - e.cy); eyeShape(c, e.cx, e.cy, Q.cell, mix(1, 0.2, k), 1 - sstep(0.3, 1, u)); c.restore(); }
  mark(c, Q, 1 - sstep(0, 0.25, t));
}

/** Prepare once per module matrix, CSS size and DPR; callers own QR encoding and expiry. */
export function qrMomentFrame(Q, t, o) {
  const { c, commands } = recording(); const S = o.size;
  const th = o.theme || 'light'; const look = PAIRING_PLANET_LOOK;
  let held = null;
  if (o.phase === 'scan') {
    if (t < 0) { paper(c, S); qrStatic(c, Q); } else qrScan(c, Q, t, S, th, look, o.collapseTargets);
    return { commands, held };
  }
  paper(c, S);
  if (o.phase === 'reform') {
    const wait = o.wait != null ? o.wait : 0.25; const Q2 = o.next;
    if (t < 0) { qrStatic(c, Q); return { commands, held }; }
    if (t < QR.BREAK + wait) { qrBreak(c, Q, Math.min(t, QR.BREAK)); return { commands, held }; }
    const t2 = t - QR.BREAK - wait; const src = Q.mods;
    qrAssemble(c, Q2, t2, (m) => { const s = src[(m.i * 2654435761 >>> 0) % src.length]; return [s.sx, s.sy]; });
    if (t2 >= QR.T) held = Q2.text;
    return { commands, held };
  }
  if (t < 0) { qrAssemble(c, Q, -1); return { commands, held }; }
  qrAssemble(c, Q, t); if (t >= QR.T) held = Q.text;
  return { commands, held };
}
const PAIR = { HAND: 0.5, TRACE: 0.46, IGNITE0: 0.36, RING: 0.75, T: 1.15 };
export function pairingMomentFrame(t, o) {
  const { c, commands } = recording(); const { w, h } = o; const th = o.theme || 'light'; const dark = th === 'dark';
  const sq = o.layout === 'square';
  const devs = o.devices || [{ n: 'MacBook Pro' }, { n: 'devbox' }, { n: 'Studio', isNew: true }];
  // the Home hangs over its horizon like a low sun, whole (never cut into a half-blob); machines stand on the line below
  const hy = Math.round(h * (sq ? 0.75 : 0.74));
  const pr = sq ? w * 0.18 : h * 0.25; const px = w * 0.5; const pcy = sq ? h * 0.38 : h * 0.33;
  const look = { ...PAIRING_PLANET_LOOK, field: 0.9 };
  const ink = dark ? [239, 239, 239] : [34, 34, 34], text2 = dark ? [138, 129, 124] : [108, 108, 112], line = dark ? [255, 255, 255] : [0, 0, 0];
  // positions: wide → to the right of the planet; square → either side of it
  const xs = devs.map((_, i) => w * (sq ? 0.2 + i * 0.3 : 0.2 + i * 0.3));
  let phase = o.phase || 'joined'; if (phase === 'joined' && t < 0) phase = 'adding';
  const hk = phase === 'handoff' ? clamp(t / PAIR.HAND) : 1; const hke = crit(hk, 6);
  // the horizon: a hairline that draws outward from the planet
  const hw = w * 0.5 * hke + 2; c.save();
  const g = c.createLinearGradient(px - w, 0, px + w, 0); const la = dark ? 0.16 : 0.14;
  g.addColorStop(0, rgba(line, 0)); g.addColorStop(0.3, rgba(line, la)); g.addColorStop(0.7, rgba(line, la)); g.addColorStop(1, rgba(line, 0));
  c.fillStyle = g; c.fillRect(Math.max(0, px - hw), hy, Math.min(w, hw * 2), 1); c.restore();
  // the Home: our planet, risen half over the horizon (from the QR it slides down from the centre of the block)
  const cy0 = h * 0.5, R0 = w * 0.29; // where the QR collapse left it
  const cyp = phase === 'handoff' ? mix(cy0, pcy, hke) : pcy, Rp = phase === 'handoff' ? mix(R0, pr, hke) : pr;
  M.planet(c, { cx: px, cy: cyp, R: Rp, theme: th, ...look });
  // machines: points of light standing on the horizon
  const lit = [255, 196, 92];
  c.textAlign = 'center'; c.textBaseline = 'top';
  devs.forEach((d, i) => {
    const x = xs[i]; const appear = phase === 'handoff' ? sstep(0.35 + i * 0.12, 0.7 + i * 0.12, hk) : 1; if (appear <= 0) return;
    const isNew = !!d.isNew; c.save(); c.globalAlpha = appear;
    if (!isNew) {
      c.fillStyle = rgba(dark ? [236, 220, 190] : [70, 62, 54], 0.85); c.fillRect(Math.round(x) - 2, Math.round(hy) - 5, 4, 4);
      c.font = '500 11.5px InterLab, system-ui'; c.fillStyle = rgba(text2); c.fillText(d.n, x, hy + 9);
    } else if (phase !== 'joined') {
      c.strokeStyle = rgba(text2, 0.7); c.lineWidth = 1; c.setLineDash([1.5, 2]); c.beginPath(); c.arc(x, hy - 3, 4.5, 0, 6.283); c.stroke(); c.setLineDash([]);
      c.font = '500 11.5px InterLab, system-ui'; c.fillStyle = rgba(text2); c.fillText(phase === 'adding' ? `Adding ${d.n}…` : d.n, x, hy + 9);
    } else {
      // confirmed: a trace from the Home to the new point, the point ignites, a ring of digits answers
      const head = easeOut(clamp(t / PAIR.TRACE)); const fade = 1 - sstep(0.5, 1.0, t);
      const ang = Math.atan2(hy - pcy, x - px); const ax = px + Math.cos(ang) * pr * 1.08, ay = pcy + Math.sin(ang) * pr * 1.08; const bx = x, by = hy - 6; const mx = (ax + bx) / 2 + (x > px ? 1 : -1) * w * 0.04, my = (ay + by) / 2 - h * 0.06;
      const nd = sq ? 26 : 40;
      for (let k = 0; k <= nd; k++) { const u = k / nd; if (u > head) break; const a = sstep(head - 0.4, head, u) * fade * 0.9; if (a <= 0.01) continue;
        const qx = (1 - u) * (1 - u) * ax + 2 * u * (1 - u) * mx + u * u * bx, qy = (1 - u) * (1 - u) * ay + 2 * u * (1 - u) * my + u * u * by;
        c.fillStyle = rgba(M.ramp(M.BODY, 0.1 + u * 0.3), a); c.fillRect(Math.round(qx) - 1, Math.round(qy) - 1, 2, 2); }
      const ig = crit((t - PAIR.IGNITE0) / 0.34, 6); const igA = sstep(0, 0.2, (t - PAIR.IGNITE0) / 0.34);
      if (igA > 0) {
        const gl = c.createRadialGradient(x, hy - 3, 0, x, hy - 3, 16); gl.addColorStop(0, rgba(lit, (dark ? 0.42 : 0.34) * igA)); gl.addColorStop(1, rgba(lit, 0)); c.fillStyle = gl; c.fillRect(x - 16, hy - 19, 32, 32);
        const s = 5 * ig; c.fillStyle = rgba(dark ? [255, 206, 112] : [236, 150, 40], igA); c.fillRect(x - s / 2, hy - 3 - s / 2, s, s);
      }
      const ru = clamp((t - PAIR.IGNITE0 - 0.04) / PAIR.RING); if (ru > 0 && ru < 1) { c.font = `500 9px ${M.MONO}`; c.textBaseline = 'middle';
        for (let k = 0; k < 9; k++) { const a = -Math.PI * (0.08 + 0.84 * (k / 8)); const rr = mix(7, sq ? 22 : 28, easeOut(ru)); c.fillStyle = rgba(M.ramp(M.BODY, 0.08 + (k / 8) * 0.4), (1 - ru) * 0.85); c.fillText(String(M.digitOf(k, 3)), x + Math.cos(a) * rr, hy - 3 + Math.sin(a) * rr); }
        c.textBaseline = 'top'; }
      const lu = sstep(0.5, 0.82, t); c.font = `${lu > 0.5 ? 600 : 500} 11.5px InterLab, system-ui`;
      c.fillStyle = rgba([mix(text2[0], ink[0], lu), mix(text2[1], ink[1], lu), mix(text2[2], ink[2], lu)]); c.fillText(d.n, x, hy + 9);
    }
    c.restore();
  });
  return commands;
}
const TH = { DUR: 1.2 };
const themeRevealProgress = (time) => easeInOut(clamp(time / TH.DUR));
const themeRevealClip = (progress, edge) => progress <= 0 ? 'circle(0px at 0 0)' : progress >= 1 ? 'none' : edge.clip;
function boundary(kind, dir, k, w, h) {
  const light = dir === 'sunrise';
  if (kind === 'horizon') {
    const Rh = w * 1.5, cx = w * 0.56; const half = Math.max(cx, w - cx); const reach = Math.sqrt(Rh * Rh - half * half);
    // light rises from below until the top corners are inside; night descends until the bottom corners are
    let cy; if (light) cy = mix(h + Rh, reach - 12, k); else cy = mix(-Rh, h - reach + 12, k);
    return { clip: `circle(${Rh}px at ${cx}px ${cy}px)`, d: (x, y) => Math.hypot(x - cx, y - cy) - Rh, cx, cy, R: Rh };
  }
  if (kind === 'radial') {
    const sx = light ? w * 0.86 : w * 0.12, sy = light ? h * 0.9 : h * 0.1; const r = k * Math.hypot(w, h) * 1.02;
    return { clip: `circle(${r}px at ${sx}px ${sy}px)`, d: (x, y) => Math.hypot(x - sx, y - sy) - r, cx: sx, cy: sy, R: r };
  }
  const sl = 0.35 * h; const x = mix(-sl - 40, w + sl + 40, k);
  return { clip: `polygon(0 0, ${x + sl}px 0, ${x - sl}px ${h}px, 0 ${h}px)`, d: (px, py) => (px - (x + sl - (py / h) * 2 * sl)) * 0.94, line: true };
}
export function themeHorizonClip(time, { w, h, dir = 'sunrise' }) {
  const progress = themeRevealProgress(time);
  return themeRevealClip(progress, boundary('horizon', dir, progress, w, h));
}
const THEME_HORIZON_PITCH = 13;
export const themeHorizonGlyphCell = Object.freeze([THEME_HORIZON_PITCH * 0.62, THEME_HORIZON_PITCH * 0.8 / 0.94]);
export function createThemeHorizonGlyphSampler() {
  let cells = new Float32Array(0);
  return function themeHorizonGlyphFrame(t, o, ink) {
    const pitch = o.dp || THEME_HORIZON_PITCH;
    const capacity = Math.ceil(o.w / (pitch * 0.62)) * Math.ceil(o.h / pitch) * 7;
    if (capacity > cells.length) cells = new Float32Array(capacity);
    let end = 0;
    const frame = themeSwitchFrame(t, o, (x, y, digit, colour, alpha) => {
      cells[end++] = x; cells[end++] = y; cells[end++] = digit;
      cells[end++] = colour[0]; cells[end++] = colour[1]; cells[end++] = colour[2]; cells[end++] = alpha;
    }, ink);
    return { ...frame, glyphs: placedGlyphLayer(cells.subarray(0, end)) };
  };
}

export function themeSwitchFrame(t, o, placeGlyph, glyphInk) {
    const { c, commands } = recording(); const { w: W, h: H } = o; const dir = o.dir || 'sunrise';
    const k = themeRevealProgress(t);
    const B = boundary(o.kind || 'horizon', dir, k, W, H);
    const clipPath = themeRevealClip(k, B); const visibility = k <= 0 ? 'hidden' : 'visible';
    const w = W, h = H; if (k <= 0 || k >= 1) return { commands, clipPath, visibility };
    const band = Math.pow(Math.sin(Math.PI * k), 0.6);
    const warm = dir === 'sunrise'; const stops = warm ? M.BODY : M.COOL;
    // 1 · the light arriving: a soft glow along the boundary (inside a thin band only)
    if (!B.line) { const g = c.createRadialGradient(B.cx, B.cy, Math.max(0, B.R - 120), B.cx, B.cy, B.R + 40);
      const gc = warm ? [255, 176, 84] : [120, 150, 255]; g.addColorStop(0, rgba(gc, 0)); g.addColorStop(0.68, rgba(gc, 0.2 * band)); g.addColorStop(0.75, rgba(warm ? [255, 232, 196] : [210, 220, 255], 0.16 * band)); g.addColorStop(1, rgba(gc, 0));
      c.fillStyle = g; c.fillRect(0, 0, w, h); }
    // 2 · the limb itself, drawn in fine dots of the planet's colours (warm at sunrise, cool at nightfall)
    if (!B.line && o.kind !== 'radial') { const step = 3 / B.R; const a0 = -Math.PI / 2 - Math.asin(Math.min(1, (w * 0.7) / B.R)), a1 = -Math.PI / 2 + Math.asin(Math.min(1, (w * 0.7) / B.R));
      const sgn = dir === 'sunrise' ? 1 : -1;
      for (let a = a0; a <= a1; a += step) { const x = B.cx + Math.cos(a) * B.R * sgn * (sgn < 0 ? -1 : 1), y = B.cy + Math.sin(a) * B.R * sgn; if (x < -4 || x > w + 4 || y < -4 || y > h + 4) continue;
        const tt = clamp(0.06 + (x / w) * 0.45); c.fillStyle = rgba(M.ramp(stops, warm ? 0.5 - tt : tt), 0.9 * band); c.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); } }
    // 3 · the wavefront of typewriter digits on a fixed grid, densest just inside the new theme
    // With the destination theme's ink the digits read on whatever it paints; without it, the lab's planet colours.
    const dp = o.dp || THEME_HORIZON_PITCH, cw = dp * 0.62;
    if (!placeGlyph) { c.font = `500 ${dp * 0.8}px ${M.MONO}`; c.textAlign = 'center'; c.textBaseline = 'middle'; }
    if (o.ink && !placeGlyph) c.fillStyle = o.ink;
    const nx = Math.ceil(w / cw), ny = Math.ceil(h / dp); const depth = o.depth || 120;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (i & 1) continue; // digit, space: single digits on the typewriter grid, like the engine's field (no clumps)
      const x = (i + 0.5) * cw, y = (j + 0.5) * dp; const d = B.d(x, y); if (d > 26 || d < -depth) continue;
      const f = d > 0 ? Math.exp(-d / 9) : Math.exp(d / (depth * 0.38)); const dens = 0.24 + 0.7 * f; if (hash(i, j + 77) > dens) continue;
      const a = band * f * (0.45 + 0.55 * hash(i + 9, j)); if (a < 0.03) continue;
      const digit = M.digitOf(i, j, t, 14);
      if (placeGlyph && glyphInk) { placeGlyph(x, y, digit, glyphInk, clamp(a)); continue; }
      if (o.ink && !placeGlyph) c.globalAlpha = clamp(a);
      else {
        const tc = clamp(warm ? 0.08 + (-d / depth) * 0.55 + hash(i, j) * 0.12 : (-d / depth) * 0.8 + hash(i, j) * 0.15);
        const colour = M.ramp(stops, tc);
        if (placeGlyph) { placeGlyph(x, y, digit, colour, clamp(a)); continue; }
        c.fillStyle = rgba(colour, clamp(a));
      }
      c.fillText(String(digit), x, y);
    }
    if (o.ink && !placeGlyph) c.globalAlpha = 1;
    return { commands, clipPath, visibility };
}

const RIP = { DUR: 1.6 };
/** How long each trigger's window lasts once a moment is admitted: finishes merge, the resettle waits an hour. */
export const MOMENT_TRIGGER_WINDOWS_MS = Object.freeze({ ripple: 8000, resettle: 3600000 });
const RESETTLE = { DUR: 1.8 };
export const FURTHER_PLANET_MOMENT_TIMINGS = { QR, SCAN, PAIR, TH, RIP, RESETTLE };
/** The ring pixels remain owned by atmosphereRipple; this frame adds the lab's planet gain only. */
export function sessionFinishedRippleFrame(t, o) {
  const { w } = o; const th = o.theme || 'light';
  const px = w - (o.px || 64), py = o.py || 64, R = o.R || 34; const u = clamp(t / RIP.DUR);
  const gain = t >= 0 ? 1 + 0.22 * (1 - sstep(0.1, 0.7, u)) * sstep(0, 0.08, u) : 1;
  return { planet: { cx: px, cy: py, R, theme: th, gain, field: 0.9, fieldDp: 9 }, ringProgress: t > 0 && t < RIP.DUR ? u : null };
}
/** Suppressed finishes merge into the current answer; they do not queue another timer or extend its window. */
export function sessionFinishedRippleTrigger({ nowMs, lastTriggeredAtMs, wasFinished, turnComplete, pendingApproval, homeVisible }) {
  const trigger = !wasFinished && turnComplete && !pendingApproval && homeVisible && (lastTriggeredAtMs === null || nowMs - lastTriggeredAtMs >= MOMENT_TRIGGER_WINDOWS_MS.ripple);
  return { trigger, lastTriggeredAtMs: trigger ? nowMs : lastTriggeredAtMs };
}
/** The caller's Home lifecycle owns idle/visibility and retains the last admitted time. */
export function idleResettleTrigger({ nowMs, lastTriggeredAtMs, homeIdle, homeVisible }) {
  const trigger = homeIdle && homeVisible && (lastTriggeredAtMs === null || nowMs - lastTriggeredAtMs >= MOMENT_TRIGGER_WINDOWS_MS.resettle);
  return { trigger, lastTriggeredAtMs: trigger ? nowMs : lastTriggeredAtMs };
}
