import { describe, expect, it } from 'vitest';

import { hitTestRowAtPointer } from '../../geometry/hitTestRowAtPointer';

describe('hitTestRowAtPointer', () => {
    it('prefers a stationary sibling over overlapping source bounds without promoting an ancestor', () => {
        const source = { id: 'source', depth: 1, bounds: { x: 0, y: 40, width: 300, height: 40 } };
        const sibling = { id: 'sibling', depth: 1, bounds: { x: 0, y: 50, width: 300, height: 80 } };
        const ancestor = { id: 'ancestor', depth: 0, bounds: { x: 0, y: 0, width: 300, height: 200 } };
        const pointer = { x: 100, y: 78 };
        expect(hitTestRowAtPointer([ancestor, source, sibling], pointer, 'source')?.id).toBe('sibling');
        expect(hitTestRowAtPointer([ancestor, source], pointer, 'source')?.id).toBe('source');
        expect(hitTestRowAtPointer([source], pointer, 'source')?.id).toBe('source');
        expect(hitTestRowAtPointer([source, sibling], pointer)?.id).toBe('source');
    });

    it('chooses the deepest smallest row under the window pointer', async () => {
        expect(hitTestRowAtPointer).toEqual(expect.any(Function));

        const rows = [
            {
                id: 'workspace',
                parentId: null,
                containerId: 'workspace',
                depth: 0,
                kind: 'container',
                bounds: { x: 0, y: 0, width: 300, height: 80 },
            },
            {
                id: 'folder',
                parentId: 'workspace',
                containerId: 'workspace',
                depth: 1,
                kind: 'container',
                bounds: { x: 20, y: 20, width: 220, height: 40 },
            },
        ] as const;

        expect(hitTestRowAtPointer(rows, { x: 40, y: 30 })?.id).toBe('folder');
    });

    it('treats adjacent bottom edges as exclusive so boundary hits target the next row', async () => {
        const rows = [
            {
                id: 'row:before',
                parentId: null,
                containerId: 'workspace',
                depth: 0,
                kind: 'leaf',
                bounds: { x: 0, y: 0, width: 300, height: 40 },
            },
            {
                id: 'row:after',
                parentId: null,
                containerId: 'workspace',
                depth: 0,
                kind: 'leaf',
                bounds: { x: 0, y: 40, width: 300, height: 40 },
            },
        ] as const;

        expect(hitTestRowAtPointer(rows, { x: 24, y: 40 })?.id).toBe('row:after');
    });
});
