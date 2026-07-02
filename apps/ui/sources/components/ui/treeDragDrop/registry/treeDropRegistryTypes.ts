import type { TreeContainerDropZone, TreeRow, WindowBounds } from '../treeDragDropTypes';
import type { TreeContentBounds, TreeContentPointer } from '../geometry/treeContentGeometryTypes';

/**
 * Tree drag/drop geometry registry contracts.
 *
 * Phase 0.5 interface freeze (`session-list-drag-geometry-performance-unification.md`,
 * sections 3.1, 3.2). This file distinguishes window-coordinate types (the
 * platform-measurement boundary) from content-coordinate types (the live
 * geometry registry storage). New code MUST use the content-coordinate types;
 * the window types remain only for `measureWindowBounds` measurement results.
 *
 * Ownership decision (recorded for lanes A-D):
 * - `useTreeDropRegistry` is the canonical live content-coordinate geometry
 *   registry. There is no second registry, no absolute-window snapshot type,
 *   and no scroll-rebasing api.
 * - The registry is queried LIVE at resolve time and is NEVER frozen into a
 *   drag snapshot. Rows register progressively as they mount (at drag start
 *   AND while autoscrolling previously-offscreen targets).
 */

/**
 * A tree row whose rectangle is in scroll-content coordinates.
 *
 * Identical shape to `TreeRow` except `bounds` is `TreeContentBounds` (its `y`
 * is `contentY`, not a window coordinate). This is what the live registry
 * stores per mounted row.
 */
export type TreeContentRow = Readonly<{
    id: string;
    parentId: string | null;
    containerId: string;
    depth: number;
    kind: TreeRow['kind'];
    bounds: TreeContentBounds;
}>;

/**
 * A container drop zone whose rectangle is in scroll-content coordinates.
 *
 * Identical shape to `TreeContainerDropZone` except `bounds` is
 * `TreeContentBounds`.
 */
export type TreeContentDropZone = Readonly<{
    containerId: string;
    rootId: string;
    parentId: string | null;
    depth: number;
    bounds: TreeContentBounds;
    role: TreeContainerDropZone['role'];
    targetId?: string;
}>;

/**
 * Platform measurement boundary: a ref that can report a window rectangle.
 *
 * `measureInWindow` is the async native path. `getBoundingClientRectFn` is the
 * synchronous web path — when present, `measureWindowBounds` reads it from the
 * same DOM clock as `scrollTop`, eliminating the stale-bounds drift that the
 * old async `measureInWindow` + scroll-rebase model produced (plan section 1.4).
 */
export type TreeDropMeasurableRef = Readonly<{
    measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
    getBoundingClientRectFn?: () => Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

/**
 * Live content-coordinate geometry registry.
 *
 * Owned by `useTreeDropRegistry` (Lane A). Stores content-coordinate rows and
 * drop zones, populated progressively as rows mount. The drag resolver queries
 * it LIVE every pointer frame; nothing here is ever frozen. There is no scroll
 * rebasing — content bounds are stable for the frozen drag surface, so the
 * registry is only mutated by mount/unmount, never by scroll events.
 */
export type TreeDropGeometryRegistry = Readonly<{
    /** Record/replace a row's content-coordinate bounds (on mount/layout). */
    registerRow: (row: TreeContentRow) => void;
    /** Drop a row's bounds (on unmount). */
    unregisterRow: (rowId: string) => void;
    /** Record/replace a drop zone's content-coordinate bounds. */
    registerDropZone: (dropZone: TreeContentDropZone) => void;
    /** Drop drop zones for a container (optionally a single role). */
    unregisterDropZone: (
        containerId: string,
        role?: TreeContentDropZone['role'],
        targetId?: string,
    ) => void;
    /**
     * Live hit query: test `pointer` (already in content coordinates) against
     * the currently-registered rows. Returns the resolved row id, or `null` if
     * the pointer is over an unmeasured/empty region.
     *
     * The caller converts a window pointer to content space with the live
     * `TreeViewportMetrics` BEFORE calling, so this query is pure
     * content-vs-content geometry and needs no viewport metrics of its own.
     */
    queryRowAtContentPointer: (pointer: TreeContentPointer) => string | null;
    /** Live snapshot of registered content geometry, for the resolver. */
    getContentGeometry: () => TreeDropContentGeometry;
}>;

/**
 * Live snapshot of the registry's currently-registered content geometry.
 *
 * Returned by `getContentGeometry()` for the drag resolver. "Snapshot" here
 * means "the registry's state at this instant" — it is read fresh every
 * resolve frame and is NOT the frozen `SessionListDragSnapshot`.
 */
export type TreeDropContentGeometry = Readonly<{
    rows: ReadonlyArray<TreeContentRow>;
    dropZones: ReadonlyArray<TreeContentDropZone>;
}>;

/**
 * Result of measuring a single ref in window coordinates.
 *
 * Boundary type only. Consumers immediately convert this to `TreeContentBounds`
 * via the coordinate-space helpers using the live `TreeViewportMetrics`; raw
 * window bounds are never stored in the registry.
 */
export type TreeDropMeasuredWindowBounds = WindowBounds;
