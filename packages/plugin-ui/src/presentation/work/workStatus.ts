/**
 * The shared status language of agent work (INT I3): where a piece of work stands, as one of five
 * buckets, the tone it is drawn in, and the owner's own state word.
 *
 * Extracted from Happier core's `apps/ui/sources/components/work/status/**`, which keeps only the
 * mapping from Happier's own owner facts (Sessions, workflow runs, worker updates) onto this
 * presentation. A plugin maps its own facts onto the same three fields; the words stay the owner's.
 */
import type { HappierTone } from '../semantics.js';

export type HappierWorkStatusBucket = 'needs_you' | 'working' | 'finished' | 'idle' | 'offline';

/** Healthy work is `neutral`; work that needs the person is `attention`; trouble is `danger`. */
export type HappierWorkStatusTone = 'neutral' | 'attention' | 'danger';

/** The shared semantic treatment for a Work tone in a status label or badge. */
export const HAPPIER_WORK_STATUS_SEMANTIC_TONE = {
  neutral: 'neutral',
  attention: 'warning',
  danger: 'danger',
} as const satisfies Readonly<Record<HappierWorkStatusTone, HappierTone>>;

export type HappierWorkStatusPresentation = Readonly<{
  bucket: HappierWorkStatusBucket;
  tone: HappierWorkStatusTone;
  /** The owner's own state word ("Completed", "Waiting for you"); never the bucket label. */
  word: string;
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

/** A state hue: the word and glyph ink, its faint tint, and the ring it is drawn from. */
export type HappierWorkStateColors = Readonly<{ foreground: string; background: string; border: string }>;

/** The colours the status treatment reads (a {@link HappierWorkTheme}'s `colors` satisfies it). */
export type HappierWorkStatusColors = Readonly<{
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
 * The ring and tint of a card or node in this tone (unified-work lab `.wm-node.need`, `.uws-card.need`):
 * the state hue at about half strength as a full ring, a 3px halo at about a tenth, over the state's
 * own tint. There is never a coloured left edge. `null` keeps healthy work neutral.
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
    backgroundColor: state.background,
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
  return stateColors(colors, tone)?.foreground ?? null;
}

/** A state glyph's colour in this tone (an icon has no text style): quiet secondary ink while healthy. */
export function resolveHappierWorkStatusGlyphColor(
  tone: HappierWorkStatusTone,
  colors: HappierWorkStatusColors,
): string {
  return stateColors(colors, tone)?.foreground ?? colors.secondaryText;
}
