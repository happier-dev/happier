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
    intensity: PlanetIntensity;
    digits: boolean;
    fade?: Readonly<{ from: number; to: number }>;
    assemble?: Timing;
    decode?: number;
    fall?: Timing & Readonly<{ from: Pick<GlyphPlanetGeometry, 'cx' | 'cy' | 'R'> }>;
    settle?: Timing;
    gain?: number;
    ring?: Readonly<{ progress: number }>;
}>;
export type MarkGlyphOptions = Readonly<{
    centre: GlyphPoint; size: number; ink: 'sunrise'; retypeS?: number; dissolve?: number; turn?: number; fill?: number;
    /** The opening's exact cells, packed as x, y, lock seconds and departure seconds. */
    cellTimeline?: Float32Array;
}>;
export type TravellerGlyphOptions = Readonly<{
    particles: Float32Array; ink: 'sunrise' | GlyphInk; small?: boolean;
    /** Presentation time from the same measured epoch when an in-flight layer is carried across a step. */
    presentationTimeS?: number;
}>;
export type FrontGlyphOptions = Readonly<{
    shape: 'superellipse' | 'roundRect';
    origin?: GlyphPoint;
    rect?: GlyphRect;
    front: number;
    band: number;
    ragged: number;
    alpha: number;
    ink: 'sunrise' | GlyphInk;
    mode: 'eat' | 'decode';
    inkMap?: GlyphInkMap;
    cover?: GlyphInk;
}>;
export type PlanetGlyphLayer = PlanetGlyphOptions & { kind: 'planet' };
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
}>;
export type FieldDotLayer = FieldDotOptions & { kind: 'field' };
export type GlyphLayer = PlanetGlyphLayer | MarkGlyphLayer | TravellerGlyphLayer | FrontGlyphLayer | FieldDotLayer;
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
export function frontGlyphLayer(options: FrontGlyphOptions): FrontGlyphLayer;
export function inkMapFromBoxes(boxes: readonly (GlyphRect & { ink: GlyphInk })[], grid: GlyphGrid): GlyphInkMap;
export function inkMapFromImage(pixels: Readonly<{ width: number; height: number; data: Uint8Array | Uint8ClampedArray }>, grid: GlyphGrid): GlyphInkMap;
export function createGlyphFrameSampler(): (scene: GlyphScene, motion?: Readonly<{ time?: number }>) => GlyphFrame;
export function glyphFrame(scene: GlyphScene, motion?: Readonly<{ time?: number }>): GlyphFrame;

export const glyphFieldDurationS: number;
export const glyphFieldTrailCell: number;
export const glyphFieldTrailLifeS: number;
export const glyphFieldRippleLifeS: number;
export function glyphFieldPhase(seconds: number): number;
export const glyphDotRadii: readonly number[];
export function fieldDotLayer(options: FieldDotOptions): FieldDotLayer;
