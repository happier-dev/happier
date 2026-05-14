import { describe, expect, it } from 'vitest';
import {
    DESKTOP_REVEAL_INTERSECTION_OPTIONS,
    MOBILE_REVEAL_INTERSECTION_OPTIONS,
    resolveRevealIntersectionOptions,
} from './RevealText';

describe('resolveRevealIntersectionOptions', () => {
    it('keeps the original desktop reveal timing', () => {
        expect(resolveRevealIntersectionOptions(false)).toEqual(DESKTOP_REVEAL_INTERSECTION_OPTIONS);
        expect(DESKTOP_REVEAL_INTERSECTION_OPTIONS).toMatchObject({
            threshold: 0.22,
            rootMargin: '0px 0px -18% 0px',
        });
    });

    it('arms reveal text before mobile headings are centered in the viewport', () => {
        expect(resolveRevealIntersectionOptions(true)).toEqual(MOBILE_REVEAL_INTERSECTION_OPTIONS);
        expect(MOBILE_REVEAL_INTERSECTION_OPTIONS).toMatchObject({
            threshold: 0.01,
            rootMargin: '0px 0px 20% 0px',
        });
    });
});
