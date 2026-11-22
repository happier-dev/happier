/** Backdrop maths extracted verbatim from the atmosphere lab v2 on 2026-10-10.
 * This module has no DOM or worker dependency. Glyph masks come from the platform.
 */
/* ═══════════════ shared maths ═══════════════ */
/** The existing device preparation edge, shared with reviewed publication media. */
export const ATMOSPHERE_PICTURE_MAX_EDGE = 2560;
export const ATMOSPHERE_HORIZON_FADE_FROM = 0.58;

/** One presentation decision for web, native and static server adapters. */
export function pictureBackdropProps(input) {
  const { picture, look, theme } = input;
  const hour = picture ? (picture.grades[theme === 'dark' ? picture.dark || 'night' : 'light'] ?? picture.hour) : null;
  const grade = picture && hour !== null && Math.abs(picture.hour - hour) > 0.05
    ? { from: picture.hour, to: hour, horizon: picture.horizon.src } : null;
  const horizon = picture?.horizon && picture.horizon.src != null
    ? { ...picture.horizon, at: input.layout === 'wallpaper' ? 0.86 : input.horizonAt } : picture?.horizon;
  return {
    look: look.effect,
    params: { ...look.params, strength: look.strength, mute: ATMOSPHERE_PALETTE.mute[theme] },
    dissolve: input.layout === 'horizon'
      ? { style: look.fade, from: look.from ?? ATMOSPHERE_HORIZON_FADE_FROM, to: look.to ?? 1 } : null,
    focus: picture?.focus ?? { x: 0.5, y: 0.5 },
    ...(horizon ? { horizon } : {}), grade, adjust: picture?.adjust ?? null, page: input.page, theme,
  };
}

/** Map a source-space grading horizon after the platform computes its canonical crop. */
export function backdropBandGrade(grade, crop, horizon) {
  if (!grade || grade.hz !== undefined) return grade;
  return { from: grade.from, to: grade.to, hz: crop.toBand(grade.horizon ?? horizon?.src ?? 0.55) };
}

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();
function hash(i, j, s) {
  let h =
    (Math.imul(i | 0, 374761393) +
      Math.imul(j | 0, 668265263) +
      Math.imul(s | 0, 1442695041)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi;
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s),
    b = hash(xi + 1, yi, s),
    c = hash(xi, yi + 1, s),
    d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// berthd's 8×8 Bayer, row-major, (v + 0.5) / 64
const BAYER8 = new Float32Array(
  [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36,
    14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55,
    23, 61, 29, 53, 21,
  ].map((x) => (x + 0.5) / 64),
);
const bayer = (i, j) => BAYER8[((j & 7) << 3) | (i & 7)];
// berthd: the dissolve reads the matrix at (x + 5, y + 3) so its pattern never lines up with the grain's
const bayerDrop = (i, j) => BAYER8[(((j + 3) & 7) << 3) | ((i + 5) & 7)];
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const hex = (h) => {
  h = h.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((x) => x + x)
      .join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

/* Blue noise, 64×64, void-and-cluster (Ulichney 1993), generated once per thread and tiled. Used by `resettle`. */
let BN = null;
function blueNoise() {
  if (BN) return BN;
  const S = 64,
    N = S * S,
    sig = 1.9,
    lut = new Float32Array(N);
  for (let dy = 0; dy < S; dy++)
    for (let dx = 0; dx < S; dx++) {
      const ax = Math.min(dx, S - dx),
        ay = Math.min(dy, S - dy);
      lut[dy * S + dx] = Math.exp(-(ax * ax + ay * ay) / (2 * sig * sig));
    }
  const E = new Float32Array(N),
    on = new Uint8Array(N);
  const upd = (p, s) => {
    const px = p % S,
      py = (p / S) | 0;
    for (let y = 0; y < S; y++) {
      const ly = ((y - py + S) & 63) * S,
        row = y * S;
      for (let x = 0; x < S; x++)
        E[row + x] += s * lut[ly + ((x - px + S) & 63)];
    }
  };
  const tight = () => {
    let m = -1,
      k = 0;
    for (let i = 0; i < N; i++)
      if (on[i] && E[i] > m) {
        m = E[i];
        k = i;
      }
    return k;
  };
  const voidp = () => {
    let m = 1e9,
      k = 0;
    for (let i = 0; i < N; i++)
      if (!on[i] && E[i] < m) {
        m = E[i];
        k = i;
      }
    return k;
  };
  let seed = 7;
  const rnd = () =>
    (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const n0 = Math.round(N * 0.1);
  for (let c = 0; c < n0;) {
    const p = (rnd() * N) | 0;
    if (!on[p]) {
      on[p] = 1;
      upd(p, 1);
      c++;
    }
  }
  for (let it = 0; it < 4000; it++) {
    const t = tight();
    on[t] = 0;
    upd(t, -1);
    const v = voidp();
    if (v === t) {
      on[t] = 1;
      upd(t, 1);
      break;
    }
    on[v] = 1;
    upd(v, 1);
  }
  const rank = new Float32Array(N),
    on0 = on.slice(),
    E0 = E.slice();
  for (let r = n0 - 1; r >= 0; r--) {
    const t = tight();
    on[t] = 0;
    upd(t, -1);
    rank[t] = r;
  }
  on.set(on0);
  E.set(E0);
  for (let r = n0; r < N; r++) {
    const v = voidp();
    on[v] = 1;
    upd(v, 1);
    rank[v] = r;
  }
  for (let i = 0; i < N; i++) rank[i] = (rank[i] + 0.5) / N;
  BN = rank;
  return BN;
}
const bnAt = (bn, x, y) => bn[((y & 63) << 6) | (x & 63)];

/* ═══════════════ the hour grade (landscapes: SKY + plateGrade) ═══════════════
   One picture, many hours: ambient white balance and exposure from the SKY table, Purkinje desaturation toward
   night, and the target hour's glow along the picture's own horizon. The composition never moves.            */
const NIGHT = {
  hor: [28, 36, 76],
  glow: [60, 78, 150],
  amb: [64, 78, 126],
  stars: 1,
};
const SKY = [
  [0, NIGHT],
  [
    4.7,
    {
      hor: [104, 74, 136],
      glow: [156, 96, 146],
      amb: [86, 76, 132],
      stars: 0.55,
    },
  ],
  [
    6.2,
    {
      hor: [255, 154, 86],
      glow: [255, 178, 96],
      amb: [216, 142, 128],
      stars: 0.07,
    },
  ],
  [
    8,
    {
      hor: [228, 228, 232],
      glow: [255, 236, 200],
      amb: [210, 210, 216],
      stars: 0,
    },
  ],
  [
    12.5,
    {
      hor: [204, 224, 248],
      glow: [255, 255, 240],
      amb: [238, 236, 228],
      stars: 0,
    },
  ],
  [
    17.1,
    {
      hor: [255, 198, 132],
      glow: [255, 198, 116],
      amb: [246, 192, 140],
      stars: 0,
    },
  ],
  [
    18.6,
    {
      hor: [248, 110, 86],
      glow: [255, 122, 82],
      amb: [180, 94, 110],
      stars: 0.12,
    },
  ],
  [
    19.7,
    {
      hor: [92, 76, 142],
      glow: [122, 86, 152],
      amb: [74, 72, 124],
      stars: 0.6,
    },
  ],
  [24, NIGHT],
];
function skyAt(h) {
  h = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < SKY.length - 2 && SKY[i + 1][0] <= h) i++;
  const [h0, A] = SKY[i],
    [h1, B] = SKY[i + 1],
    t = sstep(0, 1, (h - h0) / (h1 - h0)),
    o = {};
  for (const k of Object.keys(A))
    o[k] =
      typeof A[k] === 'number' ? A[k] + (B[k] - A[k]) * t : mix3(A[k], B[k], t);
  return o;
}
const lumc = (c) => luma(c[0], c[1], c[2]);
/* grades `px` (RGBA, W × H) in place; vy(y) is the row's fraction of the (virtual) band, hz the horizon there.
   Three parts, weighted by how far the move goes:
   · a small move keeps landscapes' grade: ambient white balance from SKY and the target hour's glow on the horizon;
   · toward dusk or dawn, a sunset map: the picture's own lightness (stretched to its range) carries a sky that runs
     from violet at the zenith to a warm band on the horizon, with the water below taking the reflection;
   · toward night, moonlight: the same lightness on a deep blue ramp, so lit cloud edges stay silver and shadows go
     to ink (berthd's night plate, not "day for night").
   Both maps keep a little of the picture's own hue.                                                                  */
const ramp = (stops, t, o) => {
  t = clamp(t);
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const [t0, a] = stops[i - 1],
    [t1, b] = stops[i],
    u = clamp((t - t0) / (t1 - t0));
  o[0] = a[0] + (b[0] - a[0]) * u;
  o[1] = a[1] + (b[1] - a[1]) * u;
  o[2] = a[2] + (b[2] - a[2]) * u;
  return o;
};
const MOON = [
  [0, [12, 18, 48]],
  [0.28, [22, 40, 104]],
  [0.6, [52, 90, 178]],
  [0.84, [148, 172, 228]],
  [1, [234, 238, 250]],
];
const WARM = [255, 204, 138];
const DUSK_SKY = [
  [0, [40, 46, 108]],
  [0.45, [104, 76, 146]],
  [0.75, [214, 116, 126]],
  [0.92, [255, 164, 108]],
  [1, [255, 204, 146]],
];
const DUSK_SEA = [
  [0, [240, 156, 120]],
  [0.12, [150, 90, 124]],
  [0.5, [70, 56, 104]],
  [1, [30, 28, 58]],
];
const duskness = (h) => {
  h = ((h % 24) + 24) % 24;
  return Math.max(
    sstep(16.6, 18.3, h) * (1 - sstep(19.5, 20.6, h)),
    sstep(4.4, 5.4, h) * (1 - sstep(6.9, 8, h)),
  );
};
function plateGrade(px, W, H, g, vy) {
  const A = skyAt(g.from),
    B = skyAt(g.to),
    hz = clamp(g.hz, 0.05, 0.98);
  const gain = [0, 1, 2].map((k) => (B.amb[k] + 22) / (A.amb[k] + 22));
  const dark = clamp((B.stars - A.stars) * 1.15),
    dusk = clamp((duskness(g.to) - duskness(g.from)) * 1.2) * (1 - dark),
    base = 1 - dark - dusk;
  const dist = clamp(
      Math.abs(B.stars - A.stars) + Math.abs(lumc(B.hor) - lumc(A.hor)) * 1.4,
    ),
    glow = mix3(B.glow, B.hor, 0.4);
  // the picture's lightness range (2nd–99.5th percentile): the maps read lightness within it
  let lo = 0,
    hi = 1;
  if (dark + dusk > 0) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let q = 0; q < px.length; q += 16) {
      hist[Math.min(255, (luma(px[q], px[q + 1], px[q + 2]) * 255) | 0)]++;
      n++;
    }
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= n * 0.02 && !lo) lo = i / 255 || 1e-3;
      if (acc >= n * 0.995) {
        hi = i / 255;
        break;
      }
    }
    hi = Math.max(hi, lo + 0.1);
  }
  const M = [0, 0, 0],
    D = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = vy(y),
      w =
        0.34 *
        dist *
        base *
        Math.exp(-Math.pow((v - hz) / (v < hz ? 0.2 : 0.07), 2));
    if (dusk > 0) {
      if (v < hz) ramp(DUSK_SKY, v / hz, D);
      else ramp(DUSK_SEA, (v - hz) / (1 - hz), D);
    }
    for (let x = 0, q = y * W * 4; x < W; x++, q += 4) {
      const r0 = px[q],
        g0 = px[q + 1],
        b0 = px[q + 2],
        L0 = luma(r0, g0, b0),
        Ls = clamp((L0 - lo) / (hi - lo)),
        Lh = L0 * 255 + 1;
      let r = r0,
        gg = g0,
        b = b0;
      if (base > 0) {
        let br = r0 * gain[0],
          bg = g0 * gain[1],
          bb = b0 * gain[2];
        if (w > 0.002) {
          const L = Math.sqrt(luma(br, bg, bb)) + 0.25;
          br += (glow[0] * L - br) * w;
          bg += (glow[1] * L - bg) * w;
          bb += (glow[2] * L - bb) * w;
        }
        r = r0 + (br - r0) * base;
        gg = g0 + (bg - g0) * base;
        b = b0 + (bb - b0) * base;
      }
      if (dusk > 0) {
        const k = 0.22 + 0.98 * Math.pow(Ls, 1.35),
          tr = D[0] * k,
          tg = D[1] * k,
          tb = D[2] * k,
          Lt = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb;
        r += (tr + ((r0 / Lh) * Lt - tr) * 0.16 - r) * dusk;
        gg += (tg + ((g0 / Lh) * Lt - tg) * 0.16 - gg) * dusk;
        b += (tb + ((b0 / Lh) * Lt - tb) * 0.16 - b) * dusk;
      }
      if (dark > 0) {
        ramp(MOON, Math.pow(Ls, 1.8) * 0.97, M);
        // a lighter band of air along the horizon, and a warm glint where the picture's own light is (a sun on the
        // water, a lit window): its brightest tones near the horizon
        const near = Math.exp(-Math.pow((v - hz) / 0.08, 2)),
          glint =
            0.75 * sstep(0.88, 1, Ls) * Math.exp(-Math.pow((v - hz) / 0.07, 2));
        M[0] += 12 * near;
        M[1] += 20 * near;
        M[2] += 34 * near;
        if (glint > 0) {
          M[0] += (WARM[0] - M[0]) * glint;
          M[1] += (WARM[1] - M[1]) * glint;
          M[2] += (WARM[2] - M[2]) * glint;
        }
        const Lt = 0.2126 * M[0] + 0.7152 * M[1] + 0.0722 * M[2];
        r += (M[0] + ((r0 / Lh) * Lt - M[0]) * 0.14 - r) * dark;
        gg += (M[1] + ((g0 / Lh) * Lt - M[1]) * 0.14 - gg) * dark;
        b += (M[2] + ((b0 / Lh) * Lt - M[2]) * 0.14 - b) * dark;
      }
      px[q] = r;
      px[q + 1] = gg;
      px[q + 2] = b;
    }
  }
}
/* the picture's own correction (a release sky's prep, e.g. lifting an old varnish): exposure, contrast around mid-grey,
   saturation and temperature (warm +, cool −). Applied before the grade. */
function adjust(px, a) {
  const ex = a.exposure != null ? a.exposure : 1,
    ct = a.contrast != null ? a.contrast : 1,
    sat = a.saturation != null ? a.saturation : 1,
    tp = a.temperature || 0;
  const kr = ex * (1 + 0.12 * tp),
    kg = ex,
    kb = ex * (1 - 0.12 * tp);
  for (let q = 0; q < px.length; q += 4) {
    let r = px[q] * kr,
      g = px[q + 1] * kg,
      b = px[q + 2] * kb;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = L + (r - L) * sat;
    g = L + (g - L) * sat;
    b = L + (b - L) * sat;
    px[q] = (r - 128) * ct + 128;
    px[q + 1] = (g - 128) * ct + 128;
    px[q + 2] = (b - 128) * ct + 128;
  }
}

/* ═══════════════ pixel helpers (RGBA Uint8ClampedArray, W × H device px) ═══════════════ */
function fillPage(out, page) {
  for (let k = 0; k < out.length; k += 4) {
    out[k] = page[0];
    out[k + 1] = page[1];
    out[k + 2] = page[2];
    out[k + 3] = 255;
  }
}
function fillRect(c, x0, y0, x1, y1, r, g, b) {
  const { out, W, H } = c;
  x0 = Math.max(0, x0 | 0);
  y0 = Math.max(0, y0 | 0);
  x1 = Math.min(W, x1 | 0);
  y1 = Math.min(H, y1 | 0);
  for (let y = y0; y < y1; y++) {
    let k = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, k += 4) {
      out[k] = r;
      out[k + 1] = g;
      out[k + 2] = b;
    }
  }
}
function blendAt(out, k, r, g, b, a) {
  out[k] += (r - out[k]) * a;
  out[k + 1] += (g - out[k + 1]) * a;
  out[k + 2] += (b - out[k + 2]) * a;
}
function disc(c, x, y, rad, r, g, b, a = 1) {
  if (rad <= 0.05 || a <= 0) return;
  const { out, W, H } = c,
    x0 = Math.max(0, Math.floor(x - rad - 1)),
    x1 = Math.min(W - 1, Math.ceil(x + rad + 1)),
    y0 = Math.max(0, Math.floor(y - rad - 1)),
    y1 = Math.min(H - 1, Math.ceil(y + rad + 1));
  const cov = rad < 0.5 ? rad * rad * 4 : 1,
    rr = Math.max(rad, 0.5); // below a pixel, keep the area as coverage
  for (let py = y0; py <= y1; py++) {
    const dy = py + 0.5 - y;
    let k = (py * W + x0) * 4;
    for (let px = x0; px <= x1; px++, k += 4) {
      const dx = px + 0.5 - x;
      const al = clamp(rr - Math.sqrt(dx * dx + dy * dy) + 0.5) * cov * a;
      if (al > 0) blendAt(out, k, r, g, b, al);
    }
  }
}
function rrect(c, x0, y0, x1, y1, rad, r, g, b, a = 1) {
  const { out, W, H } = c,
    cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    hx = (x1 - x0) / 2,
    hy = (y1 - y0) / 2;
  rad = Math.min(rad, hx, hy);
  const X0 = Math.max(0, Math.floor(x0)),
    X1 = Math.min(W - 1, Math.ceil(x1)),
    Y0 = Math.max(0, Math.floor(y0)),
    Y1 = Math.min(H - 1, Math.ceil(y1));
  for (let py = Y0; py <= Y1; py++) {
    const qy = Math.abs(py + 0.5 - cy) - hy + rad;
    let k = (py * W + X0) * 4;
    for (let px = X0; px <= X1; px++, k += 4) {
      const qx = Math.abs(px + 0.5 - cx) - hx + rad;
      const d =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
        Math.min(Math.max(qx, qy), 0) -
        rad;
      const al = clamp(0.5 - d) * a;
      if (al > 0) blendAt(out, k, r, g, b, al);
    }
  }
}
function glyph(c, A, gi, x0, y0, r, g, b, a) {
  if (a <= 0.004 || !A) return;
  const { out, W, H } = c,
    { cw, ch, masks } = A,
    base = gi * cw * ch;
  x0 |= 0;
  y0 |= 0;
  for (let y = 0; y < ch; y++) {
    const py = y0 + y;
    if (py < 0 || py >= H) continue;
    let k = (py * W + x0) * 4,
      m = base + y * cw;
    for (let x = 0; x < cw; x++, k += 4, m++) {
      const px = x0 + x;
      if (px < 0 || px >= W) continue;
      const al = (masks[m] / 255) * a;
      if (al > 0) blendAt(out, k, r, g, b, al);
    }
  }
}
/* the average colour of each cw × ch cell (fractional sizes allowed), as an RGBA grid */
function grid(src, W, H, cw, ch) {
  const cols = Math.ceil(W / cw),
    rows = Math.ceil(H / ch),
    g = new Uint8ClampedArray(cols * rows * 4);
  for (let j = 0; j < rows; j++) {
    const y0 = Math.round(j * ch),
      y1 = Math.max(y0 + 1, Math.min(H, Math.round((j + 1) * ch)));
    for (let i = 0; i < cols; i++) {
      const x0 = Math.round(i * cw),
        x1 = Math.max(x0 + 1, Math.min(W, Math.round((i + 1) * cw)));
      let r = 0,
        gg = 0,
        b = 0,
        n = 0;
      for (let y = y0; y < y1 && y < H; y++) {
        let k = (y * W + x0) * 4;
        for (let x = x0; x < x1 && x < W; x++, k += 4) {
          r += src[k];
          gg += src[k + 1];
          b += src[k + 2];
          n++;
        }
      }
      const o = (j * cols + i) * 4;
      n = n || 1;
      g[o] = r / n;
      g[o + 1] = gg / n;
      g[o + 2] = b / n;
      g[o + 3] = 255;
    }
  }
  return { cols, rows, px: g };
}
/* bilinear resample of an RGBA buffer */
function resample(s, w, h, W, H) {
  const o = new Uint8ClampedArray(W * H * 4),
    fx = w / W,
    fy = h / H;
  for (let y = 0; y < H; y++) {
    const sy = clamp((y + 0.5) * fy - 0.5, 0, h - 1),
      y0 = sy | 0,
      y1 = Math.min(h - 1, y0 + 1),
      ty = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = clamp((x + 0.5) * fx - 0.5, 0, w - 1),
        x0 = sx | 0,
        x1 = Math.min(w - 1, x0 + 1),
        tx = sx - x0,
        k = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = s[(y0 * w + x0) * 4 + ch],
          b = s[(y0 * w + x1) * 4 + ch],
          cc = s[(y1 * w + x0) * 4 + ch],
          d = s[(y1 * w + x1) * 4 + ch];
        o[k + ch] = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
      }
      o[k + 3] = 255;
    }
  }
  return o;
}
/* berthd's softening: the cell grid drawn at `scale` and back up, so the grain is the dither's, not the paint's */
function soften(G0, scale) {
  if (!(scale < 0.999)) return G0;
  const { cols, rows } = G0,
    w = Math.max(2, Math.round(cols * scale)),
    h = Math.max(2, Math.round(rows * scale));
  return {
    cols,
    rows,
    px: resample(resample(G0.px, cols, rows, w, h), w, h, cols, rows),
  };
}
/* separable box blur, three passes ≈ gaussian; O(N) whatever the radius */
function boxBlur(src, W, H, r, passes = 3) {
  r = Math.round(r);
  const a = new Uint8ClampedArray(src);
  if (r < 1) return a;
  const t = new Uint8ClampedArray(src.length);
  for (let p = 0; p < passes; p++) {
    hpass(a, t, W, H, r);
    vpass(t, a, W, H, r);
  }
  return a;
}
/* a wide blur needs no resolution: blur a copy at 1/f scale and bring it back up (cost ÷ f²) */
function wideBlur(src, W, H, r) {
  const f = Math.max(1, Math.min(4, Math.floor(r / 3)));
  if (f === 1) return boxBlur(src, W, H, r);
  const w = Math.max(2, Math.round(W / f)),
    h = Math.max(2, Math.round(H / f));
  return resample(boxBlur(resample(src, W, H, w, h), w, h, r / f), w, h, W, H);
}
function hpass(s, d, W, H, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let x = -r; x <= r; x++)
        acc += s[row + Math.min(W - 1, Math.max(0, x)) * 4 + ch];
      for (let x = 0; x < W; x++) {
        d[row + x * 4 + ch] = acc / win;
        acc +=
          s[row + Math.min(W - 1, x + r + 1) * 4 + ch] -
          s[row + Math.max(0, x - r) * 4 + ch];
      }
    }
    for (let x = 0; x < W; x++) d[row + x * 4 + 3] = 255;
  }
}
function vpass(s, d, W, H, r) {
  const win = 2 * r + 1,
    st = W * 4;
  for (let x = 0; x < W; x++)
    for (let ch = 0; ch < 3; ch++) {
      const col = x * 4 + ch;
      let acc = 0;
      for (let y = -r; y <= r; y++)
        acc += s[Math.min(H - 1, Math.max(0, y)) * st + col];
      for (let y = 0; y < H; y++) {
        d[y * st + col] = acc / win;
        acc +=
          s[Math.min(H - 1, y + r + 1) * st + col] -
          s[Math.max(0, y - r) * st + col];
      }
    }
}
/* weighted Kuwahara on an RGBA buffer: four overlapping quadrants weighted by 1/variance^q, so flat regions become
   strokes of paint and edges stay. Integral images keep it O(N) whatever the radius. */
function kuwahara(s, w, h, R, sharp, sat) {
  const W1 = w + 1,
    n = W1 * (h + 1),
    Sr = new Float64Array(n),
    Sg = new Float64Array(n),
    Sb = new Float64Array(n),
    Sl = new Float64Array(n),
    Sq = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    let ar = 0,
      ag = 0,
      ab = 0,
      al = 0,
      aq = 0;
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4,
        L = luma(s[k], s[k + 1], s[k + 2]);
      ar += s[k];
      ag += s[k + 1];
      ab += s[k + 2];
      al += L;
      aq += L * L;
      const o = (y + 1) * W1 + x + 1,
        u = y * W1 + x + 1;
      Sr[o] = Sr[u] + ar;
      Sg[o] = Sg[u] + ag;
      Sb[o] = Sb[u] + ab;
      Sl[o] = Sl[u] + al;
      Sq[o] = Sq[u] + aq;
    }
  }
  const box = (S, x0, y0, x1, y1) =>
    S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
  const o = new Uint8ClampedArray(w * h * 4),
    q = sharp / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let tr = 0,
        tg = 0,
        tb = 0,
        tw = 0;
      for (let qd = 0; qd < 4; qd++) {
        const x0 = Math.max(0, qd & 1 ? x : x - R),
          x1 = Math.min(w, (qd & 1 ? x + R : x) + 1),
          y0 = Math.max(0, qd & 2 ? y : y - R),
          y1 = Math.min(h, (qd & 2 ? y + R : y) + 1),
          N = (x1 - x0) * (y1 - y0);
        const ml = box(Sl, x0, y0, x1, y1) / N,
          vr = Math.max(0, box(Sq, x0, y0, x1, y1) / N - ml * ml),
          wt = 1 / Math.pow(vr * 400 + 1e-4, q);
        tr += (box(Sr, x0, y0, x1, y1) / N) * wt;
        tg += (box(Sg, x0, y0, x1, y1) / N) * wt;
        tb += (box(Sb, x0, y0, x1, y1) / N) * wt;
        tw += wt;
      }
      let r = tr / tw,
        g = tg / tw,
        b = tb / tw;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = L + (r - L) * sat;
      g = L + (g - L) * sat;
      b = L + (b - L) * sat;
      const k = (y * w + x) * 4;
      o[k] = r;
      o[k + 1] = g;
      o[k + 2] = b;
      o[k + 3] = 255;
    }
  return o;
}

/* ═══════════════ colour relative to the page ═══════════════ */
function makeTone(page, dark) {
  const Lbg = Math.sqrt(luma(page[0], page[1], page[2])),
    den = Math.max(Lbg, 1 - Lbg);
  // presence: how much a colour stands out from the page (lightness distance + a little chroma); 0..1
  const cov = (r, g, b) => {
    const Lc = Math.sqrt(luma(r, g, b)),
      chr = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    return clamp(
      Math.pow(clamp((Math.abs(Lc - Lbg) / den) * 1.08 + chr * 0.3), 0.85),
    );
  };
  const T = [0, 0, 0];
  // lift: a mark covering only `f` of its cell carries the whole cell's deviation from the page; the gain stops
  // before any channel clips, so the hue survives
  const room = (p, d) => (d > 0.5 ? (255 - p) / d : d < -0.5 ? p / -d : 1e9);
  const lift = (r, g, b, f) => {
    const dr = r - page[0],
      dg = g - page[1],
      db = b - page[2];
    const k = Math.max(
      1,
      Math.min(
        1 / Math.max(f, 0.08),
        room(page[0], dr),
        room(page[1], dg),
        room(page[2], db),
      ),
    );
    T[0] = page[0] + dr * k;
    T[1] = page[1] + dg * k;
    T[2] = page[2] + db * k;
    return T;
  };
  // vivid: a line or glyph keeps the picture's hue at a legible brightness
  const vivid = (r, g, b, e) => {
    if (dark) {
      const m = Math.max(r, g, b, 10),
        s = lerp(150, 255, e) / m;
      T[0] = clamp(r * s, 0, 255);
      T[1] = clamp(g * s, 0, 255);
      T[2] = clamp(b * s, 0, 255);
    } else {
      const m = Math.min(r, g, b, 245),
        k = Math.min(lerp(1.3, 1.9, e), (235 / Math.max(1, 255 - m)) * 0.9 + 1);
      T[0] = clamp(255 - (255 - r) * k, 0, 255);
      T[1] = clamp(255 - (255 - g) * k, 0, 255);
      T[2] = clamp(255 - (255 - b) * k, 0, 255);
    }
    return T;
  };
  return { cov, lift, vivid };
}

/* ═══════════════ effects ═══════════════
   Each: { label, group, note, params, lattice(c) → cell px (the ordered dissolve's lattice) | null,
           owns: [dissolve styles the effect draws itself], run(c) }.
   Every effect also takes `strength` 0..1: the look's presence over the page (0 = page, 1 = full).           */
const STRENGTH = { id: 'strength', min: 0, max: 1, step: 0.01, default: 1 };
const FX = {};
const def = (id, o) => {
  FX[id] = Object.assign({ id, params: [], lattice: null, owns: [] }, o);
  FX[id].params.push(STRENGTH);
};
const dcell = (c, v) => Math.max(1, Math.round(v * c.dpr));
const ditherCells = (c, Gd, d, levels, edge = 0) => {
  // berthd: lightness only, 8×8 Bayer, (q − Y) added to R, G and B equally (dithering channels apart makes static);
  // `edge` blends in berthd's edge weighting (full grain on edges and gradients, a third in flat areas)
  const { cols, rows, px } = Gd,
    L = Math.max(1, levels - 1),
    gi = c.gi,
    gj = c.gj,
    Yof = (k) => 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 4,
        r = px[k],
        g = px[k + 1],
        b = px[k + 2],
        Y = Yof(k);
      let amt = 1;
      if (edge > 0) {
        const ex =
          Math.abs(
            Yof((j * cols + Math.min(cols - 1, i + 1)) * 4) -
              Yof((j * cols + Math.max(0, i - 1)) * 4),
          ) +
          Math.abs(
            Yof((Math.min(rows - 1, j + 1) * cols + i) * 4) -
              Yof((Math.max(0, j - 1) * cols + i) * 4),
          );
        amt = 1 + (Math.min(1, 0.35 + ex / 40) - 1) * edge;
      }
      let dd =
        ((Math.floor((Y / 255) * L + bayer(i + gi(d), j + gj(d))) / L) * 255 -
          Y) *
        amt;
      // a step that would clip a channel turns a saturated colour into a white (or black) dot: the screen door on a golden
      // sky. The step stops a little past the colour's own room, so the grain stays in the hue
      if (dd > 0) dd = Math.min(dd, 255 - Math.max(r, g, b) + 10);
      else
        dd = Math.max(
          dd,
          Math.min(0, c.floorPx - Y) * 0.9,
          -Math.min(r, g, b) + 6,
        );
      fillRect(c, i * d, j * d, i * d + d, j * d + d, r + dd, g + dd, b + dd);
    }
};

def('original', {
  label: 'Original',
  group: 'image',
  note: 'The picture as is, graded to the hour and muted toward the page. Always offered.',
  params: [{ id: 'saturation', min: 0.6, max: 1.4, step: 0.02, default: 1 }],
  run(c) {
    const sat = c.P.saturation,
      s = c.src,
      o = c.out;
    for (let k = 0; k < o.length; k += 4) {
      const r = s[k],
        g = s[k + 1],
        b = s[k + 2];
      if (sat === 1) {
        o[k] = r;
        o[k + 1] = g;
        o[k + 2] = b;
        continue;
      }
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      o[k] = L + (r - L) * sat;
      o[k + 1] = L + (g - L) * sat;
      o[k + 2] = L + (b - L) * sat;
    }
  },
});

def('fine', {
  label: 'Fine',
  group: 'dither',
  note: 'berthd: a lightness-only 8×8 Bayer at 2 px cells, colour smooth, softened first. 10 levels so skies do not posterize.',
  params: [
    { id: 'cell', min: 2, max: 4, step: 1, default: 2 },
    { id: 'levels', min: 5, max: 14, step: 1, default: 10 },
    { id: 'soften', min: 0.4, max: 1, step: 0.05, default: 0.6 },
    { id: 'edge', min: 0, max: 1, step: 0.05, default: 0 },
  ],
  lattice: (c) => dcell(c, c.P.cell),
  run(c) {
    const d = dcell(c, c.P.cell);
    ditherCells(
      c,
      soften(grid(c.src, c.W, c.H, d, d), c.P.soften),
      d,
      c.P.levels,
      c.P.edge,
    );
  },
});

def('painted-fine', {
  label: 'Painted fine',
  group: 'dither',
  note: 'Any photo painted first (weighted Kuwahara at cell scale), then berthd’s dither: the look of a painted plate from a photograph.',
  params: [
    { id: 'cell', min: 2, max: 4, step: 1, default: 2 },
    { id: 'levels', min: 5, max: 14, step: 1, default: 10 },
    { id: 'radius', min: 1, max: 6, step: 0.5, default: 3 },
    { id: 'saturation', min: 0.8, max: 1.4, step: 0.02, default: 1.06 },
  ],
  lattice: (c) => dcell(c, c.P.cell),
  run(c) {
    const P = c.P,
      d = dcell(c, P.cell),
      G0 = grid(c.src, c.W, c.H, d, d);
    const Gp = {
      cols: G0.cols,
      rows: G0.rows,
      px: kuwahara(
        G0.px,
        G0.cols,
        G0.rows,
        Math.max(1, Math.round(P.radius)),
        8,
        P.saturation,
      ),
    };
    ditherCells(c, soften(Gp, 0.8), d, P.levels);
  },
});

def('halftone', {
  label: 'Halftone',
  group: 'print',
  owns: ['ordered', 'shrink'],
  note: 'Print dots on a rotated screen, sized by presence, over a faint wash of the picture. The dots leave the band by shrinking or in order.',
  params: [
    { id: 'cell', min: 3, max: 9, step: 0.5, default: 4.5 },
    { id: 'angle', min: 0, max: 45, step: 1, default: 45 },
    { id: 'gain', min: 0.7, max: 1.4, step: 0.05, default: 1.05 },
    { id: 'wash', min: 0, max: 0.5, step: 0.02, default: 0.22 },
  ],
  run(c) {
    const P = c.P,
      cd = P.cell * c.dpr,
      th = (P.angle * Math.PI) / 180,
      cs = Math.cos(th),
      sn = Math.sin(th),
      { W, H, out, page } = c;
    const B = wideBlur(c.src, W, H, cd * 0.45);
    if (P.wash > 0)
      for (let k = 0; k < out.length; k += 4) {
        out[k] = page[0] + (B[k] - page[0]) * P.wash;
        out[k + 1] = page[1] + (B[k + 1] - page[1]) * P.wash;
        out[k + 2] = page[2] + (B[k + 2] - page[2]) * P.wash;
      }
    // the screen is anchored to the virtual surface, so split panes share one screen
    const cx = W / 2 - c.ox,
      cy = c.vH / 2 - c.oy,
      R = Math.hypot(Math.max(W, c.vW), c.vH),
      n = Math.ceil(R / cd) + 2;
    for (let b = -n; b <= n; b++)
      for (let a = -n; a <= n; a++) {
        const x = cx + (a * cs - b * sn) * cd,
          y = cy + (a * sn + b * cs) * cd;
        if (x < -cd || y < -cd || x > W + cd || y > H + cd) continue;
        const keep = c.keep(y);
        if (keep <= 0) continue;
        if (
          c.dis === 'ordered' &&
          keep < 1 &&
          bayerDrop(a + 64, b + 64) >= keep
        )
          continue;
        const xi = Math.min(W - 1, Math.max(0, x | 0)),
          yi = Math.min(H - 1, Math.max(0, y | 0)),
          k = (yi * W + xi) * 4;
        const r = B[k],
          g = B[k + 1],
          bb = B[k + 2],
          e = clamp(c.tone.cov(r, g, bb) * P.gain);
        const rad =
          cd *
          0.5 *
          1.16 *
          Math.sqrt(e) *
          (c.dis === 'shrink' ? Math.sqrt(keep) : 1);
        if (rad < 0.25) continue;
        const f = Math.min(1, (Math.PI * rad * rad) / (cd * cd)),
          col = c.tone.lift(r, g, bb, Math.max(0.35, f + P.wash * (1 - f)));
        disc(c, x, y, rad, col[0], col[1], col[2]);
      }
  },
});

def('mosaic', {
  label: 'Mosaic',
  group: 'pixel',
  owns: ['ordered', 'shrink'],
  note: 'Glass tiles set in their own darker grout, each catching light at its top edge. Bold and graphic, still the picture; no white grid.',
  params: [
    { id: 'cell', min: 4, max: 16, step: 1, default: 8 },
    { id: 'gap', min: 0.5, max: 3, step: 0.25, default: 1 },
    { id: 'round', min: 0, max: 0.5, step: 0.02, default: 0.24 },
    { id: 'light', min: 0, max: 1, step: 0.05, default: 0.6 },
    { id: 'grout', min: 0, max: 1, step: 0.05, default: 0.07 },
  ],
  lattice: (c) => dcell(c, c.P.cell),
  run(c) {
    const P = c.P,
      d = dcell(c, P.cell),
      gap = Math.max(1, Math.round(P.gap * c.dpr)),
      Gd = grid(c.src, c.W, c.H, d, d),
      { cols, rows, px } = Gd;
    const rad = (d - gap) * P.round,
      light = P.light,
      gi = c.gi(d),
      gj = c.gj(d),
      { out, W } = c;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 4,
          ym = (j + 0.5) * d,
          keep = c.keep(ym);
        if (keep <= 0) continue;
        let r = px[k],
          g = px[k + 1],
          b = px[k + 2];
        if (
          c.dis === 'ordered' &&
          keep < 1 &&
          bayerDrop(i + gi, j + gj) >= keep
        ) {
          // the first tiles to leave fade toward the page, so the seam never shows as a row of holes
          const f = sstep(0, 0.3, 1 - keep);
          if (f >= 1) continue;
          r += (c.page[0] - r) * f;
          g += (c.page[1] - g) * f;
          b += (c.page[2] - b) * f;
        }
        const s = c.dis === 'shrink' ? Math.sqrt(keep) : 1,
          half = ((d - gap) / 2) * s,
          x0 = i * d + d / 2 - half,
          y0 = j * d + d / 2 - half,
          x1 = x0 + 2 * half,
          y1 = y0 + 2 * half;
        // grout: the tile's own colour, a step darker (lighter on dark), so the picture holds together without a page grid
        if (s >= 1 && P.grout > 0) {
          const gk = c.dark ? 1 + P.grout : 1 - P.grout;
          fillRect(
            c,
            i * d,
            j * d,
            i * d + d,
            j * d + d,
            Math.min(255, r * gk),
            Math.min(255, g * gk),
            Math.min(255, b * gk),
          );
        }
        rrect(c, x0, y0, x1, y1, rad * s, r, g, b);
        if (light > 0 && half > 2) {
          // a tile catches light at its top edge and darkens a touch at its foot: glass, not paint
          const Y0 = Math.max(0, Math.ceil(y0)),
            Y1 = Math.min(c.H - 1, Math.floor(y1)),
            X0 = Math.max(0, Math.ceil(x0)),
            X1 = Math.min(W - 1, Math.floor(x1));
          for (let y = Y0; y <= Y1; y++) {
            const t = (y + 0.5 - y0) / (y1 - y0),
              sh =
                (t < 0.18 ? (1 - t / 0.18) * 0.16 : 0) -
                sstep(0.6, 1, t) * 0.06;
            if (!sh) continue;
            for (let x = X0, q = (y * W + X0) * 4; x <= X1; x++, q += 4) {
              if (sh > 0) {
                out[q] += (255 - out[q]) * sh * light;
                out[q + 1] += (255 - out[q + 1]) * sh * light;
                out[q + 2] += (255 - out[q + 2]) * sh * light;
              } else {
                const m = 1 + sh * light;
                out[q] *= m;
                out[q + 1] *= m;
                out[q + 2] *= m;
              }
            }
          }
        }
      }
  },
});

def('painted', {
  label: 'Painted',
  group: 'image',
  note: 'Weighted Kuwahara with a faint canvas tooth: a photograph becomes a painting, and a painting gets calmer.',
  params: [
    { id: 'radius', min: 2, max: 10, step: 0.5, default: 4.5 },
    { id: 'sharp', min: 2, max: 12, step: 1, default: 8 },
    { id: 'canvas', min: 0, max: 0.1, step: 0.01, default: 0.03 },
    { id: 'saturation', min: 0.8, max: 1.4, step: 0.02, default: 1.06 },
  ],
  run(c) {
    const P = c.P,
      { W, H } = c,
      sc = W * H > 450000 ? 0.5 : 1,
      w = Math.max(2, Math.round(W * sc)),
      h = Math.max(2, Math.round(H * sc));
    const s = sc === 1 ? c.src : resample(c.src, W, H, w, h),
      o = kuwahara(
        s,
        w,
        h,
        Math.max(1, Math.round(P.radius * c.dpr * sc)),
        P.sharp,
        P.saturation,
      );
    const up = sc === 1 ? o : resample(o, w, h, W, H),
      out = c.out,
      tex = P.canvas;
    for (let y = 0, k = 0; y < H; y++)
      for (let x = 0; x < W; x++, k += 4) {
        const t = tex
          ? (vnoise((x / c.dpr) * 0.9, (y / c.dpr) * 0.9, 41) * 0.6 +
              vnoise((x / c.dpr) * 0.23, (y / c.dpr) * 1.6, 42) * 0.4 -
              0.5) *
            tex *
            2
          : 0;
        out[k] = up[k] * (1 + t);
        out[k + 1] = up[k + 1] * (1 + t);
        out[k + 2] = up[k + 2] * (1 + t);
      }
  },
});

def('haze', {
  label: 'Haze',
  group: 'image',
  note: 'A layered haze: two blurred copies that take over down the band (7 and 18 px), a veil toward the page and 1-in-3 px scanlines.',
  params: [
    { id: 'blur', min: 0.4, max: 2, step: 0.05, default: 1 },
    { id: 'veil', min: 0, max: 1, step: 0.05, default: 0.55 },
    { id: 'lines', min: 0, max: 0.6, step: 0.02, default: 0.36 },
  ],
  run(c) {
    const P = c.P,
      { W, H, src, out, page } = c,
      b1 = wideBlur(src, W, H, (7 * c.dpr * P.blur) / 1.7),
      b2 = wideBlur(src, W, H, (18 * c.dpr * P.blur) / 1.7);
    const lp = Math.max(2, Math.round(3 * c.dpr)),
      lw = Math.max(1, Math.round(c.dpr));
    // Haze stops, as fractions of the band: soft blur 18→60 %, strong 28→76 %, veil 16/38/55/75 % at 0/26/55/78 %
    const veil = (v) =>
      v < 0.16
        ? 0
        : v < 0.38
          ? ((v - 0.16) / 0.22) * 0.26
          : v < 0.55
            ? 0.26 + ((v - 0.38) / 0.17) * 0.29
            : v < 0.75
              ? 0.55 + ((v - 0.55) / 0.2) * 0.23
              : 0.78;
    for (let y = 0; y < H; y++) {
      const v = c.vy(y),
        w1 = clamp((v - 0.18) / 0.42),
        w2 = clamp((v - 0.28) / 0.48),
        g = veil(v) * P.veil,
        line = (y + c.oy) % lp < lw ? P.lines : 0;
      for (let x = 0, k = y * W * 4; x < W; x++, k += 4)
        for (let ch = 0; ch < 3; ch++) {
          let s = src[k + ch];
          s += (b1[k + ch] - s) * w1;
          s += (b2[k + ch] - s) * w2;
          s += (page[ch] - s) * g;
          if (line) s += (page[ch] - s) * line;
          out[k + ch] = s;
        }
    }
  },
});

def('engraving', {
  label: 'Engraving',
  group: 'line',
  owns: ['ordered', 'shrink', 'rows'],
  note: 'Banknote hatching in the picture’s own colours: lines swell with presence, bend with the tone and cross in the darks.',
  params: [
    { id: 'spacing', min: 2.5, max: 7, step: 0.25, default: 3.5 },
    { id: 'angle', min: -60, max: 60, step: 1, default: 24 },
    { id: 'swell', min: 0, max: 1.5, step: 0.05, default: 0.6 },
    { id: 'cross', min: 0, max: 1, step: 0.05, default: 0.55 },
    { id: 'wash', min: 0, max: 0.5, step: 0.02, default: 0.16 },
  ],
  run(c) {
    const P = c.P,
      { W, H, out, page } = c,
      s = P.spacing * c.dpr,
      B = wideBlur(c.src, W, H, s * 0.6);
    const t1 = (P.angle * Math.PI) / 180,
      t2 = t1 - 1.15,
      c1 = Math.cos(t1),
      s1 = Math.sin(t1),
      c2 = Math.cos(t2),
      s2 = Math.sin(t2);
    // the lines thin away into the page (every dissolve style but gradient and haze, which run after)
    const kr = new Float32Array(H);
    for (let y = 0; y < H; y++)
      kr[y] =
        c.dis && c.dis !== 'gradient' && c.dis !== 'haze' ? c.keep(y + 0.5) : 1;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const kp = kr[y];
        if (kp <= 0) continue;
        const k = (y * W + x) * 4,
          r = B[k],
          g = B[k + 1],
          b = B[k + 2],
          e = c.tone.cov(r, g, b) * (c.dis ? Math.sqrt(kp) : 1),
          L = luma(r, g, b),
          X = x + c.ox,
          Y = y + c.oy;
        if (P.wash > 0) {
          const wa = P.wash * kp;
          out[k] = page[0] + (r - page[0]) * wa;
          out[k + 1] = page[1] + (g - page[1]) * wa;
          out[k + 2] = page[2] + (b - page[2]) * wa;
        }
        const u = X * s1 - Y * c1 + P.swell * s * (L - 0.5) * 2.2,
          f = u / s - Math.floor(u / s),
          d = Math.abs(f - 0.5) * s,
          hw = Math.pow(e, 1.2) * s * 0.48;
        // a line thinner than a pixel keeps its width as coverage instead of a hairline floor
        let a = clamp(hw - d + 0.5) * clamp(hw * 2);
        if (P.cross > 0 && e > 0.5) {
          const u2 = X * s2 - Y * c2,
            f2 = u2 / s - Math.floor(u2 / s),
            d2 = Math.abs(f2 - 0.5) * s,
            hw2 = ((e - 0.5) / 0.5) * s * 0.42 * P.cross;
          a = Math.max(a, clamp(hw2 - d2 + 0.5) * clamp(hw2 * 2));
        }
        if (a > 0) {
          const col = c.tone.vivid(r, g, b, 0.4 + 0.6 * e);
          blendAt(out, k, col[0], col[1], col[2], a);
        }
      }
  },
});

/* ═══════════════ the dissolve ═══════════════
   keep(y) = smoothstep(t), t = 1 at `from` and 0 at `to` (fractions of the band height): berthd's ramp.         */
const DISSOLVES = [
  {
    id: 'ordered',
    label: 'Ordered',
    note: 'berthd: dots leave in an even Bayer lattice, (x + 5, y + 3), keep = smoothstep(t). The default.',
  },
  {
    id: 'gradient',
    label: 'Gradient',
    note: 'A smooth fade to the page; the dither stays intact.',
  },
  {
    id: 'haze',
    label: 'Haze',
    note: 'The picture softens through progressive blur as it fades.',
  },
  {
    id: 'shrink',
    label: 'Shrink',
    note: 'The picture turns to halftone dots that shrink to nothing.',
  },
  {
    id: 'rows',
    label: 'Rows',
    note: 'Tide lines: the picture becomes rows that thin away row by row.',
  },
];
// how far the last dots of the ordered dissolve have faded toward the page by the foot (0 = berthd's literal ramp)
const FADE_INK = 0.8;
function dissolve(c, style, lat, soft) {
  const { W, H, out, page, keep } = c;
  let y0 = 0;
  while (y0 < H && keep(y0 + 0.5) >= 1) y0++;
  if (y0 >= H) return;
  const pageRow = (y) => {
    for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
      out[k] = page[0];
      out[k + 1] = page[1];
      out[k + 2] = page[2];
    }
  };
  if (style === 'ordered') {
    const d = lat,
      gi = c.gi(d),
      gj = c.gj(d),
      j0 = Math.floor(y0 / d),
      cols = Math.ceil(W / d),
      rows = Math.ceil(H / d);
    for (let j = j0; j < rows; j++) {
      const ya = j * d,
        yb = Math.min(H, ya + d),
        kp = keep((ya + yb) / 2);
      if (kp >= 1) continue;
      // the first dots to leave fade toward the page over the first part of the ramp (a third on continuous looks,
      // a sixth in the grain), so the seam never cuts in as a row of holes, black ones on a dark page
      const f = sstep(0, soft ? 0.3 : 0.18, 1 - kp);
      // the dots that stay fade their colour toward the page as they thin, so the foot is pale, never a dark lattice
      const fk = FADE_INK * (1 - kp);
      for (let i = 0; i < cols; i++) {
        if (kp > 0 && bayerDrop(i + gi, j + gj) < kp) {
          if (fk > 0)
            for (let y = ya; y < yb; y++)
              for (
                let x = i * d, k = (y * W + x) * 4;
                x < Math.min(W, i * d + d);
                x++, k += 4
              ) {
                out[k] += (page[0] - out[k]) * fk;
                out[k + 1] += (page[1] - out[k + 1]) * fk;
                out[k + 2] += (page[2] - out[k + 2]) * fk;
              }
          continue;
        }
        if (f >= 1) {
          fillRect(c, i * d, ya, i * d + d, yb, page[0], page[1], page[2]);
          continue;
        }
        for (let y = ya; y < yb; y++)
          for (
            let x = i * d, k = (y * W + x) * 4;
            x < Math.min(W, i * d + d);
            x++, k += 4
          ) {
            out[k] += (page[0] - out[k]) * f;
            out[k + 1] += (page[1] - out[k + 1]) * f;
            out[k + 2] += (page[2] - out[k + 2]) * f;
          }
      }
    }
  } else if (style === 'gradient') {
    for (let y = y0; y < H; y++) {
      const f = 1 - keep(y + 0.5);
      for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
        out[k] += (page[0] - out[k]) * f;
        out[k + 1] += (page[1] - out[k + 1]) * f;
        out[k + 2] += (page[2] - out[k + 2]) * f;
      }
    }
  } else if (style === 'haze') {
    const m = Math.round(24 * c.dpr),
      ys = Math.max(0, y0 - m),
      h = H - ys,
      sub = out.subarray(ys * W * 4);
    const b1 = wideBlur(sub, W, h, 3 * c.dpr),
      b2 = wideBlur(sub, W, h, 11 * c.dpr);
    for (let y = y0; y < H; y++) {
      const s = 1 - keep(y + 0.5),
        w1 = sstep(0, 0.4, s),
        w2 = sstep(0.2, 0.8, s),
        f = sstep(0.3, 1, s),
        base = (y - ys) * W * 4;
      for (let x = 0, k = y * W * 4, q = base; x < W; x++, k += 4, q += 4)
        for (let ch = 0; ch < 3; ch++) {
          let v = out[k + ch];
          v += (b1[q + ch] - v) * w1;
          v += (b2[q + ch] - v) * w2;
          out[k + ch] = v + (page[ch] - v) * f;
        }
    }
  } else if (style === 'shrink') {
    const p = Math.max(lat, Math.round(3 * c.dpr)),
      cols = Math.ceil(W / p),
      j0 = Math.floor(y0 / p),
      rows = Math.ceil(H / p),
      cells = [];
    for (let j = j0; j < rows; j++) {
      const ya = j * p,
        yb = Math.min(H, ya + p),
        kp = keep((ya + yb) / 2);
      for (let i = 0; i < cols; i++) {
        const xa = i * p,
          xb = Math.min(W, xa + p);
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let y = ya; y < yb; y++)
          for (let x = xa, k = (y * W + xa) * 4; x < xb; x++, k += 4) {
            r += out[k];
            g += out[k + 1];
            b += out[k + 2];
            n++;
          }
        n = n || 1;
        cells.push([
          (xa + xb) / 2,
          (ya + yb) / 2,
          p * 0.74 * Math.sqrt(kp),
          r / n,
          g / n,
          b / n,
        ]);
      }
    }
    for (let y = j0 * p; y < H; y++) pageRow(y);
    for (const [x, y, r, cr, cg, cb] of cells) disc(c, x, y, r, cr, cg, cb);
  } else if (style === 'rows') {
    const p = Math.max(2, Math.round(3 * c.dpr));
    for (let y = y0; y < H; y++) {
      const Y = y + c.oy,
        rc = (Math.floor(Y / p) + 0.5) * p - c.oy,
        th = p * keep(rc),
        a = rc - th / 2,
        b = rc + th / 2;
      const cov = clamp(Math.min(y + 1, b) - Math.max(y, a));
      if (cov >= 1) continue;
      for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
        out[k] += (page[0] - out[k]) * (1 - cov);
        out[k + 1] += (page[1] - out[k + 1]) * (1 - cov);
        out[k + 2] += (page[2] - out[k + 2]) * (1 - cov);
      }
    }
  }
}

/* the toe: shadows lift to a deep colour of the picture's own (the average of its darkest tones), never black, so a
   dark rock or a night sea dithers as coloured dots instead of a black screen. Lightness below `T` is compressed
   onto [floor, T]; near-black pixels, whose hue is noise, take the shadow tint. */
function toe(px, dark) {
  const T = dark ? 0.26 : 0.34,
    floor = dark ? 0.075 : 0.17,
    hist = new Uint32Array(256);
  let n = 0;
  for (let q = 0; q < px.length; q += 16) {
    hist[Math.min(255, (luma(px[q], px[q + 1], px[q + 2]) * 255) | 0)]++;
    n++;
  }
  let cut = 0,
    acc = 0;
  for (; cut < 255; cut++) {
    acc += hist[cut];
    if (acc >= n * 0.03) break;
  }
  if (hist.slice(0, Math.ceil(T * 255)).every((x) => !x)) return; // no shadows: leave the picture alone
  let tr = 0,
    tg = 0,
    tb = 0,
    m = 0;
  for (let q = 0; q < px.length; q += 16)
    if (luma(px[q], px[q + 1], px[q + 2]) * 255 <= Math.min(cut, T * 255)) {
      tr += px[q];
      tg += px[q + 1];
      tb += px[q + 2];
      m++;
    }
  m = m || 1;
  tr /= m;
  tg /= m;
  tb /= m;
  const tl = Math.max(1, 0.2126 * tr + 0.7152 * tg + 0.0722 * tb),
    mx = Math.max(tr, tg, tb, 1);
  // the tint keeps the shadows' hue, a little richer, at unit lightness
  const sat = 1.25,
    tR = (tl + (tr - tl) * sat) / tl,
    tG = (tl + (tg - tl) * sat) / tl,
    tB = (tl + (tb - tl) * sat) / tl;
  void mx;
  for (let q = 0; q < px.length; q += 4) {
    const r = px[q],
      g = px[q + 1],
      b = px[q + 2],
      L = luma(r, g, b);
    if (L >= T) continue;
    const L2 = floor + (T - floor) * Math.pow(L / T, 0.85),
      k = L2 / Math.max(L, 1e-3),
      w = sstep(0.015, 0.09, L),
      Lp = L2 * 255;
    px[q] = tR * Lp + (Math.min(255, r * k) - tR * Lp) * w;
    px[q + 1] = tG * Lp + (Math.min(255, g * k) - tG * Lp) * w;
    px[q + 2] = tB * Lp + (Math.min(255, b * k) - tB * Lp) * w;
  }
}
function resolveParams(fx, params) {
  const P = {};
  for (const p of fx?.params || []) if (p.default != null) P[p.id] = p.default;
  if (params)
    for (const k in params)
      if (params[k] !== undefined && fx?.params?.some((p) => p.id === k))
        P[k] = params[k];
  return P;
}
function runJob(job) {
  const t0 = now(),
    { W, H, dpr, page, dark } = job,
    src = new Uint8ClampedArray(job.src);
  const span = job.span || { x: 0, y: 0, W, H },
    vy = (y) => (span.y + y) / span.H;
  // 2 · hour grade, 3 · mute toward the page
  if (job.adjust) adjust(src, job.adjust);
  if (job.grade) plateGrade(src, W, H, job.grade, vy);
  const mute = job.mute || 0;
  if (mute > 0)
    for (let k = 0; k < src.length; k += 4) {
      src[k] += (page[0] - src[k]) * mute;
      src[k + 1] += (page[1] - src[k + 1]) * mute;
      src[k + 2] += (page[2] - src[k + 2]) * mute;
    }
  if (job.toe !== false) toe(src, dark);
  // the dissolve's ramp (berthd), in the band's own rows
  const D = job.dissolve,
    len = D ? Math.max(1e-6, D.to - D.from) : 1;
  const keep = D
    ? (y) => {
        const v = vy(y);
        if (v <= D.from) return 1;
        if (v >= D.to) return 0;
        const t = 1 - (v - D.from) / len;
        return t * t * (3 - 2 * t);
      }
    : () => 1;
  const fx = FX[job.effect] || FX.original,
    P = resolveParams(fx, job.params);
  const out = new Uint8ClampedArray(W * H * 4);
  fillPage(out, page);
  const c = {
    W,
    H,
    dpr,
    src,
    out,
    P,
    page,
    dark,
    tone: makeTone(page, dark),
    vy,
    keep,
    ox: span.x,
    oy: span.y,
    vW: span.W,
    vH: span.H,
    floorPx: (dark ? 0.075 : 0.17) * 255 * 0.85,
    dis: D ? D.style : null,
    gi: (d) => Math.floor(span.x / d),
    gj: (d) => Math.floor(span.y / d),
  };
  // 4 · the effect
  const tf = now();
  fx.run(c);
  const fxMs = now() - tf;
  // 5 · strength: the look's presence over the page
  const st = clamp(
    (P.strength != null ? P.strength : 1) *
      (job.strength != null ? job.strength : 1),
  );
  if (st < 1)
    for (let k = 0; k < out.length; k += 4) {
      out[k] = page[0] + (out[k] - page[0]) * st;
      out[k + 1] = page[1] + (out[k + 1] - page[1]) * st;
      out[k + 2] = page[2] + (out[k + 2] - page[2]) * st;
    }
  // 6 · the dissolve, unless the effect drew it itself
  if (D && !fx.owns.includes(D.style))
    dissolve(
      c,
      D.style,
      (fx.lattice && fx.lattice(c)) || Math.max(1, Math.round(2 * dpr)),
      !fx.lattice,
    );
  return { buffer: out.buffer, W, H, ms: now() - t0, fxMs };
}

/* the crop: cover the (virtual) band; the horizon anchor wins over focus.y, so the composition never moves */
function cropOf(S, vW, vH, focus, horizon) {
  const zoom = (focus && focus.zoom) || 1,
    s = Math.max(vW / S.w, vH / S.h) * zoom,
    vw = vW / s,
    vh = vH / s;
  const fx = focus && focus.x != null ? focus.x : 0.5,
    fy = focus && focus.y != null ? focus.y : 0.5;
  const sx = clamp(fx * S.w - vw / 2, 0, S.w - vw);
  const sy =
    horizon && horizon.src != null
      ? clamp(
          horizon.src * S.h - (horizon.at != null ? horizon.at : 0.57) * vh,
          0,
          S.h - vh,
        )
      : clamp(fy * S.h - vh / 2, 0, S.h - vh);
  return { s, sx, sy, vw, vh, toBand: (srcV) => (srcV * S.h - sy) / vh };
}
const typeDigit = (i, j, s) => {
  const h = hash(i, j, s);
  return h < 0.62
    ? 1 + Math.floor((h / 0.62) * 3)
    : Math.floor(hash(j, i, s + 9) * 10);
};
const RAMP = [
  [0, '#0F1640'],
  [0.22, '#25349E'],
  [0.45, '#7B3FA8'],
  [0.62, '#D9467A'],
  [0.8, '#F5904A'],
  [1, '#FCEBCF'],
].map(([t, h]) => [t, hex(h)]);
function rampAt(t) {
  for (let i = 1; i < RAMP.length; i++)
    if (t <= RAMP[i][0]) {
      const [t0, a] = RAMP[i - 1],
        [t1, b] = RAMP[i],
        u = (t - t0) / (t1 - t0);
      return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
    }
  return RAMP[RAMP.length - 1][1];
}

const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
function lattice(W, H, dpr) {
  const cw = Math.max(4, Math.round(6 * dpr)),
    ch = Math.max(6, Math.round(9 * dpr));
  return { cw, ch, cols: Math.ceil(W / cw), rows: Math.ceil(H / ch) };
}
function cellAvg(d, W, H, x0, y0, cw, ch) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = y0; y < Math.min(H, y0 + ch); y += 2)
    for (let x = x0; x < Math.min(W, x0 + cw); x += 2) {
      const k = (y * W + x) * 4;
      r += d[k];
      g += d[k + 1];
      b += d[k + 2];
      n++;
    }
  n = n || 1;
  return [r / n, g / n, b / n];
}
/* The one ripple ring (transition style 'ripple' and the Atmos.ripple overlay): a ring of typed digits leaves (ox, oy)
   over 0..1. Digit, space on the 6 × 9 lattice; a crisp leading edge, a soft trailing one. On a picture the cell lifts
   toward the page first; as an overlay only the digits are written. In light the ring keeps a minimum ink. */
export function rippleRingGeometry(progress, reach, rowHeight, dpr) {
  return {
    radius: (1 - Math.pow(1 - progress, 2.2)) * reach,
    band: Math.max(rowHeight * 2.4, 30 * dpr),
    fade: Math.pow(1 - progress, 0.9),
  };
}
function drawRippleRing(R, p) {
  const {
    buf,
    W,
    H,
    L,
    at,
    page,
    dark,
    tone,
    ox,
    oy,
    Rmax,
    dpr,
    overlay,
    colourAt,
  } = R;
  if (p >= 1) return;
  const { radius: r, band, fade } = rippleRingGeometry(p, Rmax, L.ch, dpr);
  const c0 = Math.max(0, Math.floor((ox - r) / L.cw) - 1),
    c1 = Math.min(L.cols - 1, Math.ceil((ox + r) / L.cw) + 1),
    r0 = Math.max(0, Math.floor((oy - r) / L.ch) - 1),
    r1 = Math.min(L.rows - 1, Math.ceil((oy + r) / L.ch) + 1);
  for (let j = r0; j <= r1; j++)
    for (let i = c0; i <= c1; i++) {
      if (i & 1) continue;
      const cx = i * L.cw + L.cw / 2,
        cy = j * L.ch + L.ch / 2,
        d = r - Math.hypot(cx - ox, cy - oy);
      if (d < 0 || d > band) continue;
      const u = d / band,
        prof = Math.sin(Math.PI * Math.pow(1 - u, 0.7));
      if (hash(i, j, 93) > 0.78) continue;
      const base = colourAt(j * L.cols + i, u, i, j),
        ee = tone.cov(base[0], base[1], base[2]);
      let col = tone.vivid(base[0], base[1], base[2], 0.6 + 0.4 * ee),
        al = clamp(prof * fade * 0.95);
      if (!dark) {
        const ink = rampAt(base[0] - base[2] > 0 ? 0.62 : 0.22),
          w = clamp(1 - ee * 1.4, 0.45, 1);
        col = [
          lerp(col[0], ink[0], w),
          lerp(col[1], ink[1], w),
          lerp(col[2], ink[2], w),
        ];
        al = clamp(
          Math.max(al, 0.45 * Math.min(1, prof * 3) * Math.min(1, fade * 2.5)),
        );
      }
      const x0 = i * L.cw,
        y0 = j * L.ch,
        gi = typeDigit(i, j + Math.floor(p * 4) * 57, 7);
      if (overlay) {
        glyphOver(buf, W, H, at, gi, x0, y0, col, al);
        continue;
      }
      const wa = 0.6 * al;
      for (let y = y0; y < Math.min(H, y0 + L.ch); y++)
        for (
          let x = Math.max(0, x0 - (L.cw >> 1)), q = (y * W + x) * 4;
          x < Math.min(W, x0 + L.cw + (L.cw >> 1));
          x++, q += 4
        ) {
          const fx = Math.abs((x - x0 + 0.5) / L.cw - 0.5),
            fy = Math.abs((y - y0 + 0.5) / L.ch - 0.5),
            fall = wa * (1 - sstep(0.3, 1, fx)) * (1 - sstep(0.2, 0.5, fy));
          buf[q] += (page[0] - buf[q]) * fall;
          buf[q + 1] += (page[1] - buf[q + 1]) * fall;
          buf[q + 2] += (page[2] - buf[q + 2]) * fall;
        }
      glyph({ W, H, out: buf }, at, gi, x0, y0, col[0], col[1], col[2], al);
    }
}
/* a glyph onto a transparent RGBA buffer (straight alpha): colour where the mask is, alpha = mask × a */
function glyphOver(buf, W, H, A, gi, x0, y0, col, a) {
  const { cw, ch, masks } = A,
    base = gi * cw * ch;
  for (let y = 0; y < ch; y++) {
    const py = y0 + y;
    if (py < 0 || py >= H) continue;
    for (let x = 0; x < cw; x++) {
      const px = x0 + x;
      if (px < 0 || px >= W) continue;
      const al = (masks[base + y * cw + x] / 255) * a;
      if (al <= 0) continue;
      const q = (py * W + px) * 4,
        prev = buf[q + 3] / 255,
        out = al + prev * (1 - al);
      buf[q] = (col[0] * al + buf[q] * prev * (1 - al)) / out;
      buf[q + 1] = (col[1] * al + buf[q + 1] * prev * (1 - al)) / out;
      buf[q + 2] = (col[2] * al + buf[q + 2] * prev * (1 - al)) / out;
      buf[q + 3] = out * 255;
    }
  }
}
/* styles: 'crossfade' (180 ms), 'resettle' (the picture re-settles one 2 px grain at a time in blue-noise order; also
   what the retired 'digits' style now means), 'ripple' (one ring of typed digits from `origin`, carrying a change). */
function makeTransition(A, B, style, page, dark, dpr, opt = {}) {
  const { W, H } = A,
    buf = new Uint8ClampedArray(A.data);
  if (style === 'ripple') {
    const L = lattice(W, H, dpr),
      at = opt.glyphs,
      tone = makeTone(page, dark),
      n = L.cols * L.rows,
      avA = new Float32Array(n * 3),
      avB = new Float32Array(n * 3);
    for (let j = 0; j < L.rows; j++)
      for (let i = 0; i < L.cols; i++) {
        const c = j * L.cols + i;
        avA.set(cellAvg(A.data, W, H, i * L.cw, j * L.ch, L.cw, L.ch), c * 3);
        avB.set(cellAvg(B.data, W, H, i * L.cw, j * L.ch, L.cw, L.ch), c * 3);
      }
    const ox = opt.origin ? opt.origin.x * dpr : W * 0.85,
      oy = opt.origin ? opt.origin.y * dpr : H * 0.25;
    const Rmax = opt.radius
      ? opt.radius * dpr
      : Math.max(
          Math.hypot(ox, oy),
          Math.hypot(W - ox, oy),
          Math.hypot(ox, H - oy),
          Math.hypot(W - ox, H - oy),
        ) * 0.9;
    return {
      W,
      H,
      frame(p) {
        const r = (1 - Math.pow(1 - p, 2.2)) * Rmax;
        if (A.data === B.data) buf.set(A.data);
        else
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const k = (y * W + x) * 4,
                s = Math.hypot(x - ox, y - oy) < r ? B.data : A.data;
              buf[k] = s[k];
              buf[k + 1] = s[k + 1];
              buf[k + 2] = s[k + 2];
            }
        drawRippleRing(
          {
            buf,
            W,
            H,
            L,
            at,
            page,
            dark,
            tone,
            ox,
            oy,
            Rmax,
            dpr,
            overlay: false,
            colourAt: (c, u) => {
              const k = c * 3;
              return [
                lerp(avA[k], avB[k], 1 - u),
                lerp(avA[k + 1], avB[k + 1], 1 - u),
                lerp(avA[k + 2], avB[k + 2], 1 - u),
              ];
            },
          },
          p,
        );
        return buf;
      },
    };
  }
  if (style === 'crossfade')
    return {
      W,
      H,
      frame(p) {
        const t = ease.out(p);
        for (let k = 0; k < buf.length; k += 4) {
          buf[k] = A.data[k] + (B.data[k] - A.data[k]) * t;
          buf[k + 1] = A.data[k + 1] + (B.data[k + 1] - A.data[k + 1]) * t;
          buf[k + 2] = A.data[k + 2] + (B.data[k + 2] - A.data[k + 2]) * t;
        }
        return buf;
      },
    };
  const f = Math.max(1, Math.round(2 * dpr)),
    fc = Math.ceil(W / f),
    fr = Math.ceil(H / f),
    bn = blueNoise();
  // Whole pixels move as 32-bit words: the same bytes as copying each grain row, without a view per row.
  const words = (d) =>
    d.byteOffset % 4 === 0
      ? new Uint32Array(d.buffer, d.byteOffset, d.length >> 2)
      : new Uint32Array(new Uint8ClampedArray(d).buffer);
  const out = words(buf),
    a32 = words(A.data),
    b32 = words(B.data);
  return {
    W,
    H,
    frame(p) {
      for (let j = 0; j < fr; j++) {
        const y0 = j * f,
          y1 = Math.min(H, y0 + f);
        for (let i = 0; i < fc; i++) {
          const s = bnAt(bn, i, j) < p ? b32 : a32,
            x0 = i * f,
            x1 = Math.min(W, x0 + f);
          for (let y = y0; y < y1; y++) {
            const row = y * W;
            for (let x = x0; x < x1; x++) out[row + x] = s[row + x];
          }
        }
      }
      return buf;
    },
  };
}

/** The platform crops and samples the source before rendering (lab sourcePixels). */
export function renderBackdrop(job) {
  const { source, params = {} } = job;
  const r = runJob({
    W: source.w,
    H: source.h,
    dpr: job.dpr || 1,
    src: source.rgba,
    effect: job.look,
    params,
    page: job.page,
    dark: job.theme === 'dark',
    mute: params.mute,
    grade: job.grade,
    adjust: job.adjust,
    toe: job.toe,
    dissolve: job.dissolve,
    span: job.span,
  });
  return {
    rgba: new Uint8ClampedArray(r.buffer),
    w: r.W,
    h: r.H,
    ms: r.ms,
    fxMs: r.fxMs,
  };
}
export const ATMOSPHERE_LOOKS = Object.values(FX).map((f) => ({
  id: f.id,
  label: f.label,
  group: f.group,
  note: f.note,
  params: f.params.map((p) => ({ ...p })),
}));
export const ATMOSPHERE_DISSOLVES = DISSOLVES;
export const ATMOSPHERE_PALETTE = {
  ramp: RAMP.map(([t, rgb]) => ({ t, rgb })),
  page: { light: '#F5F5F5', dark: '#131111' },
  mute: { light: 0.05, dark: 0.08 },
};
export { FADE_INK, cropOf, resolveParams, lattice as atmosphereDigitLattice };

/** berthd's ordered fade on a transparent RGBA store (lab `at-planet.js` orderedFade, moved unchanged): 2 css px cells
 * leave in the Bayer lattice read at (x + 5, y + 3), keep = smoothstep; what stays also pales (FADE_INK 0.8), and
 * everything below the window clears. `y0`/`y1` are css px; the store is `w × h` device pixels at `dpr`. */
export function orderedFade(rgba, w, h, y0, y1, dpr) {
  const W = w,
    H = h;
  const Y0 = Math.max(0, Math.floor(y0 * dpr)),
    Y1 = Math.min(H, Math.ceil(y1 * dpr));
  if (Y0 >= H) return;
  if (Y1 < H) rgba.fill(0, Y1 * W * 4, H * W * 4);
  const D = rgba.subarray(Y0 * W * 4, Y1 * W * 4);
  const cell = Math.max(1, Math.round(2 * dpr));
  for (let py = 0; py < Y1 - Y0; py++) {
    const t = (py + 0.5) / (Y1 - Y0);
    const s = t * t * (3 - 2 * t);
    const keep = 1 - s;
    const j = Math.floor((py + Y0) / cell);
    const pale = 1 - 0.8 * s;
    for (let px = 0; px < W; px++) {
      const k = (py * W + px) * 4 + 3;
      if (!D[k]) continue;
      const i = Math.floor(px / cell);
      D[k] = bayerDrop(i, j) >= keep ? 0 : D[k] * pale;
    }
  }
}

/** Prepare once, then sample frames without rebuilding blue-noise or ripple cell data. */
export function createAtmosphereTransition(kind, options) {
  const { from, to, page, glyphs } = options;
  const T = makeTransition(
    { data: from.rgba, W: from.w, H: from.h },
    { data: to.rgba, W: to.w, H: to.h },
    kind,
    page,
    options.theme === 'dark',
    options.dpr || 1,
    { origin: options.origin, radius: options.radius, glyphs },
  );
  return { w: T.W, h: T.H, frame: T.frame };
}
export function atmosphereTransition(kind, t, options) {
  const T = createAtmosphereTransition(kind, options);
  return { rgba: T.frame(t), w: T.w, h: T.h };
}

/** The lab's typed ripple on a transparent RGBA layer; no animation scheduling. */
export function atmosphereRipple(t, o) {
  const { w: W, h: H, page, glyphs: at } = o,
    dpr = o.dpr || 1,
    dark = o.theme === 'dark';
  const L = lattice(W, H, dpr),
    tone = makeTone(page, dark);
  const ox = (o.x != null ? o.x : (W / dpr) * 0.85) * dpr,
    oy = (o.y != null ? o.y : (H / dpr) * 0.25) * dpr;
  const Rmax = o.radius
    ? o.radius * dpr
    : Math.max(
        Math.hypot(ox, oy),
        Math.hypot(W - ox, oy),
        Math.hypot(ox, H - oy),
        Math.hypot(W - ox, H - oy),
      ) * 0.9;
  const fixed = o.colour || null;
  const colourAt = (c, u, i, j) =>
    fixed ||
    rampAt(
      dark ? 0.6 + 0.25 * hash(i, j, 95) : hash(i, j, 95) < 0.5 ? 0.62 : 0.22,
    );
  const buf = new Uint8ClampedArray(W * H * 4);
  drawRippleRing(
    {
      buf,
      W,
      H,
      L,
      at,
      page,
      dark,
      tone,
      ox,
      oy,
      Rmax,
      dpr,
      overlay: true,
      colourAt,
    },
    t,
  );
  return { rgba: buf, w: W, h: H };
}

export function releaseLook(s) {
  const L = s.look || {};
  const dz = L.dissolve || {};
  return {
    effect: L.effect || 'fine',
    params: L.params || {},
    fade: dz.style || 'ordered',
    from: null,
    to: null,
    strength: L.strength != null ? L.strength : 1,
  };
}
export function lookFor(id, looks = {}, pictures = ATMOSPHERE_PICTURES) {
  const s = pictures.find((s) => s.id === id) || pictures[0];
  const base = releaseLook(s);
  const o = looks[s.id] || {};
  const eff = o.effect && o.effect !== base.effect;
  return {
    ...base,
    ...o,
    params: eff ? resolveParams(ATMOSPHERE_LOOKS.find((x) => x.id === o.effect)) : base.params,
    sky: s.id,
    src: s.custom ? { image: s.image } : { sky: s.id },
  };
}
export const changedKeys = (id, looks = {}) => Object.keys(looks[id] || {});

/** Source URLs and landscapes/CREDITS.md credits; release composition and looks tuned in the lab.
 * Orange dune uses Picsum because its original Unsplash page was removed.
 */
export const ATMOSPHERE_PICTURES = [
  {
    id: 'white-rocks-open-sea',
    kind: 'photo',
    title: 'White rocks, open sea',
    credit: {
      author: 'davide ragusa',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/QbDkhVZ80To',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.48,
      at: 0.46,
    },
    focus: {
      x: 0.3,
      zoom: 1.15,
    },
    hour: 17,
    grades: {
      light: 17,
      dusk: 18.9,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/reserve/tdedkQnQGCgIhk9eoEkP_DSC_0983.JPG?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/reserve/tdedkQnQGCgIhk9eoEkP_DSC_0983.JPG?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'dune-grass',
    kind: 'photo',
    title: 'Dune grass',
    credit: {
      author: 'Alex Talmon',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/umq-jgTjr28',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.6,
      at: 0.38,
    },
    focus: {
      x: 0.72,
      zoom: 1.3,
    },
    hour: 12,
    grades: {
      light: 12,
      dusk: 18.8,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/36/q3Y09XWNRRC5Et7bEQnE_beach-alex-talmon.jpg?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/36/q3Y09XWNRRC5Et7bEQnE_beach-alex-talmon.jpg?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'pastel-daybreak',
    kind: 'photo',
    title: 'Pastel daybreak',
    credit: {
      author: 'Kelly Sikkema',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/X7dy114KWs4',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.47,
      at: 0.62,
    },
    focus: {
      x: 0.5,
      zoom: 1.15,
    },
    hour: 6.8,
    grades: {
      light: 7,
      dusk: 18.9,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'original',
      params: {},
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/23/pink-sky.JPG?fm=webp&q=82&w=2560',
      thumb: 'https://images.unsplash.com/23/pink-sky.JPG?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'snowy-alps',
    kind: 'photo',
    title: 'Snowy alps',
    credit: {
      author: 'Wolfgang Lutz',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/yOujaSETXlo',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.5,
      at: 0.56,
    },
    focus: {
      x: 0.5,
    },
    hour: 11,
    grades: {
      light: 11,
      dusk: 18.8,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/photo-1437382944886-45a9f73d4158?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/photo-1437382944886-45a9f73d4158?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'valley-lakes',
    kind: 'photo',
    title: 'Valley lakes',
    credit: {
      author: 'Eutah Mizushima',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/OWwK_0_EnxY',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.39,
      at: 0.22,
    },
    focus: {
      x: 0.5,
    },
    hour: 9,
    grades: {
      light: 9.5,
      dusk: 18.8,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/photo-1442120108414-42e7ea50d0b5?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/photo-1442120108414-42e7ea50d0b5?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'glacier-lake',
    kind: 'photo',
    title: 'Glacier lake',
    credit: {
      author: 'Tanvi Malik',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/OeC1wIsKNpk',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.54,
      at: 0.52,
    },
    focus: {
      x: 0.5,
    },
    hour: 9.5,
    grades: {
      light: 12,
      dusk: 18.8,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/46/iYvDeqVGRbebiQv2PIJi_DSC_8407.JPG?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/46/iYvDeqVGRbebiQv2PIJi_DSC_8407.JPG?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'peak-in-the-clouds',
    kind: 'photo',
    title: 'Peak in the clouds',
    credit: {
      author: 'Nicholas Swanson',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/d19by2PLaPc',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.9,
      at: 1,
    },
    focus: {
      x: 0.92,
      zoom: 1.35,
    },
    hour: 12,
    grades: {
      light: 12,
      dusk: 18.8,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/6/mountain.JPG?fm=webp&q=82&w=2560',
      thumb: 'https://images.unsplash.com/6/mountain.JPG?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'orange-dune',
    kind: 'photo',
    title: 'Orange dune',
    credit: {
      author: 'Luca Zanon',
      source: 'Unsplash',
      url: 'https://picsum.photos/id/525/info',
      licence: 'Unsplash License',
      note: 'The original Unsplash page was removed; Picsum retains the same Luca Zanon photo.',
    },
    src: {
      full: 'https://picsum.photos/id/525/2560/1707.webp',
      thumb: 'https://picsum.photos/id/525/288/192.webp',
    },
    horizon: {
      src: 0.6,
      at: 0.52,
    },
    focus: {
      x: 0.4,
      zoom: 1.15,
    },
    hour: 15.5,
    grades: {
      light: 15.5,
      dusk: 18.1,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
  },
  {
    id: 'balloons-at-dawn',
    kind: 'photo',
    title: 'Balloons at dawn',
    credit: {
      author: 'Daniela Cuevas',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/t7YycgAoVSw',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.47,
      at: 0.58,
    },
    focus: {
      x: 0.62,
      zoom: 1.2,
    },
    hour: 7,
    grades: {
      light: 7.2,
      dusk: 18.9,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/photo-1433838552652-f9a46b332c40?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/photo-1433838552652-f9a46b332c40?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'ferris-wheel',
    kind: 'photo',
    title: 'Ferris wheel',
    credit: {
      author: 'Ilya',
      source: 'Unsplash',
      url: 'https://unsplash.com/photos/D62hQefhteg',
      licence: 'Unsplash License',
    },
    horizon: {
      src: 0.6,
      at: 0.82,
    },
    focus: {
      x: 0.5,
    },
    hour: 12,
    grades: {
      light: 12,
      dusk: 18.9,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.unsplash.com/reserve/N13RIliTTASBbuYyszgq_P9020914-54.jpg?fm=webp&q=82&w=2560',
      thumb:
        'https://images.unsplash.com/reserve/N13RIliTTASBbuYyszgq_P9020914-54.jpg?fm=webp&q=70&w=288',
    },
  },
  {
    id: 'calm-sea',
    kind: 'painting',
    title: 'Calm Sea',
    credit: {
      author: 'Gustave Courbet, 1869',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/436005',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.76,
      at: 0.6,
    },
    focus: {
      x: 0.62,
    },
    hour: 11,
    grades: {
      light: 11,
      dusk: 18.9,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ep/original/DT1973.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ep/web-large/DT1973.jpg',
    },
    adjust: {
      temperature: -0.7,
      saturation: 1.25,
      contrast: 1.1,
    },
  },
  {
    id: 'gloucester-harbor',
    kind: 'painting',
    title: 'Gloucester Harbor',
    credit: {
      author: 'Fitz Henry Lane, 1862',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/11396',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.71,
      at: 0.48,
    },
    focus: {
      x: 0.5,
    },
    hour: 17.6,
    grades: {
      light: 17.2,
      dusk: 18.9,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ad/original/DT5586.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ad/web-large/DT5586.jpg',
    },
  },
  {
    id: 'landers-peak',
    kind: 'painting',
    title: 'Lander’s Peak',
    credit: {
      author: 'Albert Bierstadt, 1863',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/10154',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.5,
      at: 0.68,
    },
    focus: {
      x: 0.5,
    },
    hour: 12,
    grades: {
      light: 12,
      dusk: 18.8,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ad/original/DT82.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ad/web-large/DT82.jpg',
    },
  },
  {
    id: 'merced-river',
    kind: 'painting',
    title: 'Merced River',
    credit: {
      author: 'Albert Bierstadt, 1866',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/10150',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.7,
      at: 0.88,
    },
    focus: {
      x: 0.5,
    },
    hour: 12,
    grades: {
      light: 12,
      dusk: 18.8,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ad/original/DT2961.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ad/web-large/DT2961.jpg',
    },
  },
  {
    id: 'ship-by-moonlight',
    kind: 'painting',
    title: 'Ship by Moonlight',
    credit: {
      author: 'Ivan Aivazovsky',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/437979',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.55,
      at: 0.6,
    },
    focus: {
      x: 0.4,
    },
    hour: 22,
    grades: {
      light: 6.4,
      dusk: 19.5,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {},
      dissolve: {
        style: 'gradient',
        from: 0.5,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ep/original/DP-23290-001.jpg',
      thumb:
        'https://images.metmuseum.org/CRDImages/ep/web-large/DP-23290-001.jpg',
    },
    themes: ['dark'],
  },
  {
    id: 'the-oxbow',
    kind: 'painting',
    title: 'The Oxbow',
    credit: {
      author: 'Thomas Cole, 1836',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/10497',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.53,
      at: 0.36,
    },
    focus: {
      x: 0.5,
    },
    hour: 13,
    grades: {
      light: 13,
      dusk: 18.8,
      night: 22,
    },
    dark: 'night',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ad/original/DP-12550-001.jpg',
      thumb:
        'https://images.metmuseum.org/CRDImages/ad/web-large/DP-12550-001.jpg',
    },
    adjust: {
      exposure: 1.08,
    },
  },
  {
    id: 'sugar-loaf-autumn',
    kind: 'painting',
    title: 'Sugar Loaf, Autumn',
    credit: {
      author: 'Jasper F. Cropsey, c. 1872',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/10578',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.55,
      at: 0.6,
    },
    focus: {
      x: 0.5,
    },
    hour: 16,
    grades: {
      light: 15.5,
      dusk: 18.8,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ad/original/ap61.262.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ad/web-large/ap61.262.jpg',
    },
    adjust: {
      saturation: 1.1,
    },
  },
  {
    id: 'fontainebleau-morning',
    kind: 'painting',
    title: 'Fontainebleau Morning',
    credit: {
      author: 'Théodore Rousseau, c. 1861',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/437517',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.47,
      at: 0.55,
    },
    focus: {
      x: 0.5,
    },
    hour: 8.5,
    grades: {
      light: 9,
      dusk: 18.8,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ep/original/DT240033.jpg',
      thumb: 'https://images.metmuseum.org/CRDImages/ep/web-large/DT240033.jpg',
    },
  },
  {
    id: 'haystacks-morning',
    kind: 'painting',
    title: 'Haystacks, Morning',
    credit: {
      author: 'Camille Pissarro, 1899',
      source: 'The Met',
      url: 'https://www.metmuseum.org/art/collection/search/438738',
      licence: 'CC0 (The Met Open Access)',
    },
    horizon: {
      src: 0.7,
      at: 0.55,
    },
    focus: {
      x: 0.5,
    },
    hour: 9,
    grades: {
      light: 9.5,
      dusk: 18.3,
      night: 22,
    },
    dark: 'dusk',
    look: {
      effect: 'fine',
      params: {
        cell: 2,
        levels: 10,
      },
      dissolve: {
        style: 'ordered',
        from: 0.55,
      },
    },
    src: {
      full: 'https://images.metmuseum.org/CRDImages/ep/original/DP-20613-001.jpg',
      thumb:
        'https://images.metmuseum.org/CRDImages/ep/web-large/DP-20613-001.jpg',
    },
  },
];
