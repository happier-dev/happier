import { describe, expect, it } from 'vitest';

import { resolveHappierCollectionRowNeedsYouHighlight } from './needsYouHighlight.js';

const live = { reducedMotion: false, unopened: true, visible: true } as const;

describe('resolveHappierCollectionRowNeedsYouHighlight (opt-in, owner ruling 2026-11-01)', () => {
    it('adds nothing for the default Dot, and a static leading bar for Accent whatever the motion facts', () => {
        expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference: 'dot' })).toEqual({ leading: null, pulse: false });
        for (const facts of [live, { reducedMotion: true, unopened: false, visible: false }]) {
            expect(resolveHappierCollectionRowNeedsYouHighlight({ ...facts, preference: 'accent' })).toEqual({ leading: 'accent', pulse: false });
        }
    });

    it('runs the chosen motion only on a visible row the person has not opened yet', () => {
        expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference: 'glint' })).toEqual({ leading: 'glint', pulse: false });
        expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference: 'shimmer' })).toEqual({ leading: 'shimmer', pulse: false });
        expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference: 'pulse' })).toEqual({ leading: null, pulse: true });
        for (const preference of ['glint', 'shimmer', 'pulse'] as const) {
            expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference, unopened: false })).toEqual({ leading: null, pulse: false });
            expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference, visible: false })).toEqual({ leading: null, pulse: false });
        }
    });

    it('falls back to Accent under reduced motion', () => {
        for (const preference of ['glint', 'shimmer', 'pulse'] as const) {
            expect(resolveHappierCollectionRowNeedsYouHighlight({ ...live, preference, reducedMotion: true })).toEqual({ leading: 'accent', pulse: false });
        }
    });
});
