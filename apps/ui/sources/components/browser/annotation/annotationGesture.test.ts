import { describe, expect, it } from 'vitest';

import {
    ANNOTATION_MIN_REGION_EXTENT_PX,
    rectFromGesture,
    sanitizeStrokePath,
} from './annotationGesture';

describe('annotationGesture', () => {
    it('builds a normalized rect from two drag endpoints regardless of direction', () => {
        const forward = rectFromGesture({ x: 10, y: 20 }, { x: 110, y: 80 });
        expect(forward).toEqual({ x: 10, y: 20, width: 100, height: 60 });
        // Dragging up-left yields the same rect (origin is the min corner).
        const reverse = rectFromGesture({ x: 110, y: 80 }, { x: 10, y: 20 });
        expect(reverse).toEqual({ x: 10, y: 20, width: 100, height: 60 });
    });

    it('treats a sub-threshold drag as a tap (null) so no degenerate region is committed', () => {
        const tiny = ANNOTATION_MIN_REGION_EXTENT_PX - 1;
        expect(rectFromGesture({ x: 5, y: 5 }, { x: 5 + tiny, y: 5 + tiny })).toBeNull();
        // A drag that clears the threshold on one axis is a real region.
        expect(rectFromGesture({ x: 5, y: 5 }, { x: 5 + tiny, y: 50 })).not.toBeNull();
    });

    it('sanitizes a stroke path: drops dup points, requires >=2 distinct, caps length', () => {
        expect(
            sanitizeStrokePath([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }]),
        ).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
        // Single distinct point is not a stroke.
        expect(sanitizeStrokePath([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toEqual([]);
        // Length cap.
        const long = Array.from({ length: 1000 }, (_unused, index) => ({ x: index, y: index }));
        expect(sanitizeStrokePath(long, 10)).toHaveLength(10);
    });
});
