/**
 * Pure window <-> content <-> viewport-overlay coordinate conversions for the
 * generic tree drag/drop geometry model.
 *
 * Phase 1 of `.project/plans/session-list-drag-geometry-performance-unification.md`
 * (section 3.1). These functions replace the old absolute-window-bounds caching
 * plus scroll rebasing with a single deterministic conversion layer.
 *
 * Coordinate spaces (section 3.1):
 * - window:  actual screen/window coordinates (what `measureInWindow` /
 *   `getBoundingClientRect` report).
 * - content: offset inside the scroll content. Stable for the duration of a
 *   frozen drag; never rebased on scroll.
 * - viewport-overlay: origin at the top-left of the scroll viewport. The
 *   list-level drop overlay renders here.
 *
 * Conversion (section 3.1):
 *   contentY = windowY - viewportWindowY + scrollOffsetY
 *   windowY  = viewportWindowY + contentY - scrollOffsetY
 *   overlayTop = contentY - scrollOffsetY
 *
 * No React, no platform imports: only numeric math.
 */

import type {
    TreeContentBounds,
    TreeContentPointer,
    TreeDropOverlayGeometry,
    TreeViewportMetrics,
} from './treeContentGeometryTypes';
import type { WindowBounds, WindowPointer } from '../treeDragDropTypes';

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * True when every field of `rect` is finite and neither dimension is negative.
 * A zero-size rectangle is accepted: that is a valid (if not yet laid-out)
 * measurement, distinct from a corrupt one.
 */
export function isFiniteRect(rect: Rect): boolean {
    return Number.isFinite(rect.x)
        && Number.isFinite(rect.y)
        && Number.isFinite(rect.width)
        && Number.isFinite(rect.height)
        && rect.width >= 0
        && rect.height >= 0;
}

/**
 * True when `bounds` is a finite rectangle with a strictly positive width and
 * height. The registry only stores content bounds that pass this check: a
 * zero-size row cannot be hit-tested meaningfully.
 */
export function isUsableTreeContentBounds(bounds: TreeContentBounds): boolean {
    return isFiniteRect(bounds) && bounds.width > 0 && bounds.height > 0;
}

function areFiniteViewportMetrics(viewport: TreeViewportMetrics): boolean {
    return Number.isFinite(viewport.viewportWindowY)
        && Number.isFinite(viewport.viewportWindowX)
        && Number.isFinite(viewport.scrollOffsetY)
        && Number.isFinite(viewport.viewportHeight);
}

/**
 * Convert a window-space pointer into scroll-content coordinates using the live
 * viewport top/left and scroll offset. Returns `null` if any input is
 * non-finite so callers never hit-test against corrupt coordinates.
 */
export function windowPointerToContentPointer(
    pointer: WindowPointer,
    viewport: TreeViewportMetrics,
): TreeContentPointer | null {
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;
    if (!areFiniteViewportMetrics(viewport)) return null;
    return {
        x: pointer.x - viewport.viewportWindowX,
        y: pointer.y - viewport.viewportWindowY + viewport.scrollOffsetY,
    };
}

/**
 * Inverse of {@link windowPointerToContentPointer}: convert a content-space
 * pointer back into window coordinates. Returns `null` for non-finite input.
 */
export function contentPointerToWindowPointer(
    pointer: TreeContentPointer,
    viewport: TreeViewportMetrics,
): WindowPointer | null {
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;
    if (!areFiniteViewportMetrics(viewport)) return null;
    return {
        x: pointer.x + viewport.viewportWindowX,
        y: pointer.y + viewport.viewportWindowY - viewport.scrollOffsetY,
    };
}

/**
 * Convert a measured window-space rectangle into stable content-coordinate
 * bounds. Returns `null` when the measurement or the viewport metrics are
 * non-finite or degenerate, so the registry never stores unusable bounds.
 */
export function windowBoundsToContentBounds(
    bounds: WindowBounds,
    viewport: TreeViewportMetrics,
): TreeContentBounds | null {
    if (!isFiniteRect(bounds) || bounds.width <= 0 || bounds.height <= 0) return null;
    if (!areFiniteViewportMetrics(viewport)) return null;
    return {
        x: bounds.x - viewport.viewportWindowX,
        y: bounds.y - viewport.viewportWindowY + viewport.scrollOffsetY,
        width: bounds.width,
        height: bounds.height,
    };
}

/**
 * Convert content-coordinate bounds into viewport-overlay coordinates by
 * subtracting the live scroll offset. The list-level drop overlay is an
 * absolutely-positioned sibling of the scroll viewport, so this is the geometry
 * it renders. A row scrolled above the viewport top yields a negative `top`.
 */
export function contentBoundsToOverlayGeometry(
    bounds: TreeContentBounds,
    viewport: TreeViewportMetrics,
): TreeDropOverlayGeometry {
    return {
        top: bounds.y - viewport.scrollOffsetY,
        left: bounds.x,
        width: bounds.width,
        height: bounds.height,
    };
}
