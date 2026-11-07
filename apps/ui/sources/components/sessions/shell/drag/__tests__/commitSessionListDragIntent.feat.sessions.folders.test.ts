import { describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';

import { commitSessionListDragIntent } from '../commitSessionListDragIntent';
import type { CommitSessionListDragIntentContext } from '../commitSessionListDragIntent';
import type { SessionListDragIntent } from '../_types';
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
    machineId: 'machine-b',
    rootPath: '/repo/b',
};

function projectHeader(
    groupKey: string,
    workspace: SessionFolderWorkspaceRefV1,
): Extract<SessionListIndexItem, { type: 'header' }> {
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

/**
 * Latest live index: project-a holds folder-a (with session inside-a),
 * folder-b, and root sessions root-a / root-b. project-b holds folder-c.
 */
function latestItems(): SessionListIndexItem[] {
    return [
        projectHeader('project-a', workspaceA),
        folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'root-a', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
        sessionItem({ id: 'root-b', groupKey: 'project-a', folderId: null, depth: 0, workspace: workspaceA }),
        projectHeader('project-b', workspaceB),
        folderHeader({ id: 'folder-c', groupKey: 'project-b:folder:folder-c', depth: 0, workspace: workspaceB }),
    ];
}

function latestFolders(): SessionFoldersV1 {
    return {
        v: 1,
        folders: [
            { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
            { id: 'folder-b', workspace: workspaceA, parentId: null, name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000002' },
            { id: 'folder-c', workspace: workspaceB, parentId: null, name: 'C', createdAt: 3, updatedAt: 3, sortKey: '000001' },
        ],
    };
}

type CommitSpyOverrides = Partial<Pick<CommitSessionListDragIntentContext,
    'latestItems' | 'sessionFoldersV1' | 'sessionListGroupOrderV1'
    | 'sessionWorkspaceOrderV1' | 'folderSortMode' | 'now'>>;

type CapturedContext = CommitSessionListDragIntentContext & Readonly<{
    setSessionFoldersV1: ReturnType<typeof vi.fn>;
    setSessionListGroupOrderV1: ReturnType<typeof vi.fn>;
    setSessionWorkspaceOrderV1: ReturnType<typeof vi.fn>;
    setSessionFolderAssignment: ReturnType<typeof vi.fn>;
}>;

function buildContext(overrides?: CommitSpyOverrides): CapturedContext {
    return {
        latestItems: overrides?.latestItems ?? latestItems(),
        sessionFoldersV1: overrides?.sessionFoldersV1 ?? latestFolders(),
        sessionListGroupOrderV1: overrides?.sessionListGroupOrderV1 ?? {},
        sessionWorkspaceOrderV1: overrides?.sessionWorkspaceOrderV1 ?? {},
        now: overrides?.now ?? (() => 100),
        folderSortMode: overrides?.folderSortMode ?? 'mixed',
        setSessionFoldersV1: vi.fn(),
        setSessionListGroupOrderV1: vi.fn(),
        setSessionWorkspaceOrderV1: vi.fn(),
        setSessionFolderAssignment: vi.fn(async () => undefined),
    };
}

/**
 * A reorder intent built from a stale drag snapshot: move `inside-a` so it
 * lands after `root-a` in the project-a root band.
 */
function reorderInsideAfterRootAIntent(): SessionListDragIntent {
    return {
        sourceRowId: treeRowId.session('server-a', 'inside-a'),
        sourceKind: 'leaf',
        instructionKind: 'reorder-after',
        targetRowId: treeRowId.session('server-a', 'root-a'),
        containerId: treeRowId.workspaceRoot('project-a'),
        parentRowId: null,
        depth: 0,
        edge: 'bottom',
        rootPlacement: null,
        sourceSnapshotSignature: 'snapshot-stale',
    };
}

describe('commitSessionListDragIntent', () => {
    it('unassigns a linked checkout session into its own root band under a repository heading', async () => {
        const linked: SessionFolderWorkspaceRefV1 = { ...workspaceA, rootPath: '/worktrees/topic' };
        const context = buildContext({ latestItems: latestItems().map((item) =>
            (item.type === 'session' && item.sessionId === 'inside-a') || (item.type === 'header' && item.folderId === 'folder-a')
                ? { ...item, workspace: linked } : item) });
        const result = await commitSessionListDragIntent({
            intent: { ...reorderInsideAfterRootAIntent(), instructionKind: 'move-to-root', targetRowId: null, rootPlacement: 'after-last' },
            context,
        });
        expect(result).toEqual({ ok: true });
        expect(context.setSessionFolderAssignment).toHaveBeenCalledWith({ serverId: 'server-a', sessionId: 'inside-a', folderId: null });
    });

    it('moves a linked checkout child folder to its own root without using a main checkout folder as its sibling', async () => {
        const linked: SessionFolderWorkspaceRefV1 = { ...workspaceA, rootPath: '/worktrees/topic' };
        const context = buildContext({
            latestItems: [
                projectHeader('project-a', workspaceA),
                folderHeader({ id: 'linked-parent', groupKey: 'linked-parent', depth: 0, workspace: linked }),
                folderHeader({ id: 'linked-child', groupKey: 'linked-child', depth: 1, workspace: linked }),
                folderHeader({ id: 'folder-a', groupKey: 'main-folder', depth: 0, workspace: workspaceA }),
            ],
            sessionFoldersV1: { v: 1, folders: [
                ...latestFolders().folders,
                { id: 'linked-parent', workspace: linked, parentId: null, name: 'Linked parent', createdAt: 1, updatedAt: 1 },
                { id: 'linked-child', workspace: linked, parentId: 'linked-parent', name: 'Linked child', createdAt: 1, updatedAt: 1 },
            ] },
        });
        const result = await commitSessionListDragIntent({
            intent: { ...reorderInsideAfterRootAIntent(), sourceKind: 'container', sourceRowId: treeRowId.folder('linked-child'),
                instructionKind: 'move-to-root', targetRowId: null, rootPlacement: 'after-last' },
            context,
        });
        expect(result).toEqual({ ok: true });
        expect(context.setSessionFoldersV1).toHaveBeenCalledWith(expect.objectContaining({
            folders: expect.arrayContaining([expect.objectContaining({ id: 'linked-child', parentId: null, workspace: linked })]),
        }));
    });

    it('persists a root session before a root folder as explicit mixed group order', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'root-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.folder('folder-a'),
            containerId: treeRowId.workspaceRoot('project-a'),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: true });
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['server-a:root-a', 'folder:folder-a', 'folder:folder-b', 'server-a:root-b'],
        });
    });

    it('persists a root folder before another root folder as explicit mixed group order', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.folder('folder-b'),
            sourceKind: 'container',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.folder('folder-a'),
            containerId: treeRowId.workspaceRoot('project-a'),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext({
            sessionListGroupOrderV1: {
                'project-a': ['server-a:root-a', 'folder:folder-a', 'folder:folder-b', 'server-a:root-b'],
            },
        });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: true });
        expect(context.setSessionFoldersV1).toHaveBeenCalledTimes(1);
        expect(context.setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': ['server-a:root-a', 'folder:folder-b', 'folder:folder-a', 'server-a:root-b'],
        });
    });

    it('commits a frozen-snapshot intent against a later mutated order map', async () => {
        const context = buildContext({
            // background reorder mutated project-a order before commit.
            sessionListGroupOrderV1: {
                'project-a': ['server-a:root-b', 'server-a:root-a'],
            },
        });

        const result = await commitSessionListDragIntent({
            intent: reorderInsideAfterRootAIntent(),
            context,
        });

        expect(result).toEqual({ ok: true });
        // inside-a is placed directly after root-a using the LATEST order map
        // as the baseline (root-b before root-a), not the stale snapshot order.
        // Newly visible sibling folder keys are appended after the baseline.
        expect(context.setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(context.setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': [
                'server-a:root-b',
                'server-a:root-a',
                'server-a:inside-a',
                'folder:folder-a',
                'folder:folder-b',
            ],
        });
    });

    it('preserves a background reorder of unrelated items through commit', async () => {
        // root-b was reordered before root-a in the background while dragging.
        const context = buildContext({
            sessionListGroupOrderV1: {
                'project-a': ['server-a:root-b', 'server-a:root-a'],
            },
        });

        const result = await commitSessionListDragIntent({
            intent: reorderInsideAfterRootAIntent(),
            context,
        });

        expect(result).toEqual({ ok: true });
        const committed = context.setSessionListGroupOrderV1.mock.calls[0][0] as Record<string, string[]>;
        // unrelated root-b/root-a relative order from the background update survives.
        expect(committed['project-a'].indexOf('server-a:root-b'))
            .toBeLessThan(committed['project-a'].indexOf('server-a:root-a'));
    });

    it('returns a source-missing no-op without mutation when the source was deleted mid-drag', async () => {
        const context = buildContext({
            latestItems: latestItems().filter((item) =>
                !(item.type === 'session' && item.sessionId === 'inside-a')),
        });

        const result = await commitSessionListDragIntent({
            intent: reorderInsideAfterRootAIntent(),
            context,
        });

        expect(result).toEqual({ ok: false, reason: 'source-missing' });
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(context.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('returns a target-missing no-op when the target row was deleted and no container survives', async () => {
        // The intent targets a row in a container that no longer exists at all.
        const intent: SessionListDragIntent = {
            ...reorderInsideAfterRootAIntent(),
            targetRowId: treeRowId.session('server-a', 'gone'),
            containerId: treeRowId.workspaceRoot('project-gone'),
        };
        const context = buildContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'container-missing' });
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('safely degrades to the container edge when the target row was deleted but the container survives', async () => {
        // root-a deleted mid-drag; project-a root container still exists, so the
        // reorder-after degrades to "append to the project-a root band". The
        // latest order map still carries the user's root-b-before-root-a order.
        const context = buildContext({
            latestItems: latestItems().filter((item) =>
                !(item.type === 'session' && item.sessionId === 'root-a')),
            sessionListGroupOrderV1: {
                'project-a': ['server-a:root-b', 'server-a:root-a'],
            },
        });

        const result = await commitSessionListDragIntent({
            intent: reorderInsideAfterRootAIntent(),
            context,
        });

        expect(result).toEqual({ ok: true });
        expect(context.setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        // The reorder-after degrades to the project-a container edge: inside-a
        // is placed after the surviving last child (root-b) of the latest tree.
        // The stale root-a key in the current map is preserved (it is filtered
        // at render, not at commit), and newly visible folders append after.
        expect(context.setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a': [
                'server-a:root-b',
                'server-a:inside-a',
                'server-a:root-a',
                'folder:folder-a',
                'folder:folder-b',
            ],
        });
    });

    it('returns a descendant-cycle no-op when a folder move would nest a folder into its own descendant', async () => {
        // Latest tree differs from the snapshot: folder-b is now a child of
        // folder-a. Nesting folder-a into folder-b would create a cycle.
        const cycleItems: SessionListIndexItem[] = [
            projectHeader('project-a', workspaceA),
            folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
            folderHeader({ id: 'folder-b', groupKey: 'project-a:folder:folder-b', depth: 1, workspace: workspaceA }),
        ];
        const cycleFolders: SessionFoldersV1 = {
            v: 1,
            folders: [
                { id: 'folder-a', workspace: workspaceA, parentId: null, name: 'A', createdAt: 1, updatedAt: 1, sortKey: '000001' },
                { id: 'folder-b', workspace: workspaceA, parentId: 'folder-a', name: 'B', createdAt: 2, updatedAt: 2, sortKey: '000001' },
            ],
        };
        const context = buildContext({ latestItems: cycleItems, sessionFoldersV1: cycleFolders });

        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.folder('folder-a'),
            sourceKind: 'container',
            instructionKind: 'nest-into',
            targetRowId: treeRowId.folder('folder-b'),
            containerId: treeRowId.folder('folder-b'),
            parentRowId: treeRowId.folder('folder-b'),
            depth: 2,
            edge: null,
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'descendant-cycle' });
        expect(context.setSessionFoldersV1).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('returns a scope-mismatch no-op when the destination now lives in an incompatible workspace', async () => {
        // Intent wants inside-a (workspace A) nested into folder-c (workspace B).
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-before',
            targetRowId: treeRowId.folder('folder-c'),
            containerId: treeRowId.workspaceRoot('project-b'),
            parentRowId: null,
            depth: 0,
            edge: 'top',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'scope-mismatch' });
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('persists a folder assignment only when the destination folder id actually changes', async () => {
        // inside-a already lives in folder-a; an intent that reorders it inside
        // folder-a (after a sibling session in the same folder) must not
        // re-issue a folder assignment, only an order update.
        const itemsWithSibling: SessionListIndexItem[] = [
            projectHeader('project-a', workspaceA),
            folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
            sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
            sessionItem({ id: 'sibling-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        ];
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'sibling-a'),
            containerId: treeRowId.folder('folder-a'),
            parentRowId: treeRowId.folder('folder-a'),
            depth: 1,
            edge: 'bottom',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext({
            latestItems: itemsWithSibling,
            sessionListGroupOrderV1: { 'project-a:folder:folder-a': ['server-a:inside-a', 'server-a:sibling-a'] },
        });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: true });
        // inside-a stays in folder-a (no folder id change) but its order updates.
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).toHaveBeenCalledWith({
            'project-a:folder:folder-a': ['server-a:sibling-a', 'server-a:inside-a'],
        });
    });

    it('blocks same-container session sibling reorder in date mode without mutation', async () => {
        const itemsWithSibling: SessionListIndexItem[] = [
            projectHeader('project-a', workspaceA),
            folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
            sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
            sessionItem({ id: 'sibling-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        ];
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'sibling-a'),
            containerId: treeRowId.folder('folder-a'),
            parentRowId: treeRowId.folder('folder-a'),
            depth: 1,
            edge: 'bottom',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = {
            ...buildContext({
                latestItems: itemsWithSibling,
                sessionListGroupOrderV1: { 'project-a:folder:folder-a': ['server-a:inside-a', 'server-a:sibling-a'] },
            }),
            sessionListOrderingModeV1: 'created' as const,
        };

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(context.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('reports the date-ordering block reason even when dormant order already matches the drag target', async () => {
        const itemsWithSibling: SessionListIndexItem[] = [
            projectHeader('project-a', workspaceA),
            folderHeader({ id: 'folder-a', groupKey: 'project-a:folder:folder-a', depth: 0, workspace: workspaceA }),
            sessionItem({ id: 'inside-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
            sessionItem({ id: 'sibling-a', groupKey: 'project-a:folder:folder-a', folderId: 'folder-a', depth: 1, workspace: workspaceA }),
        ];
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'sibling-a'),
            containerId: treeRowId.folder('folder-a'),
            parentRowId: treeRowId.folder('folder-a'),
            depth: 1,
            edge: 'bottom',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = {
            ...buildContext({
                latestItems: itemsWithSibling,
                sessionListGroupOrderV1: { 'project-a:folder:folder-a': ['server-a:sibling-a', 'server-a:inside-a'] },
            }),
            sessionListOrderingModeV1: 'updated' as const,
        };

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'date-ordering-mode' });
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(context.setSessionFoldersV1).not.toHaveBeenCalled();
    });

    it('commits session containment moves in date mode as assignment-only changes', async () => {
        const context = {
            ...buildContext({
                sessionListGroupOrderV1: {
                    'project-a': ['server-a:root-b', 'server-a:root-a'],
                    'project-a:folder:folder-a': ['server-a:inside-a'],
                },
            }),
            sessionListOrderingModeV1: 'updated' as const,
        };

        const result = await commitSessionListDragIntent({
            intent: reorderInsideAfterRootAIntent(),
            context,
        });

        expect(result).toEqual({ ok: true });
        expect(context.setSessionFolderAssignment).toHaveBeenCalledWith({
            serverId: 'server-a',
            sessionId: 'inside-a',
            folderId: null,
        });
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('returns a blocked-intent no-op for an intent resolved as blocked during the drag', async () => {
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'blocked',
            targetRowId: null,
            containerId: null,
            parentRowId: null,
            depth: null,
            edge: null,
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext();

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'blocked-intent' });
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
    });

    it('returns a no-change no-op when committing an intent that does not move the source', async () => {
        // inside-a reorder-before itself: the only ordered sibling is inside-a,
        // so the latest-state order update produces no real change.
        const intent: SessionListDragIntent = {
            sourceRowId: treeRowId.session('server-a', 'inside-a'),
            sourceKind: 'leaf',
            instructionKind: 'reorder-after',
            targetRowId: treeRowId.session('server-a', 'inside-a'),
            containerId: treeRowId.folder('folder-a'),
            parentRowId: treeRowId.folder('folder-a'),
            depth: 1,
            edge: 'bottom',
            rootPlacement: null,
            sourceSnapshotSignature: 'snapshot-stale',
        };
        const context = buildContext({
            sessionListGroupOrderV1: { 'project-a:folder:folder-a': ['server-a:inside-a'] },
        });

        const result = await commitSessionListDragIntent({ intent, context });

        expect(result).toEqual({ ok: false, reason: 'no-change' });
        expect(context.setSessionListGroupOrderV1).not.toHaveBeenCalled();
        expect(context.setSessionFolderAssignment).not.toHaveBeenCalled();
    });
});
