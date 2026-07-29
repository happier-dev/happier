import { describe, expect, it } from 'vitest';

import {
    resolveAnnotationCropClip,
    strokeViewportBounds,
    unionViewportRects,
    type AnnotationViewportRect,
} from './annotationCropGeometry';

const rect = (x: number, y: number, width: number, height: number): AnnotationViewportRect => ({
    x,
    y,
    width,
    height,
});

describe('annotationCropGeometry', () => {
    describe('unionViewportRects', () => {
        it('returns null for no rects', () => {
            expect(unionViewportRects([])).toBeNull();
        });

        it('unions two disjoint rects into their bounding box', () => {
            const union = unionViewportRects([rect(10, 20, 30, 40), rect(100, 50, 20, 10)]);
            // x: 10..120, y: 20..60 → {10,20,110,40}
            expect(union).toEqual(rect(10, 20, 110, 40));
        });

        it('ignores zero-area rects but keeps the marked targets', () => {
            const union = unionViewportRects([rect(5, 5, 0, 0), rect(10, 10, 4, 4)]);
            expect(union).toEqual(rect(10, 10, 4, 4));
        });
    });

    describe('strokeViewportBounds', () => {
        it('returns the bounding box of stroke points', () => {
            const bounds = strokeViewportBounds([
                { x: 12, y: 8 },
                { x: 40, y: 60 },
                { x: 20, y: 30 },
            ]);
            expect(bounds).toEqual(rect(12, 8, 28, 52));
        });
    });

    describe('resolveAnnotationCropClip', () => {
        const surface = { width: 1280, height: 2000 };

        it('crops to the union of element + region + stroke bounds, not the full page (DPR 1, no scroll)', () => {
            const result = resolveAnnotationCropClip({
                targets: [rect(100, 100, 50, 50), rect(300, 100, 40, 40)],
                strokes: [[{ x: 120, y: 90 }, { x: 360, y: 200 }]],
                viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1, surface },
            });
            expect(result.status).toBe('clip');
            if (result.status !== 'clip') return;
            // union of targets {100,100..340} {100..140} ∪ stroke {120,90..360,200}
            // x: 100..360 → 260 wide; y: 90..200 → 110 tall
            expect(result.cssPageRect).toEqual(rect(100, 90, 260, 110));
            // DPR 1 → device rect equals css rect
            expect(result.devicePageRect).toEqual(rect(100, 90, 260, 110));
            expect(result.scale).toBe(1);
        });

        it('adds scrollX/scrollY to convert viewport coords to page coords (scrolled page)', () => {
            const result = resolveAnnotationCropClip({
                targets: [rect(40, 60, 100, 80)],
                viewport: { scrollX: 25, scrollY: 500, devicePixelRatio: 1, surface },
            });
            if (result.status !== 'clip') throw new Error('expected clip');
            // page coords: x = 40+25 = 65, y = 60+500 = 560
            expect(result.cssPageRect).toEqual(rect(65, 560, 100, 80));
            expect((result as { cssViewportRect?: AnnotationViewportRect }).cssViewportRect).toEqual(rect(40, 60, 100, 80));
        });

        it('applies devicePixelRatio when converting CSS px to device px (DPR 2 / Retina)', () => {
            const result = resolveAnnotationCropClip({
                targets: [rect(40, 60, 100, 80)],
                viewport: { scrollX: 0, scrollY: 100, devicePixelRatio: 2, surface },
            });
            if (result.status !== 'clip') throw new Error('expected clip');
            // css page rect: {40,160,100,80}; device rect = ×2 → {80,320,200,160}
            expect(result.cssPageRect).toEqual(rect(40, 160, 100, 80));
            expect(result.devicePageRect).toEqual(rect(80, 320, 200, 160));
            expect(result.scale).toBe(2);
        });

        it('clamps the device clip to the captured surface bounds', () => {
            const result = resolveAnnotationCropClip({
                targets: [rect(1200, 1950, 400, 400)],
                viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1, surface },
            });
            if (result.status !== 'clip') throw new Error('expected clip');
            // surface 1280x2000 → clamp width to 80, height to 50
            expect(result.devicePageRect).toEqual(rect(1200, 1950, 80, 50));
        });

        it('intersects partially negative clips with the captured surface bounds', () => {
            const result = resolveAnnotationCropClip({
                targets: [rect(-20, -10, 50, 40)],
                viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1, surface },
            });
            if (result.status !== 'clip') throw new Error('expected clip');
            expect(result.devicePageRect).toEqual(rect(0, 0, 30, 30));
        });

        it('returns empty when there are no targets, regions, or strokes', () => {
            const result = resolveAnnotationCropClip({
                targets: [],
                viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1, surface },
            });
            expect(result.status).toBe('empty');
        });
    });
});
