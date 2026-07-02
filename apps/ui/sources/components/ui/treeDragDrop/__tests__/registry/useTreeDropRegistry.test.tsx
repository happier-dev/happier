import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useTreeDropRegistry } from '../../registry/useTreeDropRegistry';
import type { TreeContentDropZone, TreeContentRow } from '../../registry/treeDropRegistryTypes';

function workspaceRow(): TreeContentRow {
    return {
        id: 'workspace:a',
        parentId: null,
        containerId: 'workspace:a',
        depth: 0,
        kind: 'container',
        bounds: { x: 0, y: 0, width: 320, height: 240 },
    };
}

function folderRow(): TreeContentRow {
    return {
        id: 'folder:a',
        parentId: 'workspace:a',
        containerId: 'workspace:a',
        depth: 1,
        kind: 'container',
        bounds: { x: 16, y: 40, width: 288, height: 48 },
    };
}

describe('useTreeDropRegistry', () => {
    it('stores rows and drop zones as content-coordinate geometry', async () => {
        expect(useTreeDropRegistry).toEqual(expect.any(Function));

        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        const row = folderRow();
        const dropZone: TreeContentDropZone = {
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 0, width: 320, height: 20 },
            role: 'root-before-first',
        };
        registry.registerRow(row);
        registry.registerDropZone(dropZone);

        expect(registry.getContentGeometry()).toEqual({
            rows: [row],
            dropZones: [dropZone],
        });
    });

    it('does not expose any scroll-rebasing api on the registry', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        expect(registry).not.toHaveProperty('rebaseWindowBoundsByScrollDelta');
        expect(registry).not.toHaveProperty('getSnapshot');
    });

    it('hit-tests the deepest smallest registered row at a content-coordinate pointer', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerRow(workspaceRow());
        registry.registerRow(folderRow());

        // The pointer falls inside both the workspace and the nested folder row.
        expect(registry.queryRowAtContentPointer({ x: 40, y: 60 })).toBe('folder:a');
        // A pointer inside only the workspace resolves to the workspace row.
        expect(registry.queryRowAtContentPointer({ x: 40, y: 200 })).toBe('workspace:a');
    });

    it('keeps content hit-testing stable after registering rows from a scrolled-in region', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        // Content coordinates never change with scroll: a row mounted while scrolled
        // far down still resolves at its content-Y without any rebasing step.
        const offscreenRow: TreeContentRow = {
            id: 'session:deep',
            parentId: null,
            containerId: 'workspace:a',
            depth: 0,
            kind: 'leaf',
            bounds: { x: 0, y: 4000, width: 320, height: 56 },
        };
        registry.registerRow(offscreenRow);

        expect(registry.queryRowAtContentPointer({ x: 24, y: 4020 })).toBe('session:deep');
        expect(registry.queryRowAtContentPointer({ x: 24, y: 100 })).toBeNull();
    });

    it('returns null when the content pointer is over no registered row', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerRow(folderRow());
        expect(registry.queryRowAtContentPointer({ x: 9999, y: 9999 })).toBeNull();
    });

    it('drops a row from the registry on unregister', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerRow(folderRow());
        registry.unregisterRow('folder:a');

        expect(registry.getContentGeometry().rows).toEqual([]);
        expect(registry.queryRowAtContentPointer({ x: 40, y: 60 })).toBeNull();
    });

    it('unregisters drop zones by exact container id without deleting prefix-like containers', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerDropZone({
            containerId: 'folder:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 1,
            bounds: { x: 10, y: 20, width: 300, height: 40 },
            role: 'container-body',
        });
        registry.registerDropZone({
            containerId: 'folder:a:child',
            rootId: 'workspace:a',
            parentId: 'folder:a',
            depth: 2,
            bounds: { x: 20, y: 70, width: 280, height: 40 },
            role: 'container-body',
        });

        registry.unregisterDropZone('folder:a');

        expect(registry.getContentGeometry().dropZones).toEqual([
            {
                containerId: 'folder:a:child',
                rootId: 'workspace:a',
                parentId: 'folder:a',
                depth: 2,
                bounds: { x: 20, y: 70, width: 280, height: 40 },
                role: 'container-body',
            },
        ]);
    });

    it('unregisters a single drop-zone role for a container when a role is given', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerDropZone({
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 0, width: 320, height: 20 },
            role: 'root-before-first',
        });
        registry.registerDropZone({
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 0, y: 600, width: 320, height: 20 },
            role: 'root-after-last',
        });

        registry.unregisterDropZone('workspace:a', 'root-before-first');

        expect(registry.getContentGeometry().dropZones).toEqual([
            {
                containerId: 'workspace:a',
                rootId: 'workspace:a',
                parentId: null,
                depth: 0,
                bounds: { x: 0, y: 600, width: 320, height: 20 },
                role: 'root-after-last',
            },
        ]);
    });

    it('keeps sibling drop zones with different target rows in the same container', async () => {
        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        const beforeAlpha: TreeContentDropZone = {
            containerId: 'folder:a',
            rootId: 'workspace:a',
            parentId: 'folder:a',
            depth: 1,
            bounds: { x: 16, y: 120, width: 300, height: 16 },
            role: 'sibling-before',
            targetId: 'session:alpha',
        };
        const beforeBeta: TreeContentDropZone = {
            containerId: 'folder:a',
            rootId: 'workspace:a',
            parentId: 'folder:a',
            depth: 1,
            bounds: { x: 16, y: 240, width: 300, height: 16 },
            role: 'sibling-before',
            targetId: 'session:beta',
        };

        registry.registerDropZone(beforeAlpha);
        registry.registerDropZone(beforeBeta);

        expect(registry.getContentGeometry().dropZones).toEqual([beforeAlpha, beforeBeta]);

        registry.unregisterDropZone('folder:a', 'sibling-before', 'session:alpha');

        expect(registry.getContentGeometry().dropZones).toEqual([beforeBeta]);
    });
});
