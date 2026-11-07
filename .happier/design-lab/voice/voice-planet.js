// Voice lab · the ONE planet, shared by every voice concept page (window.VP).
// User ruling 2026-10-02: the voice planet IS the Daybreak dot planet, drawn by the shared Daybreak engine
// (../daybreak/engine.js + scenes.js: one WebGL2 context, one clock, one palette model). This file adds no renderer and no
// palette; it only binds the Daybreak grammar to voice states through one scene, SC.voice:
//   Light      = ready (idle composer, settings marks): full light, still, zero frames.
//   Atmosphere = energy: halo density follows the REAL audio level — your voice while you speak (cool), the assistant's
//                while it speaks (warm). Silence = still. This replaces the timer breath of spec §2.4a.
//   Shadow     = waiting on something outside: connecting/preparing hold a crescent; reconnecting is the eclipse;
//                a failure (couldn't connect, mic blocked) stays in partial shade, rose-tinted.
//   Dawn       = one-shot Event (<1.5 s) when the connection lands; then Status while true.
// The 2×4 dot cell (daybreak.css .db-cell) is the status glyph for working / thinking / needs you.
//   VP.planet(size, { st, label, p })  st: mic|morph|ready|listening|hearing|speaking|thinking|muted|connecting|eclipse|shade|dawn|ended
//                                    mic   = the REST control: the app icon family's line `waveform` glyph in the composer
//                                            icon tint (VE-02, owner amendment 2026-10-10; shipped VoiceMark.tsx
//                                            VoiceMarkRestGlyph, Phosphor Waveform, size max(16, 0.62 × mark), button.secondary.tint)
//                                    morph = the glyph hands over to dots streaming out of its bars onto the planet
//                                            (p 0..1; p<0 plays it once, 0.55 s); regather = the reverse on End
//   VP.tier(size)                    the planet's dot pitch per size (fewer, larger dots below ~24 pt)
//                                    (legacy names still accepted: still→ready, breathe→listening, arrive→connecting, off→shade)
//   VP.cell(kind, size)              kind: working|think|attn|done|idle|off
//   VP.meter(levels, { dir, live, h })  bar meter, kept only for the non-dot comparison
// Lab envelopes stand in for useVoiceEnergy's real input/output level (simulated, labelled in the notes).
(() => {
Object.assign(P, {
  vpMicOff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11a6.4 6.4 0 0 1-.5 2.5M12 17.5V21M3 3l18 18"/>',
  vpMic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  vpEnd: '<path d="M3.2 14.2c5-4.6 12.6-4.6 17.6 0l-2.1 2.6-3.4-1.4v-2.3a9.3 9.3 0 0 0-4.6 0v2.3l-3.4 1.4-2.1-2.6Z" fill="currentColor" stroke="none"/>',
  vpStop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  vpRetry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  vpHand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6.5 7-2.6 0-4-1.3-5.5-3.6L3.4 13a1.5 1.5 0 0 1 2.4-1.8L8 13.5"/>',
  vpSpeaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  vpExpand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  vpCollapse: '<path d="M20 4l-6.5 6.5M14 4.5V10h5.5M4 20l6.5-6.5M10 19.5V14H4.5"/>',
  vpLock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
});
const LEGACY = { still: 'ready', breathe: 'listening', arrive: 'connecting', off: 'shade' };
// Tints reuse the voice light ramp semantics (cool = listening, violet = your voice / considering, warm = assistant).
const TINT = { listening: [109, 148, 255, 0.10], hearing: [169, 140, 245, 0.14], thinking: [169, 140, 245, 0.16], speaking: [255, 177, 74, 0.10], shade: [245, 139, 168, 0.24] };
const POSE = { // static poses: drawn once, zero scheduled frames
  ready: { reveal: 1, halo: 1 },
  thinking: { reveal: 1, halo: 0.75, tint: TINT.thinking },
  muted: { reveal: 1, halo: 0.25 },
  connecting: { reveal: 0.34, halo: 0.55 },
  eclipse: { reveal: 0.08, halo: 0.5 },
  shade: { reveal: 0.5, halo: 0.45, tint: TINT.shade },
  ended: { reveal: 1, halo: 0.35 },
};
const ANIM = new Set(['listening', 'hearing', 'speaking', 'dawn']);
/* Planet pitch tiers. One dot pitch per size band, so a 16 pt planet never turns into dust (fewer, larger dots below
   ~24 pt). The rest glyph is no longer drawn in dots (VE-02 amendment): only the planet uses these tiers. */
const TIERS = { s: 9, m: 11, l: 14, xl: 19 };
function tier(s) {
  const k = s < 22 ? 's' : s < 28 ? 'm' : s < 40 ? 'l' : 'xl';
  const rows = TIERS[k];
  return { k, rows, pitch: s / rows, glyph: restGlyphSize(s) };
}
/* The rest glyph: Phosphor `Waveform` (regular), the app's icon family, sized like the shipped VoiceMarkRestGlyph. */
const WAVE_PATH = 'M56 96v64a8 8 0 0 1-16 0V96a8 8 0 0 1 16 0m32-72a8 8 0 0 0-8 8v192a8 8 0 0 0 16 0V32a8 8 0 0 0-8-8m40 32a8 8 0 0 0-8 8v128a8 8 0 0 0 16 0V64a8 8 0 0 0-8-8m40 32a8 8 0 0 0-8 8v64a8 8 0 0 0 16 0V96a8 8 0 0 0-8-8m40-16a8 8 0 0 0-8 8v96a8 8 0 0 0 16 0V80a8 8 0 0 0-8-8';
// the five bars in the glyph's 256-unit box: [x, top, bottom]
const WAVE_BARS = [[48, 88, 168], [88, 24, 232], [128, 56, 200], [168, 88, 168], [208, 72, 184]];
function restGlyphSize(s) { return Math.max(16, Math.round(s * 0.62)); }
const wave = (g, style = '') => `<svg class="vp-wave" viewBox="0 0 256 256" width="${g}" height="${g}" style="${style}" aria-hidden="true"><path d="${WAVE_PATH}" fill="currentColor"/></svg>`;
function planet(s = 20, o = {}) {
  const st = LEGACY[o.st] || o.st || 'ready';
  const T = tier(s);
  const pitch = Math.max(1.6, T.pitch); // the planet shares the mic's pitch: the same dots, rearranged
  const opts = { radius: 0.625, pitch, spin: 0.9, size: s };
  if (o.p != null) opts.p = o.p;
  const mx = st === 'muted' ? `<span class="mx" aria-hidden="true">${ic('vpMicOff')}</span>` : '';
  const aria = o.label ? `role="img" aria-label="${o.label}"` : 'aria-hidden="true"';
  // rest: the line glyph only, no canvas, zero frames (VE-02)
  if (st === 'mic') return `<span class="vp mic" style="width:${s}px;height:${s}px" ${aria}>${wave(T.glyph)}</span>`;
  // morph / regather: the glyph fades as its dots stream onto the planet (a static p shows one frame of it)
  const handover = st === 'morph' || st === 'regather';
  const gOp = handover && o.p != null && o.p >= 0 ? `opacity:${(1 - (st === 'regather' ? 1 - o.p : o.p)).toFixed(2)}` : '';
  const g = handover ? wave(T.glyph, gOp) : '';
  return `<span class="vp ${st} ${handover && (o.p == null || o.p < 0) ? 'play' : ''}" style="width:${s}px;height:${s}px" ${aria}><canvas class="db-cv" data-db="voice" data-vstate="${st}" data-o='${JSON.stringify(opts)}'></canvas>${g}${mx}</span>`;
}
const cell = (kind, size = '') => `<span class="db-cell ${kind} ${size}" aria-hidden="true">${'<i></i>'.repeat(8)}</span>`;
function meter(levels = [0.4, 0.8, 0.55, 1, 0.6, 0.35, 0.7], o = {}) {
  const hgt = o.h || 14;
  return `<span class="vp-meter ${o.dir || 'flat'} ${o.live ? 'live' : ''}" style="height:${hgt}px" aria-hidden="true">${levels.map((v) => `<i style="height:${Math.max(2, Math.round(v * hgt))}px"></i>`).join('')}</span>`;
}

/* the one voice scene, consuming the Daybreak engine (D.drawPlanet / D.animate) */
const D = window.DB;
if (D && D.SC) {
  // The shared engine's lab-wide default moved to 'pngDots' (engine.js, 2026-10-06), which needs window.DB_PNG; this page
  // does not load it, so every live planet drew nothing. Pin this page to the dot-dither planet the Brand mark uses.
  if (D.M && D.STYLES && D.STYLES.classic) D.M.style = 'classic';
  const { clamp, mix, easeOut } = D;
  // Lab stand-ins for the real level: phrase-gated syllable envelopes (assistant faster and fuller than the user).
  const level = (st, t) => {
    const phrase = Math.sin(t * 0.9) > -0.3 ? 1 : 0.08;
    if (st === 'speaking') return phrase * (0.45 + 0.55 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1)));
    if (st === 'hearing') return phrase * 0.75 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 2.3 + 0.4));
    return 0.04 + 0.03 * Math.abs(Math.sin(t * 5.7)); // listening in a quiet room: the halo barely stirs
  };
  // The morph is drawn as dots in the Daybreak palette (D.PALETTES … body ramp, top warm → bottom cool): they leave the
  // waveform glyph's five bars and land on the planet. Lab: a 2D dot tween at the planet's pitch. Production: VoiceMark's
  // morph hands the rest glyph to dots that stream out of its place (VoiceMark.tsx, shipped).
  const dotsOf = (el, o) => {
    const T = tier(o.size); const box = o.size; const pad = box * 0.3; // the canvas bleeds 30 % on each side
    const pt = box / T.rows; const R = box / 2; const gs = T.glyph / 256; const g0 = (box - T.glyph) / 2;
    const src = [];
    WAVE_BARS.forEach(([x, top, bottom]) => { const n = Math.max(2, Math.round((bottom - top) * gs / pt)); for (let i = 0; i < n; i++) { const y = top + (bottom - top) * (n === 1 ? 0.5 : i / (n - 1)); src.push({ x: pad + g0 + x * gs, y: pad + g0 + y * gs, t: 0.06 + 0.8 * clamp((y * gs + g0) / box) }); } });
    const disc = [];
    for (let r = 0; r < T.rows + 1; r++) for (let c = 0; c < T.rows + 1; c++) { const x = (c + 0.5) * pt - pt / 2, y = (r + 0.5) * pt - pt / 2; if (Math.hypot(x - R, y - R) <= R - pt * 0.15) disc.push({ x: pad + x, y: pad + y, t: 0.04 + 0.86 * clamp(y / box) }); }
    const ang = (d) => Math.atan2(d.y - pad - R, d.x - pad - R);
    const ss = [...src].sort((a, b) => ang(a) - ang(b)), ds = [...disc].sort((a, b) => ang(a) - ang(b));
    return { T, pt, pairs: ds.map((d, i) => ({ a: ss[Math.floor(i * ss.length / ds.length)], b: d })) };
  };
  const drawDots = (el, o, p) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); const w = Math.round(el.clientWidth * dpr), h = Math.round(el.clientHeight * dpr);
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
    const ctx = el.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    if (p <= 0) return; // at p = 0 only the glyph shows
    const th = D.themeOf(el); const body = D.PALETTES[th].body; const geo = el._geo || (el._geo = dotsOf(el, o));
    const col = (t) => { const c = D.gradient(body, th === 'light' ? Math.min(1, t * 0.92 + 0.04) : t); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };
    const r0 = geo.pt * 0.18, rDisc = geo.pt * 0.33;
    const e = D.easeInOut(clamp(p));
    ctx.globalAlpha = clamp(e * 1.6);
    geo.pairs.forEach(({ a, b }) => { ctx.fillStyle = col(mix(a.t, b.t, e)); ctx.beginPath(); ctx.arc(mix(a.x, b.x, e), mix(a.y, b.y, e), mix(r0, rDisc, e), 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
  };
  D.SC.voice = (el, o) => {
    const st = el.dataset.vstate || 'ready';
    if (st === 'morph' || st === 'regather') {
      if (o.p != null && o.p >= 0) { drawDots(el, o, st === 'regather' ? 1 - o.p : o.p); return null; }
      return D.animate(el, (t) => { const k = clamp(t / 0.55); drawDots(el, o, st === 'regather' ? 1 - k : k); if (k >= 1) return false; }, { fps: 60, settle: 0.55 });
    }
    if (!ANIM.has(st)) { D.drawPlanet(el, { ...o, ...(POSE[st] || POSE.ready) }); return null; }
    if (st === 'dawn') { // Event: crescent → full light, once, 1.2 s, then still
      return D.animate(el, (t) => { const k = easeOut(clamp(t / 1.2)); D.drawPlanet(el, { ...o, reveal: mix(0.34, 1, k), halo: mix(0.55, 1, k), pulse: Math.sin(k * Math.PI) * 0.35 }); if (k >= 1) return false; }, { fps: 60, settle: 1.2 });
    }
    let env = 0;
    return D.animate(el, (t) => {
      env = env * 0.72 + level(st, t + (o.phase || 0)) * 0.28;
      D.drawPlanet(el, { ...o, reveal: 1, pulse: env * 1.1, breath: env * 0.6, halo: 0.8 + env * 0.7, tint: TINT[st] });
    }, { fps: 30, settle: 0.05 });
  };
}
window.VP = { planet, cell, meter, tier };
})();
