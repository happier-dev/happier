import type { PlanetRgb, PlanetSceneOptions, PlanetTheme } from './planet.mjs';

/** Raw modules from the existing QR encoder: { size: matrix.size, data: matrix.bits, text: payload }.
 * Preserve quartile/Q error correction for the lab's central mark. The package never encodes a payload.
 */
export interface QrMomentMatrix { readonly size: number; readonly data: ArrayLike<number>; readonly text: string }
export interface QrMomentDigit { readonly sx: number; readonly sy: number; readonly d: number; readonly bit: '0' | '1'; readonly col: PlanetRgb }
export interface QrMomentModule extends QrMomentDigit { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly i: number }
export interface QrMomentModel {
  readonly N: number; readonly cell: number; readonly ox: number;
  readonly mods: readonly QrMomentModule[]; readonly extra: readonly QrMomentDigit[];
  readonly eyes: readonly Readonly<{ cx: number; cy: number }>[];
  readonly half: number; readonly hole: number; readonly text: string;
}
export interface PlanetCollapseCell { readonly x: number; readonly y: number; readonly e: 1; readonly col: PlanetRgb; readonly i: number; readonly j: number; readonly r: number }
export function qrMomentModel(matrix: QrMomentMatrix, sizeCssPx: number, dpr?: number): QrMomentModel;
/** Prepare these targets once for the model size and theme; pass them to scan frames to avoid recomputation. */
export const PAIRING_PLANET_LOOK: Readonly<{ fullness: 1; style: 'balanced'; pitch: 2 }>;
export const pairingGlyphCell: readonly [number, number];
export function planetCollapseCells(options: Pick<PlanetSceneOptions, 'R' | 'theme'>): readonly PlanetCollapseCell[];

export type MomentPlanetOptions = Omit<PlanetSceneOptions, 'view'> & Readonly<{
  view?: PlanetSceneOptions['view']; fieldDp?: number;
}>;

/** Ordered, serializable paint data in CSS pixels. The drawing owner interprets these on Canvas/Skia.
 * `planet` is projected to atlas cells; `happier-mark` is supplied by the drawing owner.
 * Gradient ids are local to one frame. Fonts are lab references; platform font aliases belong to the painter.
 */
export type MomentPaintCommand =
  | readonly ['set', 'fillStyle' | 'strokeStyle', string | Readonly<{ gradient: number }>]
  | readonly ['set', 'font', string]
  | readonly ['set', 'textAlign', 'center']
  | readonly ['set', 'textBaseline', 'middle' | 'top']
  | readonly ['set', 'globalAlpha' | 'lineWidth', number]
  | readonly ['save' | 'restore' | 'beginPath' | 'stroke']
  | readonly ['fill', ('evenodd')?]
  | readonly ['translate' | 'scale', number, number]
  | readonly ['roundRect', number, number, number, number, number]
  | readonly ['arc', number, number, number, number, number]
  | readonly ['fillRect', number, number, number, number]
  | readonly ['fillText', string, number, number]
  | readonly ['setLineDash', readonly number[]]
  | readonly ['createLinearGradient', number, number, number, number, number]
  | readonly ['createRadialGradient', number, number, number, number, number, number, number]
  | readonly ['addColorStop', number, number, string]
  | readonly ['drawImage', 'happier-mark', number, number, number, number]
  | readonly ['planet', MomentPlanetOptions];
export type MomentVectorCommand = Exclude<MomentPaintCommand, readonly ['planet', MomentPlanetOptions]>;
export function createPairingGlyphSampler(): (commands: readonly MomentPaintCommand[], view: Readonly<{ w: number; h: number }>, dpr: number) => Readonly<{
    behind: readonly MomentVectorCommand[];
    planet: Readonly<{ layer: import('./glyph-scene.mjs').PlacedGlyphLayer; opacity: number }> | null;
    ahead: readonly MomentVectorCommand[];
}>;
interface QrFrameBase {
  readonly size: number; readonly theme?: PlanetTheme;
  readonly collapseTargets?: readonly PlanetCollapseCell[];
}
export type QrMomentFrameOptions = QrFrameBase & (
  | Readonly<{ phase?: 'assemble' | 'scan' }>
  | Readonly<{ phase: 'reform'; next: QrMomentModel; wait?: number }>
);
/** Seconds since readiness/expiry/scan. Negative time holds the pre-event state.
 * The returned held payload becomes non-null only after the new code fully assembles.
 * Reduced motion and scheduling belong to the caller: use QR.T for an immediately held code.
 */
export function qrMomentFrame(model: QrMomentModel, timeSeconds: number, options: QrMomentFrameOptions): Readonly<{ commands: readonly MomentPaintCommand[]; held: string | null }>;
export interface PairingMomentOptions {
  readonly w: number; readonly h: number; readonly theme?: PlanetTheme;
  readonly layout?: 'wide' | 'square'; readonly phase?: 'handoff' | 'adding' | 'joined';
  readonly devices?: readonly Readonly<{ n: string; isNew?: boolean }>[];
}
export function pairingMomentFrame(timeSeconds: number, options: PairingMomentOptions): readonly MomentPaintCommand[];
export interface ThemeSwitchOptions {
  readonly w: number; readonly h: number; readonly dir?: 'sunrise' | 'night';
  /** Horizon/TH3 is the product moment; radial/curtain preserve the lab's comparison scenes. */
  readonly kind?: 'horizon' | 'radial' | 'curtain'; readonly dp?: number; readonly depth?: number;
  /** The destination theme's text ink (any CSS colour); the digits take it so they read on the incoming theme. */
  readonly ink?: string;
}
export function themeSwitchFrame(timeSeconds: number, options: ThemeSwitchOptions): Readonly<{
  commands: readonly MomentPaintCommand[]; clipPath: string; visibility: 'hidden' | 'visible';
}>;
export const themeHorizonGlyphCell: readonly [number, number];
export function createThemeHorizonGlyphSampler(): (timeSeconds: number, options: ThemeSwitchOptions, ink?: PlanetRgb) => Readonly<{
  commands: readonly MomentVectorCommand[]; clipPath: string; visibility: 'hidden' | 'visible';
  glyphs: import('./glyph-scene.mjs').PlacedGlyphLayer;
}>;
export interface SessionFinishedRippleOptions { readonly w: number; readonly theme?: PlanetTheme; readonly px?: number; readonly py?: number; readonly R?: number }
export function sessionFinishedRippleFrame(timeSeconds: number, options: SessionFinishedRippleOptions): Readonly<{
  planet: MomentPlanetOptions & Readonly<{ gain: number; fieldDp: number }>;
  /** Pass normalized progress to atmosphereRipple; null means clear the ring overlay. */
  ringProgress: number | null;
}>;
export const FURTHER_PLANET_MOMENT_TIMINGS: Readonly<{
  QR: Readonly<{ T: 0.92; FLY: 0.5; SPREAD: 0.22; EYE0: 0.56; EYE: 0.32; BREAK: 0.32 }>;
  SCAN: Readonly<{ FOLD: 0.56; T: 0.9 }>;
  PAIR: Readonly<{ HAND: 0.5; TRACE: 0.46; IGNITE0: 0.36; RING: 0.75; T: 1.15 }>;
  TH: Readonly<{ DUR: 1.2 }>; RIP: Readonly<{ DUR: 1.6 }>; RESETTLE: Readonly<{ DUR: 1.8 }>;
}>;
/** Each trigger's window after an admitted moment: ripple finishes merge inside it; the resettle waits it out. */
export const MOMENT_TRIGGER_WINDOWS_MS: Readonly<{ ripple: 8000; resettle: 3600000 }>;
export interface MomentTriggerDecision { readonly trigger: boolean; readonly lastTriggeredAtMs: number | null }
/** Keep the timestamp in the mounted Home owner; null admits its first eligible event.
 * wasFinished is the prior turn-complete-with-no-approval state of the observed session.
 * Hidden events are consumed by session observation and must not be replayed on returning Home.
 */
export function sessionFinishedRippleTrigger(input: Readonly<{
  nowMs: number; lastTriggeredAtMs: number | null; wasFinished: boolean;
  turnComplete: boolean; pendingApproval: boolean; homeVisible: boolean;
}>): MomentTriggerDecision;
/** Home idle includes no typing. Keep the timestamp across visibility/idle changes.
 * Use atmosphereTransition('resettle', t / RESETTLE.DUR, ...) for the existing blue-noise maths.
 */
export function idleResettleTrigger(input: Readonly<{
  nowMs: number; lastTriggeredAtMs: number | null; homeIdle: boolean; homeVisible: boolean;
}>): MomentTriggerDecision;
