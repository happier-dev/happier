import { describe, expect, it, vi } from 'vitest';

import type { WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { applySessionListTreeDropOperation } from '../applySessionListTreeDropOperation';
import { buildSessionListTreeRows } from '../../drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from '../../drop-resolution/resolveSessionListInstruction';
import { buildSessionListDragSource } from '../../drop-resolution/buildSessionListDragSource';
import { treeRowId } from '../../drop-resolution/treeRowId';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};
const workspaceB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/b',
};
const projectGroupKey = 'project-a';
const projectBGroupKey = 'project-b';
const rootFolderGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:root';
const folderAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a';
const childAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:child-a';
const folderBGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-b';

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function projectHeader(groupKey: string, workspace: SessionFolderWorkspaceRefV1 = workspaceA): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: groupKey,
        headerKind: 'project',
        groupKey,
        workspaceKey: groupKey,
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
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function sessionItem(params: Readonly<{
    id: string;
    groupKey: string;
    folderId: string | null;
    depth: number;
}>): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: params.id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: params.groupKey,
        groupKind: params.folderId ? 'folder' : 'project',
        folderId: params.folderId,
        folderDepth: params.depth,
        workspace: workspaceA,
    };
}

function items(): SessionListIndexItem[] {
    return [
        projectHeader(projectGroupKey),
        folderHeader({ id: 'folder-a', groupKey: folderAGroupKey, depth: 0 }),
        sessionItem({ id: 'inside-a', groupKey: folderAGroupKey, folderId: 'folder-a', depth: 1 }),
        folderHeader({ id: 'child-a', groupKey: childAGroupKey, depth: 1 }),
        folderHeader({ id: 'folder-b', groupKey: folderBGroupKey, depth: 0 }),
        sessionItem({ id: 'root-a', groupKey: rootFolderGroupKey, folderId: null, depth: 0 }),
    ];
}

function rootSessionItems(): SessionListIndexItem[] {
    return [
        projectHeader(projectGroupKey),
        sessionItem({ id: 'root-a', groupKey: rootFolderGroupKey, folderId: null, depth: 0 }),
        sessionItem({ id: 'root-b', groupKey: rootFolderGroupKey, folderId: null, depth: 0 }),
    ];
}

function folders(): SessionFoldersV1 {
    return {
        v: 1,
        folders: [
            { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
            { id: 'child-a', workspace: workspaceA, parentId: 'folder-a', name: 'A child', createdAt: 2, updatedAt: 2, sortKey: '000001' },
            { id: 'folder-b', workspace: workspaceA, parentId: null, name: 'B', createdAt: 3, updatedAt: 3, sortKey: '000002' },
        ],
    };
}

function buildTree() {
    return buildSessionListTreeRows({
        items: items(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot(projectGroupKey), bounds(0)],
            [treeRowId.folder('folder-a'), bounds(40)],
            [treeRowId.session('server-a', 'inside-a'), bounds(80)],
            [treeRowId.folder('child-a'), bounds(120)],
            [treeRowId.folder('folder-b'), bounds(160)],
            [treeRowId.session('server-a', 'root-a'), bounds(200)],
        ]),
        dropZoneBounds: [
            {
                containerId: treeRowId.workspaceRoot(projectGroupKey),
                role: 'root-after-last',
                bounds: { x: 0, y: 244, width: 320, height: 16 },
            },
        ],
    });
}

function buildRootSessionTree() {
    return buildSessionListTreeRows({
        items: rootSessionItems(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot(projectGroupKey), bounds(0)],
            [treeRowId.session('server-a', 'root-a'), bounds(40)],
            [treeRowId.session('server-a', 'root-b'), bounds(80)],
        ]),
    });
}

function buildTwoWorkspaceTree() {
    return buildSessionListTreeRows({
        items: [
            projectHeader(projectGroupKey, workspaceA),
            sessionItem({ id: 'root-a', groupKey: rootFolderGroupKey, folderId: null, depth: 0 }),
            projectHeader(projectBGroupKey, workspaceB),
        ],
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot(projectGroupKey), bounds(0)],
            [treeRowId.session('server-a', 'root-a'), bounds(40)],
            [treeRowId.workspaceRoot(projectBGroupKey), bounds(100)],
        ]),
    });
}

function pinnedItems(): SessionListIndexItem[] {
    return [
        { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 },
        {
            type: 'session',
            sessionId: 'pinned-a',
            serverId: 'server-a',
            storageKind: 'persisted',
            groupKey: PINNED_GROUP_KEY_V1,
            groupKind: 'pinned',
            pinned: true,
        },
        {
            type: 'session',
            sessionId: 'pinned-b',
            serverId: 'server-a',
            storageKind: 'persisted',
            groupKey: PINNED_GROUP_KEY_V1,
            groupKind: 'pinned',
            pinned: true,
        },
    ];
}

function buildPinnedTree() {
    return buildSessionListTreeRows({
        items: pinnedItems(),
        rowBoundsById: new Map([
            [treeRowId.session('server-a', 'pinned-a'), bounds(40)],
            [treeRowId.session('server-a', 'pinned-b'), bounds(80)],
        ]),
    });
}

function resolveDrop(params: Readonly<{ sourceRowId: string; y: number }>) {
    const tree = buildTree();
    return {
        tree,
        source: buildSessionListDragSource({ tree, sourceRowId: params.sourceRowId }),
        result: resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: params.sourceRowId }),
            pointer: { x: 160, y: params.y },
            foldersFeatureEnabled: true,
        }),
    };
}

describe('applySessionListTreeDropOperation', () => {
    it('blocks same-container session sibling reorder in updated mode without mutating order', async () => {
        const tree = buildRootSessionTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'root-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 42 },
            foldersFeatureEnabled: true,
        });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: { [rootFolderGroupKey]: ['server-a:root-a', 'server-a:root-b'] },
                sessionListOrderingModeV1: 'updated',
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        expect(applied).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('awaits session folder assignment before writing destination group order', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 180,
        });
        let assignmentCompleted = false;
        const setSessionListGroupOrderV1 = vi.fn(() => {
            expect(assignmentCompleted).toBe(true);
        });

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async (params) => {
                    expect(params).toEqual({
                        serverId: 'server-a',
                        sessionId: 'inside-a',
                        folderId: 'folder-b',
                    });
                    assignmentCompleted = true;
                }),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [folderBGroupKey]: ['server-a:inside-a'],
        });
    });

    it('moves a session out to the workspace root session band by default', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 250,
        });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();
        expect(tree.containerMetadataById.get(treeRowId.workspaceRoot(projectGroupKey))?.groupKey)
            .toBe(rootFolderGroupKey);

        await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['server-a:root-a', 'server-a:inside-a'],
        });
    });

    it('moves a session out to exact mixed sibling position when mixed folder sort is selected', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 250,
        });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();

        await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionListFolderSortModeV1: 'mixed',
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['folder:folder-a', 'folder:folder-b', 'server-a:root-a', 'server-a:inside-a'],
        });
    });

    it('moves a root session before a root folder when mixed folder sort is selected', async () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'root-a') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 42 },
            foldersFeatureEnabled: true,
        });
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionListFolderSortModeV1: 'mixed',
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['server-a:root-a', 'folder:folder-a', 'folder:folder-b'],
        });
    });

    it('commits pinned session reordering to the pinned group order without folder assignment', async () => {
        const tree = buildPinnedTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'pinned-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 42 },
            foldersFeatureEnabled: true,
        });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();

        await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [PINNED_GROUP_KEY_V1]: ['server-a:pinned-b', 'server-a:pinned-a'],
        });
    });

    it('moves a folder within the root folder band by default', async () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('folder-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 204 },
            foldersFeatureEnabled: true,
        });
        const setSessionFoldersV1 = vi.fn();
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                setSessionFoldersV1,
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['folder:folder-b', 'folder:folder-a'],
        });
    });

    it('moves a folder around root sessions when mixed folder sort is selected', async () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('folder-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 204 },
            foldersFeatureEnabled: true,
        });
        const setSessionFoldersV1 = vi.fn();
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionListFolderSortModeV1: 'mixed',
                now: () => 100,
                setSessionFoldersV1,
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['folder:folder-a', 'folder:folder-b', 'server-a:root-a'],
        });
    });

    it('uses folders-first structural order for folder moves when date ordering makes mixed dormant', async () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('folder-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 204 },
            foldersFeatureEnabled: true,
        });
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionListFolderSortModeV1: 'mixed',
                sessionListOrderingModeV1: 'updated',
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [rootFolderGroupKey]: ['folder:folder-b', 'folder:folder-a'],
        });
    });

    it('does not commit blocked instructions', async () => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('folder-a') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 140 },
            foldersFeatureEnabled: true,
        });
        expect(result.instruction.kind).toBe('blocked');

        const setSessionFoldersV1 = vi.fn();
        const setSessionListGroupOrderV1 = vi.fn();
        const setSessionFolderAssignment = vi.fn(async () => undefined);

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                setSessionFoldersV1,
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        expect(applied.ok).toBe(false);
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
    });

    it('commits workspace header reordering into workspace order settings', async () => {
        const tree = buildTwoWorkspaceTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.workspaceRoot(projectBGroupKey) });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 4 },
            foldersFeatureEnabled: true,
        });
        const setSessionWorkspaceOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionWorkspaceOrderV1: {},
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1: vi.fn(),
                setSessionWorkspaceOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true });
        expect(setSessionWorkspaceOrderV1).toHaveBeenCalledWith({
            'server:server-a:workspaces': ['workspace:project-b', 'workspace:project-a'],
        });
    });
});
