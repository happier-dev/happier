/** Portable Bot outline grammar and fixed 256² field. Shared by face Action admission and every renderer. */
export type BotFaceBodyArt = Readonly<{
  fill: readonly string[];
  stroke?: readonly (readonly [string, number])[];
  cut?: readonly (string | readonly [string, number])[];
  mouth: readonly [number, number, number];
}>;
/** Grid size and extent of the field; model = (source − centre) / U, so the logo's 90 units span 1.6 model units. */
const N = 256;
export const BOT_FACE_FIELD_EXTENT = 1.5;
const EXT = BOT_FACE_FIELD_EXTENT;
export const BOT_FACE_UNIT = 56.25;
const U = BOT_FACE_UNIT;
/** The slab: half-thickness WALL, rounded edges of radius RIM; DEPTH is the front face's z. */
export const BOT_FACE_RIM = 0.15,
  BOT_FACE_WALL = 0.22,
  BOT_FACE_DEPTH = BOT_FACE_RIM + BOT_FACE_WALL;

export type BotFaceGeometry = Readonly<{
  sdf: Float32Array;
  /** Vertical centre used, in source units. */
  cy: number;
  top: number;
  bot: number;
  hw: number;
  ext: number;
  mouth: Readonly<{ cx: number; y: number; s: number }>;
}>;

/* ═══ SVG path → polylines (M L C Q A Z, absolute and relative) ═══ */
type Poly = { pts: number[]; closed: boolean };
const PATH_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, C: 6, Q: 4, A: 7, Z: 0 };
type PathSegment = Readonly<{ command: string; values: readonly number[] }>;

/** Exact grammar of the geometry owner; reject unsupported commands instead of silently dropping them. */
function parsePath(d: string): PathSegment[] {
  const tokens: string[] = [];
  const pattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  let end = 0;
  for (const match of d.matchAll(pattern)) {
    if (!/^[\s,]*$/.test(d.slice(end, match.index))) throw new Error('Invalid path token');
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(d.slice(end)) || !tokens.length) throw new Error('Empty or invalid path');
  const segments: PathSegment[] = [];
  let i = 0, command = '';
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) command = tokens[i++];
    const upper = command.toUpperCase(), arity = PATH_ARITY[upper];
    if (arity === undefined || (!segments.length && upper !== 'M')) throw new Error('Path commands must be M L C Q A Z');
    if (arity === 0) { segments.push({ command, values: [] }); command = ''; continue; }
    const values = tokens.slice(i, i + arity).map(Number);
    if (values.length !== arity || values.some(v => !Number.isFinite(v))) throw new Error('Path requires finite numbers');
    if (upper === 'A' && (values[0] < 0 || values[1] < 0 || ![0, 1].includes(values[3]) || ![0, 1].includes(values[4]))) throw new Error('Invalid arc');
    i += arity;
    segments.push({ command, values });
    if (upper === 'M') command = command === 'm' ? 'l' : 'L';
  }
  return segments;
}

/** Stable content key, including the mouth anchor; caller labels never select geometry. */
const ART_HASHES = new WeakMap<BotFaceBodyArt, string>();
export function botFaceArtHash(art: BotFaceBodyArt): string {
  const known = ART_HASHES.get(art);
  if (known) return known;
  const data = JSON.stringify([art.fill, art.stroke ?? [], art.cut ?? [], art.mouth]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < data.length; i++) { const c = data.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b, 33) ^ c; }
  const hash = `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
  ART_HASHES.set(art, hash);
  return hash;
}

export function botFaceArtBounds(art: BotFaceBodyArt) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const add = (d: string, pad: number) => {
    for (const poly of flatten(d)) for (let i = 0; i < poly.pts.length; i += 2) {
      x0 = Math.min(x0, poly.pts[i] - pad); x1 = Math.max(x1, poly.pts[i] + pad);
      y0 = Math.min(y0, poly.pts[i + 1] - pad); y1 = Math.max(y1, poly.pts[i + 1] + pad);
    }
  };
  for (const path of art.fill) add(path, 0);
  for (const [path, width] of art.stroke ?? []) add(path, width / 2);
  return { x0, x1, y0, y1 };
}

export function translateBotFacePath(d: string, dx: number): string {
  return parsePath(d).map(({ command, values }, i) => {
    const absolute = command === command.toUpperCase() || (i === 0 && command === 'm');
    const shifted = values.map((v, k) => absolute && (command.toUpperCase() === 'A' ? k === 5 : k % 2 === 0) ? v + dx : v);
    return `${command}${shifted.join(' ')}`;
  }).join(' ');
}

export function isClosedBotFacePath(d: string): boolean {
  const polys = flatten(d);
  return polys.length > 0 && polys.every(poly => poly.closed);
}

function flatten(d: string): Poly[] {
  const tokens = parsePath(d).flatMap(segment => [segment.command, ...segment.values.map(String)]);
  const out: Poly[] = [];
  let cur: Poly | null = null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  let cmd = '';
  let i = 0;
  const num = () => Number(tokens[i++]);
  const line = (nx: number, ny: number) => {
    cur!.pts.push(nx, ny);
    x = nx;
    y = ny;
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0,
      oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num() + ox,
          ny = num() + oy;
        cur = { pts: [nx, ny], closed: false };
        out.push(cur);
        x = sx = nx;
        y = sy = ny;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        line(num() + ox, num() + oy);
        break;
      case 'C': {
        const x1 = num() + ox,
          y1 = num() + oy,
          x2 = num() + ox,
          y2 = num() + oy,
          x3 = num() + ox,
          y3 = num() + oy;
        const x0 = x,
          y0 = y;
        for (let k = 1; k <= 16; k++) {
          const t = k / 16,
            u = 1 - t;
          line(
            u * u * u * x0 +
              3 * u * u * t * x1 +
              3 * u * t * t * x2 +
              t * t * t * x3,
            u * u * u * y0 +
              3 * u * u * t * y1 +
              3 * u * t * t * y2 +
              t * t * t * y3,
          );
        }
        break;
      }
      case 'Q': {
        const x1 = num() + ox,
          y1 = num() + oy,
          x2 = num() + ox,
          y2 = num() + oy;
        const x0 = x,
          y0 = y;
        for (let k = 1; k <= 12; k++) {
          const t = k / 12,
            u = 1 - t;
          line(
            u * u * x0 + 2 * u * t * x1 + t * t * x2,
            u * u * y0 + 2 * u * t * y1 + t * t * y2,
          );
        }
        break;
      }
      case 'A': {
        const rx0 = num(),
          ry0 = num(),
          phi = (num() * Math.PI) / 180,
          large = num() !== 0,
          sweep = num() !== 0,
          x2 = num() + ox,
          y2 = num() + oy;
        arc(x, y, rx0, ry0, phi, large, sweep, x2, y2, line);
        break;
      }
      case 'Z':
        if (cur) {
          cur.closed = true;
          x = sx;
          y = sy;
        }
        break;
      default:
        i++;
    }
  }
  return out.filter((p) => p.pts.length >= 4);
}

/** SVG endpoint arc → centre parameterisation (SVG 1.1 F.6.5), sampled at ~48 steps per turn. */
function arc(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phi: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  line: (x: number, y: number) => void,
) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) { line(x2, y2); return; }
  const c = Math.cos(phi),
    s = Math.sin(phi);
  const dx = (x1 - x2) / 2,
    dy = (y1 - y2) / 2;
  const xp = c * dx + s * dy,
    yp = -s * dx + c * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * yp) / ry,
    cyp = (-k * ry * xp) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2,
    cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang(
    (xp - cxp) / rx,
    (yp - cyp) / ry,
    (-xp - cxp) / rx,
    (-yp - cyp) / ry,
  );
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * 48));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t),
      ey = ry * Math.sin(t);
    line(c * ex - s * ey + cx, s * ex + c * ey + cy);
  }
}

/* ═══ raster: pixel centres inside the body (fills ∪ strokes, minus cuts) ═══ */
type Prepared = {
  fills: Poly[][];
  strokes: { polys: Poly[]; w: number }[];
  cuts: { polys: Poly[]; w: number | null }[];
};
function prepare(body: BotFaceBodyArt): Prepared {
  return {
    fills: body.fill.map(flatten),
    strokes: (body.stroke ?? []).map(([p, w]) => ({ polys: flatten(p), w })),
    cuts: (body.cut ?? []).map((c) =>
      typeof c === 'string'
        ? { polys: flatten(c), w: null }
        : { polys: flatten(c[0]), w: c[1] },
    ),
  };
}
/** Even-odd scanline fill of closed polygons into `mask` (value `v`), at pixel centres. */
function fillPolys(
  mask: Uint8Array,
  polys: Poly[],
  toPx: (sx: number, sy: number) => [number, number],
  v: 0 | 1,
) {
  const edges: number[] = [];
  for (const p of polys) {
    const n = p.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = toPx(p.pts[i * 2], p.pts[i * 2 + 1]),
        b = toPx(p.pts[j * 2], p.pts[j * 2 + 1]);
      edges.push(a[0], a[1], b[0], b[1]);
    }
  }
  const xs: number[] = [];
  for (let row = 0; row < N; row++) {
    const yc = row + 0.5;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ay = edges[e + 1],
        by = edges[e + 3];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc))
        xs.push(edges[e] + ((yc - ay) / (by - ay)) * (edges[e + 2] - edges[e]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)),
        x1 = Math.min(N - 1, Math.floor(xs[k + 1] - 0.5));
      for (let col = x0; col <= x1; col++) mask[row * N + col] = v;
    }
  }
}
/** Round-capped strokes: every pixel centre within half the width of a segment. */
function strokePolys(
  mask: Uint8Array,
  polys: Poly[],
  halfPx: number,
  toPx: (sx: number, sy: number) => [number, number],
  v: 0 | 1,
) {
  for (const p of polys) {
    const n = p.pts.length / 2;
    const segs = p.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = toPx(p.pts[i * 2], p.pts[i * 2 + 1]),
        b = toPx(p.pts[((i + 1) % n) * 2], p.pts[((i + 1) % n) * 2 + 1]);
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - halfPx)),
        x1 = Math.min(N - 1, Math.ceil(Math.max(a[0], b[0]) + halfPx));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - halfPx)),
        y1 = Math.min(N - 1, Math.ceil(Math.max(a[1], b[1]) + halfPx));
      const vx = b[0] - a[0],
        vy = b[1] - a[1],
        vv = Math.max(vx * vx + vy * vy, 1e-9);
      for (let row = y0; row <= y1; row++)
        for (let col = x0; col <= x1; col++) {
          const px = col + 0.5 - a[0],
            py = row + 0.5 - a[1];
          const h = Math.min(1, Math.max(0, (px * vx + py * vy) / vv));
          const ex = px - vx * h,
            ey = py - vy * h;
          if (ex * ex + ey * ey <= halfPx * halfPx) mask[row * N + col] = v;
        }
    }
  }
}
function raster(prep: Prepared, cy: number): Uint8Array {
  const k = N / (2 * EXT * U);
  const mask = new Uint8Array(N * N);
  const toPx = (sx: number, sy: number): [number, number] => [
    (sx - 45) * k + N / 2,
    (sy - cy) * k + N / 2,
  ];
  const scratch = new Uint8Array(N * N);
  for (const polys of prep.fills) {
    scratch.fill(0);
    fillPolys(scratch, polys, toPx, 1);
    for (let i = 0; i < mask.length; i++) mask[i] |= scratch[i];
  }
  for (const s of prep.strokes)
    strokePolys(mask, s.polys, (s.w / 2) * k, toPx, 1);
  for (const c of prep.cuts) {
    if (c.w === null) {
      scratch.fill(0);
      fillPolys(scratch, c.polys, toPx, 1);
      for (let i = 0; i < mask.length; i++) if (scratch[i]) mask[i] = 0;
    } else strokePolys(mask, c.polys, (c.w / 2) * k, toPx, 0);
  }
  return mask;
}

/* ═══ exact Euclidean distance transform (Felzenszwalb), as the lab ═══ */
function edt1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
) {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
function edt(g: Float64Array) {
  const f = new Float64Array(N),
    d = new Float64Array(N),
    v = new Int32Array(N),
    z = new Float64Array(N + 1);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) f[y] = g[y * N + x];
    edt1d(f, N, d, v, z);
    for (let y = 0; y < N; y++) g[y * N + x] = d[y];
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) f[x] = g[y * N + x];
    edt1d(f, N, d, v, z);
    for (let x = 0; x < N; x++) g[y * N + x] = d[x];
  }
}

function rows(m: Uint8Array) {
  let y0 = N,
    y1 = -1,
    x0 = N,
    x1 = -1;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (m[y * N + x]) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  return { y0, y1, x0, x1 };
}

/** The vertical centre (source units) of an unhinted silhouette: hero and list forms of one body share it. */
function silhouetteCentre(prep: ReturnType<typeof prepare>): number {
  const toSrc = (t: number) => (t * ((2 * EXT) / N) - EXT) * U;
  const b = rows(raster(prep, 45));
  return 45 + (toSrc(b.y0) + toSrc(b.y1 + 1)) / 2;
}
export function createBotFaceGeometry(
  body: BotFaceBodyArt,
  /** A limb pose sits where its body does: centre it on that body's silhouette (lab `cyOf`). */
  centreOf?: BotFaceGeometry,
): BotFaceGeometry {
  const tx = (2 * EXT) / N;
  const toSrc = (t: number) => (t * tx - EXT) * U;
  // The body is centred vertically on its unhinted silhouette, so a hinted list form sits exactly where its hero does.
  const prep = prepare(body);
  // A list form only needs its body's centre, not that body's whole field.
  const cy = centreOf?.cy ?? silhouetteCentre(prep);
  const m = raster(prep, cy);
  const gi = new Float64Array(N * N),
    go = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    go[i] = m[i] ? 0 : 1e20;
    gi[i] = m[i] ? 1e20 : 0;
  }
  edt(go);
  edt(gi);
  const sdf = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++)
    sdf[i] = (m[i] ? -(Math.sqrt(gi[i]) - 0.5) : Math.sqrt(go[i]) - 0.5) * tx;
  const b = rows(m);
  const top = b.y0 * tx - EXT,
    bot = (b.y1 + 1) * tx - EXT,
    hw = ((b.x1 - b.x0 + 1) * tx) / 2;
  const [mcx, my, ms] = body.mouth;
  const geometry: BotFaceGeometry = {
    sdf,
    cy,
    top,
    bot,
    hw,
    ext: Math.max(bot, -top, hw),
    mouth: { cx: (mcx - 45) / U, y: (my - cy) / U, s: ms },
  };
  return geometry;
}
/** Bilinear sample of the field (model units); outside the grid the distance grows with the overshoot. */
export function botFaceSd(G: BotFaceGeometry, x: number, y: number): number {
  const ux = x / (2 * EXT) + 0.5,
    uy = y / (2 * EXT) + 0.5;
  const cx = Math.min(1, Math.max(0, ux)),
    cy = Math.min(1, Math.max(0, uy));
  const over = Math.hypot((ux - cx) * 2 * EXT, (uy - cy) * 2 * EXT);
  const fx = cx * N - 0.5,
    fy = cy * N - 0.5;
  const ix = Math.max(0, Math.min(N - 2, Math.floor(fx))),
    iy = Math.max(0, Math.min(N - 2, Math.floor(fy)));
  const ax = Math.min(1, Math.max(0, fx - ix)),
    ay = Math.min(1, Math.max(0, fy - iy));
  const s = G.sdf;
  const top = s[iy * N + ix] + (s[iy * N + ix + 1] - s[iy * N + ix]) * ax;
  const bottom =
    s[(iy + 1) * N + ix] +
    (s[(iy + 1) * N + ix + 1] - s[(iy + 1) * N + ix]) * ax;
  return top + (bottom - top) * ay + over;
}
/** The slab's front surface height at (x, y): flat face, rounded rim, zero outside. */
export function botFaceZ(G: BotFaceGeometry, x: number, y: number): number {
  const e = botFaceSd(G, x, y) + BOT_FACE_RIM;
  return e <= 0
    ? BOT_FACE_DEPTH
    : e < BOT_FACE_RIM
      ? BOT_FACE_WALL + Math.sqrt(BOT_FACE_RIM * BOT_FACE_RIM - e * e)
      : 0;
}
/** The normal's finite-difference step (model units). */
export const BOT_FACE_NORMAL_STEP = 0.03;
/** The front surface's normal (y down, z toward the viewer). */
export function botFaceNormal(
  G: BotFaceGeometry,
  x: number,
  y: number,
): [number, number, number] {
  const e = BOT_FACE_NORMAL_STEP;
  const zx = (botFaceZ(G, x + e, y) - botFaceZ(G, x - e, y)) / (2 * e),
    zy = (botFaceZ(G, x, y + e) - botFaceZ(G, x, y - e)) / (2 * e);
  const l = Math.hypot(zx, zy, 1);
  return [-zx / l, -zy / l, 1 / l];
}

/* ═══ the mouth: one polyline per state (smile → "…" → "o" → grin); working is three dots (lab R9) ═══ */
export type BotFaceMood = 'quiet' | 'working' | 'needsYou' | 'done' | 'failed';
export type BotFaceMouth = Readonly<{
  w: number; d: number; o: number; y: number;
  /** A dotted mouth: this many dots spread across the mouth's width, drawn as one-point strokes ("…", working). */
  dots?: number;
  /** Per-dot lift in mouth units (the mutter raises one dot at a time). */
  lift?: readonly number[];
}>;
type Mouth = BotFaceMouth;
export const BOT_FACE_MOUTHS: Readonly<Record<BotFaceMood, Mouth>> = {
  quiet: { w: 1, d: 1, o: 0, y: 0 },
  working: { w: 1.1, d: 0.42, o: 0, y: -0.01, dots: 3 },
  needsYou: { w: 1, d: 1, o: 1, y: -0.03 },
  done: { w: 1.14, d: 1.5, o: 0, y: 0 },
  failed: { w: 0.62, d: 0.12, o: 0, y: 0.035 },
};
/** The mouth as 16 points (a smile uses points 0–10; the "o" all 16), in model units. */
export function botFaceMouthPoints(
  G: BotFaceGeometry,
  m: Mouth,
): [number, number][] {
  const hw = (25.1 / U) * G.mouth.s * m.w,
    dep = (14.5 / U) * G.mouth.s * m.d,
    cyy = dep / 0.75,
    x0 = G.mouth.cx,
    y0 = G.mouth.y + m.y;
  const sm: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10,
      u = 1 - t;
    sm.push([
      x0 +
        (u * u * u * -hw +
          3 * u * u * t * -hw * 0.745 +
          3 * u * t * t * hw * 0.745 +
          t * t * t * hw),
      y0 + 3 * u * t * (u + t) * cyy,
    ]);
  }
  for (let i = 11; i < 16; i++) sm.push([sm[10][0], sm[10][1]]);
  const rx = (8.5 / U) * G.mouth.s,
    ry = (9.6 / U) * G.mouth.s,
    oy = y0 + (7.5 / U) * G.mouth.s;
  const out: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const a =
      i <= 10 ? Math.PI - (i / 10) * Math.PI : -((i - 10) / 5) * Math.PI;
    out.push([
      sm[i][0] + (x0 + Math.cos(a) * rx - sm[i][0]) * m.o,
      sm[i][1] + (oy + Math.sin(a) * ry - sm[i][1]) * m.o,
    ]);
  }
  return out;
}
export const botFaceMouthLine = (pts: [number, number][], o: number) =>
  pts.slice(0, o > 0.02 ? 16 : 11);
/**
 * The mouth as strokes, in model units: the one polyline of a smile, line, "o" or grin, or one single-point stroke per
 * dot of a dotted mouth. A dot sits `dep × 0.55` below the mouth line and rises 9 mouth units per unit of `lift`.
 * Every renderer and outline check walks these strokes, so dots never join into a bar.
 */
export function botFaceMouthStrokes(G: BotFaceGeometry, m: Mouth): [number, number][][] {
  if (!m.dots) return [botFaceMouthLine(botFaceMouthPoints(G, m), m.o)];
  const hw = (25.1 / U) * G.mouth.s * m.w,
    dep = (14.5 / U) * G.mouth.s * m.d,
    x0 = G.mouth.cx,
    y0 = G.mouth.y + m.y + dep * 0.55;
  const strokes: [number, number][][] = [];
  for (let i = 0; i < m.dots; i++) {
    strokes.push([[x0 - hw + (2 * hw * (i + 0.5)) / m.dots, y0 - (m.lift?.[i] ?? 0) * (9 / U) * G.mouth.s]]);
  }
  return strokes;
}
/** Distance from (x, y) to the nearest stroke of a mouth. */
export function botFaceStrokesDistance(
  x: number,
  y: number,
  strokes: readonly (readonly (readonly [number, number])[])[],
): number {
  let d = 1e9;
  for (const stroke of strokes) d = Math.min(d, botFaceSegDistance(x, y, stroke));
  return d;
}
export function botFaceSegDistance(
  x: number,
  y: number,
  line: readonly (readonly [number, number])[],
): number {
  if (line.length === 1) return Math.hypot(x - line[0][0], y - line[0][1]);
  let d = 1e9;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0],
      ay = line[i - 1][1],
      vx = line[i][0] - ax,
      vy = line[i][1] - ay;
    const h = Math.min(
      1,
      Math.max(
        0,
        ((x - ax) * vx + (y - ay) * vy) / Math.max(vx * vx + vy * vy, 1e-9),
      ),
    );
    d = Math.min(d, Math.hypot(x - ax - vx * h, y - ay - vy * h));
  }
  return d;
}
/** The mouth's half-width in model units for a renderer's weight `K`. */
export const botFaceMouthWidth = (G: BotFaceGeometry, K: number) =>
  (3.4 / U) * G.mouth.s * K;
/**
 * Beads for a mouth's strokes: evenly spaced along a polyline (at least three), or one bead per dot, the dots spread
 * about their middle to at least `minDotPitch` so they never merge at rail size (lab R9).
 */
export function botFaceStrokeBeads(
  strokes: readonly (readonly (readonly [number, number])[])[],
  gap: number,
  minDotPitch: number,
): [number, number][] {
  if (strokes.length === 1) return botFaceBeads(strokes[0], gap);
  const centres = strokes.map(stroke => stroke[0]);
  const mid = (centres[0][0] + centres[centres.length - 1][0]) / 2;
  const pitch = Math.max(centres.length > 1 ? Math.abs(centres[1][0] - centres[0][0]) : 0, minDotPitch);
  return centres.map(([, y], i) => [mid + (i - (centres.length - 1) / 2) * pitch, y]);
}
/** Evenly spaced beads along a polyline (at least three). */
export function botFaceBeads(
  pts: readonly (readonly [number, number])[],
  gap: number,
): [number, number][] {
  let L = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(l);
    L += l;
  }
  const n = Math.max(3, Math.round(L / gap) + 1);
  const out: [number, number][] = [];
  for (let b = 0; b < n; b++) {
    let d = (L * b) / (n - 1);
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]) {
      d -= seg[i];
      i++;
    }
    const u = seg[i] > 1e-9 ? Math.min(1, Math.max(0, d / seg[i])) : 0;
    out.push([
      pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u,
      pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u,
    ]);
  }
  return out;
}
