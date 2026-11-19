export type PlanetTheme = 'dark' | 'light';
export type PlanetRgb = readonly [number, number, number];
export type PlanetCell = Readonly<{ ch: string; rgb: PlanetRgb }>;
export type PlanetFrame = readonly (readonly (PlanetCell | null)[])[];
export type PlanetFrameOptions = Readonly<{ columns?: number; seconds?: number; theme?: PlanetTheme; intro?: boolean; dim?: number }>;
type PlanetHorizon = Readonly<{
  skyGradient: string; backgroundColor: string; backgroundColorTransparent: string;
  atmosphereColor: string; bloomColor: string; dividerColor: string;
}>;
type PlanetPalette = Readonly<{
  background: PlanetRgb; body: readonly (readonly [number, PlanetRgb])[];
  rose: PlanetRgb; attention: PlanetRgb; rim: PlanetRgb; halo: readonly (readonly [number, PlanetRgb])[];
  horizon: PlanetHorizon; websiteScrim: string; voiceField: string;
}>;
type Orb = Readonly<{ core: string; gold: string; amber: string; ember: string; plum: string; azure: string }>;
export const PLANET_PALETTES: Readonly<{
  dark: PlanetPalette & { readonly orb: Orb & { readonly abyss: string } };
  light: PlanetPalette & { readonly orb: Orb & { readonly violet: string; readonly veil: string } };
}>;
export const PLANET_LIGHT_RAMP: Readonly<{ warm: string; blush: string; violet: string; cool: string; deep: string }>;
export const PLANET_ARTWORK_BREATH: Readonly<{ durationMs: 20000; scalePeak: 1.012; bloomOpacityDelta: 0.1 }>;
export const PLANET_GRAIN: Readonly<{ opacity: 0.02; tileSize: 16 }>;
export const PLANET_ACCENT_HEX: string;
export const PLANET_ATTENTION_HEX: Readonly<{ light: string; dark: string }>;
export const PLANET_BREATH_SECONDS: number;
export const PLANET_FRAME_INTERVAL_MS: number;
export const PLANET_BREATH_FRAME_INTERVAL_MS: number;
export function planetFrameIntervalMs(seconds: number): number;
export function planetRowsForColumns(columns?: number): number;
export function createPlanetFrame(options?: PlanetFrameOptions): PlanetFrame;

export type PlanetDot = Readonly<{ id: number; x: number; y: number; radius: number; rgb: PlanetRgb; opacity: number }>;
export type PlanetMarkOptions = Readonly<{ size?: number; theme?: PlanetTheme }>;
export type PlanetDotPose = 'ready' | 'shadow' | 'eclipse' | 'shade';
export type PlanetDotOptions = PlanetMarkOptions & Readonly<{
  pose?: PlanetDotPose; energy?: number; light?: readonly [number, number, number]; bleed?: number;
  /** Lattice rows across the box (scene art keeps a finer lattice than a mark); default by size. */
  rows?: number;
  /** Atmosphere strength, 1 = the mark's resting halo. */
  halo?: number;
  /** 0…1 warmth towards the rim colour (golden hour). */
  warmth?: number;
}>;
export type PlanetMarkTier = Readonly<{ columns: number; rows: number; pitch: number; micDots: number }>;
export type PlanetDotPair = Readonly<{ id: number; mic: PlanetDot; planet: PlanetDot }>;
export type PlanetStatusCellKind = 'thinking' | 'working' | 'needs_you' | 'done' | 'idle' | 'off';
export function planetMarkTier(size?: number): PlanetMarkTier;
export function createMicDots(options?: PlanetMarkOptions): readonly PlanetDot[];
export function planetLightForProgress(progress: number): readonly [number, number, number];
export function createPlanetDots(options?: PlanetDotOptions): readonly PlanetDot[];

export type PlanetSides = Readonly<{ top?: number; right?: number; bottom?: number; left?: number }>;
export type PlanetSceneOptions = Readonly<{
  R: number; cx: number; cy: number; view: Readonly<{ w: number; h: number }>; dpr?: number; pitch?: number;
  theme?: PlanetTheme; style?: 'airy' | 'balanced' | 'rich'; fill?: number; rotate?: number; mirror?: boolean;
  fullness?: number; halo?: number | PlanetSides; tail?: number; rise?: number; light?: PlanetRgb;
  field?: number | Readonly<{
    around?: number; over?: number; overStyle?: 'emboss' | 'ink'; reach?: number | PlanetSides;
    fall?: number; ink?: number; start?: number; ramp?: number; cell?: number; seed?: number;
  }>;
  time?: number; rate?: number; gain?: number; binary?: boolean;
}>;
export type PlanetSceneDot = Readonly<{ x: number; y: number; r: number; rgb: PlanetRgb; opacity: number; i: number; j: number }>;
export type PlanetSceneCell = Readonly<{ x: number; y: number; a: number; rgb: PlanetRgb; ch: string; over: boolean; cut: boolean; fs: number; i: number; j: number }>;
export type PlanetScene = Readonly<{ body: readonly PlanetSceneDot[]; haze: readonly PlanetSceneDot[]; cells: readonly PlanetSceneCell[] }>;
/** Home uses a centre-anchored, cropped lattice; existing marks retain their edge-anchored slots. */
export function createPlanetScene(options: PlanetSceneOptions): PlanetScene;
/** The gain-1 `scene` re-gained (moment brightening): equal to `createPlanetScene({ ...options, gain })`, without resampling. */
export function gainPlanetScene(scene: PlanetScene, gain: number): PlanetScene;

export type PlanetSample = Readonly<{
  palette: PlanetPalette; light: PlanetRgb; reveal: number; breath: number; spin: number; glow: number; reach: number;
  gamma?: number; fleck?: number; detail?: number; full?: number; fleckDot?: boolean; bandStrength?: number; dusk?: number;
}>;
export function shadePlanetDot(px: number, py: number, dx: number, dy: number, sample: PlanetSample): Readonly<{ rgb: PlanetRgb; lit: boolean }>;

type SceneStyle = Readonly<{ pitchK: number; dotR: number; fleck: number; glowK: number; reach: number; detail: number }>;
type SceneField = Readonly<{
  around: number; over: number; fall: number; ink: number; start: number; ramp: number; overStyle: 'emboss' | 'ink';
  reach: number; reachAt: (x: number, y: number) => number; reachKey: string; seed: number; cell: number;
}>;
export type PlanetResolvedScene = Readonly<{
  tail: number; haloAt: ((x: number, y: number) => number) | null; haloMax: number; haloKey: string;
  full: number; fill: number; ST: SceneStyle; sample: PlanetSample; haloEnd: number;
  rc: number; rs: number; mir: number; rot: number; th: PlanetTheme; R: number; mode: string;
  pD: number; pitch: number; rise: number; L: PlanetRgb; gain: number; F: SceneField;
  dpr: number; CX: number; CY: number; cx: number; cy: number; x0: number; y0: number; W: number; H: number;
  time: number; rate: number; dp?: number; binary?: boolean; lightKey: string;
}>;
export type PlanetRawDot = Readonly<{ x: number; y: number; r: number; rgb: PlanetRgb; op: number; halo: boolean; i: number; j: number; px: number; py: number }>;
type RawCell = Omit<PlanetSceneCell, 'rgb'> & Readonly<{ col: PlanetRgb }>;
export type PlanetAssemblyPatch = Readonly<{ x: number; y: number; ks: number; d: number; sx: number; sy: number; col: PlanetRgb; a: number; i: number; j: number }>;
export type PlanetAssembly = Readonly<{
  P: PlanetResolvedScene; R: number; g: number; body: readonly (PlanetRawDot & Readonly<{ ks: number }>)[];
  patches: readonly PlanetAssemblyPatch[]; field: readonly (RawCell & Readonly<{ sx: number; sy: number; d: number }>)[];
}>;
export function planetAssembly(options: PlanetSceneOptions): PlanetAssembly;
export function planetLightAt(px: number, py: number, progress: number): number;
export function planetMaskAt(px: number, py: number, progress: number): number;
export const PLANET_MOMENT_TIMINGS: Readonly<{
  ASM: Readonly<{ FLY: 0.45; PATCH: 2 }>;
  W4: Readonly<{ T: 1.9; LIGHT0: 0.2; LIGHT1: 1.72; COPY0: 0.95; COPY1: 1.4; CROSS: 0.22 }>;
  L4: Readonly<{ GRACE: 0.25; RESOLVE: 0.5; TRAVEL: 0.5; FADE: 0.14 }>;
}>;
export type PlanetAssemblyProgress = Readonly<{
  t: number; prog: number; alpha?: number; halo: number; fieldU?: number; t0?: number; retype?: number; cloud?: number;
  landT: (patch: Pick<PlanetAssemblyPatch, 'ks' | 'd'>) => number;
  appear?: (patch: Readonly<{ d: number }>) => number; loose?: (patch: Pick<PlanetAssemblyPatch, 'ks'>) => number;
}>;
type PlanetMomentState = Readonly<{ rest: boolean; restAlpha?: number; copy?: number; time?: number; cover?: number; fast?: boolean; travel?: number }>;
export function planetMomentFrame(moment: 'welcome' | 'loading', time: number, ready?: number | null):
  PlanetMomentState & (Readonly<{ assembly: false }> | Readonly<{ assembly: true; frame: PlanetAssemblyProgress }>);
export function planetAssemblyFrame(assembly: PlanetAssembly, frame: PlanetAssemblyProgress): Readonly<{
  body: readonly Readonly<{ x: number; y: number; r: number; rgb: PlanetRgb; opacity: number }>[]; halo: number;
  cells: readonly Readonly<{ x: number; y: number; a: number; col: PlanetRgb; ch: string; over: boolean; cut: boolean; fs: number; weight: number }>[];
}>;
/** Pure maths shared with the lab's canvas shell; no DOM or canvas references. */
export const PLANET_SCENE_RENDERER: Readonly<{
  resolve: (options: PlanetSceneOptions, dpr: number, view: PlanetSceneOptions['view']) => PlanetResolvedScene;
  brandDots: (scene: PlanetResolvedScene) => readonly PlanetRawDot[];
  fieldCells: (scene: PlanetResolvedScene, all?: boolean) => readonly RawCell[];
  toArt: (scene: PlanetResolvedScene, x: number, y: number, out: [number, number]) => readonly [number, number];
  brandAt: (scene: PlanetResolvedScene, x: number, y: number) => Readonly<{ lit: boolean; rgb: PlanetRgb }>;
  sceneHash: (x: number, y: number) => number; digitOf: (i: number, j: number, time?: number, rate?: number) => number;
  bitOf: (i: number, j: number, time?: number, rate?: number) => number;
  sstep: (a: number, b: number, value: number) => number; easeOut: (v: number) => number;
  easeInOut: (v: number) => number; crit: (v: number, stiffness?: number) => number;
}>;
export const PLANET_SAMPLER: Readonly<{
  PLANET_PALETTES: typeof PLANET_PALETTES; BAYER: readonly number[]; shadePlanetDot: typeof shadePlanetDot;
  inkDot: (rgb: PlanetRgb, theme: PlanetTheme) => PlanetRgb;
  atmosphereForEnergy: (energy: number) => Readonly<{ glow: number; reach: number }>;
  lightForReveal: (reveal: number) => PlanetRgb; haloOpacity: (theme: PlanetTheme, distance: number) => number;
  gradient: (stops: readonly (readonly [number, PlanetRgb])[], position: number) => PlanetRgb;
  mixRgb: (a: PlanetRgb, b: PlanetRgb, t: number) => PlanetRgb; hash: (x: number, y: number) => number;
  DOT_RADIUS: 0.33; HERO_DOT_PITCH: 3.2; REST_SPIN: number;
}>;
export function createPlanetDotCorrespondence(options?: PlanetDotOptions): readonly PlanetDotPair[];
export function createPlanetStatusCell(options: PlanetMarkOptions & Readonly<{ kind: PlanetStatusCellKind; progress?: number }>): readonly PlanetDot[];

export type PlanetMarkGeometry = Readonly<{
  size: number; count: number; minX: number; minY: number; maxX: number; maxY: number;
  micX: readonly number[]; micY: readonly number[]; micR: readonly number[]; micA: readonly number[]; micRgb: readonly number[];
  /** The unlit disc the tap morph lands on: 1/0 per dot, one dot radius, RGB per dot. */
  discA: readonly number[]; discR: number; discRgb: readonly number[];
  planetX: readonly number[]; planetY: readonly number[]; planetR: readonly number[];
  /** Opacity and RGB per dot at each PLANET_MARK_ENERGY_SAMPLES level, flattened sample-major. */
  planetA: readonly number[]; planetRgb: readonly number[];
  tintIn: readonly [number, number, number]; tintOut: readonly [number, number, number];
}>;
export type PlanetMarkDrawDot = (x: number, y: number, radius: number, r: number, g: number, b: number, a: number) => void;
export const PLANET_MARK_ENERGY_SAMPLES: readonly number[];
export const PLANET_MARK_BLEED: number;
export function createPlanetMarkGeometry(options?: PlanetMarkOptions & Readonly<{ pose?: PlanetDotPose; light?: readonly [number, number, number] }>): PlanetMarkGeometry;
export function interpolatePlanetMarkGeometry(to: PlanetMarkGeometry, from: PlanetMarkGeometry, progress: number): PlanetMarkGeometry;
/** Opacity of an app's rest glyph drawn over the mark: 1 at rest, 0 once the tap's dots have streamed out. */
export function planetMarkRestGlyphOpacity(morph: number, leave: number): number;
/** Seconds a one-shot mark event (gather, leave) runs; the caller eases its own progress. */
export const PLANET_MARK_EVENT_SECONDS: number;
/**
 * `gather` (1 dispersed -> 0 home) and `leave` (0 -> 1 the exact rest microphone) are one-shot event
 * transforms; omitted or 0 they leave the frame unchanged.
 */
export function drawPlanetMarkFrame(
  to: PlanetMarkGeometry, from: PlanetMarkGeometry, morph: number, pose: number, energy: number, flow: number, draw: PlanetMarkDrawDot,
  gather?: number, leave?: number,
): void;
