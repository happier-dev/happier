/**
 * Resolves a drag pointer against the FROZEN topology + the LIVE content-
 * coordinate geometry registry + live viewport metrics.
 *
 * Phase 2/3 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 1.4, 3.2, 3.4). This is the wrong-blue-line fix: it converts the
 * window pointer into stable content coordinates with the live viewport, then
 * hit-tests against the live registry geometry. There is NO per-pointer-frame
 * `buildSessionListTreeRows` and NO stale-bounds rebasing — the registry holds
 * content bounds that never move with scroll, so the resolved target always sits
 * under the pointer.
 *
 * Output:
 * - `result`: the `TreeDropResult` (instruction + visual), resolved with the
 *   session-list rules (eligibility) against the frozen topology metadata
 *   combined with live content geometry;
 * - `geometry`: numeric VIEWPORT-coordinate overlay geometry derived from the
 *   live content bounds plus the live scroll offset, ready for the overlay's
 *   shared values.
 *
 * `../dev` note: `resolveSessionListInstruction` has no `folderSortMode` param
 * (folder-sort behaviour is resolved at commit time via
 * `SessionListGroupOrderChildKind`), so no sort mode is threaded here.
 */

import {
    resolveTreeDropVisualGeometry,
    windowPointerToContentPointer,
    type TreeContentRow,
    type TreeContentDropZone,
    type TreeDropContentGeometry,
    type TreeDropGeometryRegistry,
    type TreeDropResult,
    type TreeDropVisualGeometry,
    type TreeRow,
    type TreeContainerDropZone,
    type TreeViewportMetrics,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';

import type { SessionListDragSnapshot } from './_types';
import { resolveImplicitDropZoneBounds } from './resolveImplicitDropZoneBounds';
import { resolveSessionListInstruction } from '../drop-resolution/resolveSessionListInstruction';
import type { SessionListTreeDropResult, SessionListTreeModel } from '../drop-resolution/sessionListTreeTypes';

const IDLE_RESULT: TreeDropResult = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' }),
    visual: Object.freeze({ kind: 'none' }),
});

const NONE_GEOMETRY: TreeDropVisualGeometry = Object.freeze({ kind: 'none' });

export type ResolveSessionListDragPointerParams = Readonly<{
    /** The frozen drag snapshot (tree topology + source), built at drag start. */
    snapshot: SessionListDragSnapshot;
    /** The live content-coordinate geometry registry (queried, never frozen). */
    registry: Pick<TreeDropGeometryRegistry, 'getContentGeometry'>;
    /** The current window-space pointer, or `null` when there is no pointer. */
    pointer: WindowPointer | null;
    /** Live viewport + scroll metrics, read once per resolve. */
    viewport: TreeViewportMetrics;
}>;

export type ResolveSessionListDragPointerResult = Readonly<{
    /** Resolved instruction + visual (visual targets agree with the instruction). */
    result: SessionListTreeDropResult;
    /** Numeric viewport-coordinate overlay geometry, or `{ kind: 'none' }`. */
    geometry: TreeDropVisualGeometry;
}>;

/**
 * `TreeContentRow`/`TreeContentDropZone` are structurally identical to
 * `TreeRow`/`TreeContainerDropZone` (content bounds share the `WindowBounds`
 * shape). The instruction resolver only needs rows in ONE coordinate space that
 * matches the pointer; we keep everything in content space here.
 */
function asTreeRow(row: TreeContentRow): TreeRow {
    return row;
}

function asTreeDropZone(dropZone: TreeContentDropZone): TreeContainerDropZone {
    return dropZone;
}

/**
 * Combines the FROZEN topology metadata with the LIVE content geometry into a
 * single content-space `SessionListTreeModel` the session resolver consumes.
 *
 * Rows come from the live registry; metadata comes from the frozen snapshot (so
 * resolution rules see the drag-start tree structure). `dropZones` is the live
 * registry's zones (currently always empty) PLUS the implicit zones derived
 * here — without the implicit zones, dropping into a gap that misses every row
 * resolves to `blocked('no-target')` and silently no-ops (B1).
 */
function buildContentTreeModel(
    snapshot: SessionListDragSnapshot,
    geometry: TreeDropContentGeometry,
    dropZones: ReadonlyArray<TreeContentDropZone>,
): SessionListTreeModel {
    return {
        items: snapshot.frozenItems,
        rows: geometry.rows.map(asTreeRow),
        dropZones: dropZones.map(asTreeDropZone),
        rowMetadataById: snapshot.topology.rowMetadataById,
        containerMetadataById: snapshot.topology.containerMetadataById,
    };
}

export function resolveSessionListDragPointer(
    params: ResolveSessionListDragPointerParams,
): ResolveSessionListDragPointerResult {
    const { snapshot, registry, pointer, viewport } = params;

    if (!pointer) {
        return { result: IDLE_RESULT, geometry: NONE_GEOMETRY };
    }

    const contentPointer = windowPointerToContentPointer(pointer, viewport);
    if (!contentPointer) {
        return { result: IDLE_RESULT, geometry: NONE_GEOMETRY };
    }

    const geometry = registry.getContentGeometry();

    // The live registry never registers drop zones — it only tracks rows. Derive
    // the implicit root-edge / sibling-gap zones in content coordinates from the
    // frozen structural topology + live row bounds, then merge them with any
    // zones the registry did carry. Without this, gap drops resolve to
    // `blocked('no-target')` and silently no-op (B1).
    const implicitDropZones = resolveImplicitDropZoneBounds({
        topologyDropZones: snapshot.topology.dropZones,
        rows: geometry.rows,
        rowMetadataById: snapshot.topology.rowMetadataById,
    });
    const dropZones: ReadonlyArray<TreeContentDropZone> = geometry.dropZones.length > 0
        ? [...geometry.dropZones, ...implicitDropZones]
        : implicitDropZones;

    const tree = buildContentTreeModel(snapshot, geometry, dropZones);

    const result = resolveSessionListInstruction({
        tree,
        source: snapshot.source.treeSource,
        pointer: contentPointer,
        foldersFeatureEnabled: snapshot.foldersFeatureEnabled,
    });

    const overlayGeometry = resolveTreeDropVisualGeometry({
        visual: result.visual,
        rows: geometry.rows,
        dropZones,
        viewport,
    });

    return { result, geometry: overlayGeometry };
}
