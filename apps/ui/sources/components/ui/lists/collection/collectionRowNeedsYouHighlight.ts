/**
 * The opt-in "Highlight sessions that need you" preference (owner ruling 2026-11-01, device-local
 * `sessionListNeedsYouHighlight`): Dot (default) adds nothing to the amber dot; Accent a static leading bar;
 * Glint one sweep, Shimmer a slow repeating sweep, Pulse a breathing dot. Motion runs only on a visible row the
 * person has not opened since it started needing them, and reduced motion falls back to Accent.
 * Callers decide that the row needs the person and sits outside the Needs you shelf before asking.
 */
export const NEEDS_YOU_HIGHLIGHTS = ['dot', 'accent', 'glint', 'shimmer', 'pulse'] as const;
export type NeedsYouHighlightPreference = (typeof NEEDS_YOU_HIGHLIGHTS)[number];

export type CollectionRowNeedsYouHighlight = Readonly<{ leading: 'accent' | 'glint' | 'shimmer' | null; pulse: boolean }>;

const NONE: CollectionRowNeedsYouHighlight = Object.freeze({ leading: null, pulse: false });
const ACCENT: CollectionRowNeedsYouHighlight = Object.freeze({ leading: 'accent', pulse: false });
const GLINT: CollectionRowNeedsYouHighlight = Object.freeze({ leading: 'glint', pulse: false });
const SHIMMER: CollectionRowNeedsYouHighlight = Object.freeze({ leading: 'shimmer', pulse: false });
const PULSE: CollectionRowNeedsYouHighlight = Object.freeze({ leading: null, pulse: true });

export function resolveCollectionRowNeedsYouHighlight(input: Readonly<{
    preference: NeedsYouHighlightPreference;
    reducedMotion: boolean;
    /** The person has not opened the row since it started needing them (its news is unread). */
    unopened: boolean;
    /** The row is on screen in a presented list. */
    visible: boolean;
}>): CollectionRowNeedsYouHighlight {
    if (input.preference === 'dot') return NONE;
    if (input.preference === 'accent' || input.reducedMotion) return ACCENT;
    if (!input.unopened || !input.visible) return NONE;
    return input.preference === 'glint' ? GLINT : input.preference === 'shimmer' ? SHIMMER : PULSE;
}
