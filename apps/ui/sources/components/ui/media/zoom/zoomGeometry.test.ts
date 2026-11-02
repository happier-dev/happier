import { describe, expect, it } from 'vitest';

import {
    clampPan, dismissPresentation, focalZoom, galleryDirection, panBounds,
    projectRelease, resizeZoom, resolveZoomBounds, rubberBandPan, rubberBandScale,
    shouldDismiss, wheelZoomFactor,
} from './zoomGeometry';

describe('media zoom geometry', () => {
    it('derives fit, natural size and zoom targets from image pixels and DPR', () => {
        expect(resolveZoomBounds({ width: 2000, height: 1000 }, { width: 500, height: 500 }, 2))
            .toEqual({ min: 0.25, max: 1, natural: 0.5, doubleTap: 0.5 });
        expect(resolveZoomBounds({ width: 20, height: 20 }, { width: 500, height: 500 }, 1))
            .toEqual({ min: 1, max: 4, natural: 1, doubleTap: 2 });
    });

    it('clamps only the overflowing image axes', () => {
        const bounds = panBounds({ width: 1000, height: 500 }, { width: 500, height: 500 }, 1);
        expect(bounds).toEqual({ x: 250, y: 0 });
        expect(clampPan({ x: -300, y: 20 }, bounds)).toEqual({ x: -250, y: 0 });
        expect(clampPan({ x: 120, y: 0 }, bounds)).toEqual({ x: 120, y: 0 });
    });

    it('keeps small-image double-tap zoom above fit and below the four-fit maximum at either DPR', () => {
        for (const dpr of [1, 2]) {
            const bounds = resolveZoomBounds({ width: 100, height: 100 }, { width: 1024, height: 768 }, dpr);
            expect(bounds).toMatchObject({ min: 1, max: 4, doubleTap: 2 });
            expect(bounds.doubleTap).toBeGreaterThan(bounds.min);
            expect(bounds.doubleTap).toBeLessThanOrEqual(bounds.max);
        }
        // A large picture still stops a double-tap at three-fit, not at the maximum.
        expect(resolveZoomBounds({ width: 4000, height: 2000 }, { width: 500, height: 500 }, 1))
            .toMatchObject({ min: 0.125, natural: 1, doubleTap: 0.375 });
    });

    it('keeps the content under a moving pinch focal point attached to the fingers', () => {
        expect(focalZoom({ scale: 1, x: 20, y: -10 }, 2, { x: 100, y: 50 }, { x: 120, y: 60 }))
            .toEqual({ scale: 2, x: -40, y: -60 });
    });

    it('applies asymmetric elastic scale and monotonic progressive pan resistance', () => {
        expect(rubberBandScale(0, { min: 1, max: 4 })).toBeCloseTo(0.85);
        expect(rubberBandScale(6, { min: 1, max: 4 })).toBeCloseTo(4.1);
        expect(rubberBandScale(2, { min: 1, max: 4 })).toBe(2);
        const values = [0, 10, 100, 1000].map((x) => rubberBandPan(x, 0, 500));
        expect(values).toEqual([...values].sort((a, b) => a - b));
        expect(values[3]).toBeLessThan(1000);
        expect(rubberBandPan(-100, 0, 500)).toBe(-values[2]);
    });

    it('uses projected release position for dismiss and gallery decisions', () => {
        expect(projectRelease(10, 1000)).toBeCloseTo(509);
        expect(shouldDismiss({ x: 0, y: 299 }, { x: 0, y: 0 }, 1000)).toBe(false);
        expect(shouldDismiss({ x: 0, y: 300 }, { x: 0, y: 1 }, 1000)).toBe(true);
        expect(shouldDismiss({ x: 0, y: 350 }, { x: 0, y: 0 }, 1000)).toBe(true);
        expect(galleryDirection(-200, -200, 500)).toBe(1);
        expect(galleryDirection(200, 200, 500)).toBe(-1);
        expect(galleryDirection(100, 0, 500)).toBe(0);
        expect(galleryDirection(-300, 500, 500)).toBe(1);
    });

    it('tracks dismiss directly and saturates scale/backdrop at the declared endpoints', () => {
        expect(dismissPresentation(0, 1000)).toEqual({ progress: 0, scale: 1, backdrop: 1 });
        expect(dismissPresentation(-330, 1000)).toEqual({ progress: 1, scale: 0.82, backdrop: 0 });
        expect(dismissPresentation(660, 1000)).toEqual({ progress: 1, scale: 0.82, backdrop: 0 });
    });

    it('keeps a fitted picture fitted when shrinking, rotating and expanding the viewport', () => {
        const image = { width: 2000, height: 1000 };
        const desktop = { width: 1376, height: 756 };
        const portrait = { width: 358, height: 844 };
        const landscape = { width: 812, height: 390 };
        let viewport = desktop;
        let state = { scale: resolveZoomBounds(image, viewport, 1).min, x: 0, y: 0 };
        for (const next of [portrait, landscape, desktop]) {
            state = resizeZoom(state, image, viewport, next, 1, false);
            expect(state).toEqual({ scale: resolveZoomBounds(image, next, 1).min, x: 0, y: 0 });
            viewport = next;
        }
    });

    it('preserves the centre content point on resize and ignores toolbar-only changes mid-gesture', () => {
        const state = { scale: 1, x: 100, y: 50 };
        expect(resizeZoom(state, { width: 1000, height: 1000 }, { width: 500, height: 500 }, { width: 600, height: 600 }, 1, false))
            .toEqual(state);
        expect(resizeZoom(state, { width: 1000, height: 1000 }, { width: 500, height: 500 }, { width: 500, height: 900 }, 1, true))
            .toBe(state);
        expect(resizeZoom(state, { width: 1000, height: 1000 }, { width: 500, height: 500 }, { width: 1000, height: 1000 }, 1, false))
            .toEqual({ scale: 1, x: 0, y: 0 });
        expect(resizeZoom({ scale: 0, x: 0, y: 0 }, { width: 1000, height: 1000 }, { width: 0, height: 0 }, { width: 500, height: 500 }, 1, false))
            .toEqual({ scale: 0.5, x: 0, y: 0 });
    });

    it('uses the bounded exponential wheel factor for wheel and keyboard steps', () => {
        expect(wheelZoomFactor(0)).toBe(1);
        expect(wheelZoomFactor(-1000)).toBeCloseTo(Math.exp(100 / 150));
        expect(wheelZoomFactor(1000)).toBeCloseTo(Math.exp(-100 / 150));
    });
});
