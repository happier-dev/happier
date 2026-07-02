import { describe, expect, it } from 'vitest';

import { classifyVerticalThird } from '../../geometry/classifyVerticalThird';

describe('classifyVerticalThird', () => {
    it('classifies exact one-third boundaries deterministically', async () => {
        expect(classifyVerticalThird).toEqual(expect.any(Function));

        const bounds = { x: 0, y: 90, width: 100, height: 30 };

        expect(classifyVerticalThird(bounds, { x: 10, y: 99.99 })).toBe('top');
        expect(classifyVerticalThird(bounds, { x: 10, y: 100 })).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 109.99 })).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 110 })).toBe('bottom');
    });

    it('widens the centered middle band when a larger nest ratio is supplied', () => {
        const bounds = { x: 0, y: 0, width: 100, height: 100 };

        // nestRatio 0.5 -> middle band spans the centered half: [25, 75).
        expect(classifyVerticalThird(bounds, { x: 10, y: 24.99 }, 0.5)).toBe('top');
        expect(classifyVerticalThird(bounds, { x: 10, y: 25 }, 0.5)).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 74.99 }, 0.5)).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 75 }, 0.5)).toBe('bottom');
    });

    it('clamps the nest ratio into [0, 1] so out-of-range inputs stay deterministic', () => {
        const bounds = { x: 0, y: 0, width: 100, height: 100 };

        // ratio >= 1 -> the whole row is the middle band.
        expect(classifyVerticalThird(bounds, { x: 10, y: 0 }, 2)).toBe('middle');
        expect(classifyVerticalThird(bounds, { x: 10, y: 99.99 }, 2)).toBe('middle');
        // ratio <= 0 -> no middle band; the midpoint flips straight to bottom.
        expect(classifyVerticalThird(bounds, { x: 10, y: 49.99 }, -1)).toBe('top');
        expect(classifyVerticalThird(bounds, { x: 10, y: 50 }, -1)).toBe('bottom');
    });
});
