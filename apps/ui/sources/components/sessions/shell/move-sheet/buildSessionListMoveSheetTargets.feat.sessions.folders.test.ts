import { describe, expect, it } from 'vitest';

import type { WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListMoveSheetTargets } from './buildSessionListMoveSheetTargets';

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
        folderHeader({ id: 'child-a', groupKey: 'project-a:folder:child-a', depth: 1 }),
        folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 0 }),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0 }),
    ];

    return buildSessionListTreeRows({
        items,
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot('project-a'), bounds(0)],
            [treeRowId.folder('folder-a'), bounds(40)],
            [treeRowId.session('server-a', 'inside-a'), bounds(80)],
            [treeRowId.folder('child-a'), bounds(120)],
            [treeRowId.folder('folder-b'), bounds(160)],
            [treeRowId.session('server-a', 'root-a'), bounds(200)],
        ]),
    });
}

describe('buildSessionListMoveSheetTargets', () => {
    it('returns workspace root first and disables the current folder for a session source', () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({
            tree,
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
        });

        const targets = buildSessionListMoveSheetTargets({ tree, source });

        expect(targets[0]).toMatchObject({
            id: `root:${treeRowId.workspaceRoot('project-a')}`,
            disabled: false,
            result: {
                instruction: {
                    kind: 'move-to-root',
                    containerId: treeRowId.workspaceRoot('project-a'),
                },
            },
        });
        expect(targets.find((target) => target.id === 'folder:folder-a')).toMatchObject({
            disabled: true,
            disabledReason: 'same-position',
        });
        expect(targets.find((target) => target.id === 'folder:folder-b')).toMatchObject({
            disabled: false,
            result: {
                instruction: {
                    kind: 'nest-into',
                    targetId: treeRowId.folder('folder-b'),
                    containerId: treeRowId.folder('folder-b'),
                },
            },
        });
    });

    it('disables descendant targets for folder sources', () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({
            tree,
            sourceRowId: treeRowId.folder('folder-a'),
        });

        const targets = buildSessionListMoveSheetTargets({ tree, source });

        expect(targets.find((target) => target.id === 'folder:child-a')).toMatchObject({
            disabled: true,
            disabledReason: 'descendant-cycle',
        });
        expect(targets.find((target) => target.id === 'folder:folder-b')).toMatchObject({
            disabled: false,
        });
    });
});
