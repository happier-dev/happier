import * as React from 'react';

import type { TreeContainerDropZone, TreeRow } from '../treeDragDropTypes';
import type { TreeDropRegistrySnapshot } from './treeDropRegistryTypes';

export type TreeDropRegistry = Readonly<{
    registerRow: (row: TreeRow) => void;
    unregisterRow: (rowId: string) => void;
    registerDropZone: (dropZone: TreeContainerDropZone) => void;
    unregisterDropZone: (containerId: string, role?: TreeContainerDropZone['role']) => void;
    rebaseWindowBoundsByScrollDelta: (deltaY: number) => void;
    getSnapshot: () => TreeDropRegistrySnapshot;
}>;

function dropZoneKey(dropZone: Pick<TreeContainerDropZone, 'containerId' | 'role'>): string {
    return `${dropZone.role}\u0000${dropZone.containerId}`;
}

function rebaseRow(row: TreeRow, deltaY: number): TreeRow {
    return {
        ...row,
        bounds: {
            ...row.bounds,
            y: row.bounds.y - deltaY,
        },
    };
}

function rebaseDropZone(dropZone: TreeContainerDropZone, deltaY: number): TreeContainerDropZone {
    return {
        ...dropZone,
        bounds: {
            ...dropZone.bounds,
            y: dropZone.bounds.y - deltaY,
        },
    };
}

export function useTreeDropRegistry(): TreeDropRegistry {
    const rowsRef = React.useRef(new Map<string, TreeRow>());
    const dropZonesRef = React.useRef(new Map<string, TreeContainerDropZone>());

    const registerRow = React.useCallback((row: TreeRow) => {
        rowsRef.current.set(row.id, row);
    }, []);

    const unregisterRow = React.useCallback((rowId: string) => {
        rowsRef.current.delete(rowId);
    }, []);

    const registerDropZone = React.useCallback((dropZone: TreeContainerDropZone) => {
        dropZonesRef.current.set(dropZoneKey(dropZone), dropZone);
    }, []);

    const unregisterDropZone = React.useCallback((containerId: string, role?: TreeContainerDropZone['role']) => {
        if (role) {
            dropZonesRef.current.delete(dropZoneKey({ containerId, role }));
            return;
        }
        for (const [key, dropZone] of dropZonesRef.current) {
            if (dropZone.containerId === containerId) {
                dropZonesRef.current.delete(key);
            }
        }
    }, []);

    const rebaseWindowBoundsByScrollDelta = React.useCallback((deltaY: number) => {
        if (!Number.isFinite(deltaY) || deltaY === 0) return;
        rowsRef.current = new Map(Array.from(rowsRef.current, ([id, row]) => [id, rebaseRow(row, deltaY)]));
        dropZonesRef.current = new Map(Array.from(dropZonesRef.current, ([id, dropZone]) => [id, rebaseDropZone(dropZone, deltaY)]));
    }, []);

    const getSnapshot = React.useCallback((): TreeDropRegistrySnapshot => ({
        rows: Array.from(rowsRef.current.values()),
        dropZones: Array.from(dropZonesRef.current.values()),
    }), []);

    return React.useMemo(() => ({
        registerRow,
        unregisterRow,
        registerDropZone,
        unregisterDropZone,
        rebaseWindowBoundsByScrollDelta,
        getSnapshot,
    }), [
        getSnapshot,
        rebaseWindowBoundsByScrollDelta,
        registerDropZone,
        registerRow,
        unregisterDropZone,
        unregisterRow,
    ]);
}
