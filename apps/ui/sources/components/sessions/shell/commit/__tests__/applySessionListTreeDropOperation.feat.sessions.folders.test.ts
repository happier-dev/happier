import { describe, expect, it, vi } from 'vitest';

import type { WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { applySessionListTreeDropOperation } from '../applySessionListTreeDropOperation';
import { buildSessionListTreeRows } from '../../drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from '../../drop-resolution/resolveSessionListInstruction';
import { buildSessionListDragSource } from '../../drop-resolution/buildSessionListDragSource';
import { treeRowId } from '../../drop-resolution/treeRowId';
import { buildSessionListKeyboardMoveResult } from '../../move-sheet/buildSessionListKeyboardMoveResult';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function projectHeader(groupKey: string): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: groupKey,
        headerKind: 'project',
        groupKey,
        workspaceKey: groupKey,
        workspace: workspaceA,
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
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'attention' | 'working' | 'shared' | 'folder';
    section?: 'active' | 'inactive';
}>): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: params.id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: params.groupKey,
        groupKind: params.groupKind ?? (params.folderId ? 'folder' : 'project'),
        folderId: params.folderId,
        folderDepth: params.depth,
        workspace: workspaceA,
        section: params.section,
    };
}

function items(): SessionListIndexItem[] {
    return [
        projectHeader('project-a'),
        folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0 }),
        sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1 }),
        folderHeader({ id: 'child-a', groupKey: 'project-a:folder:child-a', depth: 1 }),
        folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 0 }),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0 }),
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
            [treeRowId.workspaceRoot('project-a'), bounds(0)],
            [treeRowId.folder('folder-a'), bounds(40)],
            [treeRowId.session('server-a', 'inside-a'), bounds(80)],
            [treeRowId.folder('child-a'), bounds(120)],
            [treeRowId.folder('folder-b'), bounds(160)],
            [treeRowId.session('server-a', 'root-a'), bounds(200)],
        ]),
        dropZoneBounds: [
            {
                containerId: treeRowId.workspaceRoot('project-a'),
                role: 'root-after-last',
                bounds: { x: 0, y: 244, width: 320, height: 16 },
            },
        ],
    });
}

function twoWorkspaceItems(): SessionListIndexItem[] {
    return [
        projectHeader('project-a'),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0 }),
        projectHeader('project-b'),
        sessionItem({ id: 'root-b', groupKey: 'project-b', folderId: null, depth: 0 }),
    ];
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

function buildTwoWorkspaceTree() {
    return buildSessionListTreeRows({
        items: twoWorkspaceItems(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot('project-a'), bounds(0)],
            [treeRowId.session('server-a', 'root-a'), bounds(40)],
            [treeRowId.workspaceRoot('project-b'), bounds(80)],
            [treeRowId.session('server-a', 'root-b'), bounds(120)],
        ]),
    });
}

function rootSessionItems(): SessionListIndexItem[] {
    return [
        projectHeader('project-a'),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0 }),
        sessionItem({ id: 'root-b', groupKey: 'project-a', folderId: null, depth: 0 }),
    ];
}

function inactiveDateItems(): SessionListIndexItem[] {
    return [
        { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'inactive:date:2026-05-26' },
        sessionItem({
            id: 'inactive-a',
            groupKey: 'inactive:date:2026-05-26',
            folderId: null,
            depth: 0,
            groupKind: 'date',
            section: 'inactive',
        }),
        sessionItem({
            id: 'inactive-b',
            groupKey: 'inactive:date:2026-05-26',
            folderId: null,
            depth: 0,
            groupKind: 'date',
            section: 'inactive',
        }),
    ];
}

function buildRootSessionTree() {
    return buildSessionListTreeRows({
        items: rootSessionItems(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot('project-a'), bounds(0)],
            [treeRowId.session('server-a', 'root-a'), bounds(40)],
            [treeRowId.session('server-a', 'root-b'), bounds(80)],
        ]),
    });
}

function buildInactiveDateTree() {
    return buildSessionListTreeRows({
        items: inactiveDateItems(),
        rowBoundsById: new Map([
            [treeRowId.session('server-a', 'inactive-a'), bounds(40)],
            [treeRowId.session('server-a', 'inactive-b'), bounds(80)],
        ]),
    });
}

function resolveRootSessionSiblingDrop(params: Readonly<{ orderingMode?: 'custom' | 'created' | 'updated' }> = {}) {
    const tree = buildRootSessionTree();
    const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'root-b') });
    return {
        tree,
        source,
        result: resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 42 },
            foldersFeatureEnabled: true,
        }),
        orderingMode: params.orderingMode ?? 'custom',
    };
}

function resolveDrop(params: Readonly<{ sourceRowId: string; y: number; folderSortMode?: 'foldersFirst' | 'mixed' }>) {
    const tree = buildTree();
    return {
        tree,
        source: buildSessionListDragSource({ tree, sourceRowId: params.sourceRowId }),
        result: resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: params.sourceRowId }),
            pointer: { x: 160, y: params.y },
            foldersFeatureEnabled: true,
            folderSortMode: params.folderSortMode,
        }),
    };
}

describe('applySessionListTreeDropOperation', () => {
    it('reorders pinned sessions without changing their folder assignment', async () => {
        const tree = buildSessionListTreeRows({ items: [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 },
            sessionItem({ id: 'first', groupKey: PINNED_GROUP_KEY_V1, folderId: null, depth: 0, groupKind: 'pinned' }),
            sessionItem({ id: 'second', groupKey: PINNED_GROUP_KEY_V1, folderId: 'folder-a', depth: 1, groupKind: 'pinned' }),
        ] });
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'second') });
        const result = buildSessionListKeyboardMoveResult({ tree, source, direction: 'up' });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();
        const applied = await applySessionListTreeDropOperation({ tree, source, result, context: {
            sessionFoldersV1: folders(), sessionListGroupOrderV1: {}, now: () => 100,
            setSessionFoldersV1: vi.fn(), setSessionListGroupOrderV1, setSessionFolderAssignment,
        } });
        expect(applied.ok).toBe(true);
        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [PINNED_GROUP_KEY_V1]: ['server-a:second', 'server-a:first'],
        });
    });

    it('commits same-container session sibling reorder in custom mode', async () => {
        const { tree, source, result } = resolveRootSessionSiblingDrop();
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();

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
                setSessionFolderAssignment,
            },
        });

        expect(applied).toEqual({ ok: true, operationKind: 'sessionSiblingReorder' });
        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['server-a:root-b', 'server-a:root-a'],
        });
    });

    it('blocks same-container session sibling reorder in created mode without mutating order', async () => {
        const { tree, source, result } = resolveRootSessionSiblingDrop({ orderingMode: 'created' });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();
        const context = {
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: { 'project-a': ['server-a:root-a', 'server-a:root-b'] },
            sessionListOrderingModeV1: 'created' as const,
            now: () => 100,
            setSessionFoldersV1: vi.fn(),
            setSessionListGroupOrderV1,
            setSessionFolderAssignment,
        };

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context,
        });

        expect(applied).toEqual({
            ok: false,
            reason: 'date-ordering-mode',
            operationKind: 'sessionSiblingReorder',
        });
        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('blocks same-container session sibling reorder in updated mode without mutating order', async () => {
        const { tree, source, result } = resolveRootSessionSiblingDrop({ orderingMode: 'updated' });
        const setSessionListGroupOrderV1 = vi.fn();
        const context = {
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: { 'project-a': ['server-a:root-a', 'server-a:root-b'] },
            sessionListOrderingModeV1: 'updated' as const,
            now: () => 100,
            setSessionFoldersV1: vi.fn(),
            setSessionListGroupOrderV1,
            setSessionFolderAssignment: vi.fn(async () => undefined),
        };

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context,
        });

        expect(applied).toEqual({
            ok: false,
            reason: 'date-ordering-mode',
            operationKind: 'sessionSiblingReorder',
        });
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('blocks inactive date-group session sibling reorder even when user mode is custom', async () => {
        const tree = buildInactiveDateTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inactive-b') });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: 42 },
            foldersFeatureEnabled: true,
        });
        const setSessionListGroupOrderV1 = vi.fn();
        const context = {
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: { 'inactive:date:2026-05-26': ['server-a:inactive-a', 'server-a:inactive-b'] },
            sessionListOrderingModeV1: 'custom' as const,
            sessionListSectionModeV1: 'activity' as const,
            now: () => 100,
            setSessionFoldersV1: vi.fn(),
            setSessionListGroupOrderV1,
            setSessionFolderAssignment: vi.fn(async () => undefined),
        };

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context,
        });

        expect(applied).toEqual({
            ok: false,
            reason: 'date-ordering-mode',
            operationKind: 'sessionSiblingReorder',
        });
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('commits a session dropped before root folders to the top of the root session band', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 45,
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

        expect(setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['folder:folder-a', 'folder:folder-b', 'server-a:inside-a', 'server-a:root-a'],
        });
    });

    it('commits exact session and folder interleaving in mixed mode', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 45,
            folderSortMode: 'mixed',
        });
        const setSessionListGroupOrderV1 = vi.fn();

        await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                now: () => 100,
                folderSortMode: 'mixed',
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['server-a:inside-a', 'folder:folder-a', 'folder:folder-b', 'server-a:root-a'],
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

        expect(applied).toEqual({ ok: true, operationKind: 'sessionContainerContainmentMove' });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a:folder:folder-b': ['server-a:inside-a'],
        });
    });

    it('moves a session out to the workspace root and clears its folder assignment', async () => {
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
            'project-a': ['folder:folder-a', 'folder:folder-b', 'server-a:root-a', 'server-a:inside-a'],
        });
    });

    it('moves a session to a different container in date mode without writing manual session rank', async () => {
        const { tree, source, result } = resolveDrop({
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 250,
        });
        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionListGroupOrderV1 = vi.fn();
        const context = {
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'updated' as const,
            now: () => 100,
            setSessionFoldersV1: vi.fn(),
            setSessionListGroupOrderV1,
            setSessionFolderAssignment,
        };

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context,
        });

        expect(applied).toEqual({ ok: true, operationKind: 'sessionContainerContainmentMove' });
        expect(setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('moves a folder around root sessions through the same operation path', async () => {
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

        expect(applied).toEqual({ ok: true, operationKind: 'folderSiblingReorder' });
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['folder:folder-a', 'folder:folder-b', 'server-a:root-a'],
        });
    });

    it('reorders folder siblings in date mode using structural folder keys only', async () => {
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
        const context = {
            sessionFoldersV1: folders(),
            sessionListGroupOrderV1: {},
            sessionListOrderingModeV1: 'created' as const,
            now: () => 100,
            setSessionFoldersV1,
            setSessionListGroupOrderV1,
            setSessionFolderAssignment: vi.fn(async () => undefined),
        };

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context,
        });

        expect(applied).toEqual({ ok: true, operationKind: 'folderSiblingReorder' });
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['folder:folder-a', 'folder:folder-b'],
        });
    });

    it('preserves dormant session order keys while writing folder structural order in date mode', async () => {
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
                sessionListGroupOrderV1: {
                    'project-a': [
                        'server-a:dormant-root',
                        'folder:folder-b',
                        'server-a:dormant-missing',
                        'folder:folder-a',
                    ],
                },
                sessionListOrderingModeV1: 'updated' as const,
                now: () => 100,
                setSessionFoldersV1: vi.fn(),
                setSessionListGroupOrderV1,
                setSessionFolderAssignment: vi.fn(async () => undefined),
            },
        });

        expect(applied).toEqual({ ok: true, operationKind: 'folderSiblingReorder' });
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': [
                'server-a:dormant-root',
                'folder:folder-a',
                'server-a:dormant-missing',
                'folder:folder-b',
            ],
        });
    });

    it('commits workspace header reordering to the workspace order map', async () => {
        const tree = buildTwoWorkspaceTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.workspaceRoot('project-b') });
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

        expect(applied).toEqual({ ok: true, operationKind: 'workspaceStructuralReorder' });
        expect(setSessionWorkspaceOrderV1).toHaveBeenCalledWith({
            'server:server-a:workspaces': ['workspace:project-b', 'workspace:project-a'],
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
});
