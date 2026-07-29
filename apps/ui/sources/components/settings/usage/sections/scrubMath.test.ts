import { describe, expect, it } from 'vitest';

import { clampLensLeft, resolveScrubIndex, scrubCellCenterX } from './scrubMath';

const layout = { leadingPx: 4, cellPx: 42, gapPx: 10, count: 5 } as const;

describe('scrubMath', () => {
    it('maps x offsets to the cell under them', () => {
        expect(resolveScrubIndex(4, layout)).toBe(0);
        expect(resolveScrubIndex(4 + 21, layout)).toBe(0);
        expect(resolveScrubIndex(4 + 42 + 10 + 1, layout)).toBe(1);
        expect(resolveScrubIndex(4 + 4 * 52 + 20, layout)).toBe(4);
    });

    it('resolves gap points to the nearest cell and clamps the edges', () => {
        // Point in the middle of the first gap → still the closer cell.
        expect(resolveScrubIndex(4 + 42 + 4, layout)).toBe(0);
        expect(resolveScrubIndex(4 + 42 + 9, layout)).toBe(1);
        // Before the row and past the end clamp.
        expect(resolveScrubIndex(-50, layout)).toBe(0);
        expect(resolveScrubIndex(10_000, layout)).toBe(4);
    });

    it('returns null for empty or degenerate rows', () => {
        expect(resolveScrubIndex(10, { ...layout, count: 0 })).toBeNull();
        expect(resolveScrubIndex(10, { ...layout, cellPx: 0 })).toBeNull();
    });

    it('computes cell centers consistent with index resolution', () => {
        for (let index = 0; index < layout.count; index += 1) {
            const center = scrubCellCenterX(index, layout);
            expect(resolveScrubIndex(center, layout)).toBe(index);
        }
    });

    it('clamps the lens inside the container while centering on the anchor', () => {
        expect(clampLensLeft(100, 80, 400)).toBe(60);
        expect(clampLensLeft(10, 80, 400)).toBe(0);
        expect(clampLensLeft(390, 80, 400)).toBe(320);
        // Lens wider than container pins to 0.
        expect(clampLensLeft(50, 500, 400)).toBe(0);
    });
});
