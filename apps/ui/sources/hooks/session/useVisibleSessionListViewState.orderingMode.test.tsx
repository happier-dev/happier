import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';

const viewState = vi.hoisted(() => ({
    orderingMode: 'updated' as SessionListOrderingModeV1,
    hideInactiveSessions: false,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    } as any,
    source: null as SessionListIndexItem[] | null,
    groupOrder: {
        'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
    } as Record<string, string[]>,
    setGroupOrder: vi.fn(),
    rowsByServerId: {} as Record<string, Record<string, SessionListRenderableSession>>,
    observedOrderingMode: [] as Array<SessionListOrderingModeV1>,
    sessionFolders: { v: 1, folders: [] } as any,
    sessionFolderViewMode: 'off' as 'off' | 'tree',
    sessionFoldersFeatureEnabled: true,
    focusedSessionFolder: null as any,
    sessionFolderAssignmentsBySessionKey: {} as Record<string, string | null>,
}));

function makeSessionRow(id: string, partial?: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        owner: undefined,
        accessLevel: undefined,
        canApprovePermissions: undefined,
        hasPendingPermissionRequests: undefined,
        hasPendingUserActionRequests: undefined,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeSourceIndex(): SessionListIndexItem[] {
    const groupKey = 'server:s1:day:2026-02-17';
    return [
        { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
        { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
    ];
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListRowStateByServerId: () => viewState.rowsByServerId,
            useSetting: ((key: string) => {
                if (key === 'hideInactiveSessions') return viewState.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return [];
                if (key === 'sessionListOrderingModeV1') {
                    viewState.observedOrderingMode.push(viewState.orderingMode);
                    return viewState.orderingMode;
                }
                if (key === 'sessionFoldersV1') return viewState.sessionFolders;
                if (key === 'sessionFolderViewModeV1') return viewState.sessionFolderViewMode;
                return null;
            }) as any,
            useSettingMutable: ((key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [viewState.groupOrder, viewState.setGroupOrder];
                }
                return [null, vi.fn()];
            }) as any,
            useLocalSetting: ((key: string) => {
                if (key === 'sessionListFocusedFolderV1') return viewState.focusedSessionFolder;
                return null;
            }) as any,
            useSessionFolderAssignmentsBySessionKey: () => viewState.sessionFolderAssignmentsBySessionKey,
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.folders'
        ? viewState.sessionFoldersFeatureEnabled
        : true,
}));

vi.mock('./useVisibleSessionListSourceState', () => ({
    useVisibleSessionListSourceState: () => ({
        selection: viewState.selection,
        activeIndex: viewState.source,
        byServerId: {},
        source: viewState.source,
    }),
}));

describe('useVisibleSessionListViewState (index pipeline)', () => {
    afterEach(() => {
        standardCleanup();
        viewState.orderingMode = 'updated';
        viewState.source = null;
        viewState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.groupOrder = {
            'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
        };
        viewState.hideInactiveSessions = false;
        viewState.rowsByServerId = {};
        viewState.observedOrderingMode.length = 0;
        viewState.setGroupOrder.mockClear();
        viewState.sessionFolders = { v: 1, folders: [] };
        viewState.sessionFolderViewMode = 'off';
        viewState.sessionFoldersFeatureEnabled = true;
        viewState.focusedSessionFolder = null;
        viewState.sessionFolderAssignmentsBySessionKey = {};
    });

    it('keeps dormant manual group order data untouched when ordering mode is updated', async () => {
        viewState.orderingMode = 'updated';
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const sessionIds = (hook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);

        expect(sessionIds).toEqual(['a', 'b']);
        expect(viewState.observedOrderingMode).toEqual(['updated']);
        expect(viewState.setGroupOrder).not.toHaveBeenCalled();
    });

    it('exposes when the inactive filter hides all visible sessions', async () => {
        viewState.hideInactiveSessions = true;
        viewState.source = [
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                inactive: makeSessionRow('inactive', { active: false, keepVisibleWhenInactive: false }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent()?.hasHiddenInactiveSessions).toBe(true);
    });

    it('builds a folder tree from durable workspace refs and scopes focused folders', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'in-folder': makeSessionRow('in-folder', { active: true, createdAt: 10 }),
                'at-root': makeSessionRow('at-root', { active: true, createdAt: 9 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                renderWorkspaceKey: 'wl_old_hash',
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {
            's1:in-folder': 'folder-a',
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a', folderDepth: 0 }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'at-root', folderId: null }),
        ]);

        viewState.focusedSessionFolder = {
            serverId: 's1',
            workspace: {
                t: 'workspaceScope',
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            folderId: 'folder-a',
        };
        const focusedHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const focusedSessions = (focusedHook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);
        expect(focusedSessions).toEqual(['in-folder']);
        expect(focusedHook.getCurrent()?.folderFocus?.breadcrumbs.map((crumb: any) => crumb.name)).toEqual(['Planning']);
    });

    it('keeps empty folder rows visible after workspace root sessions', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'at-root',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'at-root': makeSessionRow('at-root', { active: true, createdAt: 9 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {};

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'header', headerKind: 'folder', folderId: 'folder-a' }),
            expect.objectContaining({ type: 'session', sessionId: 'at-root', folderId: null }),
        ]);
    });

    it('leaves folder metadata inactive when the feature is disabled or Direct mode is selected', async () => {
        viewState.sessionFolderViewMode = 'tree';
        viewState.sessionFoldersFeatureEnabled = false;
        viewState.source = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:s1:active:project:hash-a',
                workspaceKey: 'wl_hash_a',
                serverId: 's1',
                workspaceScopeHint: {
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                sessionId: 'in-folder',
                serverId: 's1',
                section: 'active',
                groupKey: 'server:s1:active:project:hash-a',
                groupKind: 'project',
            },
        ];
        viewState.rowsByServerId = {
            s1: {
                'in-folder': makeSessionRow('in-folder', { active: true, createdAt: 10 }),
            },
        };
        viewState.sessionFolders = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        viewState.sessionFolderAssignmentsBySessionKey = {
            's1:in-folder': 'folder-a',
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const disabledHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(disabledHook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'project' }),
            expect.objectContaining({ type: 'session', sessionId: 'in-folder', groupKind: 'project' }),
        ]);
        expect(disabledHook.getCurrent()?.folderFocus).toBeNull();

        viewState.sessionFoldersFeatureEnabled = true;
        const directHook = await renderHook(() => useVisibleSessionListViewState('direct'));
        await flushHookEffects();

        expect(directHook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(directHook.getCurrent()?.folderFocus).toBeNull();
    });
});
