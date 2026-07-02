import { describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { commitSessionListDragIntent } from './commitSessionListDragIntent';
import type { SessionListDragIntent } from './_types';
import { treeRowId } from '../drop-resolution/treeRowId';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

const projectGroupKey = 'project-a';
const folderAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a';
const folderBGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-b';

function projectHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: projectGroupKey,
        headerKind: 'project',
        groupKey: projectGroupKey,
        workspaceKey: projectGroupKey,
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function folderHeader(id: string, groupKey: string, depth: number): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: id,
        headerKind: 'folder',
        folderId: id,
        folderDepth: depth,
        groupKey,
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function sessionItem(id: string, groupKey: string, folderId: string | null, depth: number): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey,
        groupKind: folderId ? 'folder' : 'project',
        folderId,
        folderDepth: depth,
        workspace: workspaceA,
    };
}

/** Project with two root sessions and a folder. */
function items(): SessionListIndexItem[] {
    return [
        projectHeader(),
        folderHeader('folder-a', folderAGroupKey, 0),
        sessionItem('inside-a', folderAGroupKey, 'folder-a', 1),
        sessionItem('root-a', projectGroupKey, null, 0),
        sessionItem('root-b', projectGroupKey, null, 0),
    ];
}

function folders(): SessionFoldersV1 {
    return {
        v: 1,
        folders: [
            { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
            { id: 'folder-b', workspace: workspaceA, parentId: null, name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000002' },
        ],
    };
}

function makeContext(overrides?: Partial<Parameters<typeof commitSessionListDragIntent>[0]['context']>) {
    const setSessionFoldersV1 = vi.fn();
    const setSessionListGroupOrderV1 = vi.fn();
    const setSessionWorkspaceOrderV1 = vi.fn();
    const setSessionFolderAssignment = vi.fn(
        async (_assignment: Readonly<{ serverId: string; sessionId: string; folderId: string | null }>) => {},
    );
    return {
        context: {
            latestItems: items(),
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {},
            now: () => 100,
            setSessionFoldersV1,
            setSessionListGroupOrderV1,
            setSessionWorkspaceOrderV1,
            setSessionFolderAssignment,
            ...overrides,
        },
        spies: { setSessionFoldersV1, setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFolderAssignment },
    };
}

describe('commitSessionListDragIntent', () => {
    it('commits a valid reorder intent against the latest tree (moving root-b before root-a)', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result.ok).toBe(true);
        expect(spies.setSessionListGroupOrderV1).toHaveBeenCalledTimes(1);
    });

    it('blocks same-container session reorder intents in date ordering mode', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();
        const dateModeContext = {
            ...context,
            sessionListOrderingModeV1: 'updated' as const,
            sessionListSectionModeV1: 'activity' as const,
        };

        const result = await commitSessionListDragIntent({ intent, context: dateModeContext });

        expect(result).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('no-ops with source-missing when the dragged source vanished mid-drag', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'gone'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'source-missing' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('no-ops with container-missing when the destination container vanished mid-drag', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'nest-into',
            targetRowId: treeRowId.folder('gone'),
            containerId: treeRowId.folder('gone'),
            parentRowId: treeRowId.folder('gone'),
            depth: 1,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'container-missing' });
    });

    it('no-ops blocked/idle intents without mutating any state', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-b'),
            sourceKind: 'leaf',
            instructionKind: 'blocked',
            targetRowId: null,
            containerId: null,
            parentRowId: null,
            depth: null,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'blocked-intent' });
        expect(spies.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(spies.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('degrades a reorder whose target row vanished to a safe container-edge move', async () => {
        // root-a deleted mid-drag; the project container still survives.
        const latestItems: SessionListIndexItem[] = [
            projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            sessionItem('inside-a', folderAGroupKey, 'folder-a', 1),
            sessionItem('root-b', projectGroupKey, null, 0),
        ];
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.session('server-a', 'root-a'),
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            sourceSnapshotSignature: 'sig',
        };
        const { context } = makeContext({ latestItems });

        const result = await commitSessionListDragIntent({ intent, context });

        // The target row is gone but the container survives: the move still
        // applies (degraded to the container top edge), it does not no-op.
        expect(result.ok).toBe(true);
    });

    it('no-ops folder moves that would create a cycle against the latest tree', async () => {
        // folder-b nested under folder-a in the latest tree; moving folder-a into
        // folder-b would cycle.
        const latestItems: SessionListIndexItem[] = [
            projectHeader(),
            folderHeader('folder-a', folderAGroupKey, 0),
            folderHeader('folder-b', folderBGroupKey, 1),
        ];
        const cyclicFolders: SessionFoldersV1 = {
            v: 1,
            folders: [
                { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
                { id: 'folder-b', workspace: workspaceA, parentId: 'folder-a', name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000001' },
            ],
        };
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.folder('folder-a'),
            sourceKind: 'container',
            instructionKind: 'nest-into',
            targetRowId: treeRowId.folder('folder-b'),
            containerId: treeRowId.folder('folder-b'),
            parentRowId: treeRowId.folder('folder-b'),
            depth: 2,
            edge: null,
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext({ latestItems, sessionFoldersV1: cyclicFolders });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'descendant-cycle' });
        expect(spies.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('commits a move-to-root intent rebased onto the latest tree', async () => {
        // A session inside folder-a moves to the project root (move-to-root).
        // `../dev` carries the root placement on the intent `edge`.
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'move-to-root',
            targetRowId: null,
            containerId: treeRowId.workspaceRoot(projectGroupKey),
            parentRowId: null,
            depth: 0,
            edge: 'bottom',
            sourceSnapshotSignature: 'sig',
        };
        const { context, spies } = makeContext();

        const result = await commitSessionListDragIntent({ intent, context });

        // Moving the session out of folder-a to the project root persists both the
        // folder assignment change and the order update.
        expect(result.ok).toBe(true);
        expect(spies.setSessionFolderAssignment).toHaveBeenCalledTimes(1);
        expect(spies.setSessionFolderAssignment.mock.calls[0]?.[0]).toEqual({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
    });
});

describe('commitSessionListDragIntent — latest-tree rebuild', () => {
    it('rebuilds the latest tree once from latestItems (geometry-free)', () => {
        // Sanity: the commit's tree input is built without measured bounds.
        const tree = buildSessionListTreeRows({ items: items() });
        expect(tree.rows).toEqual([]);
        expect(tree.rowMetadataById.size).toBeGreaterThan(0);
    });
});
