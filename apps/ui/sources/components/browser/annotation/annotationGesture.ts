import type { BrowserAnnotationViewportRect } from '@/sync/domains/browser/context';

/** A point in the overlay's local (CSS viewport) coordinate space. */
export type AnnotationGesturePoint = Readonly<{ x: number; y: number }>;

/**
 * Minimum marquee extent (CSS px) below which a region drag is treated as a tap, not a rect. Keeps a
 * stray click from producing a zero-area region the union crop would degenerate on.
 */
export const ANNOTATION_MIN_REGION_EXTENT_PX = 4;

/**
 * Build a normalized (positive width/height) rect from two drag endpoints. Returns `null` when the
 * drag is below the minimum extent in BOTH axes (a tap, not a marquee) so the caller can fall back to
 * a point interaction instead of committing a degenerate region.
 */
export function rectFromGesture(
    start: AnnotationGesturePoint,
    end: AnnotationGesturePoint,
): BrowserAnnotationViewportRect | null {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < ANNOTATION_MIN_REGION_EXTENT_PX && height < ANNOTATION_MIN_REGION_EXTENT_PX) {
        return null;
    }
    return { x, y, width, height };
}

/**
 * Drop consecutive duplicate points and clamp the path length so a freehand stroke stays bounded
 * before it is normalized to the crop at commit time (`annotationDraft.normalizeStrokeToCrop` further
 * caps to 512). A stroke with fewer than two distinct points is rejected (returns an empty array).
 */
export function sanitizeStrokePath(
    points: readonly AnnotationGesturePoint[],
    maxPoints = 512,
): readonly AnnotationGesturePoint[] {
    const out: AnnotationGesturePoint[] = [];
    for (const point of points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const last = out[out.length - 1];
        if (last && last.x === point.x && last.y === point.y) continue;
        out.push({ x: point.x, y: point.y });
        if (out.length >= maxPoints) break;
    }
    return out.length >= 2 ? out : [];
}
