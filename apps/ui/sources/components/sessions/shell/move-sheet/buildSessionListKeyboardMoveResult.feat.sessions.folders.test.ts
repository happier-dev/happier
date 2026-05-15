import { describe, expect, it } from 'vitest';

import type { WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListKeyboardMoveResult } from './buildSessionListKeyboardMoveResult';

const workspace: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo',
};

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function projectHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: '~/repo',
        headerKind: 'project',
        groupKey: 'project-a',
        workspaceKey: 'project-a',
        workspace,
        serverId: 'server-a',
    };
}

function folderHeader(params: Readonly<{ id: string; groupKey: string; depth: number }>): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: params.id,
        headerKind: 'folder',
        folderId: params.id,
        folderDepth: params.depth,
        groupKey: params.groupKey,
        workspace,
        serverId: 'server-a',
    };
}

function sessionItem(params: Readonly<{ id: string; groupKey: string; folderId: string | null; depth: number }>): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: params.id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: params.groupKey,
        groupKind: params.folderId ? 'folder' : 'project',
        folderId: params.folderId,
        folderDepth: params.depth,
        workspace,
    };
}

function buildTree() {
    const items: SessionListIndexItem[] = [
        projectHeader(),
        folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0 }),
        sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1 }),
        sessionItem({ id: 'inside-b', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1 }),
        folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 0 }),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0 }),
    ];

    return buildSessionListTreeRows({
        items,
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot('project-a'), bounds(0)],
            [treeRowId.folder('folder-a'), bounds(40)],
            [treeRowId.session('server-a', 'inside-a'), bounds(80)],
            [treeRowId.session('server-a', 'inside-b'), bounds(120)],
            [treeRowId.folder('folder-b'), bounds(160)],
            [treeRowId.session('server-a', 'root-a'), bounds(200)],
        ]),
    });
}

describe('buildSessionListKeyboardMoveResult', () => {
    it('moves a session up by resolving a reorder-before instruction for its previous sibling', () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({
            tree,
            sourceRowId: treeRowId.session('server-a', 'inside-b'),
        });

        const result = buildSessionListKeyboardMoveResult({ tree, source, direction: 'up' });

        expect(result).toEqual({
            instruction: {
                kind: 'reorder-before',
                targetId: treeRowId.session('server-a', 'inside-a'),
                containerId: treeRowId.folder('folder-a'),
                parentId: treeRowId.folder('folder-a'),
                depth: 1,
            },
            visual: {
                kind: 'line',
                targetId: treeRowId.session('server-a', 'inside-a'),
                edge: 'top',
                depth: 1,
            },
        });
    });

    it('moves a folder down by resolving a reorder-after instruction for its next root sibling', () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({
            tree,
            sourceRowId: treeRowId.folder('folder-a'),
        });

        const result = buildSessionListKeyboardMoveResult({ tree, source, direction: 'down' });

        expect(result).toMatchObject({
            instruction: {
                kind: 'reorder-after',
                targetId: treeRowId.folder('folder-b'),
                containerId: treeRowId.workspaceRoot('project-a'),
                parentId: null,
                depth: 0,
            },
            visual: {
                kind: 'line',
                targetId: treeRowId.folder('folder-b'),
                edge: 'bottom',
                depth: 0,
            },
        });
    });

    it('blocks keyboard movement at the edge of the sibling container', () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({
            tree,
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
        });

        const result = buildSessionListKeyboardMoveResult({ tree, source, direction: 'up' });

        expect(result).toEqual({
            instruction: {
                kind: 'blocked',
                reason: 'same-position',
                hintTargetId: treeRowId.session('server-a', 'inside-a'),
            },
            visual: {
                kind: 'none',
            },
        });
    });
});
