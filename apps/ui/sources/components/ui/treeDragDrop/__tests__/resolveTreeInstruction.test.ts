import { describe, expect, it } from 'vitest';

import { resolveTreeInstruction } from '../resolveTreeInstruction';

const rowBounds = (y: number) => ({ x: 0, y, width: 320, height: 30 });

const baseRows = [
    {
        id: 'folder:a',
        parentId: null,
        containerId: 'workspace:alpha',
        depth: 0,
        kind: 'container',
        bounds: rowBounds(20),
    },
    {
        id: 'session:a1',
        parentId: 'folder:a',
        containerId: 'folder:a',
        depth: 1,
        kind: 'leaf',
        bounds: { x: 24, y: 60, width: 296, height: 30 },
    },
    {
        id: 'folder:b',
        parentId: null,
        containerId: 'workspace:alpha',
        depth: 0,
        kind: 'container',
        bounds: rowBounds(100),
    },
    {
        id: 'session:root',
        parentId: null,
        containerId: 'workspace:alpha',
        depth: 0,
        kind: 'leaf',
        bounds: rowBounds(140),
    },
] as const;

const baseDropZones = [
    {
        containerId: 'workspace:alpha',
        rootId: 'workspace:alpha',
        parentId: null,
        depth: 0,
        bounds: { x: 0, y: 0, width: 320, height: 20 },
        role: 'root-before-first',
    },
    {
        containerId: 'workspace:alpha',
        rootId: 'workspace:alpha',
        parentId: null,
        depth: 0,
        bounds: { x: 0, y: 180, width: 320, height: 30 },
        role: 'root-after-last',
    },
    {
        containerId: 'folder:empty',
        rootId: 'workspace:alpha',
        parentId: 'folder:empty',
        depth: 1,
        bounds: { x: 24, y: 220, width: 296, height: 34 },
        role: 'container-body',
    },
] as const;

const allowRules = {
    canNestInto: () => true,
    canReorderAround: () => true,
};

function source(overrides: Partial<{ id: string; kind: 'container' | 'leaf'; excludedDescendantIds: ReadonlySet<string> }> = {}) {
    return {
        id: overrides.id ?? 'session:a1',
        kind: overrides.kind ?? 'leaf',
        excludedDescendantIds: overrides.excludedDescendantIds ?? new Set(['session:a1']),
    };
}

describe('resolveTreeInstruction', () => {
    it('resolves a top-third row hit as reorder-before with matching line visual depth', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 103 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'reorder-before',
                targetId: 'folder:b',
                containerId: 'workspace:alpha',
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'folder:b',
                edge: 'top',
                depth: 0,
            },
        });
    });

    it('resolves a bottom-third row hit as reorder-after with matching line visual depth', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'folder:a', kind: 'container', excludedDescendantIds: new Set(['folder:a', 'session:a1']) }),
            pointer: { x: 12, y: 165 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'reorder-after',
                targetId: 'session:root',
                containerId: 'workspace:alpha',
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'session:root',
                edge: 'bottom',
                depth: 0,
            },
        });
    });

    it('resolves a middle-third container hit as nest-into with outline visual', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 115 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'nest-into',
                targetId: 'folder:b',
                containerId: 'folder:b',
                parentId: 'folder:b',
                depth: 1,
            },
            visual: {
                kind: 'outline',
                targetId: 'folder:b',
            },
        });
    });

    it('blocks same-position row hits before choosing an edge operation', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'folder:b', kind: 'container', excludedDescendantIds: new Set(['folder:b']) }),
            pointer: { x: 12, y: 103 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'same-position',
                hintTargetId: 'folder:b',
            },
            visual: { kind: 'none' },
        });
    });

    it('resolves row targets when the dragged source row is not visible', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'session:hidden', kind: 'leaf', excludedDescendantIds: new Set(['session:hidden']) }),
            pointer: { x: 12, y: 103 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'reorder-before',
                targetId: 'folder:b',
                containerId: 'workspace:alpha',
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'folder:b',
                edge: 'top',
                depth: 0,
            },
        });
    });

    it('prioritizes concrete row hits over overlapping drop zones', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: [
                ...baseDropZones,
                {
                    containerId: 'folder:overlap',
                    rootId: 'workspace:alpha',
                    parentId: 'folder:overlap',
                    depth: 3,
                    bounds: { x: 0, y: 95, width: 320, height: 40 },
                    role: 'container-body',
                },
            ],
            source: source(),
            pointer: { x: 12, y: 103 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'reorder-before',
                targetId: 'folder:b',
                containerId: 'workspace:alpha',
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'folder:b',
                edge: 'top',
                depth: 0,
            },
        });
    });

    it('resolves explicit root drop zones without inventing row fallbacks', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 8 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'move-to-root',
                containerId: 'workspace:alpha',
                rootId: 'workspace:alpha',
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'workspace:alpha',
                edge: 'top',
                depth: 0,
            },
        });
    });

    it('resolves a root-empty drop zone as scoped root movement', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: [
                {
                    containerId: 'focused-folder:alpha',
                    rootId: 'folder:focused',
                    parentId: 'folder:focused',
                    depth: 2,
                    bounds: { x: 24, y: 260, width: 296, height: 48 },
                    role: 'root-empty',
                },
            ],
            source: source(),
            pointer: { x: 30, y: 280 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'move-to-root',
                containerId: 'focused-folder:alpha',
                rootId: 'folder:focused',
                depth: 2,
            },
            visual: {
                kind: 'outline',
                targetId: 'focused-folder:alpha',
            },
        });
    });

    it('resolves an empty container body drop zone as nest-into', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 32, y: 238 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'nest-into',
                targetId: 'folder:empty',
                containerId: 'folder:empty',
                parentId: 'folder:empty',
                depth: 1,
            },
            visual: {
                kind: 'outline',
                targetId: 'folder:empty',
            },
        });
    });

    it('blocks dropping a container into its descendant subtree', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'folder:a', kind: 'container', excludedDescendantIds: new Set(['folder:a', 'session:a1']) }),
            pointer: { x: 36, y: 75 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'descendant-cycle',
                hintTargetId: 'session:a1',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks a middle hit on a leaf row before domain rules run', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'folder:b', kind: 'container', excludedDescendantIds: new Set(['folder:b']) }),
            pointer: { x: 36, y: 75 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'leaf-cannot-be-parent',
                hintTargetId: 'session:a1',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks max-depth violations for container body zones', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 32, y: 238 },
            rules: {
                ...allowRules,
                maxDepth: 0,
            },
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'max-depth-exceeded',
                hintTargetId: 'folder:empty',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks max-depth violations for row nesting', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 115 },
            rules: {
                ...allowRules,
                maxDepth: 0,
            },
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'max-depth-exceeded',
                hintTargetId: 'folder:b',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks max-depth violations for row reordering', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source({ id: 'session:root', excludedDescendantIds: new Set(['session:root']) }),
            pointer: { x: 36, y: 63 },
            rules: {
                ...allowRules,
                maxDepth: 0,
            },
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'max-depth-exceeded',
                hintTargetId: 'session:a1',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks workspace-scope mismatches reported by domain rules', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 103 },
            rules: {
                canNestInto: () => true,
                canReorderAround: () => false,
            },
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'workspace-scope-mismatch',
                hintTargetId: 'folder:b',
            },
            visual: { kind: 'none' },
        });
    });

    it('blocks root-zone scope mismatches reported by domain rules', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 8 },
            rules: {
                ...allowRules,
                canMoveToRoot: () => false,
            },
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'workspace-scope-mismatch',
                hintTargetId: 'workspace:alpha',
            },
            visual: { kind: 'none' },
        });
    });

    it('uses the bottom edge at the exact two-thirds threshold', async () => {
        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 12, y: 120 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'reorder-after',
                targetId: 'folder:b',
                containerId: 'workspace:alpha',
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: 'folder:b',
                edge: 'bottom',
                depth: 0,
            },
        });
    });

    it('returns no-target when the pointer is outside rows and explicit drop zones', async () => {
        expect(resolveTreeInstruction).toEqual(expect.any(Function));

        expect(resolveTreeInstruction({
            rows: baseRows,
            dropZones: baseDropZones,
            source: source(),
            pointer: { x: 999, y: 999 },
            rules: allowRules,
        })).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'no-target',
            },
            visual: { kind: 'none' },
        });
    });
});
