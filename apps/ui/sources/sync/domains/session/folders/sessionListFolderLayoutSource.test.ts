import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionFolderAssignmentKey } from './assignmentKeys';
import { resolveFolderAwareSessionListSourceForLayout } from './sessionListFolders';
import type { SessionFolderList } from './types';
import { normalizeSessionFolderWorkspaceRef } from './workspaceRefs';

const workspaceScopeHint = { serverId: 'home-a', machineId: 'm1', rootPath: '/home/u/repo' } as const;
const workspace = normalizeSessionFolderWorkspaceRef({ t: 'workspaceScope', ...workspaceScopeHint })!;

const folders: SessionFolderList = {
    version: 1,
    folders: [
        { id: 'f-parent', name: 'Parent', parentId: null, workspace, orderKey: 'a', createdAt: 1, updatedAt: 1 },
        { id: 'f-child', name: 'Child', parentId: 'f-parent', workspace, orderKey: 'b', createdAt: 1, updatedAt: 1 },
        { id: 'f-other', name: 'Other', parentId: null, workspace, orderKey: 'c', createdAt: 1, updatedAt: 1 },
    ],
} as unknown as SessionFolderList;

const source: ReadonlyArray<SessionListIndexItem> = [
    {
        type: 'header',
        headerKind: 'project',
        title: '~/repo',
        serverId: 'home-a',
        groupKey: 'g',
        workspaceKey: 'wl_1',
        workspaceScopeHint,
    },
    { type: 'session', sessionId: 'in-parent', serverId: 'home-a', section: 'active', groupKey: 'g', groupKind: 'project' },
    { type: 'session', sessionId: 'in-child', serverId: 'home-a', section: 'active', groupKey: 'g', groupKind: 'project' },
    { type: 'session', sessionId: 'in-other', serverId: 'home-a', section: 'active', groupKey: 'g', groupKind: 'project' },
    { type: 'session', sessionId: 'unassigned', serverId: 'home-a', section: 'active', groupKey: 'g', groupKind: 'project' },
];

const assignmentsBySessionKey: Readonly<Record<string, string | null>> = {
    [buildSessionFolderAssignmentKey('home-a', 'in-parent')]: 'f-parent',
    [buildSessionFolderAssignmentKey('home-a', 'in-child')]: 'f-child',
    [buildSessionFolderAssignmentKey('home-a', 'in-other')]: 'f-other',
};

function resolveForLayout(layoutChoice: 'projects' | 'recent_activity', focusedFolderId: string | null) {
    return resolveFolderAwareSessionListSourceForLayout({
        source,
        layoutChoice,
        foldersFeatureEnabled: true,
        folderViewModeV1: 'tree',
        folders,
        assignmentsBySessionKey,
        collapsedGroupKeys: {},
        focusedFolder: focusedFolderId ? { folderId: focusedFolderId, workspace, serverId: 'home-a' } : null,
    });
}

describe('resolveFolderAwareSessionListSourceForLayout', () => {
    it('narrows Recent activity to the focused folder subtree without folder presentation', () => {
        const result = resolveForLayout('recent_activity', 'f-parent');

        expect(result.items.map((item) => item.type === 'session' ? item.sessionId : item.type === 'header' ? `header:${item.headerKind}` : `run:${item.runId}`))
            .toEqual(['in-parent', 'in-child']);
        expect(result.items.every((item) => item.type === 'session' && item.groupKind === 'project')).toBe(true);
        expect(result.folderFocus?.folder.id).toBe('f-parent');
    });

    it('leaves Recent activity as one flat corpus when no folder is focused', () => {
        const result = resolveForLayout('recent_activity', null);

        expect(result.items).toEqual(source.map(item => item.type === 'session'
            ? { ...item, folderId: assignmentsBySessionKey[buildSessionFolderAssignmentKey(item.serverId, item.sessionId)] ?? null }
            : item));
        expect(result.folderFocus).toBeNull();
    });

    it('still builds the folder tree for project-grouped layouts', () => {
        const result = resolveForLayout('projects', 'f-parent');

        expect(result.items.some((item) => item.type === 'header' && item.headerKind === 'project')).toBe(true);
        expect(result.items.some((item) => item.type === 'session' && item.groupKind === 'folder')).toBe(true);
        expect(result.folderFocus?.folder.id).toBe('f-parent');
    });

    it('applies no folder state at all when the folders feature is unavailable', () => {
        const result = resolveFolderAwareSessionListSourceForLayout({
            source,
            layoutChoice: 'recent_activity',
            foldersFeatureEnabled: false,
            folderViewModeV1: 'tree',
            folders,
            assignmentsBySessionKey,
            collapsedGroupKeys: {},
            focusedFolder: { folderId: 'f-parent', workspace, serverId: 'home-a' },
        });

        expect(result.items).toBe(source);
        expect(result.folderFocus).toBeNull();
    });
});
