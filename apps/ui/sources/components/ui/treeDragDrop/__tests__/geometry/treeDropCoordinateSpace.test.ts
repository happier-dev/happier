import { describe, expect, it } from 'vitest';

import {
    contentBoundsToOverlayGeometry,
    contentPointerToWindowPointer,
    isFiniteRect,
    isUsableTreeContentBounds,
    windowBoundsToContentBounds,
    windowPointerToContentPointer,
} from '../../geometry/treeDropCoordinateSpace';
import type { TreeViewportMetrics } from '../../geometry/treeContentGeometryTypes';

const viewport: TreeViewportMetrics = {
    viewportWindowY: 120,
    viewportWindowX: 16,
    scrollOffsetY: 240,
    viewportHeight: 600,
};

describe('treeDropCoordinateSpace', () => {
    describe('isFiniteRect', () => {
        it('accepts a rectangle whose numeric fields are all finite and non-negative in size', () => {
            expect(isFiniteRect({ x: 10, y: 20, width: 300, height: 40 })).toBe(true);
            expect(isFiniteRect({ x: -5, y: -7, width: 0, height: 0 })).toBe(true);
        });

        it('rejects a rectangle with a non-finite field or a negative dimension', () => {
            expect(isFiniteRect({ x: Number.NaN, y: 20, width: 300, height: 40 })).toBe(false);
            expect(isFiniteRect({ x: 10, y: Number.POSITIVE_INFINITY, width: 300, height: 40 })).toBe(false);
            expect(isFiniteRect({ x: 10, y: 20, width: -1, height: 40 })).toBe(false);
            expect(isFiniteRect({ x: 10, y: 20, width: 300, height: -1 })).toBe(false);
        });
    });

    describe('isUsableTreeContentBounds', () => {
        it('accepts content bounds with a positive width and height', () => {
            expect(isUsableTreeContentBounds({ x: 0, y: 480, width: 320, height: 56 })).toBe(true);
        });

        it('rejects content bounds that are degenerate or non-finite', () => {
            expect(isUsableTreeContentBounds({ x: 0, y: 480, width: 0, height: 56 })).toBe(false);
            expect(isUsableTreeContentBounds({ x: 0, y: 480, width: 320, height: 0 })).toBe(false);
            expect(isUsableTreeContentBounds({ x: 0, y: Number.NaN, width: 320, height: 56 })).toBe(false);
        });
    });

    describe('windowPointerToContentPointer', () => {
        it('converts a window pointer into content coordinates using viewport top and live scroll offset', () => {
            // contentY = windowY - viewportWindowY + scrollOffsetY = 300 - 120 + 240 = 420
            // contentX = windowX - viewportWindowX = 64 - 16 = 48
            expect(windowPointerToContentPointer({ x: 64, y: 300 }, viewport)).toEqual({ x: 48, y: 420 });
        });

        it('returns null when the window pointer is not finite', () => {
            expect(windowPointerToContentPointer({ x: 64, y: Number.NaN }, viewport)).toBeNull();
        });
    });

    describe('contentPointerToWindowPointer', () => {
        it('is the exact inverse of windowPointerToContentPointer', () => {
            const windowPointer = { x: 64, y: 300 };
            const content = windowPointerToContentPointer(windowPointer, viewport);
            expect(content).not.toBeNull();
            expect(contentPointerToWindowPointer(content!, viewport)).toEqual(windowPointer);
        });
    });

    describe('windowBoundsToContentBounds', () => {
        it('converts measured window bounds to content bounds using viewport top and scroll offset', () => {
            // content y = 200 - 120 + 240 = 320; content x = 32 - 16 = 16
            expect(windowBoundsToContentBounds({ x: 32, y: 200, width: 320, height: 56 }, viewport)).toEqual({
                x: 16,
                y: 320,
                width: 320,
                height: 56,
            });
        });

        it('returns null for non-finite or degenerate window bounds', () => {
            expect(windowBoundsToContentBounds({ x: 32, y: Number.NaN, width: 320, height: 56 }, viewport)).toBeNull();
            expect(windowBoundsToContentBounds({ x: 32, y: 200, width: 0, height: 56 }, viewport)).toBeNull();
        });
    });

    describe('contentBoundsToOverlayGeometry', () => {
        it('converts content bounds to viewport-overlay coordinates by subtracting the scroll offset', () => {
            // overlayTop = contentBounds.y - scrollOffsetY = 320 - 240 = 80
            expect(contentBoundsToOverlayGeometry({ x: 16, y: 320, width: 320, height: 56 }, viewport)).toEqual({
                top: 80,
                left: 16,
                width: 320,
                height: 56,
            });
        });

        it('keeps overlay geometry consistent for a row above the current scroll position', () => {
            // A content row at y=100 with scrollOffsetY=240 sits 140px above the viewport top.
            expect(contentBoundsToOverlayGeometry({ x: 0, y: 100, width: 320, height: 56 }, viewport)).toEqual({
                top: -140,
                left: 0,
                width: 320,
                height: 56,
            });
        });
    });
});
