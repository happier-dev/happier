import { describe, expect, it, vi } from 'vitest';

import type { WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
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
            'project-a': ['server-a:inside-a', 'folder:folder-a', 'folder:folder-b', 'server-a:root-a'],
        });
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

        expect(applied).toEqual({ ok: true });
        expect(setSessionFoldersV1).not.toHaveBeenCalled();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['folder:folder-a', 'folder:folder-b', 'server-a:root-a'],
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
