import { describe, expect, it } from 'vitest';

import {
    classifySelectionRelease,
    dragRectWithinDisplay,
    resolveSelectionHintEdge,
    resolveSelectionLabelPosition,
} from './captureSelectionGeometry';

const display = { width: 1440, height: 900 };

describe('capture selection geometry', () => {
    it('treats a release inside the gesture slop, or a sliver, as a click', () => {
        expect(classifySelectionRelease({ width: 4, height: 3 }, 12)).toBe('click');
        expect(classifySelectionRelease({ width: 400, height: 6 }, 12)).toBe('click');
        expect(classifySelectionRelease({ width: 40, height: 30 }, 12)).toBe('drag');
    });

    it('clamps a drag to its starting display in every direction', () => {
        expect(dragRectWithinDisplay({ x: 1400, y: 880 }, { x: 1900, y: 1200 }, display)).toEqual({ x: 1400, y: 880, width: 40, height: 20 });
        expect(dragRectWithinDisplay({ x: 40, y: 20 }, { x: -300, y: -300 }, display)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    });

    it('keeps the size label under the moving corner and flips it near an edge', () => {
        const size = { width: 120, height: 26 };
        const area = { x: 100, y: 100, width: 300, height: 200 };
        expect(resolveSelectionLabelPosition(area, { x: 400, y: 300 }, size, display, 8))
            .toEqual({ x: 280, y: 310 });
        const low = { x: 100, y: 600, width: 300, height: 295 };
        expect(resolveSelectionLabelPosition(low, { x: 400, y: 895 }, size, display, 8))
            .toEqual({ x: 280, y: 859 });
        const left = { x: 2, y: 100, width: 40, height: 200 };
        expect(resolveSelectionLabelPosition(left, { x: 2, y: 300 }, size, display, 8).x).toBe(8);
    });

    it('moves the hint to the bottom only when the area reaches under it', () => {
        const hint = { x: 500, y: 24, width: 440, height: 40 };
        expect(resolveSelectionHintEdge(null, hint)).toBe('top');
        expect(resolveSelectionHintEdge({ x: 0, y: 200, width: 900, height: 300 }, hint)).toBe('top');
        expect(resolveSelectionHintEdge({ x: 600, y: 40, width: 100, height: 100 }, hint)).toBe('bottom');
    });
});
