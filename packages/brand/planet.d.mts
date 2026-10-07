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
export function drawPlanetMarkFrame(
  to: PlanetMarkGeometry, from: PlanetMarkGeometry, morph: number, pose: number, energy: number, flow: number, draw: PlanetMarkDrawDot,
): void;
