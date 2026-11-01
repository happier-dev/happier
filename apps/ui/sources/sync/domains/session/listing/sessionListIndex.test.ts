import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';
import {
    buildSessionListIndexFromViewData,
    buildSessionListIndexNodeId,
    resolveSessionListIndexFolderDragEligibility,
} from './sessionListIndex';

function makeRenderable(
    id: string,
    partial?: Partial<SessionListRenderableSession>,
): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...partial,
    };
}

describe('buildSessionListIndexFromViewData', () => {
    it('builds stable node ids without relying on item index', () => {
        const sessionNodeId = buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        });
        expect(sessionNodeId).toBe(buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        }));

        const headerNodeId = buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        });
        expect(headerNodeId).toBe(buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        }));
    });

    it('propagates direct storage and folder depth metadata from view data', () => {
        const directSession = makeRenderable('direct-session', {
            metadata: {
                path: '/repo',
                directSessionV1: { v: 1 },
            },
        });
        const workspace = {
            t: 'workspaceScope' as const,
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
        };
        const viewData: SessionListViewItem[] = [
            {
                type: 'header',
                title: 'Planning',
                headerKind: 'folder',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                serverId: 'server-a',
                folderId: 'folder-a',
                depth: 1,
                workspace,
            },
            {
                type: 'session',
                session: directSession,
                serverId: 'server-a',
                serverName: 'Server A',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                groupKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 2,
                workspace,
            },
        ];

        const index = buildSessionListIndexFromViewData(viewData);

        expect(index?.[0]).toMatchObject({
            type: 'header',
            headerKind: 'folder',
            folderId: 'folder-a',
            folderDepth: 1,
            workspace,
        });
        expect(index?.[1]).toMatchObject({
            type: 'session',
            sessionId: 'direct-session',
            storageKind: 'direct',
            groupKind: 'folder',
            folderId: 'folder-a',
            folderDepth: 2,
            workspace,
        });
    });

    it('reuses the previous index reference when inputs are semantically identical', () => {
        const session = makeRenderable('s1');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            {
                type: 'session',
                session,
                serverId: 'server-a',
                serverName: 'Server A',
                section: 'active',
                groupKey: 'g1',
                groupKind: 'date',
            },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            { ...viewData[0] },
            { ...(viewData[1] as Extract<SessionListViewItem, { type: 'session' }>) },
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).toBe(first);
    });

    it('does not reuse a session index item when working placement metadata changes', () => {
        const session = makeRenderable('s1');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            {
                type: 'session',
                session,
                serverId: 'server-a',
                section: 'active',
                groupKey: 'g1',
                groupKind: 'date',
                workingPlacementReason: 'working',
            },
        ];
        const first = buildSessionListIndexFromViewData(viewData);
        expect(first?.[1]).toMatchObject({ type: 'session', workingPlacementReason: 'working' });

        const nextViewData: SessionListViewItem[] = [
            viewData[0],
            {
                ...(viewData[1] as Extract<SessionListViewItem, { type: 'session' }>),
                workingPlacementReason: undefined,
            },
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second?.[1]).toMatchObject({ type: 'session', workingPlacementReason: undefined });
        expect(second?.[1]).not.toBe(first?.[1]);
    });
});

describe('resolveSessionListIndexFolderDragEligibility', () => {
    it('allows both session storage kinds and folder headers only when the folders feature is enabled', () => {
        const persistedSession = {
            type: 'session' as const,
            sessionId: 'persisted-session',
            storageKind: 'persisted' as const,
        };
        const directSession = {
            type: 'session' as const,
            sessionId: 'direct-session',
            storageKind: 'direct' as const,
        };
        const folderHeader = {
            type: 'header' as const,
            title: 'Planning',
            headerKind: 'folder' as const,
            folderId: 'folder-a',
        };

        expect(resolveSessionListIndexFolderDragEligibility(persistedSession, { foldersFeatureEnabled: true })).toEqual({
            canUseSessionFolders: true,
            foldersFeatureEnabled: true,
            reason: 'eligible',
            storageKind: 'persisted',
        });
        expect(resolveSessionListIndexFolderDragEligibility(directSession, { foldersFeatureEnabled: true })).toMatchObject({
            canUseSessionFolders: true,
            reason: 'eligible',
            storageKind: 'direct',
        });
        expect(resolveSessionListIndexFolderDragEligibility(folderHeader, { foldersFeatureEnabled: true })).toMatchObject({
            canUseSessionFolders: true,
            reason: 'eligible',
            storageKind: null,
        });
        expect(resolveSessionListIndexFolderDragEligibility(persistedSession, { foldersFeatureEnabled: false })).toMatchObject({
            canUseSessionFolders: false,
            foldersFeatureEnabled: false,
            reason: 'feature-disabled',
        });
        expect(resolveSessionListIndexFolderDragEligibility(directSession, { foldersFeatureEnabled: false })).toMatchObject({
            canUseSessionFolders: false,
            reason: 'feature-disabled',
        });
    });
}
);
