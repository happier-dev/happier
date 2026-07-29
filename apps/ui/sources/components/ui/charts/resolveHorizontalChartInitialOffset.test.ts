import { describe, expect, it } from 'vitest';

import {
    resolveHorizontalChartInitialOffset,
    resolveHorizontalChartTrailingPad,
    resolveHorizontalChartViewportWidth,
} from './resolveHorizontalChartInitialOffset';

describe('resolveHorizontalChartInitialOffset', () => {
    it('returns the trailing overflow amount when content exceeds the viewport', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 920,
            viewportWidth: 640,
        })).toBe(280);
    });

    it('returns zero when the content fits within the viewport', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 520,
            viewportWidth: 640,
        })).toBe(0);
    });

    it('snaps the end-anchor up to a column boundary when a stride is given, so the leftmost label is never left-clipped (C-3)', () => {
        // 53 heatmap week-columns × 14px = 742 content; a ~706px modal viewport
        // overflows by 36px — which lands the left edge 8px into column 2 and
        // clips its month label. Snapping to the next 14px boundary (→ 42)
        // starts the leftmost visible column whole.
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 742,
            viewportWidth: 706,
            columnStride: 14,
        })).toBe(42);
        // The extra 6px past the 36px raw overflow is the trailing pad.
        expect(resolveHorizontalChartTrailingPad({
            contentWidth: 742,
            viewportWidth: 706,
            columnStride: 14,
        })).toBe(6);
    });

    it('leaves an exact-boundary overflow untouched (no needless pad)', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 742,
            viewportWidth: 700,
            columnStride: 14,
        })).toBe(42);
        expect(resolveHorizontalChartTrailingPad({
            contentWidth: 742,
            viewportWidth: 700,
            columnStride: 14,
        })).toBe(0);
    });

    it('behaves exactly as before when no stride is supplied (flow chart)', () => {
        expect(resolveHorizontalChartInitialOffset({
            contentWidth: 920,
            viewportWidth: 640,
        })).toBe(280);
        expect(resolveHorizontalChartTrailingPad({
            contentWidth: 920,
            viewportWidth: 640,
        })).toBe(0);
    });
});

describe('resolveHorizontalChartViewportWidth', () => {
    it('prefers the measured viewport over the window estimate (D-R3-1: modal panels are far narrower than the window)', () => {
        expect(resolveHorizontalChartViewportWidth({
            windowWidth: 1280,
            viewportInset: 104,
            measuredWidth: 625,
        })).toBe(625);
    });

    it('falls back to the window estimate before the first layout pass', () => {
        expect(resolveHorizontalChartViewportWidth({
            windowWidth: 1280,
            viewportInset: 104,
            measuredWidth: null,
        })).toBe(1176);
        expect(resolveHorizontalChartViewportWidth({
            windowWidth: 1280,
            viewportInset: 104,
            measuredWidth: 0,
        })).toBe(1176);
    });
});
