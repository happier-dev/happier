export type AtmosphereTheme = 'light' | 'dark';
export type AtmosphereLook = 'original' | 'fine' | 'painted-fine' | 'halftone' | 'mosaic' | 'painted' | 'haze' | 'engraving';
export type AtmosphereDissolveStyle = 'ordered' | 'gradient' | 'haze' | 'shrink' | 'rows';
export type AtmosphereTransitionKind = 'crossfade' | 'resettle' | 'ripple';
export type AtmosphereRgb = readonly [number, number, number];
export const ATMOSPHERE_PICTURE_MAX_EDGE: 2560;
export const ATMOSPHERE_HORIZON_FADE_FROM: 0.58;
export type AtmosphereBackdropPicture = Pick<AtmospherePicture, 'hour' | 'grades' | 'dark' | 'horizon' | 'focus' | 'adjust'>;
export type AtmosphereSourceGrade = Readonly<{ from: number; to: number; hz?: number; horizon?: number }>;
export function pictureBackdropProps(input: Readonly<{
  picture: AtmosphereBackdropPicture | null; look: AtmosphereEffectiveLook; theme: AtmosphereTheme;
  page: AtmosphereRgb; layout: 'horizon' | 'wallpaper'; horizonAt: number;
}>): Readonly<{
  look: AtmosphereLook; params: Readonly<Record<string, number>>; dissolve: AtmosphereDissolve | null;
  focus: AtmosphereFocus; horizon?: AtmosphereHorizon; grade: AtmosphereSourceGrade | null;
  adjust: AtmosphereAdjustment | null; page: AtmosphereRgb; theme: AtmosphereTheme;
}>;
export function backdropBandGrade(grade: AtmosphereSourceGrade | null | undefined, crop: AtmosphereCrop,
  horizon?: AtmosphereHorizon): AtmosphereGrade | null | undefined;

/** Platform-decoded, cropped and sampled device-pixel source; no JPEG decoder is needed by the core. */
export interface AtmospherePixels {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}
/** Device-pixel pane rectangle in a shared virtual picture surface. */
export interface AtmosphereSpan { x: number; y: number; W: number; H: number }
export interface AtmosphereFocus { x?: number; y?: number; zoom?: number }
export interface AtmosphereHorizon { src?: number; at?: number }
export interface AtmosphereGrade { from: number; to: number; hz: number }
export interface AtmosphereAdjustment { exposure?: number; contrast?: number; saturation?: number; temperature?: number }
export interface AtmosphereDissolve { style: AtmosphereDissolveStyle; from: number; to: number }
export interface AtmosphereBackdropJob {
  source: AtmospherePixels;
  look: AtmosphereLook;
  page: AtmosphereRgb;
  theme: AtmosphereTheme;
  dpr?: number;
  /** Effect parameters use the catalogue defaults; strength and mute also live here. */
  params?: Readonly<Record<string, number | undefined>>;
  dissolve?: AtmosphereDissolve | null;
  span?: AtmosphereSpan | null;
  grade?: AtmosphereGrade | null;
  adjust?: AtmosphereAdjustment | null;
  toe?: boolean;
}
export interface AtmosphereBackdropResult extends AtmospherePixels { ms: number; fxMs: number }
export function renderBackdrop(job: AtmosphereBackdropJob): AtmosphereBackdropResult;

export interface AtmosphereLookParameter { id: string; min: number; max: number; step: number; default: number }
export interface AtmosphereLookDefinition { id: AtmosphereLook; label: string; group: string; note: string; params: readonly AtmosphereLookParameter[] }
export const ATMOSPHERE_LOOKS: readonly AtmosphereLookDefinition[];
export const ATMOSPHERE_DISSOLVES: readonly { id: AtmosphereDissolveStyle; label: string; note: string }[];
export const FADE_INK: 0.8;
export const ATMOSPHERE_PALETTE: {
  ramp: readonly { t: number; rgb: AtmosphereRgb }[];
  page: { light: string; dark: string };
  mute: { light: number; dark: number };
};
export function resolveParams(look: Pick<AtmosphereLookDefinition, 'params'> | undefined, params?: Readonly<Record<string, number | undefined>>): Record<string, number>;
export interface AtmosphereCrop {
  s: number; sx: number; sy: number; vw: number; vh: number;
  toBand(sourceFraction: number): number;
}
export function cropOf(source: { w: number; h: number }, virtualWidth: number, virtualHeight: number, focus?: AtmosphereFocus | null, horizon?: AtmosphereHorizon | null): AtmosphereCrop;

/** The lab atlas layout: one contiguous cw × ch alpha mask per character. */
export interface AtmosphereGlyphAtlas { cw: number; ch: number; chars: string; masks: Uint8Array }
export function atmosphereDigitLattice(w: number, h: number, dpr: number): { cw: number; ch: number; cols: number; rows: number };
interface AtmosphereTransitionBase {
  from: AtmospherePixels; to: AtmospherePixels;
  page: AtmosphereRgb; theme: AtmosphereTheme; dpr?: number;
  /** CSS-pixel origin/radius; the core scales these by dpr. */
  origin?: { x: number; y: number }; radius?: number;
}
export type AtmosphereTransitionOptions = AtmosphereTransitionBase & { glyphs?: AtmosphereGlyphAtlas };
export interface AtmosphereTransitionFrames { w: number; h: number; frame(progress: number): Uint8ClampedArray<ArrayBuffer> }
/** Frame buffers are reused; copy a returned frame if it must outlive the next call. Progress is normalized 0..1.
 * Like the lab scheduler, paint the complete target after the final ripple frame.
 */
export function createAtmosphereTransition(kind: 'ripple', options: AtmosphereTransitionBase & { glyphs: AtmosphereGlyphAtlas }): AtmosphereTransitionFrames;
export function createAtmosphereTransition(kind: 'crossfade' | 'resettle', options: AtmosphereTransitionOptions): AtmosphereTransitionFrames;
export function atmosphereTransition(kind: 'ripple', progress: number, options: AtmosphereTransitionBase & { glyphs: AtmosphereGlyphAtlas }): AtmospherePixels;
export function atmosphereTransition(kind: 'crossfade' | 'resettle', progress: number, options: AtmosphereTransitionOptions): AtmospherePixels;
export interface AtmosphereRippleOptions {
  w: number; h: number; page: AtmosphereRgb; theme: AtmosphereTheme;
  glyphs: AtmosphereGlyphAtlas; dpr?: number;
  x?: number; y?: number; radius?: number; colour?: AtmosphereRgb;
}
export function atmosphereRipple(progress: number, options: AtmosphereRippleOptions): AtmospherePixels & { rgba: Uint8ClampedArray<ArrayBuffer> };
export function rippleRingGeometry(progress: number, reach: number, rowHeight: number, dpr: number): { radius: number; band: number; fade: number };
/** The lab's ordered foot fade, in place on a straight-alpha RGBA store of `w × h` device pixels; `y0`/`y1` are css px. */
export function orderedFade(rgba: Uint8ClampedArray, w: number, h: number, y0: number, y1: number, dpr: number): void;

export interface AtmosphereReleaseLook {
  effect?: AtmosphereLook; params?: Readonly<Record<string, number>>;
  dissolve?: { style?: AtmosphereDissolveStyle; from?: number; to?: number };
  strength?: number;
}
export interface AtmospherePicture {
  id: string; kind: 'photo' | 'painting'; title: string;
  credit: { author: string; source: string; url: string; licence: string; note?: string };
  src: { full: string; thumb: string };
  horizon: AtmosphereHorizon; focus: AtmosphereFocus; hour: number;
  grades: { light: number; dusk: number; night: number };
  dark: 'dusk' | 'night'; look: AtmosphereReleaseLook;
  adjust?: AtmosphereAdjustment; themes?: readonly AtmosphereTheme[];
}
export const ATMOSPHERE_PICTURES: readonly AtmospherePicture[];
export interface AtmosphereEffectiveLook {
  effect: AtmosphereLook; params: Readonly<Record<string, number>>;
  fade: AtmosphereDissolveStyle; from: number | null; to: number | null; strength: number;
}
export type AtmosphereRememberedLooks = Readonly<Record<string, Partial<Pick<AtmosphereEffectiveLook, 'effect' | 'fade' | 'from' | 'to' | 'strength'>>>>;
export interface AtmosphereLookPicture { id: string; look?: AtmosphereReleaseLook; custom?: boolean; image?: unknown }
export function releaseLook(picture: Pick<AtmosphereLookPicture, 'look'>): AtmosphereEffectiveLook;
export function lookFor(id: string, looks?: AtmosphereRememberedLooks, pictures?: readonly AtmosphereLookPicture[]): AtmosphereEffectiveLook & { sky: string; src: { sky: string } | { image: unknown } };
export function changedKeys(id: string, looks?: AtmosphereRememberedLooks): string[];
