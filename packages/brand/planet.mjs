/**
 * Dependency-free Happier planet owner, shared by terminal/installer projections
 * and the existing voice, onboarding and website artwork tokens.
 *
 * The planet is a lit sphere sampled at Braille resolution: every terminal cell holds
 * a 2x4 dot grid, the Braille character is the set of lit dots and the cell colour is
 * the mean of their shading. Palettes are sampled from the onboarding planet artwork
 * (apps/ui/sources/assets/onboarding/planet-{dark,light}.jpg).
 *
 * Choreography is part of the frame so every caller shows the same planet: it rises
 * out of an eclipse, turns while the welcome lands, comes to rest, and from then on
 * only breathes, slowly enough to signal "alive" without drawing the eye.
 */

/** Terminal cells are roughly 2.2 times taller than wide. */
const CELL_ASPECT = 2.2;
const DOT_WIDTH = 0.5;
const DOT_HEIGHT = CELL_ASPECT / 4;
const MIN_COLUMNS = 8;
const MAX_COLUMNS = 40;

/** One full, calm breath. */
export const PLANET_BREATH_SECONDS = 9.6;
/** Redraw cadence while the planet rises and turns. */
export const PLANET_FRAME_INTERVAL_MS = 66;
/** Redraw cadence once it only breathes: a slow breath needs no more. */
export const PLANET_BREATH_FRAME_INTERVAL_MS = 200;
const INTRO_SECONDS = 1.9;
const SPIN_SPEED = 0.55;
const SPIN_REST_SECONDS = 6;

/** How long an animating caller should wait before its next frame, `seconds` after the planet appeared. */
export function planetFrameIntervalMs(seconds) {
  return seconds < SPIN_REST_SECONDS ? PLANET_FRAME_INTERVAL_MS : PLANET_BREATH_FRAME_INTERVAL_MS;
}
/** A pose at rest, half-way through a breath: used for static renderings. */
const SETTLED_SECONDS = PLANET_BREATH_SECONDS * 0.75;
/** How far a dimmed planet recedes towards the terminal background. */
const DIM_OPACITY = 0.38;

export const PLANET_PALETTES = {
  dark: {
    // Existing artwork projections stay unchanged until the voice labs redesign them.
    orb: { core: '#1343A7', gold: '#FFA135', amber: '#FEBA3F', ember: '#DF5145', plum: '#31186B', azure: '#2A5BC4', abyss: '#01041E' },
    voiceField: 'rgba(109,148,255,0.05)',
    horizon: {
      skyGradient: 'linear-gradient(180deg, #050508 0%, #0A0A10 100%)',
      backgroundColor: '#050508', backgroundColorTransparent: 'rgba(5,5,8,0)',
      atmosphereColor: 'rgba(109,148,255,.28)', bloomColor: 'rgba(255,177,74,.18)',
      dividerColor: 'rgba(255,177,74,.08)',
    },
    websiteScrim: 'linear-gradient(to right, #050507 0%, rgba(5,5,7,0.92) 35%, rgba(5,5,7,0.45) 70%, rgba(5,5,7,0) 100%)',
    background: [18, 19, 24],
    body: [
      [0, [255, 238, 150]], [0.12, [255, 204, 84]], [0.26, [254, 150, 52]], [0.38, [240, 99, 55]],
      [0.48, [204, 64, 88]], [0.57, [124, 42, 112]], [0.63, [60, 50, 150]], [0.71, [30, 86, 196]],
      [0.82, [40, 110, 214]], [0.92, [14, 60, 170]], [1, [8, 30, 110]],
    ],
    rose: [196, 58, 132],
    attention: [224, 182, 90],
    rim: [255, 214, 120],
    halo: [[0, [255, 190, 90]], [0.5, [214, 80, 110]], [1, [40, 70, 170]]],
  },
  light: {
    orb: { core: '#A6C7FD', gold: '#FEC460', amber: '#FFD8A0', ember: '#FEBF9E', plum: '#F4B5E2', violet: '#C8BBFF', azure: '#79A0FD', veil: '#FFFFFF' },
    voiceField: 'rgba(109,148,255,0.06)',
    horizon: {
      skyGradient: 'linear-gradient(180deg, #FAF9F7 0%, #F3EDE6 100%)',
      backgroundColor: '#FAF9F7', backgroundColorTransparent: 'rgba(250,249,247,0)',
      atmosphereColor: 'rgba(255,177,74,.24)', bloomColor: 'rgba(255,177,74,.20)',
      dividerColor: 'rgba(255,177,74,.14)',
    },
    websiteScrim: 'none',
    background: [251, 250, 249],
    body: [
      [0, [255, 204, 104]], [0.14, [252, 178, 84]], [0.28, [248, 150, 108]], [0.4, [242, 132, 150]],
      [0.5, [226, 124, 196]], [0.6, [180, 128, 236]], [0.7, [124, 142, 246]], [0.82, [88, 124, 240]],
      [1, [120, 152, 244]],
    ],
    rose: [230, 120, 190],
    attention: [148, 82, 0],
    rim: [250, 184, 90],
    halo: [[0, [250, 190, 100]], [0.5, [236, 150, 210]], [1, [130, 156, 246]]],
  },
};

const BRAILLE_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]];
// 4x4 ordered-dither thresholds: sparse regions thin out without flickering.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);
const COS_TILT = Math.cos(0.38);
const SIN_TILT = Math.sin(0.38);

const clamp = (value, low = 0, high = 1) => (value < low ? low : value > high ? high : value);
const smooth = (value) => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function gradient(stops, position, into) {
  const t = clamp(position);
  for (let index = 1; index < stops.length; index += 1) {
    const [end, to] = stops[index];
    if (t <= end) {
      const [start, from] = stops[index - 1];
      const progress = (t - start) / (end - start);
      if (!into) return mixRgb(from, to, progress);
      for (let channel = 0; channel < 3; channel++) into[channel] = mix(from[channel], to[channel], progress);
      return into;
    }
  }
  return stops[stops.length - 1][1];
}

function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function normalize([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

const clampColumns = (columns) => Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(columns ?? 28)));

export function planetRowsForColumns(columns) {
  return Math.ceil(clampColumns(columns) / CELL_ASPECT);
}

/** Calm breathing: a plain sine from fully exhaled (0) to fully inhaled (1). */
function breathAt(seconds) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * (seconds % PLANET_BREATH_SECONDS)) / PLANET_BREATH_SECONDS);
}

/** Turns at SPIN_SPEED, decelerating evenly until it rests at SPIN_REST_SECONDS. */
function spinAt(seconds) {
  const t = Math.min(seconds, SPIN_REST_SECONDS);
  return SPIN_SPEED * (t - (t * t) / (2 * SPIN_REST_SECONDS));
}

/** The single light/detail/dither sampler used by terminal cells and app dots. */
function samplePlanetDot(px, py, dx, dy, sample) {
  const shaded = shadePlanetDot(px, py, dx, dy, sample);
  return shaded.lit ? shaded.rgb : null;
}

/** The sampler's colour for a cell, lit or not (a mark slot keeps its colour while a level lights it). */
export function shadePlanetDot(px, py, dx, dy, { palette, light, reveal, breath, spin, glow, reach, gamma = 1, fleck: fleckShare = 0.06 /* lab: */, detail: detailK = 1 /* lab: */, full = 0 /* lab: */, fleckDot = false /* lab: */, bandStrength = 0.07, dusk = 0 }) {
  const distanceSquared = px * px + py * py;
  const threshold = BAYER[(dy & 3) * 4 + (dx & 3)];
  if (distanceSquared >= 1) {
    const r = Math.sqrt(distanceSquared);
    const altitude = r - 1;
    const facing = clamp(((px * light[0] + py * light[1]) / r) * 0.8 + 0.35);
    const density = glow * facing * Math.exp(-altitude * reach) * 0.9 * clamp(reveal * 1.4);
    const colour = gradient(palette.halo, clamp((py + 1) / 2 - px * 0.2));
    return { rgb: mixRgb(palette.background, colour, 0.45 + 0.55 * Math.exp(-altitude * 5)), lit: density > threshold + 0.02 };
  }
  const pz = Math.sqrt(1 - distanceSquared);
  const lambert = px * light[0] + py * light[1] + pz * light[2];
  const day0 = smooth((lambert + 0.42) / 1.05);
  const day = full ? mix(day0, 0.6 + 0.4 * day0, full) : day0; // lab: fullness lifts the night side to a soft terminator shade
  const rimFacing = clamp(((px * light[0] + py * light[1]) / Math.max(0.2, Math.sqrt(distanceSquared))) * 1.2 + 0.1);
  const rim = (1 - pz) ** 2.6 * rimFacing * (0.6 + 0.4 * reveal);
  const qy = py * COS_TILT - px * SIN_TILT;
  const qx = px * COS_TILT + py * SIN_TILT;
  const longitude = Math.atan2(qx, pz) + spin;
  const latitude = Math.asin(clamp(qy, -1, 1));
  const bands = Math.sin(latitude * 7 + Math.sin(longitude * 2 + latitude * 3) * 0.9) * 0.5 + 0.5;
  const grain = hash(Math.floor((longitude / (Math.PI * 2)) * 180 + 1000), Math.floor(latitude * 40 + 100));
  const detail = 1 + ((bands - 0.5) * bandStrength + (grain - 0.5) * 0.12) * detailK;
  let colour = gradient(palette.body, clamp(0.44 + py * 0.6 - px * 0.12 + dusk * 0.3));
  colour = mixRgb(colour, palette.rose, clamp(-px * 0.35) * (1 - Math.abs(py)));
  colour = mixRgb(palette.background, colour, clamp(day * detail * (1 + 0.08 * breath)) ** gamma);
  colour = mixRgb(colour, palette.rim, clamp(rim * 1.1));
  // lab: beyond the product's sizes a surface cell spans several dots, so flecks would cluster; there each fleck is ONE
  // lattice dot, scattered, at the share the product shows at 160 px (a fleck cell drops about half of its dots)
  const fleck = fleckDot ? (hash(dx * 7 + 3, dy * 13 + 5) < fleckShare * 0.5 ? 1 : 0) : (grain < fleckShare ? 0.5 : 0);
  return { rgb: colour, lit: !(clamp(day * 1.25 + rim * 2 + full * 0.3) - fleck < threshold) };
}

export function createPlanetFrame(options = {}) {
  const columns = clampColumns(options.columns);
  const rows = planetRowsForColumns(columns);
  const palette = PLANET_PALETTES[options.theme === 'light' ? 'light' : 'dark'];
  const seconds = Math.max(0, options.seconds ?? SETTLED_SECONDS);
  const reveal = options.intro === false ? 1 : smooth(seconds / INTRO_SECONDS);
  const breath = breathAt(seconds);
  const spin = spinAt(seconds);
  const opacity = mix(1, DIM_OPACITY, clamp(options.dim ?? 0));

  // The light swings from behind the planet (eclipse) to its resting upper-right key.
  const light = normalize([mix(0.35, 0.78, reveal), mix(-0.2, -0.42, reveal), mix(-0.95, 0.5, smooth(reveal))]);
  const width = columns;
  const height = rows * CELL_ASPECT;
  const radius = 0.74 * (0.965 + 0.035 * breath) * (Math.min(width, height) / 2);
  const glow = 1 + 0.5 * breath;
  const reach = 7 - 2 * breath;
  const sample = { palette, light, reveal, breath, spin, glow, reach };

  const dotColumns = columns * 2;
  const dotRows = rows * 4;
  const lit = new Array(dotColumns * dotRows).fill(null);

  for (let dy = 0; dy < dotRows; dy += 1) {
    for (let dx = 0; dx < dotColumns; dx += 1) {
      const px = ((dx + 0.5) * DOT_WIDTH - width / 2) / radius;
      const py = ((dy + 0.5) * DOT_HEIGHT - height / 2) / radius;
      lit[dy * dotColumns + dx] = samplePlanetDot(px, py, dx, dy, sample);
    }
  }

  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    let bits = 0;
    let count = 0;
    const sum = [0, 0, 0];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        const colour = lit[(row * 4 + y) * dotColumns + column * 2 + x];
        if (!colour) continue;
        bits |= BRAILLE_BITS[y][x];
        count += 1;
        sum[0] += colour[0]; sum[1] += colour[1]; sum[2] += colour[2];
      }
    }
    if (bits === 0) return null;
    const rgb = mixRgb(palette.background, [sum[0] / count, sum[1] / count, sum[2] / count], opacity)
      .map((channel) => Math.round(clamp(channel, 0, 255)));
    return { ch: String.fromCharCode(0x2800 + bits), rgb };
  }));
}

// Approved voice-lab masks, sampled once here rather than rebuilt in each renderer.
const MIC_SMALL = ['..###..', '..###..', '..###..', '#.###.#', '#.###.#', '.#...#.', '..###..', '...#...', '..###..'];
const MIC_MEDIUM = ['...###...', '..#####..', '..#####..', '..#####..', '#.#####.#', '#.#####.#', '#..###..#', '.#.....#.', '..#####..', '....#....', '..#####..'];
const MIC_LARGE = ['....###....', '...#####...', '...#####...', '...#####...', '...#####...', '.#.#####.#.', '.#.#####.#.', '.#..###..#.', '.##.....##.', '..##...##..', '...#####...', '.....#.....', '.....#.....', '...#####...'];
const MIC_XL = Array.from({ length: 19 }, (_, row) => Array.from({ length: 15 }, (_, column) => {
  const x = (column + 0.5) / 15;
  const y = (row + 0.5) / 19;
  const cap = Math.abs(x - 0.5) <= 0.17 && y >= 0.02 && y <= 0.6
    && (y >= 0.16 || Math.hypot(x - 0.5, y - 0.16) <= 0.17)
    && (y <= 0.46 || Math.hypot(x - 0.5, y - 0.46) <= 0.17);
  const d = Math.hypot((x - 0.5) / 0.92, y - 0.44);
  const holder = y >= 0.38 && y <= 0.8 && d >= 0.27 && d <= 0.36 + 0.5 / 19;
  const stem = Math.abs(x - 0.5) <= 0.5 / 15 + 0.01 && y > 0.79 && y < 0.93;
  const base = Math.abs(x - 0.5) <= 0.21 && y >= 0.92;
  return cap || holder || stem || base ? '#' : '.';
}).join(''));

function markMask(size) {
  return size < 22 ? MIC_SMALL : size < 28 ? MIC_MEDIUM : size < 40 ? MIC_LARGE : MIC_XL;
}

export function planetMarkTier(size = 24) {
  const mask = markMask(size);
  return { columns: mask[0].length, rows: mask.length, pitch: size / mask.length,
    micDots: mask.join('').split('#').length - 1 };
}

/**
 * Dots on white paper cover under half of each cell, so at the artwork's pastel saturation they read
 * washed out (Daybreak lab note). Light-theme dots keep each colour's hue and brightest channel and
 * deepen the rest by the lab-measured factor; dark-theme dots and terminal frames are unchanged.
 */
const LIGHT_DOT_INK = 1.4;
function inkDot(rgb, theme) {
  if (theme !== 'light') return rgb;
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  return rgb.map((channel) => clamp(peak - (peak - channel) * LIGHT_DOT_INK, 0, 255));
}

export function createMicDots({ size = 24, theme = 'dark' } = {}) {
  const mask = markMask(size);
  const { columns, rows, pitch } = planetMarkTier(size);
  const palette = PLANET_PALETTES[theme === 'light' ? 'light' : 'dark'];
  const dots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (mask[row][column] !== '#') continue;
      dots.push({ id: row * columns + column,
        x: (size - columns * pitch) / 2 + (column + 0.5) * pitch,
        y: (row + 0.5) * pitch, radius: pitch * 0.4,
        rgb: inkDot(gradient(palette.body, 0.06 + 0.8 * row / (rows - 1)), theme).map(Math.round), opacity: 1 });
    }
  }
  return dots;
}

/** Hero art (setup, onboarding) keeps the Daybreak pitch rather than stretching the largest mark tier. */
const HERO_DOT_PITCH = 3.2;

function planetLattice(size) {
  const tier = planetMarkTier(size);
  const rows = Math.max(tier.rows, Math.round(size / HERO_DOT_PITCH));
  return { rows, pitch: size / rows };
}

/**
 * The terminator for explicit progress (0 night → 1 full day), Daybreak's readiness grammar:
 * the caller passes only facts it observed (steps really finished); nothing here advances by time.
 */
export function planetLightForProgress(progress) {
  const p = Number.isFinite(progress) ? clamp(progress) : 0;
  const eased = p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2;
  const angle = mix(-2.2, 0.62, eased);
  return normalize([Math.sin(angle) * 0.95, -0.38, Math.cos(angle)]);
}

/**
 * The Daybreak voice grammar's atmosphere for a real audio level (lab `voice-planet.js`: halo
 * 0.8 + 0.7·e, breath 0.6·e, pulse 1.1·e on the dot shader): density and reach grow together, so a
 * voice throws dots past the limb while a quiet room keeps only the resting halo. Level only — no
 * time term, so silence is still.
 */
function atmosphereForEnergy(energy) {
  const halo = 0.8 + energy * 0.7;
  const breath = energy * 0.6;
  const pulse = energy * 1.1;
  return { glow: halo * (1 + breath * 0.6) * (1 + pulse * 1.6), reach: 7 - breath * 2 - pulse * 2.5 };
}

/**
 * Explicit poses; no readiness decisions or time-derived production amplitude.
 *
 * `bleed` (a fraction of the box per side, e.g. 0.3) is the live mark's geometry (see
 * `createLiveMarkDots`). Without it the planet sits inside the box (hero/readiness art).
 */
function createPlanetDotSlots({ size = 24, theme = 'dark', pose = 'ready', energy = 0, light, bleed = 0, rows: latticeRows, halo = 1, warmth = 0 } = {}) {
  const amplitude = Number.isFinite(energy) ? clamp(energy) : 0;
  if (Number.isFinite(bleed) && bleed > 0) return createLiveMarkDots({ size, theme, pose, amplitude, light, bleed });
  // Scene art keeps a finer lattice than a mark of the same box (`rows`), a quieter halo and, at golden
  // hour, a warmer body; the sampler, palette and light are the same planet.
  const { rows, pitch } = Number.isFinite(latticeRows) && latticeRows > 0
    ? { rows: Math.round(latticeRows), pitch: size / Math.round(latticeRows) }
    : planetLattice(size);
  const palette = PLANET_PALETTES[theme === 'light' ? 'light' : 'dark'];
  const sample = planetSample(palette, pose, light, amplitude, Number.isFinite(halo) ? Math.max(0, halo) : 1);
  const warm = Number.isFinite(warmth) ? clamp(warmth) : 0;
  const radius = size * 0.4;
  return Array.from({ length: rows * rows }, (_, id) => {
    const column = id % rows;
    const row = Math.floor(id / rows);
    const x = (column + 0.5) * pitch;
    const y = (row + 0.5) * pitch;
    const px = (x - size / 2) / radius;
    const py = (y - size / 2) / radius;
    const distance = Math.hypot(px, py);
    let rgb = samplePlanetDot(px, py, column, row, sample);
    // App dots sit on any surface, so an atmosphere dot carries its halo colour and fades by opacity
    // rather than by being pre-mixed into one background (terminal cells keep the mixed colour).
    let opacity = rgb ? 1 : 0;
    if (rgb && distance >= 1) {
      rgb = gradient(palette.halo, clamp((py + 1) / 2 - px * 0.2));
      opacity = haloOpacity(theme, distance);
    }
    if (rgb && pose === 'shade') rgb = mixRgb(rgb, palette.rose, 0.24);
    if (rgb && warm > 0) rgb = mixRgb(rgb, palette.rim, warm);
    return { id, x, y, radius: pitch * 0.33, rgb: (rgb ? inkDot(rgb, theme) : palette.background).map(Math.round), opacity };
  });
}

/** Existing mark projection delegates to the scene owner, retaining every invisible lattice slot. */
export function createPlanetDots(options = {}) {
  return planetScene(options, 'mark');
}

/**
 * The failed pose's partial shade on the smallest mark tier (7×9, 16–20pt): there the half-reveal
 * crescent is a handful of dots and, with no status word beside it (composer, Orb), reads as the mark
 * vanishing. That tier keeps ≥ 40 % of its disc lit; larger tiers keep the lab's half-reveal.
 */
const SHADE_REVEAL = 0.5;
const SHADE_REVEAL_COMPACT = 0.58;
const COMPACT_MARK_ROWS = 9;

function planetSample(palette, pose, light, amplitude, haloScale = 1, compact = false) {
  const reveal = pose === 'eclipse' ? 0.08 : pose === 'shadow' ? 0.34
    : pose === 'shade' ? (compact ? SHADE_REVEAL_COMPACT : SHADE_REVEAL) : 1;
  const atmosphere = atmosphereForEnergy(amplitude);
  return { palette, reveal, breath: 0, spin: spinAt(SPIN_REST_SECONDS),
    light: normalize(light ?? [mix(0.35, 0.78, reveal), mix(-0.2, -0.42, reveal), mix(-0.95, 0.5, smooth(reveal))]),
    glow: atmosphere.glow * haloScale, reach: atmosphere.reach };
}

/** Paper needs more presence than a dark sky for the same falloff (Daybreak light-theme ink). */
function haloOpacity(theme, distance) {
  return (theme === 'light' ? 0.7 : 0.45) + (theme === 'light' ? 0.3 : 0.55) * Math.exp(-(distance - 1) * 5);
}

/** The voice scene's halo per static pose, relative to a live conversation's resting halo (lab `voice-planet.js` POSE). */
const LIVE_MARK_POSE_HALO = { ready: 1, shadow: 0.55 / 0.8, eclipse: 0.5 / 0.8, shade: 0.45 / 0.8 };
/** Lab dot shader: a sphere dot covers 0.39 of the pitch; atmosphere dots shrink with altitude. */
const LIVE_MARK_DOT = 0.39;

/**
 * Readiness art (an explicit light) follows the Daybreak size→pitch rule; the live mark keeps the
 * microphone's legibility tier so its dots can gather from the mic's.
 */
function liveMarkPitch(size, light) {
  return light ? Math.max(1.3, Math.min(3.2, size / 13)) : planetLattice(size).pitch;
}

/**
 * The live mark is the lab's voice planet (Daybreak dot shader, `voice-planet.js`): the lattice is
 * the bleeding canvas's own (origin at its edge, so the limb never lands on one long flat row), the
 * sphere sits at 0.94 of the half box and swells with the voice's breath, and the atmosphere has the
 * canvas around the box to spread into. Every slot keeps its colour while unlit, so a level that
 * lights an atmosphere dot shows its halo colour, never a background-coloured hole.
 */
function createLiveMarkDots({ size, theme, pose, amplitude, light, bleed }) {
  const pitch = liveMarkPitch(size, light);
  const origin = -bleed * size;
  const rows = Math.ceil((size * (1 + 2 * bleed)) / pitch);
  const palette = PLANET_PALETTES[theme === 'light' ? 'light' : 'dark'];
  // On paper a readiness planet's lit rim keeps its colour (the lab's light-theme gamma 0.55).
  const compact = !light && planetMarkTier(size).rows <= COMPACT_MARK_ROWS;
  const sample = { ...planetSample(palette, pose, light, amplitude, LIVE_MARK_POSE_HALO[pose] ?? 1, compact),
    gamma: light && theme === 'light' ? 0.55 : 1 };
  const radius = (size / 2) * (0.94 + amplitude * 0.6 * 0.06);
  // The atmosphere stays inside the circle the canvas can hold, so it never shows the lattice's corners.
  const edge = (size * (0.5 + bleed)) / radius - 0.05;
  return Array.from({ length: rows * rows }, (_, id) => {
    const column = id % rows;
    const row = Math.floor(id / rows);
    const x = origin + (column + 0.5) * pitch;
    const y = origin + (row + 0.5) * pitch;
    const px = (x - size / 2) / radius;
    const py = (y - size / 2) / radius;
    const distance = Math.hypot(px, py);
    if (distance > edge) return { id, x, y, radius: pitch * LIVE_MARK_DOT, rgb: palette.background.map(Math.round), opacity: 0 };
    const shaded = shadePlanetDot(px, py, column, row, sample);
    let rgb = shaded.rgb;
    let opacity = shaded.lit ? 1 : 0;
    let dot = LIVE_MARK_DOT;
    if (distance >= 1) {
      rgb = gradient(palette.halo, clamp((py + 1) / 2 - px * 0.2));
      if (shaded.lit) opacity = haloOpacity(theme, distance);
      dot = LIVE_MARK_DOT * (0.72 + 0.28 * (0.45 + 0.55 * Math.exp(-(distance - 1) * 5)));
    }
    if (pose === 'shade') rgb = mixRgb(rgb, palette.rose, 0.24);
    return { id, x, y, radius: pitch * dot, rgb: inkDot(rgb, theme).map(Math.round), opacity };
  });
}

/** Map each mic sample once; additional sphere/halo dots fade from invisible endpoints. */
export function createPlanetDotCorrespondence(options = {}) {
  const mic = createMicDots(options);
  const planet = createPlanetDots(options);
  const assigned = new Map();
  for (const dot of mic) {
    let nearest = null;
    let distance = Infinity;
    for (const target of planet) {
      if (assigned.has(target.id)) continue;
      const next = (target.x - dot.x) ** 2 + (target.y - dot.y) ** 2;
      if (next < distance) { nearest = target; distance = next; }
    }
    assigned.set(nearest.id, dot);
  }
  // Residual slots stream out of the microphone: like the lab's angle-sorted pairing, each takes the
  // microphone dot at the same rank around the centre, so the tap fans the microphone out into the
  // disc (dots cross and dissolve) rather than swelling it in place.
  const centre = (options.size ?? 24) / 2;
  const angle = (dot) => Math.atan2(dot.y - centre, dot.x - centre);
  const micByAngle = [...mic].sort((a, b) => angle(a) - angle(b) || a.id - b.id);
  const residual = planet.filter((dot) => !assigned.has(dot.id)).sort((a, b) => angle(a) - angle(b) || a.id - b.id);
  const sourceOf = new Map(residual.map((dot, index) => [dot.id, micByAngle[Math.floor((index * micByAngle.length) / residual.length)]]));
  return planet.map((dot) => ({ id: dot.id, mic: assigned.get(dot.id) ?? { ...sourceOf.get(dot.id), id: dot.id, opacity: 0 }, planet: dot }));
}

/** 2×4 semantic cell; progress is supplied by the existing presentation clock. */
export function createPlanetStatusCell({ kind, size = 14, theme = 'dark', progress } = {}) {
  const palette = PLANET_PALETTES[theme === 'light' ? 'light' : 'dark'];
  const p = Number.isFinite(progress) ? clamp(progress) : null;
  const perimeter = [0, 1, 3, 5, 7, 6, 4, 2];
  const lead = p === null ? 0 : Math.min(7, Math.floor(p * 8));
  // "Needs you" is the attention amber everywhere it appears; rose is reserved for failure (the shade pose).
  const colour = kind === 'needs_you' ? palette.attention : kind === 'thinking' ? gradient(palette.body, 0.6) : palette.rim;
  const pitch = size / 4;
  return Array.from({ length: 8 }, (_, id) => {
    const row = Math.floor(id / 2);
    let opacity = 0.16;
    if (kind === 'needs_you' && (row === 1 || row === 2)) opacity = 1;
    else if (kind === 'working' && (id === perimeter[lead] || id === perimeter[(lead + 1) % 8])) opacity = 1;
    else if (kind === 'thinking' && row === (p === null ? 2 : 3 - Math.min(3, Math.floor(p * 4)))) opacity = 1;
    else if (kind === 'done') opacity = p === null || p >= (row + 1) / 4 ? 0.9 : 0.16;
    else if (kind === 'idle' && row === 3) opacity = 0.7;
    else if (kind === 'off') opacity = 0;
    return { id, x: (id % 2 + 0.5) * pitch, y: (row + 0.5) * pitch,
      radius: pitch * 0.3, rgb: colour.map(Math.round), opacity };
  });
}

/** Existing artwork's warm-to-cool atmosphere, shared by voice and onboarding. */
export const PLANET_LIGHT_RAMP = {
  warm: '#FFB14A', blush: '#F58BA8', violet: '#A98CF5', cool: '#6D94FF', deep: '#4A5CC7',
};
/** The static artwork's existing motion recipe; the dot projection has its own sampled breath above. */
export const PLANET_ARTWORK_BREATH = { durationMs: 20_000, scalePeak: 1.012, bloomOpacityDelta: 0.1 };
export const PLANET_GRAIN = { opacity: 0.02, tileSize: 16 };
export const PLANET_ACCENT_HEX = '#d6a24a';

/**
 * "Needs you": the one attention amber per theme, shared by the status cell, scene beacons and the app
 * theme's `state.attention` (a deep amber on paper so its label stays AA on its own tint).
 */
export const PLANET_ATTENTION_HEX = Object.freeze({ light: '#945200', dark: '#E0B65A' });

/**
 * Real audio levels a live mark's atmosphere is sampled at, once per pose. A renderer follows the
 * live level by blending the two neighbouring samples instead of asking this model every frame.
 */
export const PLANET_MARK_ENERGY_SAMPLES = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
/** The live mark's canvas bleeds 30 % per side (lab), so the atmosphere never shrinks the planet. */
export const PLANET_MARK_BLEED = 0.3;
/** Atmosphere tint at full voice: violet while the person is heard, warm while the assistant speaks. */
const MARK_TINT_MAX = 0.14;
/** A streaming dot is fully drawn once the tap has run this long (raw progress), so the rest mic stays exact. */
const MARK_STREAM_EMERGE = 0.125;
/** The light resolves over the last part of the tap (lab: the morph lands on an unlit disc, then the planet lights). */
const MARK_LIGHT_FROM = 0.8;
/** The morph's disc dot (lab `voice-planet.js`: 0.33 of the pitch; the microphone's is 0.4). */
const MARK_DISC_DOT = 0.33;
/**
 * One real-event transform (lab `screens-voice-moments.js` vmGather / vmLeave): dots gathering into
 * the planet when a first conversation succeeds or a conversation arrives here, and dots leaving when
 * this device lets a conversation go. The caller eases its progress over this many seconds, once.
 */
export const PLANET_MARK_EVENT_SECONDS = 1.2;
/** Lab scatter at the start of a gather (0.9) and at the end of a leave (0.7), in sphere radii x (0.2 + hash). */
const MARK_GATHER_SCATTER = 0.9;
const MARK_LEAVE_SCATTER = 0.7;
/** A leave's planet is gone by 70 % and the rest microphone resolves over its second half. */
const MARK_LEAVE_FADE_FROM = 0.1;
const MARK_LEAVE_FADE_TO = 0.7;
const MARK_LEAVE_MIC_FROM = 0.5;
/** The app's rest glyph has handed over to the streaming dots by 30 % of the tap morph. */
const MARK_REST_HANDOFF = 0.3;

/**
 * How visible an app's rest glyph (the line waveform, VE-02 2026-10-10) is over the mark's dots: it
 * fades out while the tap's dots stream out of its place, fades back as the End regather lands, and
 * returns over a leave's second half, as the dispersed planet is gone.
 */
export function planetMarkRestGlyphOpacity(morph, leave) {
  'worklet';
  const m = morph <= 0 ? 0 : morph >= MARK_REST_HANDOFF ? 1 : morph / MARK_REST_HANDOFF;
  const away = 1 - m * m * (3 - 2 * m);
  const l = leave <= MARK_LEAVE_MIC_FROM ? 0 : leave >= 1 ? 1 : (leave - MARK_LEAVE_MIC_FROM) / (1 - MARK_LEAVE_MIC_FROM);
  const back = l * l * (3 - 2 * l);
  return away > back ? away : back;
}

const unitRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
};

/**
 * One renderer-ready mark: the rest microphone, the unlit disc the tap morph lands on, and the
 * planet at one pose (sampled at each real-energy level) on the same stable lattice, flattened into
 * plain number arrays so a painter (Skia on the UI thread, a 2D canvas on the web) can draw any
 * frame without allocating or calling back into this model.
 */
export function createPlanetMarkGeometry({ size = 24, theme = 'dark', pose = 'ready', light } = {}) {
  const options = { size, theme, pose, light, bleed: PLANET_MARK_BLEED };
  const pairs = createPlanetDotCorrespondence({ ...options, energy: 0 });
  const pitch = liveMarkPitch(size, light);
  const palette = PLANET_PALETTES[theme === 'light' ? 'light' : 'dark'];
  const geometry = {
    size, count: pairs.length, minX: 0, minY: 0, maxX: size, maxY: size,
    micX: [], micY: [], micR: [], micA: [], micRgb: [],
    discA: [], discR: pitch * MARK_DISC_DOT, discRgb: [],
    planetX: [], planetY: [], planetR: [], planetRgb: [], planetA: [],
    tintIn: unitRgb(PLANET_LIGHT_RAMP.violet), tintOut: unitRgb(PLANET_LIGHT_RAMP.warm),
  };
  for (const { mic, planet } of pairs) {
    geometry.micX.push(mic.x); geometry.micY.push(mic.y); geometry.micR.push(mic.radius); geometry.micA.push(mic.opacity);
    geometry.micRgb.push(mic.rgb[0] / 255, mic.rgb[1] / 255, mic.rgb[2] / 255);
    geometry.planetX.push(planet.x); geometry.planetY.push(planet.y); geometry.planetR.push(planet.radius);
    // The disc the tap lands on: every cell inside the box's circle, coloured down the body ramp like the microphone.
    geometry.discA.push(Math.hypot(planet.x - size / 2, planet.y - size / 2) <= size / 2 - pitch * 0.15 ? 1 : 0);
    const disc = inkDot(gradient(palette.body, 0.04 + 0.86 * clamp(planet.y / size)), theme);
    geometry.discRgb.push(disc[0] / 255, disc[1] / 255, disc[2] / 255);
    for (const dot of [mic, planet]) {
      geometry.minX = Math.min(geometry.minX, dot.x - dot.radius); geometry.minY = Math.min(geometry.minY, dot.y - dot.radius);
      geometry.maxX = Math.max(geometry.maxX, dot.x + dot.radius); geometry.maxY = Math.max(geometry.maxY, dot.y + dot.radius);
    }
  }
  for (const energy of PLANET_MARK_ENERGY_SAMPLES) {
    const byId = new Map(createPlanetDots({ ...options, energy }).map((dot) => [dot.id, dot]));
    for (const pair of pairs) {
      const dot = byId.get(pair.id);
      geometry.planetA.push(dot?.opacity ?? 0);
      const rgb = dot?.rgb ?? pair.planet.rgb;
      geometry.planetRgb.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }
  }
  return Object.freeze(geometry);
}

/**
 * Capture the displayed pose shading on the same mark lattice, including every energy sample.
 * Retargeting can start here without rounding the light back to either semantic endpoint.
 */
export function interpolatePlanetMarkGeometry(to, from, progress) {
  const k = clamp(progress);
  if (k === 0) return from;
  if (k === 1) return to;
  return Object.freeze({
    ...to,
    planetA: to.planetA.map((value, i) => mix(from.planetA[i], value, k)),
    planetRgb: to.planetRgb.map((value, i) => mix(from.planetRgb[i], value, k)),
  });
}

/**
 * One frame of a mark, as dots, for any painter. `morph` 0 is the exact microphone and 1 the exact
 * planet: the microphone's dots (and the extra dots streaming out of it) travel, eased, onto an
 * unlit disc, and the light resolves over the last part of the tap (a reversal from mid-way stays
 * smooth); `pose` blends `from` → `to` (same lattice, colour and visibility only); `energy` is the
 * real level and `flow` its direction (< 0 the person, > 0 the assistant). Pure: no time, no
 * allocation per dot. The directive lets the app run it on its UI thread; elsewhere it is an
 * ordinary function.
 *
 * Two optional one-shot event transforms, each 0 when settled (the frame is then unchanged):
 * `gather` (1 -> 0) is how far the planet's dots are still dispersed while they gather home;
 * `leave` (0 -> 1) disperses the planet and resolves the rest microphone, exactly, at 1. Each dot
 * keeps a stable hash, so an event is the same dispersal on every painter.
 */
export function drawPlanetMarkFrame(to, from, morph, pose, energy, flow, draw, gather, leave) {
  'worklet';
  const m = morph <= 0 ? 0 : morph >= 1 ? 1 : (morph < 0.5 ? 4 * morph * morph * morph : 1 - ((-2 * morph + 2) ** 3) / 2);
  const settleRaw = morph <= MARK_LIGHT_FROM ? 0 : morph >= 1 ? 1 : (morph - MARK_LIGHT_FROM) / (1 - MARK_LIGHT_FROM);
  const settle = settleRaw * settleRaw * (3 - 2 * settleRaw);
  const emerge = morph <= 0 ? 0 : morph >= MARK_STREAM_EMERGE ? 1 : morph / MARK_STREAM_EMERGE;
  const k = pose <= 0 ? 0 : pose >= 1 ? 1 : pose;
  const level = energy <= 0 ? 0 : energy >= 1 ? 1 : energy;
  const steps = 4;
  const scaled = level * steps;
  const lower = Math.min(steps - 1, Math.floor(scaled));
  const fraction = scaled - lower;
  const tint = MARK_TINT_MAX * level * settle;
  const tintRgb = flow > 0 ? to.tintOut : to.tintIn;
  const count = to.count;
  const lowerBase = lower * count;
  const upperBase = (lower + 1) * count;
  // Event transforms: only the planet disperses; the rest microphone never does.
  const gathering = (gather > 0 ? (gather >= 1 ? 1 : gather) : 0) * m;
  const leaving = leave > 0 ? (leave >= 1 ? 1 : leave) : 0;
  const fadeRaw = leaving <= MARK_LEAVE_FADE_FROM ? 0 : leaving >= MARK_LEAVE_FADE_TO ? 1
    : (leaving - MARK_LEAVE_FADE_FROM) / (MARK_LEAVE_FADE_TO - MARK_LEAVE_FADE_FROM);
  const planetKeep = 1 - fadeRaw * fadeRaw * (3 - 2 * fadeRaw);
  const micRaw = leaving <= MARK_LEAVE_MIC_FROM ? 0 : (leaving - MARK_LEAVE_MIC_FROM) / (1 - MARK_LEAVE_MIC_FROM);
  const micResolve = micRaw * micRaw * (3 - 2 * micRaw);
  const scatter = (gathering * MARK_GATHER_SCATTER + leaving * MARK_LEAVE_SCATTER * m) * (to.size / 2) * 0.94;
  const centre = to.size / 2;
  const fadeBand = to.size * 0.12;
  for (let i = 0; i < count; i += 1) {
    const c = i * 3;
    let a = 0;
    if (planetKeep > 0) {
      const toA = to.planetA[lowerBase + i] + (to.planetA[upperBase + i] - to.planetA[lowerBase + i]) * fraction;
      const fromA = from.planetA[lowerBase + i] + (from.planetA[upperBase + i] - from.planetA[lowerBase + i]) * fraction;
      const planetA = fromA + (toA - fromA) * k;
      const targetA = to.discA[i] + (planetA - to.discA[i]) * settle;
      // Microphone dots travel; the disc's extra dots stream out of the microphone with them.
      a = (to.micA[i] > 0 ? to.micA[i] + (targetA - to.micA[i]) * m : targetA * emerge) * planetKeep;
    }
    if (a > 0.004) {
      let x = to.micX[i] + (to.planetX[i] - to.micX[i]) * m;
      let y = to.micY[i] + (to.planetY[i] - to.micY[i]) * m;
      const targetR = to.discR + (to.planetR[i] - to.discR) * settle;
      const radius = to.micR[i] + (targetR - to.micR[i]) * m;
      if (scatter > 0) {
        // A stable per-dot hash (the lab shader's per-cell hash): some dots travel farther and fade more.
        const h = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
        const dx = x - centre;
        const dy = y - centre;
        const d = Math.sqrt(dx * dx + dy * dy);
        const offset = scatter * (0.2 + h);
        x += (d > 1e-6 ? dx / d : Math.cos(h * 6.283185307179586)) * offset;
        y += (d > 1e-6 ? dy / d : Math.sin(h * 6.283185307179586)) * offset;
        a *= 1 - gathering * (0.35 + 0.65 * h);
        // A dispersed dot fades out before the canvas edge rather than being clipped by it.
        const room = Math.min(x - radius - to.minX, to.maxX - x - radius, y - radius - to.minY, to.maxY - y - radius);
        a *= room <= 0 ? 0 : room >= fadeBand ? 1 : room / fadeBand;
      }
      if (a > 0.004) {
        const channel = (offset) => {
          const lo = (lowerBase + i) * 3 + offset;
          const hi = (upperBase + i) * 3 + offset;
          const toRgb = to.planetRgb[lo] + (to.planetRgb[hi] - to.planetRgb[lo]) * fraction;
          const fromRgb = from.planetRgb[lo] + (from.planetRgb[hi] - from.planetRgb[lo]) * fraction;
          const planet = fromRgb + (toRgb - fromRgb) * k;
          const target = to.discRgb[c + offset] + (planet - to.discRgb[c + offset]) * settle;
          const value = to.micRgb[c + offset] + (target - to.micRgb[c + offset]) * m;
          return value + (tintRgb[offset] - value) * tint;
        };
        draw(x, y, radius, channel(0), channel(1), channel(2), a);
      }
    }
    // A leave lands on the exact rest microphone.
    const micA = leaving > 0 ? to.micA[i] * micResolve : 0;
    if (micA > 0.004) draw(to.micX[i], to.micY[i], to.micR[i], to.micRgb[c], to.micRgb[c + 1], to.micRgb[c + 2], micA);
  }
}

// The Home scene maths below are extracted unchanged from the approved atmosphere lab.
const STYLES = { airy: 0.12, balanced: 0.55, rich: 1 };
const DOT_RADIUS = 0.33, REST_SPIN = spinAt(SPIN_REST_SECONDS);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOut = (v) => 1 - (1 - clamp(v)) ** 3;
const easeInOut = (v) => { const t = clamp(v); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
const crit = (v, w = 7) => { const t = clamp(v); return (1 - (1 + w * t) * Math.exp(-w * t)) / (1 - (1 + w) * Math.exp(-w)); };
// The field/choreography hash uses addition. The existing body sampler uses XOR above.
function sceneHash(x, y) { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function digitOf(i, j, t = 0, rate = 0) { const step = rate ? Math.floor(t * rate + sceneHash(i, j) * 9) : 0; const h = sceneHash(i + step * 7, j - step * 13); return h < 0.62 ? 1 + Math.floor(h / 0.62 * 3) : Math.floor(sceneHash(i * 3 + step, j + 11) * 10); }
const bitOf = (i, j, t = 0, rate = 0) => (sceneHash(i + Math.floor(t * rate) * 5, j * 7 + 1) < 0.5 ? 0 : 1);
const lightForReveal = (reveal) => normalize([mix(0.35, 0.78, reveal), mix(-0.2, -0.42, reveal), mix(-0.95, 0.5, smooth(reveal))]);
const lightK = (k) => normalize([mix(0.3, 0.42, k), mix(-0.25, -0.5, k), mix(-0.92, 0.76, easeOut(k))]);
const PRESETS = [[0.12, 1.375, 0.27, 0.13, 1.35, 4.6, 0.4], [0.55, 1, DOT_RADIUS, 0.06, 1, 7, 1], [1, 0.75, 0.41, 0.025, 0.85, 9, 1.7]];
function styleOf(fill) {
  const [a, b] = fill <= PRESETS[1][0] ? [PRESETS[0], PRESETS[1]] : [PRESETS[1], PRESETS[2]]; const t = clamp((fill - a[0]) / (b[0] - a[0]));
  return { pitchK: mix(a[1], b[1], t), dotR: mix(a[2], b[2], t), fleck: mix(a[3], b[3], t), glowK: mix(a[4], b[4], t), reach: mix(a[5], b[5], t), detail: mix(a[6], b[6], t) };
}
// reach: a number of planet radii, or { top, right, bottom, left } (missing sides take the default), blended by direction
function reachOf(f, o, R) {
  const d = clamp(1 + 320 / R, 1.3, 1.9); const r = f.reach != null ? f.reach : o.fieldReach; // at most ~320 px from the limb
  if (r && typeof r === 'object') { const t = r.top || d, ri = r.right || d, bo = r.bottom || d, l = r.left || d; return { max: Math.max(t, ri, bo, l), key: [t, ri, bo, l].join('/'),
    at: (px, py) => { const q = Math.hypot(px, py) || 1, x = px / q, y = py / q; return (x > 0 ? ri : l) * x * x + (y > 0 ? bo : t) * y * y; } }; }
  const v = r || d; return { max: v, key: String(v), at: () => v };
}
function fieldOf(o, R) {
  let f = o.field; if (f == null) f = {}; if (typeof f === 'number') f = { around: f, over: o.over != null ? o.over : (f > 0 ? 0.16 : 0) };
  const reach = reachOf(f, o, R);
  return { around: R < 24 ? 0 : (f.around != null ? f.around : 1), over: R < 90 ? 0 : (f.over != null ? f.over : 0.3), fall: f.fall || 2.1, ink: f.ink || 1, start: f.start != null ? f.start : 1, ramp: f.ramp || 0.5, overStyle: f.overStyle || 'emboss',
    reach: reach.max, reachAt: reach.at, reachKey: reach.key, seed: f.seed || 0, cell: f.cell || (o.fieldDp ? o.fieldDp * 1.3 : clamp(R / 10.5, 11, 22)) };
}
function resolve(o, dpr, view) {
  const th = o.theme === 'light' ? 'light' : 'dark'; const R = o.R != null ? o.R : o.r; const mode = o.mode || 'dots';
  const fill = o.fill != null ? clamp(o.fill) : (STYLES[o.style] != null ? STYLES[o.style] : STYLES.balanced); const ST = styleOf(fill);
  // the brand's hero pitch is 3.2 px; a big planet keeps about 80 dots across until the pitch reaches 9 px, then it gains
  // dots instead of growing them, so at R 700–1100 it is still a field of round dots. Small marks follow the product's tiers.
  // the planet is always a FINE field of small round dots: the pitch is about constant in css px (balanced 4, airy 5.5,
  // rich 3), so a larger planet has more dots, never bigger ones. Up to 400 px across it is the product's hero lattice (3.2 px).
  const pitch = o.pitch || Math.max(1.6, Math.min(clamp(R / 50, HERO_DOT_PITCH, 4) * ST.pitchK, (2.5 * R) / 14)); const pD = Math.max(2, Math.round(pitch * dpr));
  const rise = o.rise != null ? o.rise : 1; const rot = o.rotate || 0, mir = o.mirror ? -1 : 1;
  const F = fieldOf(o, R); const CX = Math.round(o.cx * dpr), CY = Math.round(o.cy * dpr); // the lattice is anchored to the centre: it never swims
  // halo: a number, or { top, right, bottom, left } (missing sides = 1), blended by direction on the canvas like `reach`
  const hs = o.halo != null && typeof o.halo === 'object' ? o.halo : null; const hv = (v) => (v != null ? v : 1);
  const haloAt = hs ? (fx, fy) => { const q = Math.hypot(fx, fy) || 1, x = fx / q, y = fy / q; return hv(x > 0 ? hs.right : hs.left) * x * x + hv(y > 0 ? hs.bottom : hs.top) * y * y; } : null;
  const haloMax = hs ? Math.max(hv(hs.top), hv(hs.right), hv(hs.bottom), hv(hs.left)) : (o.halo != null ? o.halo : 1);
  const full = o.fullness != null ? clamp(o.fullness) : 0;
  const atm = atmosphereForEnergy(0); const glow = atm.glow * ST.glowK * haloMax;
  const tail = o.tail || 0;
  const haloEnd = Math.max(1 + Math.log(Math.max(1.01, glow * 0.9 / 0.05)) / ST.reach, tail ? 1 + tail * haloMax : 0); // beyond this altitude no halo dot can light
  const B = Math.max(haloEnd, F.around ? F.reach : 0) * R + pitch;
  const x0 = Math.max(0, Math.floor(CX - B * dpr)), y0 = Math.max(0, Math.floor(CY - B * dpr));
  const x1 = Math.min(Math.round(view.w * dpr), Math.ceil(CX + B * dpr)), y1 = Math.min(Math.round(view.h * dpr), Math.ceil(CY + B * dpr));
  const sample = { palette: PLANET_PALETTES[th], light: o.light || lightForReveal(rise), reveal: rise, breath: 0, spin: REST_SPIN, glow, reach: ST.reach, fleck: ST.fleck, detail: ST.detail, full, fleckDot: R > 200 }; // above 400 px across: single-dot flecks
  return { tail, haloAt, haloMax, haloKey: hs ? [hs.top, hs.right, hs.bottom, hs.left].join('/') : '', full, fill, ST, sample, haloEnd, rc: Math.cos(-rot), rs: Math.sin(-rot), mir, rot, th, R, mode, pD, pitch: pD / dpr, rise, L: lightK(rise), gain: o.gain || 1, F, dpr, CX, CY, cx: CX / dpr, cy: CY / dpr,
    x0, y0, W: Math.max(0, x1 - x0), H: Math.max(0, y1 - y0), time: o.time || 0, rate: o.rate || 0, dp: o.dp, binary: o.binary, lightKey: o.light ? o.light.map((v) => v.toFixed(3)).join() : '' };
}
function toArt(P, fx, fy, o) { const x = fx * P.mir; o[0] = x * P.rc - fy * P.rs; o[1] = x * P.rs + fy * P.rc; return o; }
const AP = [0, 0];
function brandAt(P, fx, fy) { toArt(P, fx, fy, AP); const sh = shadePlanetDot(AP[0], AP[1], 0, 0, P.sample); return { lit: sh.lit, rgb: inkDot(sh.rgb, P.th) }; }
// every lit dot of the visible region: { x, y (css px in the canvas), r, rgb, op, halo, i, j, px, py (art space) }
function brandDots(P) {
  const { pD, dpr, R, th, sample } = P; const out = []; const p = pD / dpr; const rB = p * P.ST.dotR, rH = p * P.ST.dotR * (0.28 / 0.33);
  const i0 = Math.floor((P.x0 - P.CX) / pD) - 1, i1 = Math.ceil((P.x0 + P.W - P.CX) / pD) + 1, j0 = Math.floor((P.y0 - P.CY) / pD) - 1, j1 = Math.ceil((P.y0 + P.H - P.CY) / pD) + 1; const lim = P.haloEnd * P.haloEnd;
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const fx = (i + 0.5) * p / R, fy = (j + 0.5) * p / R; const d2 = fx * fx + fy * fy; if (d2 > lim) continue;
    toArt(P, fx, fy, AP); const px = AP[0], py = AP[1]; const g0 = sample.glow; if (P.haloAt && d2 >= 1) sample.glow = g0 * P.haloAt(fx, fy) / P.haloMax;
    const sh = shadePlanetDot(px, py, i + 4096, j + 4096, sample); sample.glow = g0; const d = Math.sqrt(d2); let fade = 1;
    if (!sh.lit) { // the tail: past the brand's glow the haze keeps thinning on the same ordered lattice, all round the planet
      if (!P.tail || d2 < 1) continue; const L = P.tail * (P.haloAt ? P.haloAt(fx, fy) : 1); if (L <= 0) continue; const k = (d - 1) / L;
      const facing = clamp(((px * sample.light[0] + py * sample.light[1]) / d) * 0.5 + 0.6);
      // dense enough: the brand's ordered lattice; fainter: a random scatter, so the haze thins to nothing with no contour
      const dn = (0.45 * Math.exp(-9 * k) + 0.05 * (1 - sstep(0.4, 1, k))) * facing; /* dissolves fast, then a few stray dots */ const bt = BAYER[((j + 4096) & 3) * 4 + ((i + 4096) & 3)] + 0.02;
      if (dn >= 0.12 ? dn <= bt : sceneHash(i + 7331, j + 1709) >= dn * 0.75) continue; fade = 1 - 0.55 * clamp(k); }
    let rgb = sh.rgb, op = 1; const halo = d >= 1;
    if (halo) { rgb = gradient(sample.palette.halo, clamp((py + 1) / 2 - px * 0.2)); op = haloOpacity(th, d) * fade; } // as createPlanetDots: a halo dot carries its colour and fades by opacity
    rgb = inkDot(rgb, th); if (P.gain !== 1) rgb = gainRgb(rgb, P.gain);
    out.push({ x: P.cx + (i + 0.5) * p, y: P.cy + (j + 0.5) * p, r: halo ? rH : rB, rgb, op, halo, i, j, px, py });
  }
  return out;
}
// gain is a dot's final colour step (moment brightening); the digit cells never carry it
const gainRgb = (rgb, gain) => rgb.map((c) => clamp(c * gain, 0, 255));
function fieldCells(P, all) {
  const { th, R, F, cx, cy } = P; const out = []; if (!F.around && !F.over) return out;
  const vx0 = P.x0 / P.dpr, vy0 = P.y0 / P.dpr, vx1 = (P.x0 + P.W) / P.dpr, vy1 = (P.y0 + P.H) / P.dpr;
  const dark = th === 'dark'; const grey = dark ? [190, 186, 204] : [128, 124, 142]; const sd = F.seed * 131; const base = dark ? 0.2 : 0.13;
  const c = F.cell, fs = c * 0.62, n = Math.ceil(F.reach * R / c); const doOver = F.over && P.mode === 'dots'; const pal = P.sample.palette;
  for (let j = -n; j < n; j++) for (let i = -n; i < n; i++) {
    const X = cx + (i + 0.5) * c, Y = cy + (j + 0.5) * c; if (!all && (X < vx0 - c || X > vx1 + c || Y < vy0 - c || Y > vy1 + c)) continue;
    const fx = (X - cx) / R, fy = (Y - cy) / R; const r = Math.hypot(fx, fy); const over = r < 1;
    if (over ? !doOver : (!F.around || r > F.reach)) continue;
    const hi = i + 4096 + sd, hj = j + 4096; if (sceneHash(hi + 911, hj + 77) < 0.07) continue;   // a few cells are never struck
    let a, col; const m = sstep(0, 0.5, P.rise);
    if (over) { const b = brandAt(P, fx, fy); if (!b.lit) continue; a = F.over * m * sstep(1, 0.9, r);
      // printed ('ink'): the number is cut out of the planet in the page colour (white on light, near-black on dark);
      // embossed: the dots under the glyph go paler
      col = F.overStyle === 'ink' ? pal.background.slice() : [mix(b.rgb[0], 255, 0.4), mix(b.rgb[1], 255, 0.4), mix(b.rgb[2], 255, 0.4)]; }
    else { const reach = F.reachAt(fx, fy); if (r > reach) continue; toArt(P, fx, fy, AP);
      const near = Math.exp(-(r - 1) * 3) * clamp(((AP[0] * P.sample.light[0] + AP[1] * P.sample.light[1]) / r) * 0.8 + 0.5); // the halo's own light
      const fall = Math.pow(1 - sstep(1, reach, r), F.fall) * sstep(1.0, 1.05, r); const rampIn = F.start < 1 ? mix(F.start, 1, sstep(1, 1 + F.ramp, r)) : 1; // softer at the limb, building outward
      a = F.around * F.ink * (base + (dark ? 0.3 : 0.2) * near * F.start) * fall * m * rampIn;
      const hc = inkDot(gradient(pal.halo, clamp((AP[1] + 1) / 2 - AP[0] * 0.2)), th); const k = near * 0.75; col = [mix(grey[0], hc[0], k), mix(grey[1], hc[1], k), mix(grey[2], hc[2], k)]; }
    if (sceneHash(hi + 401, hj + 7) > 0.8) a *= 0.45;                                              // a typewriter's uneven strike
    if (a < 0.012) continue;
    const step = P.rate && !over && sceneHash(hi + 5, hj + 9) < 0.15 ? Math.floor(P.time * P.rate + sceneHash(hi, hj + 3) * 4) : 0;
    out.push({ x: X, y: Y, a: clamp(a), col, cut: over && F.overStyle === 'ink', ch: String(P.binary ? bitOf(hi + step * 7, hj) : digitOf(hi + step * 7, hj)), over, fs, i, j });
  }
  return out;
}

/** Visible Home body, haze and typewriter field. Coordinates are CSS pixels, RGB is unrounded. */
export function createPlanetScene(options) {
  return planetScene(options, 'scene');
}

function planetScene(options, projection) {
  // Existing hero/voice grids are edge-anchored and retain unlit slots for morph correspondence.
  // Home's visible scene is centre-anchored. Both projections use the one canonical sampler.
  if (projection === 'mark') return createPlanetDotSlots(options);
  const P = resolve(options, options.dpr || 1, options.view);
  const list = brandDots(P);
  const dot = ({ x, y, r, rgb, op, i, j }) => ({ x, y, r, rgb, opacity: op, i, j });
  return { body: list.filter((d) => !d.halo).map(dot), haze: list.filter((d) => d.halo).map(dot),
    cells: fieldCells(P).map(({ col, ...c }) => ({ ...c, rgb: col })) };
}

/** The same scene at another gain without sampling it again: gain only scales the dots' colours (brandDots).
 * `scene` must be the gain-1 scene for the same options. */
export function gainPlanetScene(scene, gain) {
  if (gain === 1) return scene;
  const dot = (d) => ({ ...d, rgb: gainRgb(d.rgb, gain) });
  return { body: scene.body.map(dot), haze: scene.haze.map(dot), cells: scene.cells };
}

// The lab's canvas shell consumes these pure functions rather than keeping private copies.
export const PLANET_SAMPLER = { PLANET_PALETTES, BAYER, shadePlanetDot, inkDot, atmosphereForEnergy, lightForReveal, haloOpacity, gradient, mixRgb, hash, DOT_RADIUS, HERO_DOT_PITCH, REST_SPIN };
export const PLANET_SCENE_RENDERER = { resolve, brandDots, fieldCells, toArt, brandAt, sceneHash, digitOf, bitOf, sstep, easeOut, easeInOut, crit };

const ASM = { FLY: 0.45, PATCH: 2 };
// the light of the assembly: it starts behind the planet, so only the limb on the lit side catches it (a crescent out
// of the eclipse), then swings round to the front; the terminator crosses the sphere and the far limb is lit last.
const UX = 0.643, UY = -0.766; // the PNG's own key-light side (up and to the right)
export function planetLightAt(px, py, k) {
  const r = Math.hypot(px, py); const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, r * r))); const q = r > 1 ? 1 / r : 1;
  const th = (1 - k) * 2.75; return (px * UX + py * UY) * q * Math.sin(th) + nz * Math.cos(th) + 0.3 * k * k;
}
export const planetMaskAt = (px, py, k) => (k >= 1 ? 1 : sstep(-0.07, 0.1, planetLightAt(px, py, k)));
export function planetAssembly(o) {
  const dpr = o.dpr || 1, view = o.view;
  const P0 = resolve({ ...o, rise: 1 }, dpr, view);
  const parts = { P: P0, list: brandDots(P0), field: fieldCells(P0) }; const P = parts.P; const R = P.R; const spread = R * 0.72;
  // every body dot knows when the light reaches it; one digit per patch of PATCH × PATCH dots flies in and settles into them
  const body = parts.list.filter((d) => !d.halo); const N = 48; const G = new Map();
  for (const d of body) { d.ks = 1; for (let n = 0; n <= N; n++) { if (planetMaskAt(d.px, d.py, n / N) >= 0.5) { d.ks = n / N; break; } }
    const gk = `${Math.floor(d.i / ASM.PATCH)}|${Math.floor(d.j / ASM.PATCH)}`; let g = G.get(gk); if (!g) { g = { n: 0, x: 0, y: 0, ks: 0, col: [0, 0, 0], i: Math.floor(d.i / ASM.PATCH) + 600, j: Math.floor(d.j / ASM.PATCH) + 600 }; G.set(gk, g); }
    g.n++; g.x += d.x; g.y += d.y; g.ks += d.ks; g.col[0] += d.rgb[0]; g.col[1] += d.rgb[1]; g.col[2] += d.rgb[2]; }
  const patches = [...G.values()].map((g) => { const hi = g.i, hj = g.j; const x = g.x / g.n, y = g.y / g.n;
    const g1 = (sceneHash(hi * 3 + 1, hj * 5 + 2) + sceneHash(hi + 9, hj + 4) + sceneHash(hj, hi + 33) - 1.5), g2 = (sceneHash(hi * 7 + 3, hj + 21) + sceneHash(hi + 2, hj * 3 + 8) + sceneHash(hj + 5, hi * 2) - 1.5);
    return { x, y, ks: g.ks / g.n, d: sceneHash(hi + 13, hj + 17), sx: x + g1 * spread * 1.5, sy: y + g2 * spread * 1.1, col: [g.col[0] / g.n, g.col[1] / g.n, g.col[2] / g.n], a: 1, i: hi, j: hj }; });
  const field = parts.field.filter((c) => !c.over).map((c) => { const hi = c.i + 900, hj = c.j + 900;
    const g1 = (sceneHash(hi * 3 + 1, hj * 5 + 2) + sceneHash(hi + 9, hj + 4) - 1), g2 = (sceneHash(hi * 7 + 3, hj + 21) + sceneHash(hi + 2, hj * 3 + 8) - 1);
    return { ...c, sx: c.x + g1 * R * 0.5, sy: c.y + g2 * R * 0.5, d: sceneHash(hi + 3, hj + 5) }; });
  return { P, R, g: P.pitch * ASM.PATCH, body, patches, field };
}

const W4 = { T: 1.9, LIGHT0: 0.2, LIGHT1: 1.72, COPY0: 0.95, COPY1: 1.4, CROSS: 0.22 };
const L4 = { GRACE: 0.25, RESOLVE: 0.5, TRAVEL: 0.5, FADE: 0.14 };
export const PLANET_MOMENT_TIMINGS = { ASM, W4, L4 };

/** Renderer-independent assembly drawing, extracted from the lab's drawAssembly. */
export function planetAssemblyFrame(A, f) {
  const { P, patches, field } = A; const prog = clamp(f.prog); const al = f.alpha != null ? f.alpha : 1;
  const body = [], cells = [];
  if (prog > 0 && al > 0) {
    for (const d of A.body) {
      const k = prog >= 1 ? 1 : sstep(d.ks, d.ks + 0.07, prog); if (k <= 0) continue;
      body.push({ x: d.x, y: d.y, r: d.r * k, rgb: d.rgb, opacity: al });
    }
  }
  const halo = prog > 0 && al > 0 ? al * clamp(f.halo || 0) : 0;
  const ca = (f.cloud != null ? f.cloud : 1) * al;
  if (ca <= 0) return { body, halo, cells };
  for (const q of field) {
    const u = f.fieldU != null ? clamp((f.fieldU - q.d * 0.45) / 0.55) : 0; const k = crit(u, 6);
    const x = mix(q.sx, q.x, k), y = mix(q.sy, q.y, k);
    cells.push({ ...q, x, y, a: ca * mix(Math.min(0.16, q.a * 1.6) * (f.appear ? f.appear(q) : 1), q.a, k), weight: q.over ? (q.cut ? 700 : 600) : 400, fs: Number(q.fs.toFixed(2)) });
  }
  const g = A.g; const dark = P.th === 'dark';
  for (const p of patches) {
    const tl = f.landT(p); const start = Math.max(f.t0 != null ? f.t0 : 0, tl - ASM.FLY);
    // readiness not known yet: the patch has not left the cloud (only `loose` moves it)
    const u = tl === Infinity ? -Infinity : (f.t - start) / Math.max(0.12, tl - start);
    if (u >= 1.12) continue; const k = crit(u, 6.5); const loose = f.loose ? f.loose(p) : 0; const kk = Math.max(k, loose);
    const x = mix(p.sx, p.x, kk), y = mix(p.sy, p.y, kk); const out = sstep(0.82, 1.1, u);
    const size = g * mix(1.35, 1.05, kk);
    const a = ca * (1 - out) * mix((dark ? 0.36 : 0.3) * (f.appear ? f.appear(p) : 1), 0.92, Math.max(sstep(0, 0.5, u), loose * 0.9));
    if (a > 0.01) cells.push({ x, y, a: a * (0.45 + 0.55 * p.a), col: p.col, ch: String(digitOf(p.i, p.j, f.t, u > 0 ? 0 : (f.retype || 0))), over: false, cut: false, fs: Number(size.toFixed(1)), weight: 500 });
  }
  return { body, halo, cells };
}

/** Pure lab curves. Readiness is a caller-observed time; null never finishes Loading. */
export function planetMomentFrame(moment, t, T = null) {
  if (moment === 'welcome') {
    const copy = easeOut(sstep(W4.COPY0, W4.COPY1, t));
    if (t >= W4.T) return { assembly: false, rest: true, restAlpha: 1, copy, time: t - W4.T };
    const lin = clamp((t - W4.LIGHT0) / (W4.LIGHT1 - W4.LIGHT0)); const prog = easeInOut(lin);
    const inv = (k) => (k < 0.5 ? Math.cbrt(k / 4) : 1 - Math.cbrt((1 - k) / 4));
    const x = sstep(W4.T - W4.CROSS, W4.T, t);
    return { assembly: true, rest: false, restAlpha: x, copy, frame: {
      t, prog, alpha: 1 - x, halo: sstep(1.42, 1.78, t), landT: (p) => W4.LIGHT0 + inv(p.ks) * (W4.LIGHT1 - W4.LIGHT0) + 0.05 + p.d * 0.06, fieldU: clamp((t - 0.25) / 1.35),
      appear: (p) => sstep(-0.35 + p.d * 0.2, -0.05 + p.d * 0.2, t),
    } };
  }
  const fast = T != null && T <= L4.GRACE; const after = T != null ? t - T : -1;
  const cover = T == null || after < 0 ? 1 : 1 - sstep(0, L4.FADE, after);
  if (fast) return { assembly: false, fast, cover, rest: after >= 0, travel: 1 };
  if (t < L4.GRACE) return { assembly: false, fast, cover, rest: false, travel: 0 };
  if (after >= L4.RESOLVE + L4.TRAVEL) return { assembly: false, fast, cover, rest: true, travel: 1 };
  if (after >= L4.RESOLVE) return { assembly: false, fast, cover, rest: false, travel: crit((after - L4.RESOLVE) / L4.TRAVEL, 6) };
  const wait = t - L4.GRACE; const hold = easeOut(clamp(wait / 1.1));
  const prog = after < 0 ? 0 : easeInOut(clamp(after / (L4.RESOLVE - 0.06)));
  return { assembly: true, fast, cover, rest: false, travel: 0, frame: {
    t, t0: T != null ? T - 0.05 : 0, prog, retype: 6, halo: after < 0 ? 0 : sstep(0.32, 0.5, after), landT: (p) => (T == null ? Infinity : T + 0.2 + p.ks * 0.22 + p.d * 0.04),
    appear: (p) => sstep(p.d * 0.3, 0.15 + p.d * 0.3, wait), fieldU: after < 0 ? 0 : clamp(after / L4.RESOLVE),
    loose: (p) => hold * 0.86 * sstep(0.34, 0.04, p.ks),
  } };
}
