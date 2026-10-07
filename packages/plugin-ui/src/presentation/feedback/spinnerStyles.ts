/**
 * The loading-indicator styles, as data.
 *
 * Every id except `classicRing` is a dot style: the Happier mark or H on a 3 × 3 grid.
 * The mark adds a bottom-centre dot; the top-centre cell stays empty in both shapes. A dot style is only a
 * cycle length and a function that says how bright each dot is at a moment in that cycle.
 * `dotSpinnerFrames.ts` samples it into a frame table that both platforms render, so adding a style
 * never adds a renderer. `classicRing` keeps the original rotating ring.
 */
export const HAPPIER_SPINNER_STYLE_IDS = [
  'wave',
  'handwritten',
  'buildAndRelease',
  'relay',
  'twinStems',
  'slowBreath',
  'starfield',
  'sweep',
  'radar',
  'ripple',
  'aurora',
  'hWave',
  'hHandwritten',
  'hBuildAndRelease',
  'hRelay',
  'hTwinStems',
  'hSlowBreath',
  'hStarfield',
  'hSweep',
  'hRadar',
  'hRipple',
  'hAurora',
  'classicRing',
] as const;

export type HappierSpinnerStyleId = (typeof HAPPIER_SPINNER_STYLE_IDS)[number];

export const DEFAULT_HAPPIER_SPINNER_STYLE_ID = 'wave' satisfies HappierSpinnerStyleId;

const HAPPIER_SPINNER_STYLE_ID_SET: ReadonlySet<string> = new Set(HAPPIER_SPINNER_STYLE_IDS);

export function isHappierSpinnerStyleId(value: unknown): value is HappierSpinnerStyleId {
  return typeof value === 'string' && HAPPIER_SPINNER_STYLE_ID_SET.has(value);
}

/** An id this build does not know (written by a newer build, or since removed) draws the default. */
export function normalizeHappierSpinnerStyleId(value: unknown): HappierSpinnerStyleId {
  return isHappierSpinnerStyleId(value) ? value : DEFAULT_HAPPIER_SPINNER_STYLE_ID;
}

export type DotSpinnerStyleId = Exclude<HappierSpinnerStyleId, 'classicRing'>;

export type SpinnerDotId = 'TL' | 'ML' | 'BL' | 'MC' | 'TR' | 'MR' | 'BR' | 'BC';

export type SpinnerDot = Readonly<{ id: SpinnerDotId; col: 0 | 1 | 2; row: 0 | 1 | 2 }>;

/** Fixed order; a dot's index here is its column in every frame table. */
export const H_DOTS: readonly SpinnerDot[] = [
  { id: 'TL', col: 0, row: 0 },
  { id: 'ML', col: 0, row: 1 },
  { id: 'BL', col: 0, row: 2 },
  { id: 'MC', col: 1, row: 1 },
  { id: 'TR', col: 2, row: 0 },
  { id: 'MR', col: 2, row: 1 },
  { id: 'BR', col: 2, row: 2 },
];

/**
 * How a dot style loops. A `rests` style plays its motion once (the first dot lights, the light
 * travels, the last dot returns to rest), then every dot rests for the chosen pause. A `continuous`
 * style has no moment where every dot is at rest, so it loops straight on and the pause does not
 * apply to it.
 */
export type DotSpinnerLoop = 'rests' | 'continuous';

export const MARK_DOTS: readonly SpinnerDot[] = [...H_DOTS, { id: 'BC', col: 1, row: 2 }];

export type DotSpinnerStyle = Readonly<{
  dots: readonly SpinnerDot[];
  /** One loop's motion at Normal speed, in ms: for a `rests` style, the active phase before the pause. */
  motionMs: number;
  loop: DotSpinnerLoop;
  /** `aurora` dots also carry a hue position that renderers map onto theme accent colors. */
  ink: 'mono' | 'aurora';
  /** How bright a dot is `tMs` into the motion, `0 ≤ tMs < motionMs`. */
  opacity: (dot: SpinnerDot, tMs: number) => number;
  hue?: (dot: SpinnerDot, tMs: number) => number;
}>;

/**
 * Speed is a playback rate on the motion, shared by every style. The pause is the rest after a
 * `rests` style's motion, in absolute ms: it is the beat between loops, so it stays the length the
 * person chose at any speed (scaling it would make Slow + Short as long as Normal + Long).
 */
export const HAPPIER_SPINNER_SPEED_IDS = ['slow', 'normal', 'fast'] as const;
export type HappierSpinnerSpeedId = (typeof HAPPIER_SPINNER_SPEED_IDS)[number];
export const DEFAULT_HAPPIER_SPINNER_SPEED_ID = 'normal' satisfies HappierSpinnerSpeedId;

export const HAPPIER_SPINNER_PAUSE_IDS = ['none', 'short', 'long'] as const;
export type HappierSpinnerPauseId = (typeof HAPPIER_SPINNER_PAUSE_IDS)[number];
export const DEFAULT_HAPPIER_SPINNER_PAUSE_ID = 'short' satisfies HappierSpinnerPauseId;

export const HAPPIER_SPINNER_SPEED_RATES: Readonly<Record<HappierSpinnerSpeedId, number>> = {
  slow: 0.75,
  normal: 1,
  fast: 1.5,
};

/** `long` is the rest the wave had before the pause was a choice (≈500 ms of a 1.3 s loop). */
export const HAPPIER_SPINNER_PAUSE_MS: Readonly<Record<HappierSpinnerPauseId, number>> = {
  none: 0,
  short: 200,
  long: 500,
};

export type HappierSpinnerTiming = Readonly<{ speed: HappierSpinnerSpeedId; pause: HappierSpinnerPauseId }>;

export const DEFAULT_HAPPIER_SPINNER_TIMING: HappierSpinnerTiming = {
  speed: DEFAULT_HAPPIER_SPINNER_SPEED_ID,
  pause: DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
};

/** Unknown stored values (a newer build's choice, or garbage) play at the defaults. */
export function normalizeHappierSpinnerTiming(speed: unknown, pause: unknown): HappierSpinnerTiming {
  return {
    speed: (HAPPIER_SPINNER_SPEED_IDS as readonly unknown[]).includes(speed) ? speed as HappierSpinnerSpeedId : DEFAULT_HAPPIER_SPINNER_SPEED_ID,
    pause: (HAPPIER_SPINNER_PAUSE_IDS as readonly unknown[]).includes(pause) ? pause as HappierSpinnerPauseId : DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
  };
}

/** Ink on an idle dot. The Grok reference measured 23%; 20% keeps the H legible without competing. */
export const DOT_REST_OPACITY = 0.2;

/**
 * Piecewise-linear brightness over a position; stops before the first or after the last read the
 * first or last value. The lit envelopes below are in ms since the dot lit and end back at rest, so
 * the last stop is how long a dot stays lit. Those durations are the ones the styles had when each
 * loop was a fixed cycle, so the light itself looks the same at Normal speed.
 */
type Envelope = Readonly<{ stops: readonly (readonly [at: number, opacity: number])[]; easeInOut?: boolean }>;

const R = DOT_REST_OPACITY;
/** Fast attack, short plateau, soft tail: the reference envelope (≈370 ms lit). */
const PULSE: Envelope = { stops: [[0, R], [65, 1], [234, 0.88], [364, R]] };
const HOLD: Envelope = { stops: [[0, R], [75, 1], [900, 1], [1080, R]] };
const BUILD: Envelope = { stops: [[0, R], [68, 1], [986, 1], [1190, R]] };
const TIGHT: Envelope = { stops: [[0, R], [48, 1], [144, 0.5], [288, R]] };
/** Fractions of a starfield track's own cycle. */
const TWINKLE: Envelope = { stops: [[0, R], [0.08, 1], [0.34, R], [1, R]] };
/** Fractions of the breath's cycle. */
const BREATHE: Envelope = { stops: [[0, R], [0.5, 1], [1, R]], easeInOut: true };

function envelopeLitMs(envelope: Envelope): number {
  return envelope.stops[envelope.stops.length - 1]![0];
}

function sampleEnvelope(envelope: Envelope, x: number): number {
  const { stops } = envelope;
  if (x < stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [b, vb] = stops[i]!;
    if (x > b) continue;
    const [a, va] = stops[i - 1]!;
    const linear = b === a ? 1 : (x - a) / (b - a);
    const k = envelope.easeInOut ? linear * linear * (3 - 2 * linear) : linear;
    return va + (vb - va) * k;
  }
  return stops[stops.length - 1]![1];
}

function wrap01(x: number): number {
  return ((x % 1) + 1) % 1;
}

/** 0 at the bottom-left foot, 1 at the top-right corner. */
function diagonal(dot: SpinnerDot): number {
  return (dot.col + (2 - dot.row)) / 4;
}

/**
 * Each ranked dot lights `stepMs × rank` into the motion and plays the lit envelope once. The motion
 * ends when the last dot is back at rest, so the pause that follows is the only gap between loops.
 */
function staggered(params: Readonly<{
  dots: readonly SpinnerDot[];
  stepMs: number;
  envelope: Envelope;
  rank: (dot: SpinnerDot) => number | null;
}>): DotSpinnerStyle {
  const { dots, stepMs, envelope, rank } = params;
  const lastRank = Math.max(...dots.map((dot) => rank(dot) ?? 0));
  return {
    dots,
    motionMs: lastRank * stepMs + envelopeLitMs(envelope),
    loop: 'rests',
    ink: 'mono',
    opacity: (dot, tMs) => {
      const k = rank(dot);
      if (k === null) return R;
      return sampleEnvelope(envelope, tMs - k * stepMs);
    },
  };
}

function byId(ranks: Partial<Record<SpinnerDotId, number>>): (dot: SpinnerDot) => number | null {
  return (dot) => ranks[dot.id] ?? null;
}

const diagonalRank = (dot: SpinnerDot) => diagonal(dot) * 4;

/** A comet with a soft leading edge and a longer trailing tail, given how far a dot sits behind the head. */
function comet(behindHead: number, tail: number, lead: number): number {
  if (behindHead < 0) {
    return behindHead > -lead ? R + (1 - R) * (1 + behindHead / lead) : R;
  }
  return behindHead <= tail ? R + (1 - R) * Math.pow(1 - behindHead / tail, 1.5) : R;
}

/** Starfield loops every 2.4 s; each dot's own cycle divides it so the loop is seamless. */
const STARFIELD_LOOP_MS = 2400;
const STARFIELD_TRACKS: Readonly<Record<SpinnerDotId, readonly [cycleMs: number, delayMs: number]>> = {
  TL: [1200, 0],
  ML: [2400, 400],
  BL: [800, 300],
  MC: [1200, 700],
  TR: [2400, 1500],
  MR: [600, 100],
  BR: [800, 650],
  BC: [1200, 500],
};

const SLOW_BREATH_LOOP_MS = 2400;
const SLOW_BREATH_STEP_MS = 70;

/** The sweep's head crosses the H in 936 ms; the last dot's tail is back at rest by 910 ms. */
const SWEEP_CROSSING_MS = 936;
const SWEEP_MOTION_MS = 910;
/** The ripple's ring eases out over 1050 ms; it has passed the corners by 710 ms. */
const RIPPLE_EXPANSION_MS = 1050;
const RIPPLE_MOTION_MS = 710;

function createDotSpinnerStyles(dots: readonly SpinnerDot[]) {
  return {
    wave: staggered({ dots, stepMs: 110, envelope: PULSE, rank: diagonalRank }),
    handwritten: staggered({
      dots,
      stepMs: 90,
      envelope: HOLD,
      rank: byId({ TL: 0, ML: 1, BL: 2, BC: 2.7, MC: 3.4, TR: 4.8, MR: 5.8, BR: 6.8 }),
    }),
    buildAndRelease: staggered({ dots, stepMs: 95, envelope: BUILD, rank: diagonalRank }),
    relay: staggered({
      dots,
      stepMs: 95,
      envelope: TIGHT,
      rank: byId({ BL: 0, BC: 0.5, ML: 1, MC: 2, MR: 3, TR: 4 }),
    }),
    twinStems: staggered({
      dots,
      stepMs: 130,
      envelope: PULSE,
      rank: byId({ BL: 0, BR: 0, BC: 0.5, ML: 1, MR: 1, MC: 1.5, TL: 2, TR: 2 }),
    }),
    slowBreath: {
      dots,
      motionMs: SLOW_BREATH_LOOP_MS,
      loop: 'continuous',
      ink: 'mono',
      opacity: (dot, tMs) => sampleEnvelope(BREATHE, wrap01((tMs - diagonalRank(dot) * SLOW_BREATH_STEP_MS) / SLOW_BREATH_LOOP_MS)),
    },
    starfield: {
      dots,
      motionMs: STARFIELD_LOOP_MS,
      loop: 'continuous',
      ink: 'mono',
      opacity: (dot, tMs) => {
        const [cycleMs, delayMs] = STARFIELD_TRACKS[dot.id];
        return sampleEnvelope(TWINKLE, wrap01((tMs - delayMs) / cycleMs));
      },
    },
    sweep: {
      dots,
      motionMs: SWEEP_MOTION_MS,
      loop: 'rests',
      ink: 'mono',
      opacity: (dot, tMs) => comet(-0.1 + (tMs / SWEEP_CROSSING_MS) * 1.7 - diagonal(dot), 0.55, 0.08),
    },
    radar: {
      dots,
      motionMs: 1100,
      loop: 'continuous',
      ink: 'mono',
      opacity: (dot, tMs) => {
        if (dot.col === 1 && dot.row === 1) return 0.55;
        const angle = wrap01(Math.atan2(dot.col - 1, 1 - dot.row) / (2 * Math.PI));
        const behind = wrap01(tMs / 1100 - angle);
        return comet(behind > 0.96 ? behind - 1 : behind, 0.5, 0.04);
      },
    },
    ripple: {
      dots,
      motionMs: RIPPLE_MOTION_MS,
      loop: 'rests',
      ink: 'mono',
      opacity: (dot, tMs) => {
        const p = Math.min(1, tMs / RIPPLE_EXPANSION_MS);
        const ring = (1 - Math.pow(1 - p, 3)) * 1.45 - 0.1;
        const radius = Math.hypot(dot.col - 1, dot.row - 1) / Math.SQRT2;
        return R + (1 - R) * Math.max(0, 1 - Math.abs(radius - ring) / 0.3);
      },
    },
    aurora: {
      dots,
      motionMs: 2600,
      loop: 'continuous',
      ink: 'aurora',
      opacity: () => 0.92,
      hue: (dot, tMs) => wrap01(diagonal(dot) * 0.6 - tMs / 2600),
    },
  } satisfies Record<string, DotSpinnerStyle>;
}

const markStyles = createDotSpinnerStyles(MARK_DOTS);
const hStyles = createDotSpinnerStyles(H_DOTS);

export const DOT_SPINNER_STYLES: Readonly<Record<DotSpinnerStyleId, DotSpinnerStyle>> = {
  ...markStyles,
  hWave: hStyles.wave,
  hHandwritten: hStyles.handwritten,
  hBuildAndRelease: hStyles.buildAndRelease,
  hRelay: hStyles.relay,
  hTwinStems: hStyles.twinStems,
  hSlowBreath: hStyles.slowBreath,
  hStarfield: hStyles.starfield,
  hSweep: hStyles.sweep,
  hRadar: hStyles.radar,
  hRipple: hStyles.ripple,
  hAurora: hStyles.aurora,
};

/**
 * Which timing choices change how a style plays: speed applies to every dot style, the pause only
 * to styles that rest between loops. The classic ring is the platform's own indicator on native,
 * whose speed is not ours to set, so neither applies to it.
 */
export function happierSpinnerStyleTimingControls(styleId: HappierSpinnerStyleId): Readonly<{ speed: boolean; pause: boolean }> {
  if (styleId === 'classicRing') return { speed: false, pause: false };
  return { speed: true, pause: DOT_SPINNER_STYLES[styleId].loop === 'rests' };
}
