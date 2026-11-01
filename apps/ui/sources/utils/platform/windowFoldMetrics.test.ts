import { describe, expect, it } from 'vitest';

import { normalizeWindowFoldMetrics } from './windowFoldMetrics';

describe('normalizeWindowFoldMetrics', () => {
    const folded = { width: 466, height: 678, divisions: [], verticalBarEdge: null };
    const unfolded = {
        width: 951,
        height: 669,
        divisions: [{ x: 475, y: 0, width: 1, height: 669 }],
        verticalBarEdge: null,
    };

    it('normalizes the directional rail edge and invalidates identity when only that trait changes', () => {
        const trailing = normalizeWindowFoldMetrics({ ...folded, verticalBarEdge: 'trailing' });
        expect(trailing).toMatchObject({ verticalBarEdge: 'trailing', hasFoldDivision: false });
        expect(normalizeWindowFoldMetrics({ ...folded, verticalBarEdge: 'trailing' }, trailing)).toBe(trailing);
        const leading = normalizeWindowFoldMetrics({ ...folded, verticalBarEdge: 'leading' }, trailing);
        expect(leading).toMatchObject({ verticalBarEdge: 'leading' });
        expect(leading).not.toBe(trailing);
        for (const verticalBarEdge of [undefined, null, 'left', 'right', 2, {}, true]) {
            expect(normalizeWindowFoldMetrics({ ...folded, verticalBarEdge }, leading)).toMatchObject({
                verticalBarEdge: null,
                width: folded.width,
            });
        }
    });

    it('reports window-point division geometry and distinguishes a window without a division', () => {
        expect(normalizeWindowFoldMetrics(unfolded)).toEqual({ ...unfolded, hasFoldDivision: true });
        expect(normalizeWindowFoldMetrics(folded)).toEqual({ ...folded, hasFoldDivision: false });
    });

    it('retains the previous reference until geometry changes, including fold removal and window resize', () => {
        const previous = normalizeWindowFoldMetrics(unfolded);
        expect(previous).not.toBeNull();
        expect(normalizeWindowFoldMetrics(structuredClone(unfolded), previous)).toBe(previous);
        const moved = normalizeWindowFoldMetrics({ ...unfolded, divisions: [{ ...unfolded.divisions[0], x: 460 }] }, previous);
        expect(moved).not.toBe(previous);
        expect(moved?.divisions[0].x).toBe(460);
        expect(normalizeWindowFoldMetrics(folded, moved)).toEqual({ ...folded, hasFoldDivision: false });
        const phone = normalizeWindowFoldMetrics(folded);
        expect(normalizeWindowFoldMetrics({ ...folded, height: 700 }, phone)?.height).toBe(700);
    });

    it('accepts a zero-width or zero-height division line, including the window boundary', () => {
        const divisions = [
            { x: 0, y: 0, width: 0, height: 669 },
            { x: 0, y: 334, width: 951, height: 0 },
        ];
        expect(normalizeWindowFoldMetrics({ ...unfolded, divisions })?.divisions).toEqual(divisions);
    });

    it.each([
        null, undefined, {}, { ...folded, width: 0 }, { ...folded, height: Infinity },
        { ...folded, width: '466' }, { ...folded, divisions: null },
        ...[
            { x: -1, y: 0, width: 1, height: 669 },
            { x: 950, y: 0, width: 2, height: 669 },
            { x: 475, y: 0, width: 1, height: 670 },
            { x: NaN, y: 0, width: 1, height: 669 },
            { x: 475, y: 0, width: -1, height: 669 },
            { x: 475, y: 0, width: 0, height: 0 },
            null,
        ].map((division) => ({ ...unfolded, divisions: [division] })),
    ])('rejects unavailable or malformed native geometry: %j', (payload) => {
        expect(normalizeWindowFoldMetrics(payload)).toBeNull();
    });
});
