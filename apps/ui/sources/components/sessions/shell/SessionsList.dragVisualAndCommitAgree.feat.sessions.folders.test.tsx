import { describe, expect, it, vi } from 'vitest';

import type { TreeDropResult, WindowBounds } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { applySessionListTreeDropOperation } from './commit/applySessionListTreeDropOperation';
import { buildSessionListDragSource } from './drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
import { resolveSessionListInstruction } from './drop-resolution/resolveSessionListInstruction';
import { treeRowId } from './drop-resolution/treeRowId';

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

const workspaceB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-b',
    rootPath: '/repo/b',
};
const projectAGroupKey = 'project-a';
const projectBGroupKey = 'project-b';
const rootAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:root';
const folderAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-a';
const childAGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:child-a';
const folderBGroupKey = 'folder:server-a:workspaceScope:server-a:machine-a:/repo/a:folder-b';
const folderCGroupKey = 'folder:server-a:workspaceScope:server-a:machine-b:/repo/b:folder-c';

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function projectHeader(groupKey: string, workspace: SessionFolderWorkspaceRefV1): Extract<SessionListIndexItem, { type: 'header' }> {
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

function folderHeader(params: Readonly<{
    id: string;
    groupKey: string;
    depth: number;
    workspace: SessionFolderWorkspaceRefV1;
}>): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: params.id,
        headerKind: 'folder',
        folderId: params.id,
        folderDepth: params.depth,
        groupKey: params.groupKey,
        workspace: params.workspace,
        serverId: 'server-a',
    };
}

function sessionItem(params: Readonly<{
    id: string;
    groupKey: string;
    folderId: string | null;
    depth: number;
    workspace: SessionFolderWorkspaceRefV1;
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
        workspace: params.workspace,
    };
}

function items(): SessionListIndexItem[] {
    return [
        projectHeader(projectAGroupKey, workspaceA),
        folderHeader({ id: 'folder-a', groupKey: folderAGroupKey, depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'inside-a', groupKey: folderAGroupKey, folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'child-a', groupKey: childAGroupKey, depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'folder-b', groupKey: folderBGroupKey, depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'root-a', groupKey: rootAGroupKey, folderId: null, depth: 0, workspace: workspaceA }),
        projectHeader(projectBGroupKey, workspaceB),
        folderHeader({ id: 'folder-c', groupKey: folderCGroupKey, depth: 0, workspace: workspaceB }),
    ];
}

function folders(): SessionFoldersV1 {
    return {
        v: 1,
        folders: [
            { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
            { id: 'child-a', workspace: workspaceA, parentId: 'folder-a', name: 'A child', createdAt: 2, updatedAt: 2, sortKey: '000001' },
            { id: 'folder-b', workspace: workspaceA, parentId: null, name: 'B', createdAt: 3, updatedAt: 3, sortKey: '000002' },
            { id: 'folder-c', workspace: workspaceB, parentId: null, name: 'C', createdAt: 4, updatedAt: 4, sortKey: '000001' },
        ],
    };
}

function buildTree() {
    return buildSessionListTreeRows({
        items: items(),
        rowBoundsById: new Map([
            [treeRowId.workspaceRoot(projectAGroupKey), bounds(0)],
            [treeRowId.folder('folder-a'), bounds(40)],
            [treeRowId.session('server-a', 'inside-a'), bounds(80)],
            [treeRowId.folder('child-a'), bounds(120)],
            [treeRowId.folder('folder-b'), bounds(160)],
            [treeRowId.session('server-a', 'root-a'), bounds(200)],
            [treeRowId.workspaceRoot(projectBGroupKey), bounds(300)],
            [treeRowId.folder('folder-c'), bounds(340)],
        ]),
        dropZoneBounds: [
            {
                containerId: treeRowId.workspaceRoot(projectAGroupKey),
                role: 'root-before-first',
                bounds: { x: 0, y: 20, width: 320, height: 16 },
            },
            {
                containerId: treeRowId.workspaceRoot(projectAGroupKey),
                role: 'root-after-last',
                bounds: { x: 0, y: 244, width: 320, height: 16 },
            },
            {
                containerId: treeRowId.folder('folder-b'),
                role: 'container-body',
                bounds: { x: 0, y: 164, width: 320, height: 24 },
            },
        ],
    });
}

function expectVisualToMatchInstruction(result: TreeDropResult): void {
    const { instruction, visual } = result;
    if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
        expect(visual).toEqual({
            kind: 'line',
            targetId: instruction.targetId,
            edge: instruction.kind === 'reorder-before' ? 'top' : 'bottom',
            depth: instruction.depth,
        });
        return;
    }
    if (instruction.kind === 'nest-into') {
        expect(visual).toEqual({ kind: 'outline', targetId: instruction.targetId });
        return;
    }
    if (instruction.kind === 'move-to-root') {
        expect(visual.kind).not.toBe('outline');
        if (visual.kind === 'line') {
            expect(visual.targetId).toBe(instruction.containerId);
            expect(visual.depth).toBe(instruction.depth);
        }
        return;
    }
    expect(visual).toEqual({ kind: 'none' });
}

describe('SessionsList drag result consistency', () => {
    it.each([
        {
            name: 'session into sibling folder',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 180,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: 'folder-b' },
            expectedOrder: { [folderBGroupKey]: ['server-a:inside-a'] },
        },
        {
            name: 'session out to workspace root',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 250,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: null },
            expectedOrder: { [rootAGroupKey]: ['server-a:root-a', 'server-a:inside-a'] },
        },
        {
            name: 'session out to exact mixed workspace root position',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 250,
            sessionListFolderSortModeV1: 'mixed' as const,
            expectedAssignment: { serverId: 'server-a', sessionId: 'inside-a', folderId: null },
            expectedOrder: { [rootAGroupKey]: ['folder:folder-a', 'folder:folder-b', 'server-a:root-a', 'server-a:inside-a'] },
        },
        {
            name: 'folder around root sessions',
            sourceRowId: treeRowId.folder('folder-b'),
            y: 204,
            expectedOrder: { [rootAGroupKey]: ['folder:folder-b', 'folder:folder-a'] },
        },
        {
            name: 'folder around root sessions in exact mixed position',
            sourceRowId: treeRowId.folder('folder-b'),
            y: 204,
            sessionListFolderSortModeV1: 'mixed' as const,
            expectedOrder: { [rootAGroupKey]: ['folder:folder-a', 'folder:folder-b', 'server-a:root-a'] },
        },
        {
            name: 'blocked descendant folder target',
            sourceRowId: treeRowId.folder('folder-a'),
            y: 140,
            expectedBlocked: true,
        },
        {
            name: 'blocked cross-workspace target',
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            y: 360,
            expectedBlocked: true,
        },
    ])('uses one result for $name', async (scenario) => {
        const tree = buildTree();
        const source = buildSessionListDragSource({ tree, sourceRowId: scenario.sourceRowId });
        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: { x: 160, y: scenario.y },
            foldersFeatureEnabled: true,
        });

        expectVisualToMatchInstruction(result);

        const setSessionFolderAssignment = vi.fn(async () => undefined);
        const setSessionFoldersV1 = vi.fn();
        const setSessionListGroupOrderV1 = vi.fn();

        const applied = await applySessionListTreeDropOperation({
            tree,
            source,
            result,
            context: {
                sessionFoldersV1: folders(),
                sessionListGroupOrderV1: {},
                sessionListFolderSortModeV1: scenario.sessionListFolderSortModeV1,
                now: () => 100,
                setSessionFoldersV1,
                setSessionListGroupOrderV1,
                setSessionFolderAssignment,
            },
        });

        if (scenario.expectedBlocked) {
            expect(applied.ok).toBe(false);
            expect(setSessionFolderAssignment).not.toHaveBeenCalled();
            expect(setSessionFoldersV1).not.toHaveBeenCalled();
            expect(setSessionListGroupOrderV1).not.toHaveBeenCalled();
            return;
        }

        expect(applied.ok).toBe(true);
        if (scenario.expectedAssignment) {
            expect(setSessionFolderAssignment).toHaveBeenCalledWith(scenario.expectedAssignment);
        }
        if (scenario.expectedOrder) {
            expect(setSessionListGroupOrderV1).toHaveBeenCalledWith(scenario.expectedOrder);
        }
    });
});
