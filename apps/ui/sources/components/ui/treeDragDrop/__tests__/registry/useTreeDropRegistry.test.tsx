import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useTreeDropRegistry } from '../../registry/useTreeDropRegistry';

describe('useTreeDropRegistry', () => {
    it('stores and returns window-absolute rows and drop zones without layout fallback data', async () => {
        expect(useTreeDropRegistry).toEqual(expect.any(Function));

        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();

        registry.registerRow({
            id: 'folder:a',
            parentId: null,
            containerId: 'workspace:a',
            depth: 0,
            kind: 'container',
            bounds: { x: 10, y: 20, width: 300, height: 40 },
        });
        registry.registerDropZone({
            containerId: 'workspace:a',
            rootId: 'workspace:a',
            parentId: null,
            depth: 0,
            bounds: { x: 10, y: 0, width: 300, height: 20 },
            role: 'root-before-first',
        });

        expect(registry.getSnapshot()).toEqual({
            rows: [
                {
                    id: 'folder:a',
                    parentId: null,
                    containerId: 'workspace:a',
                    depth: 0,
                    kind: 'container',
                    bounds: { x: 10, y: 20, width: 300, height: 40 },
                },
            ],
            dropZones: [
                {
                    containerId: 'workspace:a',
                    rootId: 'workspace:a',
                    parentId: null,
                    depth: 0,
                    bounds: { x: 10, y: 0, width: 300, height: 20 },
                    role: 'root-before-first',
                },
            ],
        });
    });

    it('rebases window bounds by scroll delta without changing x or dimensions', async () => {
        expect(useTreeDropRegistry).toEqual(expect.any(Function));

        const hook = await renderHook(() => useTreeDropRegistry());
        const registry = hook.getCurrent();
        registry.registerRow({
            id: 'folder:a',
            parentId: null,
            containerId: 'workspace:a',
            depth: 0,
            kind: 'container',
            bounds: { x: 10, y: 120, width: 300, height: 40 },
        });

        registry.rebaseWindowBoundsByScrollDelta(24);

        expect(registry.getSnapshot().rows[0]?.bounds).toEqual({
            x: 10,
            y: 96,
            width: 300,
            height: 40,
        });
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

        expect(registry.getSnapshot().dropZones).toEqual([
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
});
