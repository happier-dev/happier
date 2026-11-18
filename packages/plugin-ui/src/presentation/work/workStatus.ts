/**
 * The shared status language of agent work (INT I3): where a piece of work stands, as one of five
 * buckets, the tone it is drawn in, and the owner's own state word.
 *
 * Extracted from Happier core's `apps/ui/sources/components/work/status/**`, which keeps only the
 * mapping from Happier's own owner facts (Sessions, workflow runs, worker updates) onto this
 * presentation. A plugin maps its own facts onto the same fields; the words stay the owner's.
 */
import type { HappierIconName } from '../content/Icon.js';
import type { HappierTone } from '../semantics.js';

export type HappierWorkStatusBucket = 'needs_you' | 'working' | 'finished' | 'idle' | 'offline';

/** Healthy work is `neutral`; work that needs the person is `attention`; trouble is `danger`. */
export type HappierWorkStatusTone = 'neutral' | 'attention' | 'danger';

/** The shared semantic treatment for a Work tone in a status label or badge. */
export const HAPPIER_WORK_STATUS_SEMANTIC_TONE = {
  neutral: 'neutral',
  attention: 'attention',
  danger: 'danger',
} as const satisfies Readonly<Record<HappierWorkStatusTone, HappierTone>>;

export type HappierWorkStatusPresentation = Readonly<{
  /** The domain owner's state; Session vocabulary remains Protocol-owned. */
  state: string;
  bucket: HappierWorkStatusBucket;
  tone: HappierWorkStatusTone;
  /** C1's admitted classification, independent of the visible status tone. */
  attentionType: 'mention' | 'blocked' | 'decision' | 'approval' | 'update' | null;
  /** The owner's own state word ("Completed", "Waiting for you"); never the bucket label. */
  word: string;
  /** The public semantic icon token, resolved by the shared status renderer. */
  glyph?: HappierIconName;
}>;

/** Caller-owned group membership and C1 subject count; unavailable coverage is never zero. */
export type CollectionGroupRollup = Readonly<{
  status: HappierWorkStatusPresentation | null;
  needsYouCount: number | null;
  coverage: 'complete' | 'partial' | 'unavailable';
}>;

/** The buckets in reading order: the columns of a by-status board and the groups of every status list. */
export const HAPPIER_WORK_STATUS_BUCKETS: readonly HappierWorkStatusBucket[] = Object.freeze([
  'needs_you',
  'working',
  'finished',
  'idle',
  'offline',
]);

/** The host-reserved translation key of each bucket's label, resolved in the host's locale. */
export const HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS: Readonly<Record<HappierWorkStatusBucket, string>> = Object.freeze({
  needs_you: 'happier.plugin-ui.workStatus.needsYou',
  working: 'happier.plugin-ui.workStatus.working',
  finished: 'happier.plugin-ui.workStatus.finished',
  idle: 'happier.plugin-ui.workStatus.idle',
  offline: 'happier.plugin-ui.workStatus.offline',
});

const BUCKET_LABEL_FALLBACKS: Readonly<Record<HappierWorkStatusBucket, string>> = Object.freeze({
  needs_you: 'Needs you',
  working: 'Working',
  finished: 'Finished',
  idle: 'Idle',
  offline: 'Offline',
});

/**
 * The one label of a bucket (Needs you · Working · Finished · Idle · Offline). Pass the environment's
 * `translate` so it reads in the host's locale; without one it is the English label.
 */
export function resolveHappierWorkStatusBucketLabel(
  bucket: HappierWorkStatusBucket,
  translate?: (key: string, fallback?: string) => string,
): string {
  const fallback = BUCKET_LABEL_FALLBACKS[bucket];
  return translate ? translate(HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS[bucket], fallback) : fallback;
}

/** The marker ink, text ink, tint and ring for a Work state. */
export type HappierWorkStateColors = Readonly<{
  foreground: string;
  /** A state with one ink can omit this role and use its foreground for the word. */
  textForeground?: string;
  background: string;
  border: string;
}>;

/** The colours the status treatment reads (a {@link HappierWorkTheme}'s `colors` satisfies it). */
export type HappierWorkStatusColors = Readonly<{
  /**
   * The card's own fill. Given, a tone's tint is laid over it as one opaque colour, so a tinted card never
   * shows what lies beneath it (a Board Canvas's dots, a card it overlaps).
   */
  surface?: string;
  secondaryText: string;
  attention: HappierWorkStateColors;
  danger: HappierWorkStateColors;
}>;

/** `#RRGGBB` at an alpha; a non-hex colour (a custom theme's rgba) has no softened form. */
export function softenHappierWorkColor(color: string, alpha: number): string | null {
  const hex = /^#([0-9a-fA-F]{6})$/u.exec(color.trim());
  if (!hex) return null;
  const value = parseInt(hex[1]!, 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function parseRgba(color: string): readonly [number, number, number, number] | null {
  const value = color.trim();
  const hex = /^#([0-9a-fA-F]{6})$/u.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])] : null;
}

/** A translucent tint laid over an opaque fill, as the one opaque colour it shows; unparseable input keeps the tint. */
function layOver(tint: string, surface: string | undefined): string {
  const over = parseRgba(tint);
  const under = surface === undefined ? null : parseRgba(surface);
  if (!over || !under || under[3] !== 1) return tint;
  const channel = (index: number) => Math.round(over[index]! * over[3] + under[index]! * (1 - over[3]));
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/** The needs-you wash for a fill: lighter on light paper, stronger on dark; 5% when the fill is unknown. */
function attentionWashAlpha(surface: string | undefined): number {
  const rgba = surface === undefined ? null : parseRgba(surface);
  if (!rgba) return 0.05;
  const luminance = (0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]) / 255;
  return luminance < 0.5 ? 0.07 : 0.04;
}

function stateColors(colors: HappierWorkStatusColors, tone: HappierWorkStatusTone): HappierWorkStateColors | null {
  if (tone === 'attention') return colors.attention;
  if (tone === 'danger') return colors.danger;
  return null;
}

type WorkStatusSurfaceStyle = Readonly<{
  borderWidth: 1;
  borderColor: string;
  backgroundColor: string;
  boxShadow?: string;
}>;

/**
 * The ring and tint of a card or node in this tone (unified-work lab `.wm-node.need`, `.uws-card.need`;
 * PLAN §5.3, owner ruling 2026-10-09): the state hue at about half strength as a full ring, a 3px halo at
 * about a tenth, over the state's own tint. Needs-you and trouble both carry it, each in its own hue.
 * There is never a coloured left edge. `null` keeps healthy work neutral.
 */
export function resolveHappierWorkStatusSurfaceStyle(
  tone: Exclude<HappierWorkStatusTone, 'neutral'>,
  colors: HappierWorkStatusColors,
): WorkStatusSurfaceStyle;
export function resolveHappierWorkStatusSurfaceStyle(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): WorkStatusSurfaceStyle | null;
export function resolveHappierWorkStatusSurfaceStyle(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): WorkStatusSurfaceStyle | null {
  const state = stateColors(colors, tone);
  if (state === null) return null;
  const halo = softenHappierWorkColor(state.border, 0.12);
  return {
    borderWidth: 1,
    borderColor: softenHappierWorkColor(state.border, 0.55) ?? state.border,
    // The ring speaks; the wash only warms the paper (lab `.uwr-hold.st-need`: 4% on light paper, 7% on
    // dark, where the same hue needs more presence). A heavier wash turns a reading card into an amber slab.
    backgroundColor: layOver(tone === 'attention'
      ? softenHappierWorkColor(state.border, attentionWashAlpha(colors.surface)) ?? state.background : state.background,
      colors.surface),
    ...(halo ? { boxShadow: `0 0 0 3px ${halo}` } : null),
  };
}

/**
 * The state word's ink in this tone; `null` keeps the surface's quiet text colour. A word in a
 * non-neutral tone is also drawn strong (semi-bold), so the tone never rests on colour alone.
 */
export function resolveHappierWorkStatusWordColor(
  tone: Exclude<HappierWorkStatusTone, 'neutral'>,
  colors: HappierWorkStatusColors,
): string;
export function resolveHappierWorkStatusWordColor(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): string | null;
export function resolveHappierWorkStatusWordColor(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): string | null {
  const state = stateColors(colors, tone);
  return state === null ? null : state.textForeground ?? state.foreground;
}

/** A state glyph's colour in this tone (an icon has no text style): quiet secondary ink while healthy. */
export function resolveHappierWorkStatusGlyphColor(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): string {
  return stateColors(colors, tone)?.foreground ?? colors.secondaryText;
}
