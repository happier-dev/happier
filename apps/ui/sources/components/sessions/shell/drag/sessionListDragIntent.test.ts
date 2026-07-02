import { describe, expect, it } from 'vitest';

import type { TreeDropResult } from '@/components/ui/treeDragDrop';

import { buildSessionListDragIntent } from './sessionListDragIntent';
import { treeRowId } from '../drop-resolution/treeRowId';

describe('buildSessionListDragIntent', () => {
    it('captures a reorder-after as a stable, serializable, geometry-free intent', () => {
        const result: TreeDropResult = {
            instruction: {
                kind: 'reorder-after',
                targetId: treeRowId.session('server-a', 'root-a'),
                containerId: 'project-a',
                parentId: null,
                depth: 0,
            },
            visual: { kind: 'line', targetId: treeRowId.session('server-a', 'root-a'), edge: 'bottom', depth: 0 },
        };

        const intent = buildSessionListDragIntent({
            result,
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            snapshotSignature: 'sig-1',
        });

        expect(intent).toEqual({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: 'project-a',
            parentRowId: null,
            depth: 0,
            edge: 'bottom',
            sourceSnapshotSignature: 'sig-1',
        });
    });

    it('captures a nest-into intent with its parent row id', () => {
        const result: TreeDropResult = {
            instruction: {
                kind: 'nest-into',
                targetId: treeRowId.folder('folder-b'),
                containerId: treeRowId.folder('folder-b'),
                parentId: treeRowId.folder('folder-b'),
                depth: 1,
            },
            visual: { kind: 'outline', targetId: treeRowId.folder('folder-b') },
        };

        const intent = buildSessionListDragIntent({
            result,
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            snapshotSignature: 'sig-2',
        });

        expect(intent.instructionKind).toBe('nest-into');
        expect(intent.targetRowId).toBe(treeRowId.folder('folder-b'));
        expect(intent.parentRowId).toBe(treeRowId.folder('folder-b'));
        expect(intent.edge).toBeNull();
    });

    it('captures a move-to-root intent with its line edge (../dev derives placement from edge)', () => {
        const result: TreeDropResult = {
            instruction: {
                kind: 'move-to-root',
                containerId: 'project-a',
                rootId: 'project-a',
                depth: 0,
            },
            visual: { kind: 'line', targetId: 'project-a', edge: 'bottom', depth: 0 },
        };

        const intent = buildSessionListDragIntent({
            result,
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            snapshotSignature: 'sig-3',
        });

        expect(intent.instructionKind).toBe('move-to-root');
        expect(intent.containerId).toBe('project-a');
        expect(intent.targetRowId).toBeNull();
        // `../dev` has no `rootPlacement` field — the edge carries placement.
        expect(intent).not.toHaveProperty('rootPlacement');
        expect(intent.edge).toBe('bottom');
    });

    it('returns a non-committing intent for blocked/idle results', () => {
        const blocked = buildSessionListDragIntent({
            result: { instruction: { kind: 'blocked', reason: 'descendant-cycle' }, visual: { kind: 'none' } },
            sourceRowId: treeRowId.folder('folder-a'),
            sourceKind: 'container',
            snapshotSignature: 'sig-4',
        });

        expect(blocked.instructionKind).toBe('blocked');
        expect(blocked.targetRowId).toBeNull();
        expect(blocked.containerId).toBeNull();
        expect(blocked.depth).toBeNull();
        expect(blocked.edge).toBeNull();
    });
});
