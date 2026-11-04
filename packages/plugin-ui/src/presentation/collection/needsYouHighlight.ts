/**
 * The opt-in "Highlight sessions that need you" preference (owner ruling 2026-11-01, device-local
 * `sessionListNeedsYouHighlight`): Dot (default) adds nothing to the amber dot; Accent a static leading bar;
 * Glint one sweep, Shimmer a slow repeating sweep, Pulse a breathing dot. Motion runs only on a visible row the
 * person has not opened since it started needing them, and reduced motion falls back to Accent.
 * Callers decide that the row needs the person and sits outside the Needs you shelf before asking.
 */
export const HAPPIER_NEEDS_YOU_HIGHLIGHTS = ['dot', 'accent', 'glint', 'shimmer', 'pulse'] as const;
export type HappierNeedsYouHighlightPreference = (typeof HAPPIER_NEEDS_YOU_HIGHLIGHTS)[number];

export type HappierCollectionRowNeedsYouHighlight = Readonly<{ leading: 'accent' | 'glint' | 'shimmer' | null; pulse: boolean }>;

/** Whether a row that needs the person has been opened since, and whether it is on screen. */
export type HappierCollectionRowNeedsYouFacts = Readonly<{ unopened: boolean; visible: boolean }>;

const NONE: HappierCollectionRowNeedsYouHighlight = Object.freeze({ leading: null, pulse: false });
const ACCENT: HappierCollectionRowNeedsYouHighlight = Object.freeze({ leading: 'accent', pulse: false });
const GLINT: HappierCollectionRowNeedsYouHighlight = Object.freeze({ leading: 'glint', pulse: false });
const SHIMMER: HappierCollectionRowNeedsYouHighlight = Object.freeze({ leading: 'shimmer', pulse: false });
const PULSE: HappierCollectionRowNeedsYouHighlight = Object.freeze({ leading: null, pulse: true });

export function resolveHappierCollectionRowNeedsYouHighlight(input: Readonly<{
  preference: HappierNeedsYouHighlightPreference;
  reducedMotion: boolean;
  /** The person has not opened the row since it started needing them (its news is unread). */
  unopened: boolean;
  /** The row is on screen in a presented list. */
  visible: boolean;
}>): HappierCollectionRowNeedsYouHighlight {
  if (input.preference === 'dot') return NONE;
  if (input.preference === 'accent' || input.reducedMotion) return ACCENT;
  if (!input.unopened || !input.visible) return NONE;
  return input.preference === 'glint' ? GLINT : input.preference === 'shimmer' ? SHIMMER : PULSE;
}
