import { describe, expect, it } from 'vitest';

import {
    DESKTOP_REVEAL_INTERSECTION_OPTIONS as ISLAND_DESKTOP,
    MOBILE_REVEAL_INTERSECTION_OPTIONS as ISLAND_MOBILE,
    REVEAL_DEFAULT_STAGGER_MS,
    resolveRevealIntersectionOptions as islandResolve,
} from './revealOptions';
import {
    DESKTOP_REVEAL_INTERSECTION_OPTIONS as COMPONENT_DESKTOP,
    MOBILE_REVEAL_INTERSECTION_OPTIONS as COMPONENT_MOBILE,
    resolveRevealIntersectionOptions as componentResolve,
} from '../components/RevealText';

/**
 * While these constants exist in two files they must hold the same values, or a
 * heading inside an island and a heading in prose start animating at different
 * scroll positions on the same page — a difference nobody would attribute to a
 * duplicated constant.
 *
 * DELETE THIS FILE when src/components/RevealText.tsx re-exports from
 * ./islands/revealOptions instead of declaring its own copies (step 1 of the
 * islands plan). At that point the two cannot differ and a test that they do not
 * is just noise. Until then this is the thing keeping them honest.
 */
describe('reveal options are defined once in effect, if not yet in source', () => {
    it('agrees with src/components/RevealText.tsx on desktop timing', () => {
        expect(ISLAND_DESKTOP).toEqual(COMPONENT_DESKTOP);
    });

    it('agrees with src/components/RevealText.tsx on mobile timing', () => {
        expect(ISLAND_MOBILE).toEqual(COMPONENT_MOBILE);
    });

    it('resolves the same options for the same pointer type', () => {
        expect(islandResolve(true)).toEqual(componentResolve(true));
        expect(islandResolve(false)).toEqual(componentResolve(false));
    });

    /**
     * The default `stagger` prop in RevealText. The armer has to reproduce it
     * for any group that ships without an explicit `data-reveal-stagger`, so a
     * change to one is a change to both.
     */
    it('matches the RevealText default stagger', () => {
        expect(REVEAL_DEFAULT_STAGGER_MS).toBe(70);
    });
});
