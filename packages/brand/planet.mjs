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

function gradient(stops, position) {
  const t = clamp(position);
  for (let index = 1; index < stops.length; index += 1) {
    const [end, to] = stops[index];
    if (t <= end) {
      const [start, from] = stops[index - 1];
      return mixRgb(from, to, (t - start) / (end - start));
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
function shadePlanetDot(px, py, dx, dy, { palette, light, reveal, breath, spin, glow, reach, gamma = 1 }) {
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
  const day = smooth((lambert + 0.42) / 1.05);
  const rimFacing = clamp(((px * light[0] + py * light[1]) / Math.max(0.2, Math.sqrt(distanceSquared))) * 1.2 + 0.1);
  const rim = (1 - pz) ** 2.6 * rimFacing * (0.6 + 0.4 * reveal);
  const qy = py * COS_TILT - px * SIN_TILT;
  const qx = px * COS_TILT + py * SIN_TILT;
  const longitude = Math.atan2(qx, pz) + spin;
  const latitude = Math.asin(clamp(qy, -1, 1));
  const bands = Math.sin(latitude * 7 + Math.sin(longitude * 2 + latitude * 3) * 0.9) * 0.5 + 0.5;
  const grain = hash(Math.floor((longitude / (Math.PI * 2)) * 180 + 1000), Math.floor(latitude * 40 + 100));
  const detail = 1 + (bands - 0.5) * 0.07 + (grain - 0.5) * 0.12;
  let colour = gradient(palette.body, clamp(0.44 + py * 0.6 - px * 0.12));
  colour = mixRgb(colour, palette.rose, clamp(-px * 0.35) * (1 - Math.abs(py)));
  colour = mixRgb(palette.background, colour, clamp(day * detail * (1 + 0.08 * breath)) ** gamma);
  colour = mixRgb(colour, palette.rim, clamp(rim * 1.1));
  const fleck = grain < 0.06 ? 0.5 : 0;
  return { rgb: colour, lit: !(clamp(day * 1.25 + rim * 2) - fleck < threshold) };
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
export function createPlanetDots({ size = 24, theme = 'dark', pose = 'ready', energy = 0, light, bleed = 0, rows: latticeRows, halo = 1, warmth = 0 } = {}) {
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
 */
export function drawPlanetMarkFrame(to, from, morph, pose, energy, flow, draw) {
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
  for (let i = 0; i < count; i += 1) {
    const toA = to.planetA[lowerBase + i] + (to.planetA[upperBase + i] - to.planetA[lowerBase + i]) * fraction;
    const fromA = from.planetA[lowerBase + i] + (from.planetA[upperBase + i] - from.planetA[lowerBase + i]) * fraction;
    const planetA = fromA + (toA - fromA) * k;
    const targetA = to.discA[i] + (planetA - to.discA[i]) * settle;
    // Microphone dots travel; the disc's extra dots stream out of the microphone with them.
    const a = to.micA[i] > 0 ? to.micA[i] + (targetA - to.micA[i]) * m : targetA * emerge;
    if (a <= 0.004) continue;
    const c = i * 3;
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
    const targetR = to.discR + (to.planetR[i] - to.discR) * settle;
    draw(
      to.micX[i] + (to.planetX[i] - to.micX[i]) * m,
      to.micY[i] + (to.planetY[i] - to.micY[i]) * m,
      to.micR[i] + (targetR - to.micR[i]) * m,
      channel(0), channel(1), channel(2), a,
    );
  }
}
