import { describe, expect, it } from 'vitest';

import {
    applySessionFolderTreeToSessionListIndex,
    buildSessionFolderAssignmentKey,
    buildSessionFolderCollapseKey,
    buildSessionFolderTree,
    compareSessionFolderWorkspaceRefs,
    createSessionFolder,
    deleteSessionFolder,
    buildSessionFolderMoveTargets,
    buildSessionFolderWorkspaceTargets,
    moveSessionFolder,
    renameSessionFolder,
    normalizeSessionFolderName,
    normalizeSessionFolders,
    resolveDurableWorkspaceRefForSessionListHeader,
    resolveSessionFolderFocusScope,
    sessionFolderAddressKey,
    SESSION_FOLDER_MAX_NAME_LENGTH,
} from './index';
import type {
    SessionFolderList,
    SessionFolderV1,
    SessionFoldersV1,
    SessionFolderWorkspaceRefV1,
} from './types';

/**
 * The stored setting projected into the Home-qualified list the tree builder reads.
 * A stored folder always carries its Home inside its workspace ref.
 */
function listedFolders(stored: SessionFoldersV1): SessionFolderList {
    return {
        v: 1,
        folders: stored.folders.map((folder) => ({ ...folder, serverId: folder.workspace.serverId ?? '' })),
    };
}

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/Users/lee/project',
};

const workspaceB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/Users/lee/other',
};

const workspaceHomeB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-b',
    machineId: 'machine-a',
    rootPath: '/Users/lee/project',
};

function folder(overrides: Partial<SessionFolderV1>): SessionFolderV1 {
    return {
        id: 'folder-a',
        workspace: workspaceA,
        renderWorkspaceKey: 'wl_old',
        parentId: null,
        name: 'Folder',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

describe('session folder domain helpers', () => {
    it('compares normalized workspace scopes and refuses invalid scopes', () => {
        expect(compareSessionFolderWorkspaceRefs({
            ...workspaceA,
            serverId: ' server-a ', machineId: ' machine-a ',
            rootPath: '/Users/lee/project/',
        }, workspaceA)).toBe(true);
        expect(compareSessionFolderWorkspaceRefs({
            t: 'workspaceRef', serverId: ' server-a ', workspaceRefId: ' workspace-a ',
        }, {
            t: 'workspaceRef', serverId: 'server-a', workspaceRefId: 'workspace-a',
        })).toBe(true);
        expect(compareSessionFolderWorkspaceRefs({ ...workspaceA, rootPath: '' }, {
            ...workspaceA, rootPath: '',
        })).toBe(false);
        expect(compareSessionFolderWorkspaceRefs(workspaceA, workspaceHomeB)).toBe(false);
    });

    it('preserves and mutates duplicate Home-local folder ids by exact Home', () => {
        const homeA = folder({ id: 'shared', name: 'Home A', workspace: workspaceA });
        const homeB = folder({ id: 'shared', name: 'Home B', workspace: workspaceHomeB });
        const childA = folder({ id: 'child-a', parentId: 'shared', name: 'Child A', workspace: workspaceA });
        const childB = folder({ id: 'child-b', parentId: 'shared', name: 'Child B', workspace: workspaceHomeB });
        const normalized = normalizeSessionFolders({ v: 1, folders: [homeA, childA, homeB, childB] });

        expect(normalized.folders).toHaveLength(4);
        const focus = resolveSessionFolderFocusScope(normalized, {
            serverId: 'server-b',
            folderId: 'shared',
            workspace: workspaceHomeB,
        });
        expect(focus?.folder.name).toBe('Home B');
        expect(focus?.folderIds).toEqual(new Set(['shared', 'child-b']));

        const renamed = renameSessionFolder({
            current: normalized,
            serverId: 'server-b',
            folderId: 'shared',
            name: 'Renamed B',
            now: 2,
        });
        expect(renamed.next.folders.map((item) => [item.workspace.serverId, item.name])).toEqual([
            ['server-a', 'Home A'],
            ['server-a', 'Child A'],
            ['server-b', 'Renamed B'],
            ['server-b', 'Child B'],
        ]);

        const deleted = deleteSessionFolder({
            current: renamed.next,
            serverId: 'server-b',
            folderId: 'shared',
        });
        expect(deleted.next.folders.map((item) => [item.workspace.serverId, item.name])).toEqual([
            ['server-a', 'Home A'],
            ['server-a', 'Child A'],
        ]);
    });
    it('normalizes folder ownership without persisting render keys as identity', () => {
        const setting: SessionFoldersV1 = {
            v: 1,
            folders: [folder({ id: 'root', renderWorkspaceKey: 'wl_old' })],
        };

        const normalized = normalizeSessionFolders(setting, {
            currentRenderWorkspaceKeysByFolderKey: {
                [sessionFolderAddressKey({ serverId: 'server-a', folderId: 'root' })]: 'wl_new',
            },
        });

        expect(normalized.folders[0]).toMatchObject({
            id: 'root',
            renderWorkspaceKey: 'wl_new',
        });
        expect(compareSessionFolderWorkspaceRefs(normalized.folders[0]!.workspace, workspaceA)).toBe(true);
    });

    it('builds tree, breadcrumbs, focus scope, and durable collapse keys', () => {
        const normalized = normalizeSessionFolders({
            v: 1,
            folders: [
                folder({ id: 'root', name: 'Root' }),
                folder({ id: 'child', name: 'Child', parentId: 'root' }),
                folder({ id: 'grandchild', name: 'Grandchild', parentId: 'child' }),
                folder({ id: 'other', name: 'Other', workspace: workspaceB }),
            ],
        });

        const tree = buildSessionFolderTree(listedFolders(normalized), workspaceA);
        const focus = resolveSessionFolderFocusScope(normalized, {
            folderId: 'child',
            workspace: workspaceA,
            serverId: 'server-a',
        });

        expect(tree.rootNodes.map((node) => node.id)).toEqual(['root']);
        expect(focus?.folderIds).toEqual(new Set(['child', 'grandchild']));
        expect(focus?.breadcrumbs.map((crumb) => crumb.name)).toEqual(['Root', 'Child']);
        expect(buildSessionFolderCollapseKey({ serverId: 'server-a', workspace: workspaceA, folderId: 'child' }))
            .toContain('child');
    });

    it('creates, renames defensively, and deletes folders without deleting sessions', () => {
        expect(normalizeSessionFolderName('  Alpha\nBeta  ')).toBe('Alpha Beta');
        expect(normalizeSessionFolderName('x'.repeat(SESSION_FOLDER_MAX_NAME_LENGTH + 10))).toHaveLength(SESSION_FOLDER_MAX_NAME_LENGTH);

        const created = createSessionFolder({
            current: { v: 1, folders: [] },
            workspace: workspaceA,
            renderWorkspaceKey: 'wl_a',
            parentId: null,
            name: 'New folder',
            now: 10,
            id: 'new',
        });
        expect(created.folder.name).toBe('New folder');

        const deleted = deleteSessionFolder({
            current: {
                v: 1,
                folders: [
                    folder({ id: 'parent', name: 'Parent' }),
                    folder({ id: 'child', name: 'Child', parentId: 'parent' }),
                ],
            },
            serverId: 'server-a',
            folderId: 'child',
        });
        expect(deleted.deletedFolderIds).toEqual(['child']);
        expect(deleted.replacementFolderId).toBe('parent');
        expect(deleted.next.folders.map((item) => item.id)).toEqual(['parent']);
    });

    it('moves folders between workspace root and subfolders without cycles', () => {
        const current: SessionFoldersV1 = {
            v: 1,
            folders: [
                folder({ id: 'parent', name: 'Parent' }),
                folder({ id: 'child', name: 'Child', parentId: 'parent' }),
                folder({ id: 'sibling', name: 'Sibling' }),
            ],
        };

        const movedToSibling = moveSessionFolder({
            current,
            serverId: 'server-a',
            folderId: 'child',
            parentId: 'sibling',
            now: 20,
        });
        expect(movedToSibling.folder).toMatchObject({ id: 'child', parentId: 'sibling', updatedAt: 20 });

        const movedToRoot = moveSessionFolder({
            current: movedToSibling.next,
            serverId: 'server-a',
            folderId: 'child',
            parentId: null,
            now: 30,
        });
        expect(movedToRoot.folder).toMatchObject({ id: 'child', parentId: null, updatedAt: 30 });

        const rejectedCycle = moveSessionFolder({
            current,
            serverId: 'server-a',
            folderId: 'parent',
            parentId: 'child',
            now: 40,
        });
        expect(rejectedCycle.folder).toBeNull();
        expect(rejectedCycle.next).toBe(current);
    });

    it('moves folders before a sibling and persists sibling order with sort keys', () => {
        const current: SessionFoldersV1 = {
            v: 1,
            folders: [
                folder({ id: 'parent', name: 'Parent' }),
                folder({ id: 'child', name: 'Child', parentId: 'parent' }),
                folder({ id: 'alpha', name: 'Alpha' }),
                folder({ id: 'zulu', name: 'Zulu' }),
            ],
        };

        const moved = moveSessionFolder({
            current,
            serverId: 'server-a',
            folderId: 'child',
            parentId: null,
            beforeFolderId: 'alpha',
            now: 50,
        });

        expect(moved.folder).toMatchObject({ id: 'child', parentId: null, updatedAt: 50 });
        expect(buildSessionFolderTree(listedFolders(moved.next), workspaceA).rootNodes.map((node) => node.id))
            .toEqual(['parent', 'child', 'alpha', 'zulu']);
    });

    it('moves a folder before a sibling without rewriting unchanged sibling sort keys', () => {
        const current: SessionFoldersV1 = {
            v: 1,
            folders: [
                folder({ id: 'parent', name: 'Parent', sortKey: 'a0', updatedAt: 10 }),
                folder({ id: 'child', name: 'Child', parentId: 'parent', sortKey: 'a0', updatedAt: 11 }),
                folder({ id: 'alpha', name: 'Alpha', sortKey: 'a1', updatedAt: 12 }),
                folder({ id: 'zulu', name: 'Zulu', sortKey: 'a2', updatedAt: 13 }),
            ],
        };

        const moved = moveSessionFolder({
            current,
            serverId: 'server-a',
            folderId: 'child',
            parentId: null,
            beforeFolderId: 'alpha',
            now: 50,
        });

        const foldersById = new Map(moved.next.folders.map((item) => [item.id, item] as const));
        expect(foldersById.get('alpha')).toMatchObject({ sortKey: 'a1', updatedAt: 12 });
        expect(foldersById.get('zulu')).toMatchObject({ sortKey: 'a2', updatedAt: 13 });
        expect(foldersById.get('child')).toMatchObject({ parentId: null, updatedAt: 50 });
        expect(foldersById.get('child')?.sortKey).not.toBe('a0');
        expect(buildSessionFolderTree(listedFolders(moved.next), workspaceA).rootNodes.map((node) => node.id))
            .toEqual(['parent', 'child', 'alpha', 'zulu']);
    });

    it('resolves durable workspace refs and drag intents for assignment', () => {
        expect(buildSessionFolderAssignmentKey('server-a', 'session-a')).toBe('["server-a","session-a"]');
        expect(buildSessionFolderAssignmentKey('https://home.example.test:8443', 'session:part'))
            .not.toBe(buildSessionFolderAssignmentKey('https://home.example.test', '8443:session:part'));
        expect(buildSessionFolderAssignmentKey(null, 'session-a'))
            .not.toBe(buildSessionFolderAssignmentKey('local', 'session-a'));
        expect(resolveDurableWorkspaceRefForSessionListHeader({
            type: 'header',
            title: 'Project',
            serverId: 'server-a',
            workspaceKey: 'wl_hash',
            workspaceScopeHint: {
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: 'C:\\Users\\Lee\\repo\\',
            },
        })).toEqual({
            t: 'workspaceScope',
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: 'c:/users/lee/repo',
        });
    });

    it('builds workspace-scoped session move targets with current assignment disabled', () => {
        const normalized = normalizeSessionFolders({
            v: 1,
            folders: [
                folder({ id: 'root', name: 'Root' }),
                folder({ id: 'child', name: 'Child', parentId: 'root' }),
                folder({ id: 'other-workspace', name: 'Other', workspace: workspaceB }),
            ],
        });

        const targets = buildSessionFolderMoveTargets({
            folders: normalized,
            workspace: workspaceA,
            currentFolderIds: ['child'],
            workspaceRootTitle: 'Workspace root',
        });

        expect(targets).toEqual([
            {
                id: 'session-folder-move-root',
                folderId: null,
                title: 'Workspace root',
                depth: 0,
                disabled: false,
            },
            {
                id: 'session-folder-move-folder-root',
                folderId: 'root',
                title: 'Root',
                depth: 0,
                disabled: false,
            },
            {
                id: 'session-folder-move-folder-child',
                folderId: 'child',
                title: 'Child',
                depth: 1,
                disabled: true,
            },
        ]);
    });

    it.each([
        { currentFolderIds: ['child', null], disabled: [false, false, false] },
        { currentFolderIds: ['child', 'child'], disabled: [false, false, true] },
        { currentFolderIds: [null, null], disabled: [true, false, false] },
        { currentFolderIds: [], disabled: [true, true, true] },
    ])('disables only destinations that change none of the selected assignments: $currentFolderIds', ({ currentFolderIds, disabled }) => {
        const targets = buildSessionFolderMoveTargets({
            folders: normalizeSessionFolders({ v: 1, folders: [
                folder({ id: 'root', name: 'Root' }),
                folder({ id: 'child', name: 'Child', parentId: 'root' }),
            ] }),
            workspace: workspaceA,
            currentFolderIds,
            workspaceRootTitle: 'Workspace root',
        });
        expect(targets.map((target) => target.disabled)).toEqual(disabled);
    });

    it('shares normalized workspace folder targets with creation-draft pickers', () => {
        const normalized = normalizeSessionFolders({
            v: 1,
            folders: [
                folder({
                    id: 'windows-folder',
                    name: 'Windows project',
                    workspace: {
                        t: 'workspaceScope',
                        serverId: 'server-a',
                        machineId: 'machine-a',
                        rootPath: 'C:\\Users\\Lee\\repo\\',
                    },
                }),
                folder({ id: 'other-workspace', name: 'Other', workspace: workspaceB }),
            ],
        });

        expect(buildSessionFolderWorkspaceTargets({
            folders: normalized,
            workspace: {
                t: 'workspaceScope',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: 'c:/users/lee/repo',
            },
        })).toEqual([{
            folderId: 'windows-folder',
            title: 'Windows project',
            depth: 0,
        }]);
    });

    it('keeps an assigned locked folder as a typed folder group without using its id as a name', () => {
        const result = applySessionFolderTreeToSessionListIndex({
            source: [
                {
                    type: 'header',
                    title: 'Project',
                    headerKind: 'project',
                    serverId: 'server-a',
                    workspaceScopeHint: {
                        serverId: 'server-a',
                        machineId: 'machine-a',
                        rootPath: '/Users/lee/project',
                    },
                },
                {
                    type: 'session',
                    sessionId: 'session-a',
                    serverId: 'server-a',
                },
            ],
            folders: {
                v: 1,
                folders: [{
                    id: 'folder-locked',
                    serverId: 'server-a',
                    workspace: null,
                    parentId: null,
                    name: '',
                    sortKey: 'a0',
                    createdAt: 1,
                    updatedAt: 1,
                    displayState: {
                        status: 'locked',
                        reason: 'account_key_unavailable',
                    },
                }],
            },
            assignmentsBySessionKey: {
                [buildSessionFolderAssignmentKey('server-a', 'session-a')]: 'folder-locked',
            },
            collapsedGroupKeys: {},
            focusedFolder: null,
        });

        expect(result.items).toEqual([
            expect.objectContaining({
                type: 'header',
                title: 'Project',
            }),
            expect.objectContaining({
                type: 'header',
                headerKind: 'folder',
                folderId: 'folder-locked',
                title: '',
                displayState: {
                    status: 'locked',
                    reason: 'account_key_unavailable',
                },
            }),
            expect.objectContaining({
                type: 'session',
                sessionId: 'session-a',
                folderId: 'folder-locked',
            }),
        ]);
        expect(JSON.stringify(result.items)).not.toContain(
            '"title":"folder-locked"',
        );
    });

    it('keeps unassigned locked folder hierarchy visible after project groups', () => {
        const locked = {
            status: 'locked' as const,
            reason: 'content_unreadable' as const,
        };
        const result = applySessionFolderTreeToSessionListIndex({
            source: [{
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                serverId: 'server-a',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/Users/lee/project',
                },
            }],
            folders: {
                v: 1,
                folders: [
                    {
                        id: 'locked-parent',
                        serverId: 'server-a',
                        workspace: null,
                        parentId: null,
                        name: '',
                        sortKey: 'a0',
                        createdAt: 1,
                        updatedAt: 1,
                        displayState: locked,
                    },
                    {
                        id: 'locked-child',
                        serverId: 'server-a',
                        workspace: null,
                        parentId: 'locked-parent',
                        name: '',
                        sortKey: 'a1',
                        createdAt: 2,
                        updatedAt: 2,
                        displayState: locked,
                    },
                ],
            },
            assignmentsBySessionKey: {},
            collapsedGroupKeys: {},
            focusedFolder: null,
        });

        expect(result.items.slice(1)).toEqual([
            expect.objectContaining({
                folderId: 'locked-parent',
                folderDepth: 0,
                displayState: locked,
            }),
            expect.objectContaining({
                folderId: 'locked-child',
                folderDepth: 1,
                displayState: locked,
            }),
        ]);
    });
});
