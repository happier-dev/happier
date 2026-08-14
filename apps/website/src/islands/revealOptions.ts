/**
 * The viewport thresholds that decide when a word-reveal starts playing.
 *
 * These values live here, in a module with no React import, because two very
 * different things need them: src/components/RevealText.tsx (a React component)
 * and src/islands/armReveals.ts (a ~40-line DOM script that must not pull React
 * into a page that has none). Duplicating them would mean the animation on a
 * prose page and the animation inside an island drift apart, and nobody would
 * notice for months because both look fine in isolation.
 *
 * They are the values RevealText.tsx has always used, moved rather than chosen:
 * src/components/RevealText.test.ts and src/styles/revealMotion.test.ts assert
 * the exact numbers, and src/islands/revealOptions.test.ts asserts that this
 * module and RevealText still agree for as long as both define them.
 */

export const DESKTOP_REVEAL_INTERSECTION_OPTIONS = {
    threshold: 0.22,
    rootMargin: '0px 0px -18% 0px',
} satisfies IntersectionObserverInit;

export const MOBILE_REVEAL_INTERSECTION_OPTIONS = {
    threshold: 0.01,
    rootMargin: '0px 0px 20% 0px',
} satisfies IntersectionObserverInit;

export function resolveRevealIntersectionOptions(isMobilePointer: boolean): IntersectionObserverInit {
    return isMobilePointer ? MOBILE_REVEAL_INTERSECTION_OPTIONS : DESKTOP_REVEAL_INTERSECTION_OPTIONS;
}

/** The attribute that marks a run of words the armer should animate together. */
export const REVEAL_GROUP_ATTR = 'data-reveal-group';

/** Milliseconds before the first word of a group starts. */
export const REVEAL_DELAY_ATTR = 'data-reveal-delay';

/** Milliseconds between consecutive words of a group. */
export const REVEAL_STAGGER_ATTR = 'data-reveal-stagger';

/** The class a word ships in, and the class it is swapped to when armed. */
export const REVEAL_IDLE_CLASS = 'reveal-word-idle';
export const REVEAL_ARMED_CLASS = 'reveal-word';

/** Matches the `stagger` default in src/components/RevealText.tsx. */
export const REVEAL_DEFAULT_STAGGER_MS = 70;
