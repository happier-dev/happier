import { describe, expect, it } from 'vitest';

import { resolveTreeDropAutoscrollTarget } from '../../autoscroll/useTreeDropAutoscroll';

describe('useTreeDropAutoscroll', () => {
    it('computes bounded upward and downward scroll targets from edge bands', async () => {
        expect(resolveTreeDropAutoscrollTarget).toEqual(expect.any(Function));

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 105,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBeLessThan(100);

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 495,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBeGreaterThan(100);

        expect(resolveTreeDropAutoscrollTarget({
            pointerY: 300,
            viewportTopY: 100,
            viewportHeight: 400,
            scrollOffsetY: 100,
            contentHeight: 1000,
            edgeBandPx: 60,
            maxScrollPerFrame: 14,
        })).toBe(100);
    });
});
