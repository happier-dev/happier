/**
 * Generic tree drag/drop content-coordinate geometry contracts.
 *
 * Phase 0.5 interface freeze for the session-list drag geometry unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.1, 3.4). These are pure type contracts: no behaviour lives here.
 *
 * Coordinate-space vocabulary (section 3.1):
 * - `contentY`        vertical offset inside the scroll content.
 * - `viewportWindowY` top of the scroll viewport in window coordinates.
 * - `scrollOffsetY`   live scroll position of the scroll container.
 * - `windowY`         actual screen/window coordinate.
 *
 * Conversion:
 *   contentY = windowY - viewportWindowY + scrollOffsetY
 *   windowY  = viewportWindowY + contentY - scrollOffsetY
 *
 * Naming rule (section 3.1): every new generic geometry type names its
 * coordinate space. `WindowBounds`/`WindowPointer` (window space) stay in
 * `treeDragDropTypes.ts` as the platform-measurement boundary type.
 */

/**
 * A row/header rectangle expressed in scroll-content coordinates.
 *
 * `y` is `contentY`: the distance from the top of the scroll content, NOT a
 * window coordinate. Content bounds are measured once when a row mounts and are
 * never rebased on scroll, because the drag surface is frozen (stable order)
 * for the duration of a drag.
 */
export type TreeContentBounds = Readonly<{
    x: number;
    /** contentY — offset from the top of the scroll content. */
    y: number;
    width: number;
    height: number;
}>;

/**
 * A pointer position expressed in scroll-content coordinates.
 *
 * Produced by converting a window pointer with the live `TreeViewportMetrics`
 * at resolve time. Hit-testing during a drag happens in this space.
 */
export type TreeContentPointer = Readonly<{
    x: number;
    /** contentY — offset from the top of the scroll content. */
    y: number;
}>;

/**
 * Live viewport + scroll state of the scroll container.
 *
 * Read once per drag-resolve frame from the same DOM/native clock. It is the
 * single source of truth for converting between window, content, and
 * viewport-overlay coordinate spaces. It is NEVER frozen into a drag snapshot.
 */
export type TreeViewportMetrics = Readonly<{
    /** Top of the scroll viewport in window coordinates. */
    viewportWindowY: number;
    /** Left of the scroll viewport in window coordinates. */
    viewportWindowX: number;
    /** Live vertical scroll position of the scroll container. */
    scrollOffsetY: number;
    /** Visible viewport height (used for autoscroll edge bands / clamping). */
    viewportHeight: number;
}>;

/**
 * A rectangle expressed in viewport-overlay coordinates.
 *
 * Viewport-overlay space has its origin at the top-left of the scroll viewport.
 * The list-level drop overlay (section 3.4) is an absolutely-positioned sibling
 * of the scroll container and renders in this space.
 *
 * Conversion from content space:
 *   overlayTop = contentBounds.y - scrollOffsetY
 */
export type TreeDropOverlayGeometry = Readonly<{
    /** Top edge in viewport-overlay coordinates. */
    top: number;
    /** Left edge in viewport-overlay coordinates. */
    left: number;
    width: number;
    height: number;
}>;

/**
 * Resolved numeric overlay geometry for the current drag visual, or hidden.
 *
 * This is the headless output of `resolveTreeDropVisualGeometry` (Lane A): it
 * maps a `TreeInstructionVisual` plus content-coordinate row geometry plus live
 * viewport metrics into pure numbers the overlay can render without any React
 * row reconciliation. Carries no React, no theme, no session-list imports.
 *
 * - `kind: 'none'`    nothing to draw.
 * - `kind: 'line'`    a reorder indicator line; `geometry` is a thin rectangle
 *                     at the target edge; `depth` drives the indent.
 * - `kind: 'outline'` a nest/container highlight; `geometry` frames the target.
 */
export type TreeDropVisualGeometry =
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'line';
        geometry: TreeDropOverlayGeometry;
        /** Tree depth of the resolved instruction; drives the visual indent. */
        depth: number;
        /** Resolved edge of the target row the line sits against. */
        edge: 'top' | 'bottom';
        /** Stable row id of the resolved target (diagnostics/accessibility). */
        targetId: string;
    }>
    | Readonly<{
        kind: 'outline';
        geometry: TreeDropOverlayGeometry;
        /** Stable row id of the resolved nest target (diagnostics/a11y). */
        targetId: string;
    }>;
