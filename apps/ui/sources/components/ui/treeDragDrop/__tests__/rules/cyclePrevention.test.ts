import { describe, expect, it } from 'vitest';

import { buildExcludedDescendantIds } from '../../rules/cyclePrevention';

describe('cyclePrevention', () => {
    it('builds an excluded descendant set from a flattened tree', async () => {
        expect(buildExcludedDescendantIds).toEqual(expect.any(Function));

        const rows = [
            { id: 'folder:a', parentId: null, containerId: 'root', depth: 0, kind: 'container', bounds: { x: 0, y: 0, width: 1, height: 1 } },
            { id: 'folder:b', parentId: 'folder:a', containerId: 'folder:a', depth: 1, kind: 'container', bounds: { x: 0, y: 1, width: 1, height: 1 } },
            { id: 'session:c', parentId: 'folder:b', containerId: 'folder:b', depth: 2, kind: 'leaf', bounds: { x: 0, y: 2, width: 1, height: 1 } },
            { id: 'session:d', parentId: null, containerId: 'root', depth: 0, kind: 'leaf', bounds: { x: 0, y: 3, width: 1, height: 1 } },
        ] as const;

        expect([...buildExcludedDescendantIds(rows, 'folder:a')].sort()).toEqual([
            'folder:a',
            'folder:b',
            'session:c',
        ]);
    });
});
