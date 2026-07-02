import * as React from 'react';

import { hitTestRowAtPointer } from '../geometry/hitTestRowAtPointer';
import type { TreeContentPointer } from '../geometry/treeContentGeometryTypes';
import type {
    TreeContentDropZone,
    TreeContentRow,
    TreeDropContentGeometry,
    TreeDropGeometryRegistry,
} from './treeDropRegistryTypes';

/**
 * Live content-coordinate geometry registry for generic tree drag/drop.
 *
 * Phase 1 of `.project/plans/session-list-drag-geometry-performance-unification.md`
 * (sections 3.1, 3.2). This is the canonical registry — there is no second one.
 *
 * Rows and drop zones are stored in scroll-content coordinates (`TreeContentRow`
 * / `TreeContentDropZone`). They are registered progressively as rows mount (at
 * drag start AND while autoscrolling previously-offscreen targets) and are only
 * ever mutated by mount/unmount. There is NO scroll rebasing: content
 * coordinates are stable for the frozen drag surface, so a scroll event never
 * changes a stored rectangle. The drag resolver queries this registry LIVE
 * every pointer frame; nothing here is frozen into a drag snapshot.
 *
 * `queryRowAtContentPointer` takes a pointer that is already in content space
 * (the caller converts a window pointer with the live `TreeViewportMetrics`
 * before calling), so hit-testing here is pure content-vs-content geometry and
 * needs no viewport metrics of its own.
 *
 * The registry contract type `TreeDropGeometryRegistry` is owned by
 * `treeDropRegistryTypes.ts`; import it from there or from the package barrel.
 */

/**
 * Composite drop-zone key. A JSON tuple is collision-proof regardless of role /
 * container-id / target-id content, so prefix-like ids (`folder:a` vs
 * `folder:a:child`) never alias to the same drop-zone slot. Sibling boundary
 * zones can repeat the same role inside one container, so `targetId` is part of
 * the key when present.
 */
function dropZoneKey(dropZone: Pick<TreeContentDropZone, 'containerId' | 'role' | 'targetId'>): string {
    return JSON.stringify([dropZone.role, dropZone.containerId, dropZone.targetId ?? null]);
}

export function useTreeDropRegistry(): TreeDropGeometryRegistry {
    const rowsRef = React.useRef(new Map<string, TreeContentRow>());
    const dropZonesRef = React.useRef(new Map<string, TreeContentDropZone>());

    const registerRow = React.useCallback((row: TreeContentRow) => {
        rowsRef.current.set(row.id, row);
    }, []);

    const unregisterRow = React.useCallback((rowId: string) => {
        rowsRef.current.delete(rowId);
    }, []);

    const registerDropZone = React.useCallback((dropZone: TreeContentDropZone) => {
        dropZonesRef.current.set(dropZoneKey(dropZone), dropZone);
    }, []);

    const unregisterDropZone = React.useCallback((
        containerId: string,
        role?: TreeContentDropZone['role'],
        targetId?: string,
    ) => {
        for (const [key, dropZone] of dropZonesRef.current) {
            if (
                dropZone.containerId === containerId
                && (!role || dropZone.role === role)
                && (targetId === undefined || dropZone.targetId === targetId)
            ) {
                dropZonesRef.current.delete(key);
            }
        }
    }, []);

    const queryRowAtContentPointer = React.useCallback((pointer: TreeContentPointer): string | null => {
        const row = hitTestRowAtPointer(Array.from(rowsRef.current.values()), pointer);
        return row ? row.id : null;
    }, []);

    const getContentGeometry = React.useCallback((): TreeDropContentGeometry => ({
        rows: Array.from(rowsRef.current.values()),
        dropZones: Array.from(dropZonesRef.current.values()),
    }), []);

    return React.useMemo(() => ({
        registerRow,
        unregisterRow,
        registerDropZone,
        unregisterDropZone,
        queryRowAtContentPointer,
        getContentGeometry,
    }), [
        getContentGeometry,
        queryRowAtContentPointer,
        registerDropZone,
        registerRow,
        unregisterDropZone,
        unregisterRow,
    ]);
}
