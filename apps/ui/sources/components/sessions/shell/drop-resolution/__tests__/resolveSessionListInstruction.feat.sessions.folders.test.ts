import { describe, expect, it } from 'vitest';

import type { WindowBounds, WindowPointer } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

import { buildSessionListDragSource } from '../buildSessionListDragSource';
import { buildSessionListTreeRows } from '../buildSessionListTreeRows';
import { resolveSessionListInstruction } from '../resolveSessionListInstruction';
import { treeRowId } from '../treeRowId';
import { isSessionTreeRowId } from '../treeRowId';

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
            workspace: workspaceA,
        },
        {
            type: 'session',
            sessionId: 'pinned-b',
            serverId: 'server-a',
            storageKind: 'persisted',
            groupKey: PINNED_GROUP_KEY_V1,
            groupKind: 'pinned',
            pinned: true,
            workspace: workspaceA,
        },
    ];
}

function buildTree(items = mixedWorkspaceItems()) {
    const rowBoundsById = new Map<string, WindowBounds>([
        [treeRowId.workspaceRoot('project-a'), bounds(0)],
        [treeRowId.folder('server-a', 'folder-a'), bounds(40)],
        [treeRowId.session('server-a', 'inside-a'), bounds(80)],
        [treeRowId.folder('server-a', 'child-a'), bounds(120)],
        [treeRowId.folder('server-a', 'folder-b'), bounds(160)],
        [treeRowId.session('server-a', 'root-a'), bounds(200)],
        [treeRowId.workspaceRoot('project-b'), bounds(300)],
        [treeRowId.folder('server-a', 'folder-c'), bounds(340)],
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
    it('keeps mirror geometry separate while drag metadata retains one Session address', () => {
        const base = sessionItem({ id: 'mirrored', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA });
        const shelf = { ...base, occurrenceRole: 'needsYou' as const, groupKey: 'attention' };
        const baseId = treeRowId.session('server-a', 'mirrored');
        const shelfId = treeRowId.session('server-a', 'mirrored', undefined, 'needsYou');
        const tree = buildSessionListTreeRows({
            items: [projectHeader('attention', workspaceA), shelf, projectHeader('project-a', workspaceA), base],
            rowBoundsById: new Map([[shelfId, bounds(40)], [baseId, bounds(160)]]),
        });
        const sessionRows = [...tree.rowMetadataById.values()].filter(item => item.kind === 'session');
        expect(sessionRows).toHaveLength(2);
        expect(tree.rows.filter(item => isSessionTreeRowId(item.id)).map(item => item.bounds.y)).toEqual([40, 160]);
        expect(sessionRows.map(item => [item.serverId, item.sessionId])).toEqual([
            ['server-a', 'mirrored'], ['server-a', 'mirrored'],
        ]);
        expect(buildSessionListDragSource({ tree, sourceRowId: shelfId }).metadata).toMatchObject({ serverId: 'server-a', sessionId: 'mirrored' });
    });

    it('keeps delimiter-bearing qualified Session tree rows distinct', () => {
        const first = treeRowId.session('https://home.example/a', 'b:c');
        const second = treeRowId.session('https://home.example/a:b', 'c');

        expect(first).not.toBe(second);
    });

    it('keeps equal Home-local folder ids distinct across Homes in the live drag tree', () => {
        const workspaceB = {
            ...workspaceA,
            serverId: 'server-b',
            rootPath: '/repo-b',
        } as const;
        const tree = buildSessionListTreeRows({
            items: [
                projectHeader('project-a', workspaceA),
                folderHeader({ id: 'same-folder', groupKey: 'project-a:folder:same-folder', depth: 0, workspace: workspaceA }),
                projectHeader('project-b', workspaceB),
                {
                    ...folderHeader({ id: 'same-folder', groupKey: 'project-b:folder:same-folder', depth: 0, workspace: workspaceB }),
                    serverId: 'server-b',
                },
            ],
        });
        const folderRows = [...tree.rowMetadataById.values()]
            .filter((metadata) => metadata.kind === 'folder');

        expect(folderRows).toHaveLength(2);
        expect(new Set(folderRows.map((metadata) => metadata.rowId)).size).toBe(2);
        expect(folderRows.map((metadata) => metadata.serverId)).toEqual(['server-a', 'server-b']);
        expect(new Set(folderRows.map((metadata) => metadata.orderKey)).size).toBe(2);
    });

    it('moves external and persisted sessions through the same folder instruction owner', () => {
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
                [treeRowId.folder('server-a', 'folder-a'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'direct-a') }),
            pointer: pointer(100),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toMatchObject({
            kind: 'nest-into',
            targetId: treeRowId.folder('server-a', 'folder-a'),
        });
        expect(result.sessionListBlockReason).toBeUndefined();
    });

    it('puts a Session under another Session on a middle drop, independent of folders and ordering', () => {
        const items = [
            projectHeader('project-a', workspaceA),
            sessionItem({ id: 'lead-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
            sessionItem({ id: 'worker-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
        ];
        const tree = buildSessionListTreeRows({
            items,
            rowBoundsById: new Map([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.session('server-a', 'lead-a'), bounds(40)],
                [treeRowId.session('server-a', 'worker-a'), bounds(80)],
            ]),
        });
        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'worker-a') });
        const resolve = (y: number, canPutSessionUnder?: (sessionId: string, managerSessionId: string) => boolean) => resolveSessionListInstruction({
            tree,
            source,
            pointer: pointer(y),
            foldersFeatureEnabled: false,
            canReorderSessionSiblings: false,
            ...(canPutSessionUnder ? { canPutSessionUnder } : {}),
        });
        const onlyUnderLead = (sessionId: string, managerSessionId: string) => sessionId === 'worker-a' && managerSessionId === 'lead-a';

        const underLead = resolve(60, onlyUnderLead);
        expect(underLead.instruction).toMatchObject({
            kind: 'nest-into',
            targetId: treeRowId.session('server-a', 'lead-a'),
        });
        expect(underLead.visual).toEqual({ kind: 'outline', targetId: treeRowId.session('server-a', 'lead-a') });
        expect(underLead.sessionListBlockReason).toBeUndefined();

        // The edges still mean reorder, which this layout does not allow.
        expect(resolve(42, onlyUnderLead).instruction.kind).toBe('blocked');
        // Without the manager rule a Session row is never a drop target.
        expect(resolve(60).instruction.kind).toBe('blocked');
        expect(resolve(60, () => false).instruction.kind).toBe('blocked');
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

    it('keeps same-container custom session reorder available without a durable folder scope', () => {
        const items: SessionListIndexItem[] = [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: PINNED_GROUP_KEY_V1 },
            {
                type: 'session',
                sessionId: 'unscoped-a',
                serverId: 'server-a',
                storageKind: 'persisted',
                groupKey: PINNED_GROUP_KEY_V1,
                groupKind: 'pinned',
                pinned: true,
            },
            {
                type: 'session',
                sessionId: 'unscoped-b',
                serverId: 'server-a',
                storageKind: 'persisted',
                groupKey: PINNED_GROUP_KEY_V1,
                groupKind: 'pinned',
                pinned: true,
            },
        ];
        const tree = buildSessionListTreeRows({
            items,
            rowBoundsById: new Map([
                [treeRowId.session('server-a', 'unscoped-a'), bounds(40)],
                [treeRowId.session('server-a', 'unscoped-b'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({
                tree,
                sourceRowId: treeRowId.session('server-a', 'unscoped-a'),
            }),
            pointer: pointer(90),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toMatchObject({
            kind: 'reorder-before',
            targetId: treeRowId.session('server-a', 'unscoped-b'),
        });
        expect(result.sessionListBlockReason).toBeUndefined();
    });

    it('keeps same-container custom session reorder available when folders are disabled', () => {
        const tree = buildSessionListTreeRows({
            items: pinnedItems(),
            rowBoundsById: new Map([
                [treeRowId.session('server-a', 'pinned-a'), bounds(40)],
                [treeRowId.session('server-a', 'pinned-b'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({
                tree,
                sourceRowId: treeRowId.session('server-a', 'pinned-a'),
            }),
            pointer: pointer(90),
            foldersFeatureEnabled: false,
        });

        expect(result.instruction).toMatchObject({
            kind: 'reorder-before',
            targetId: treeRowId.session('server-a', 'pinned-b'),
        });
        expect(result.sessionListBlockReason).toBeUndefined();
    });

    it('blocks an ineligible sibling reorder without blocking valid folder containment', () => {
        const pinnedTree = buildSessionListTreeRows({
            items: pinnedItems(),
            rowBoundsById: new Map([
                [treeRowId.session('server-a', 'pinned-a'), bounds(40)],
                [treeRowId.session('server-a', 'pinned-b'), bounds(80)],
            ]),
        });

        const reorder = resolveSessionListInstruction({
            tree: pinnedTree,
            source: buildSessionListDragSource({
                tree: pinnedTree,
                sourceRowId: treeRowId.session('server-a', 'pinned-a'),
            }),
            pointer: pointer(90),
            foldersFeatureEnabled: true,
            canReorderSessionSiblings: false,
        });

        expect(reorder.instruction.kind).toBe('blocked');
        expect(reorder.visual).toEqual({ kind: 'none' });
        expect(reorder.sessionListBlockReason).toBe('ordering-mode');

        const mixedTree = buildTree();
        const reorderAroundFolder = resolveSessionListInstruction({
            tree: mixedTree,
            source: buildSessionListDragSource({
                tree: mixedTree,
                sourceRowId: treeRowId.session('server-a', 'root-a'),
            }),
            pointer: pointer(42),
            foldersFeatureEnabled: true,
            canReorderSessionSiblings: false,
        });

        expect(reorderAroundFolder.instruction.kind).toBe('blocked');
        expect(reorderAroundFolder.visual).toEqual({ kind: 'none' });
        expect(reorderAroundFolder.instruction).toMatchObject({ reason: 'workspace-scope-mismatch' });

        const folderTree = buildTree();
        const containment = resolveSessionListInstruction({
            tree: folderTree,
            source: buildSessionListDragSource({
                tree: folderTree,
                sourceRowId: treeRowId.session('server-a', 'inside-a'),
            }),
            pointer: pointer(180),
            foldersFeatureEnabled: true,
            canReorderSessionSiblings: false,
        });

        expect(containment.instruction).toMatchObject({
            kind: 'nest-into',
            targetId: treeRowId.folder('server-a', 'folder-b'),
        });
        expect(containment.sessionListBlockReason).toBeUndefined();
    });

    it('admits same-Home section membership without a workspace scope', () => {
        const items: SessionListIndexItem[] = [
            projectHeader('project-a', workspaceA),
            {
                type: 'session',
                sessionId: 'unscoped',
                serverId: 'server-a',
                storageKind: 'persisted',
                groupKey: 'project-a',
                groupKind: 'project',
            },
            folderHeader({
                id: 'folder-a',
                groupKey: 'project-a:folder:folder-a',
                depth: 0,
                workspace: workspaceA,
            }),
        ];
        const tree = buildSessionListTreeRows({
            items,
            rowBoundsById: new Map([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.session('server-a', 'unscoped'), bounds(40)],
                [treeRowId.folder('server-a', 'folder-a'), bounds(80)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({
                tree,
                sourceRowId: treeRowId.session('server-a', 'unscoped'),
            }),
            pointer: pointer(100),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toMatchObject({ kind: 'nest-into', targetId: treeRowId.folder('server-a', 'folder-a') });
        expect(result.sessionListBlockReason).toBeUndefined();
    });

    it('admits same-Home sections across workspace roots', () => {
        const tree = buildTree();

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(360),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toMatchObject({ kind: 'nest-into', targetId: treeRowId.folder('server-a', 'folder-c') });
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
            targetId: treeRowId.folder('server-a', 'folder-b'),
            containerId: treeRowId.folder('server-a', 'folder-b'),
            parentId: treeRowId.folder('server-a', 'folder-b'),
            depth: 1,
        });
        expect(result.visual).toEqual({ kind: 'outline', targetId: treeRowId.folder('server-a', 'folder-b') });
    });

    it('resolves a session drop onto workspace-root whitespace as a scoped root move', () => {
        const tree = buildSessionListTreeRows({
            items: [
                projectHeader('project-a', workspaceA),
                sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
                projectHeader('project-b', workspaceB),
                folderHeader({ id: 'folder-a', groupKey: 'section-a', depth: 0, workspace: workspaceA }),
                sessionItem({ id: 'inside-a', groupKey: 'section-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
            ],
            rowBoundsById: new Map([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.session('server-a', 'root-a'), bounds(40)],
                [treeRowId.workspaceRoot('project-b'), bounds(120)],
                [treeRowId.folder('server-a', 'folder-a'), bounds(200)],
                [treeRowId.session('server-a', 'inside-a'), bounds(240)],
            ]),
            dropZoneBounds: [{ containerId: treeRowId.workspaceRoot('project-a'), role: 'root-after-last',
                bounds: { x: 0, y: 84, width: 320, height: 16 } }],
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(90),
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
        const tree = buildSessionListTreeRows({
            items: [
                projectHeader('project-a', workspaceA),
                sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
                projectHeader('project-b', workspaceB),
                folderHeader({ id: 'folder-a', groupKey: 'section-a', depth: 0, workspace: workspaceA }),
                sessionItem({ id: 'inside-a', groupKey: 'section-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
            ],
            rowBoundsById: new Map<string, WindowBounds>([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.session('server-a', 'root-a'), bounds(40)],
                [treeRowId.workspaceRoot('project-b'), bounds(120)],
                [treeRowId.folder('server-a', 'folder-a'), bounds(200)],
                [treeRowId.session('server-a', 'inside-a'), bounds(240)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(90),
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

    it('does not mix Session rows into the section header order', () => {
        const tree = buildSessionListTreeRows({
            items: mixedWorkspaceItems(),
            rowBoundsById: new Map<string, WindowBounds>([
                [treeRowId.workspaceRoot('project-a'), bounds(0)],
                [treeRowId.folder('server-a', 'folder-a'), bounds(40)],
                [treeRowId.session('server-a', 'inside-a'), bounds(80)],
                [treeRowId.folder('server-a', 'child-a'), bounds(120)],
                [treeRowId.folder('server-a', 'folder-b'), bounds(170)],
                [treeRowId.session('server-a', 'root-a'), bounds(210)],
                [treeRowId.workspaceRoot('project-b'), bounds(300)],
                [treeRowId.folder('server-a', 'folder-c'), bounds(340)],
            ]),
        });

        const result = resolveSessionListInstruction({
            tree,
            source: buildSessionListDragSource({ tree, sourceRowId: treeRowId.session('server-a', 'inside-a') }),
            pointer: pointer(165),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toMatchObject({ kind: 'blocked', reason: 'workspace-scope-mismatch' });
        expect(result.visual).toEqual({ kind: 'none' });
    });

    it('keeps imported child sections flat and refuses nesting their definitions', () => {
        const tree = buildTree();

        const source = buildSessionListDragSource({ tree, sourceRowId: treeRowId.folder('server-a', 'folder-a') });
        expect(source.excludedDescendantIds.has(treeRowId.folder('server-a', 'child-a'))).toBe(false);

        const result = resolveSessionListInstruction({
            tree,
            source,
            pointer: pointer(140),
            foldersFeatureEnabled: true,
        });

        expect(result.instruction).toEqual({
            kind: 'blocked',
            reason: 'workspace-scope-mismatch',
            hintTargetId: treeRowId.folder('server-a', 'child-a'),
        });
    });
});
