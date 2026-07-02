import { describe, expect, it } from 'vitest';

import type { WindowBounds, WindowPointer } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

import { buildSessionListDragSource } from '../buildSessionListDragSource';
import { buildSessionListTreeRows } from '../buildSessionListTreeRows';
import { resolveSessionListInstruction } from '../resolveSessionListInstruction';
import { treeRowId } from '../treeRowId';

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

function bounds(y: number): WindowBounds {
    return { x: 0, y, width: 320, height: 40 };
}

function pointer(y: number): WindowPointer {
    return { x: 160, y };
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
    storageKind?: 'persisted' | 'direct';
}>): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: params.id,
        serverId: 'server-a',
        storageKind: params.storageKind ?? 'persisted',
        groupKey: params.groupKey,
        groupKind: params.folderId ? 'folder' : 'project',
        folderId: params.folderId,
        folderDepth: params.depth,
        workspace: params.workspace,
    };
}

function mixedWorkspaceItems(): SessionListIndexItem[] {
    return [
        projectHeader('project-a', workspaceA),
        folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'child-a', groupKey: 'project-a:folder:child-a', depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
        projectHeader('project-b', workspaceB),
        folderHeader({ id: 'folder-c', groupKey: 'project-b:folder:folder-c', depth: 0, workspace: workspaceB }),
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

function buildTree(items = mixedWorkspaceItems()) {
    const rowBoundsById = new Map<string, WindowBounds>([
        [treeRowId.workspaceRoot('project-a'), bounds(0)],
        [treeRowId.folder('folder-a'), bounds(40)],
        [treeRowId.session('server-a', 'inside-a'), bounds(80)],
        [treeRowId.folder('child-a'), bounds(120)],
        [treeRowId.folder('folder-b'), bounds(160)],
        [treeRowId.session('server-a', 'root-a'), bounds(200)],
        [treeRowId.workspaceRoot('project-b'), bounds(300)],
        [treeRowId.folder('folder-c'), bounds(340)],
    ]);
    return buildSessionListTreeRows({
        items,
        rowBoundsById,
        dropZoneBounds: [
            {
                containerId: treeRowId.workspaceRoot('project-a'),
                role: 'root-after-last',
                bounds: { x: 0, y: 244, width: 320, height: 16 },
            },
        ],
    });
}

describe('resolveSessionListInstruction', () => {
    it('blocks direct sessions before resolving a target', () => {
        const items = [
            projectHeader('project-a', workspaceA),
            sessionItem({
                id: 'direct-a',
                groupKey: 'project-a',
                folderId: null,
                depth: 0,
                workspace: workspaceA,
                storageKind: 'direct',
            }),
            folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
        ];
        const tree = buildSessionListTreeRows({
            items,
            rowBoundsById: new Map([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.session('server-a', 'direct-a'), bounds(40)],
                [treeRowId.folder('folder-a'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'direct-a') }),
            pointer: pointer(100),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction.kind).toBe('blocked');
        expect(result.sessionListBlockReason).toBe('direct-session');
    });

    it('blocks all folder moves when the sessions.folders feature is disabled', () => {
        const tree = buildTree();

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(180),
            foldersFeatureEnabled: false,
        });

        expect(result.instruction.kind).toBe('blocked');
        expect(result.sessionListBlockReason).toBe('feature-disabled');
    });

    it('blocks cross-workspace drops', () => {
        const tree = buildTree();

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(360),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'blocked',
            reason: 'workspace-scope-mismatch',
            hintTargetId: treeRowId.folder('folder-c'),
        });
    });

    it('resolves a session drop into a sibling folder as a nest instruction', () => {
        const tree = buildTree();

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(180),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'nest-into',
            targetId: treeRowId.folder('folder-b'),
            containerId: treeRowId.folder('folder-b'),
            parentId: treeRowId.folder('folder-b'),
            depth: 1,
        });
        expect(result.visual).toEqual({ kind: 'outline', targetId: treeRowId.folder('folder-b') });
    });

    it('resolves a session drop onto workspace-root whitespace as a scoped root move', () => {
        const tree = buildTree();

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(250),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'move-to-root',
            containerId: treeRowId.workspaceRoot('project-a'),
            rootId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
        });
    });

    it('resolves workspace-root whitespace using implicit production drop zones', () => {
        const items = mixedWorkspaceItems();
        const tree = buildSessionListTreeRows({
            items,
            rowBoundsById: new Map<string, WindowBounds>([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.folder('folder-a'), bounds(40)],
                [treeRowId.session('server-a', 'inside-a'), bounds(80)],
                [treeRowId.folder('child-a'), bounds(120)],
                [treeRowId.folder('folder-b'), bounds(160)],
                [treeRowId.session('server-a', 'root-a'), bounds(200)],
                [treeRowId.workspaceRoot('project-b'), bounds(300)],
                [treeRowId.folder('folder-c'), bounds(340)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(250),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'move-to-root',
            containerId: treeRowId.workspaceRoot('project-a'),
            rootId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
        });
        expect(result.visual).toEqual({
            kind: 'line',
            targetId: treeRowId.workspaceRoot('project-a'),
            edge: 'bottom',
            depth: 0,
            dropZoneRole: 'root-after-last',
        });
    });

    it('resolves pinned session reordering within the pinned group', () => {
        const tree = buildSessionListTreeRows({
            items: pinnedItems(),
            rowBoundsById: new Map<string, WindowBounds>([
                [treeRowId.session('server-a', 'pinned-a'), bounds(40)],
                [treeRowId.session('server-a', 'pinned-b'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'pinned-a') }),
            pointer: pointer(82),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'reorder-before',
            targetId: treeRowId.session('server-a', 'pinned-b'),
            containerId: PINNED_GROUP_KEY_V1,
            parentId: null,
            depth: 0,
        });
        expect(result.visual).toEqual({
            kind: 'line',
            targetId: treeRowId.session('server-a', 'pinned-b'),
            edge: 'top',
            depth: 0,
        });
    });

    it('resolves whitespace after an expanded folder subtree as a root sibling insertion', () => {
        const tree = buildSessionListTreeRows({
            items: mixedWorkspaceItems(),
            rowBoundsById: new Map<string, WindowBounds>([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.folder('folder-a'), bounds(40)],
                [treeRowId.session('server-a', 'inside-a'), bounds(80)],
                [treeRowId.folder('child-a'), bounds(120)],
                [treeRowId.folder('folder-b'), bounds(170)],
                [treeRowId.session('server-a', 'root-a'), bounds(210)],
                [treeRowId.workspaceRoot('project-b'), bounds(300)],
                [treeRowId.folder('folder-c'), bounds(340)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(165),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'reorder-before',
            targetId: treeRowId.folder('folder-b'),
            containerId: treeRowId.workspaceRoot('project-a'),
            parentId: null,
            depth: 0,
        });
        expect(result.visual).toEqual({
            kind: 'line',
            targetId: treeRowId.folder('folder-b'),
            edge: 'top',
            depth: 0,
        });
    });

    it('blocks folder drops into descendants', () => {
        const tree = buildTree();

        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('folder-a') });
        expect(source.excludedDescendantIds.has(treeRowId.folder('child-a'))).toBe(true);

        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: pointer(140),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'blocked',
            reason: 'descendant-cycle',
            hintTargetId: treeRowId.folder('child-a'),
        });
    });
});
