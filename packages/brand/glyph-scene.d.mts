import type { GlyphPlanetGeometry } from './planet-placement.mjs';

export type GlyphInk = readonly [number, number, number, number?];
export type GlyphRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type GlyphPoint = Readonly<{ x: number; y: number }>;
export type GlyphGrid = Readonly<{ cell: readonly [number, number]; cols: number; rows: number; origin: readonly [number, number] }>;
export type GlyphInkMap = Readonly<{ rgba: Uint8Array; cols: number; rows: number }>;
export type PlanetIntensity = 'quiet' | 'calm' | 'full';
type Timing = Readonly<{ startS?: number; durationS: number }>;
export type PlanetGlyphOptions = Readonly<{
    geometry: GlyphPlanetGeometry;
    /** Full-colour lab ink by default. Preference-backed surfaces can supply their selected intensity. */
    intensity?: PlanetIntensity;
    digits: boolean;
    /** Visible digit cadence. Defaults to the scene clock for callers that choreograph their own digits. */
    digitTimeS?: number;
    fade?: Readonly<{ from: number; to: number }>;
    assemble?: Timing;
    fall?: Timing & Readonly<{ from: Pick<GlyphPlanetGeometry, 'cx' | 'cy' | 'R'> }>;
    settle?: Timing;
    gain?: number;
    ring?: Readonly<{ progress: number }>;
    /** Phone: a sparse share of cells, each nudged and dimmed (the lab's soft planet). */
    soft?: boolean;
}>;
export type MarkGlyphOptions = Readonly<{
    centre: GlyphPoint; size: number; ink: 'sunrise'; retypeS?: number; dissolve?: number; turn?: number; fill?: number;
    /** The opening's exact cells, packed as x, y, lock seconds and departure seconds. */
    cellTimeline?: Float32Array;
}>;
export type TravellerGlyphOptions = Readonly<{
    particles: Float32Array; ink: 'sunrise' | GlyphInk; small?: boolean;
    /** Opacity of every particle in the layer (default 1). */
    alpha?: number;
    /** Presentation time from the same measured epoch when an in-flight layer is carried across a step. */
    presentationTimeS?: number;
    /** Step morph progress supplies the envelope around the particles' individual flight times. */
    stepMorphProgress?: number;
}>;
export type FrontGlyphOptions = Readonly<{
    shape: 'superellipse' | 'roundRect' | 'horizontal';
    origin?: GlyphPoint;
    rect?: GlyphRect;
    front: number;
    band: number;
    ragged: number;
    alpha: number;
    ink: 'sunrise' | GlyphInk;
    mode: 'eat' | 'decode';
    inkMap?: GlyphInkMap;
    /** Lift the sampled leaving ink after the climbing front passes it. */
    climbProgress?: number;
    cover?: GlyphInk;
}>;
export type PlanetGlyphLayer = PlanetGlyphOptions & Readonly<{ kind: 'planet'; intensity: PlanetIntensity }>;
export type MarkGlyphLayer = MarkGlyphOptions & { kind: 'mark' };
export type TravellerGlyphLayer = TravellerGlyphOptions & { kind: 'traveller' };
export type FrontGlyphLayer = FrontGlyphOptions & { kind: 'front' };
export type GlyphFieldMode = 'animated' | 'still' | 'off';
type FieldInput = GlyphPoint & { at: number };
export type FieldDotOptions = Readonly<{
    mode: GlyphFieldMode;
    quiet?: readonly (GlyphRect & { level?: number; feather?: number })[];
    seed?: number;
    strength?: number;
    phaseS?: number;
    elapsedS?: number;
    stampTimeS?: number;
    stirs?: readonly FieldInput[];
    ripples?: readonly FieldInput[];
    /** The planet the field gives way around (css px). */
    planet?: Readonly<{ cx: number; cy: number; R: number }>;
}>;
export type FieldDotLayer = FieldDotOptions & { kind: 'field' };
export type PlacedGlyphLayer = Readonly<{ kind: 'placed'; cells: Float32Array }>;
export type GlyphLayer = PlanetGlyphLayer | MarkGlyphLayer | TravellerGlyphLayer | FrontGlyphLayer | FieldDotLayer | PlacedGlyphLayer;
type GlyphSprites = Readonly<{ at: Uint16Array; glyph: Uint8Array; rgba: Uint8Array }>;
export type GlyphScene = Readonly<{
    view: Readonly<{ w: number; h: number }>;
    dpr: number;
    theme: 'dark' | 'light';
    layers: readonly GlyphLayer[];
    cell?: readonly [number, number];
}>;
export type GlyphFrame = Readonly<{
    width: number;
    height: number;
    grid: GlyphGrid;
    sprites: GlyphSprites;
    field: Readonly<{
        sprites: GlyphSprites;
        mask: Readonly<{ rgba: Uint8Array; width: number; height: number }>;
        maskExtent: readonly [number, number];
        revision: number;
    }> | null;
    body: Readonly<{
        rgba: Uint8Array;
        cols: number;
        rows: number;
        disc: Readonly<{ cx: number; cy: number; R: number }>;
        fade?: Readonly<{ from: number; to: number }>;
        fadeMask: Readonly<{ rgba: Uint8ClampedArray; width: number; height: number }> | null;
    }> | null;
}>;
export function planetGlyphLayer(options: PlanetGlyphOptions): PlanetGlyphLayer;
export function markGlyphLayer(options: MarkGlyphOptions): MarkGlyphLayer;
export function markGlyphTone(layer: Pick<MarkGlyphOptions, 'centre' | 'size'>, x: number, y: number): number;
export function travellerGlyphLayer(options: TravellerGlyphOptions): TravellerGlyphLayer;
export const loadingPlanetSize: number;
export function createLoadingPlanetScene(): (
    seconds: number, origin?: Pick<GlyphPlanetGeometry, 'cx' | 'cy' | 'R'>, orbitOpacity?: number,
) => readonly [PlanetGlyphLayer, TravellerGlyphLayer];
export function frontGlyphLayer(options: FrontGlyphOptions): FrontGlyphLayer;
/** Pre-positioned cells packed as CSS x, CSS y, atlas index, R, G, B, and opacity. */
export function placedGlyphLayer(cells: Float32Array): PlacedGlyphLayer;
export function inkMapFromBoxes(boxes: readonly (GlyphRect & { ink: GlyphInk })[], grid: GlyphGrid): GlyphInkMap;
export function inkMapFromImage(pixels: Readonly<{ width: number; height: number; data: Uint8Array | Uint8ClampedArray }>, grid: GlyphGrid): GlyphInkMap;
export function createGlyphFrameSampler(): (scene: GlyphScene, motion?: Readonly<{ time?: number }>) => GlyphFrame;
export function glyphFrame(scene: GlyphScene, motion?: Readonly<{ time?: number }>): GlyphFrame;

export const glyphFieldDurationS: number;
export const glyphDigitStepS: number;
export const glyphFieldTrailCell: number;
export const glyphFieldTrailLifeS: number;
export const glyphFieldRippleLifeS: number;
export function glyphFieldPhase(seconds: number): number;
export const glyphDotRadii: readonly number[];
/** The light ramp's glyphs, dimmest first; atlas tiles from `glyphRampFirstTile`. */
export const glyphRampChars: string;
export const glyphRampFirstTile: number;
/** The planet's digits at the ramp's size, `glyphPlanetDigitFirstTile + digit`. */
export const glyphPlanetDigitFirstTile: number;
/** The planet's lattice dot tile and its radius in css px. */
export const glyphLatticeTile: number;
export const glyphLatticeRadius: number;
export function homeFieldStrength(intensity: PlanetIntensity, options?: Readonly<{ phone?: boolean }>): number;
export function fieldDotLayer(options: FieldDotOptions): FieldDotLayer;
