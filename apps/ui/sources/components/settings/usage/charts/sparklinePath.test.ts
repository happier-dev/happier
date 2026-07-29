import { describe, expect, it } from 'vitest';
import { buildSparklinePath } from './sparklinePath';

describe('buildSparklinePath', () => {
    it('returns an empty string for an empty series', () => {
        expect(buildSparklinePath([], { width: 40, height: 14 })).toBe('');
    });

    it('draws a centered horizontal line for a flat or single-point series', () => {
        expect(buildSparklinePath([5], { width: 40, height: 14, inset: 1 })).toBe('M0 7 L40 7');
        expect(buildSparklinePath([5, 5, 5], { width: 40, height: 14, inset: 1 })).toBe('M0 7 L40 7');
    });

    it('maps higher values to smaller y (top of the box) across evenly spaced x', () => {
        const path = buildSparklinePath([0, 10], { width: 40, height: 14, inset: 2 });
        // two points: x at 0 and 40; low value at bottom (y=12), high value at top (y=2)
        expect(path).toBe('M0 12 L40 2');
    });

    it('spaces intermediate points evenly along the width', () => {
        const path = buildSparklinePath([0, 5, 10], { width: 40, height: 10, inset: 0 });
        expect(path).toBe('M0 10 L20 5 L40 0');
    });
});
