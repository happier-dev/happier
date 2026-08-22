import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

function makeRenderableSession(id: string, overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

function makeOrganizationProjection(
    attentionStandingsBySessionId: SessionOrganizationProjection['attentionStandingsBySessionId'],
): SessionOrganizationProjection {
    return {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById: {},
        folderAssignmentsBySessionId: {},
        tagsById: {},
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId,
        labelsByLabelKey: {},
        orderEntriesByScopeKey: {},
    };
}

const sourceData = vi.hoisted(() => ({
    activeData: [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey: 'server:server-a:day:2026-05-04',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderableSession('session-a'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
    ] as SessionListViewItem[],
    dataByServerId: {} as Record<string, SessionListViewItem[] | null>,
    sessionListViewDataByServerIdSelections: [] as ReadonlyArray<string>[],
    hideInactiveSessions: false,
    sessionListAttentionPromotionMode: 'off' as 'off' | 'global' | 'withinGroups',
    sessionListAttentionStandingDefault: false,
    sessionListWorkingPlacementMode: 'off' as 'off' | 'global' | 'withinGroups',
    sessionListOrderingModeV1: 'custom' as 'custom' | 'created' | 'updated',
    sessionListSectionModeV1: 'activity' as 'activity' | 'single',
    sessionListFolderSortModeV1: 'foldersFirst' as 'foldersFirst' | 'mixed',
    groupOrder: {} as Record<string, readonly string[] | undefined>,
    pinnedKeys: [] as string[],
    setGroupOrder: vi.fn(),
    sessionFoldersEnabled: false,
    sessionFolderViewModeV1: 'off' as 'off' | 'tree',
    sessionFoldersV1: { v: 1, folders: [] } as SessionFoldersV1,
    sessionFolderAssignmentsBySessionKey: {} as Record<string, string | null>,
    sessionOrganizationProjection: null as SessionOrganizationProjection | null,
    openApprovalSessionIds: [] as ReadonlyArray<string>,
    openApprovalSessionIdCalls: 0,
    sessionFolderAssignmentSubscriptions: 0,
    settingMutableKeys: [] as string[],
    fetchAndApplySessionFolderAssignments: vi.fn(async () => undefined),
    deprecatedFetchAndApplySessionFolderAssignments: vi.fn(async () => undefined),
    getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sourceData.activeData,
            useSessionListViewDataByServerId: (serverIds?: ReadonlyArray<string>) => {
                sourceData.sessionListViewDataByServerIdSelections.push(serverIds ?? ['__all__']);
                return sourceData.dataByServerId;
            },
            useArtifacts: () => {
                throw new Error('session list must use open approval session ids instead of subscribing to full artifacts');
            },
            useOpenApprovalSessionIds: () => {
                sourceData.openApprovalSessionIdCalls += 1;
                return sourceData.openApprovalSessionIds;
            },
            useSessionFolderAssignmentsBySessionKey: () => {
                sourceData.sessionFolderAssignmentSubscriptions += 1;
                return sourceData.sessionFolderAssignmentsBySessionKey;
            },
            useSessionOrganizationProjection: () => sourceData.sessionOrganizationProjection,
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return sourceData.hideInactiveSessions;
                if (key === 'sessionListAttentionPromotionModeV1') return sourceData.sessionListAttentionPromotionMode;
                if (key === 'sessionListAttentionStandingDefaultV1') return sourceData.sessionListAttentionStandingDefault;
                if (key === 'sessionListWorkingPlacementModeV1') return sourceData.sessionListWorkingPlacementMode;
                if (key === 'sessionListOrderingModeV1') return sourceData.sessionListOrderingModeV1;
                if (key === 'sessionListSectionModeV1') return sourceData.sessionListSectionModeV1;
                if (key === 'pinnedSessionKeysV1') return sourceData.pinnedKeys;
                if (key === 'sessionFolderViewModeV1') return sourceData.sessionFolderViewModeV1;
                if (key === 'sessionFoldersV1') return sourceData.sessionFoldersV1;
                return null;
            },
            useLocalSetting: <K extends keyof LocalSettings>(key: K): LocalSettings[K] => {
                if (key === 'sessionListFolderSortModeV1') {
                    return sourceData.sessionListFolderSortModeV1 as LocalSettings[K];
                }
                return localSettingsDefaults[key];
            },
            useSettingMutable: (key: string) => {
                sourceData.settingMutableKeys.push(key);
                if (key === 'sessionListGroupOrderV1') {
                    return [sourceData.groupOrder, sourceData.setGroupOrder];
                }
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: false,
        activeServerId: 'server-a',
        allowedServerIds: ['server-a'],
        presentation: 'grouped',
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => sourceData.sessionFoldersEnabled,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => (
        profile.serverIdentityId ?? profile.id
    ),
    getServerProfileById: (serverId: string) => serverId === 'server-a'
        ? { id: 'server-a', serverUrl: 'https://server-a.test' }
        : null,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: sourceData.getCredentialsForServerUrl,
    },
}));

vi.mock('@/sync/ops/sessionOrganization', () => ({
    fetchAndApplySessionFolderAssignments: sourceData.fetchAndApplySessionFolderAssignments,
}));

vi.mock('@/sync/ops/sessionFolders', () => ({
    fetchAndApplySessionFolderAssignments: sourceData.deprecatedFetchAndApplySessionFolderAssignments,
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...original,
        buildSessionListShellViewItemSignature: vi.fn(original.buildSessionListShellViewItemSignature),
    };
});

describe('useVisibleSessionListViewData', () => {
    afterEach(async () => {
        sourceData.hideInactiveSessions = false;
        sourceData.sessionListAttentionPromotionMode = 'off';
        sourceData.sessionListAttentionStandingDefault = false;
        sourceData.sessionListWorkingPlacementMode = 'off';
        sourceData.sessionListOrderingModeV1 = 'custom';
        sourceData.sessionListSectionModeV1 = 'activity';
        sourceData.sessionListFolderSortModeV1 = 'foldersFirst';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        sourceData.dataByServerId = {};
        sourceData.sessionListViewDataByServerIdSelections = [];
        sourceData.sessionFoldersEnabled = false;
        sourceData.sessionFolderViewModeV1 = 'off';
        sourceData.sessionFoldersV1 = { v: 1, folders: [] };
        sourceData.sessionFolderAssignmentsBySessionKey = {};
        sourceData.sessionOrganizationProjection = null;
        sourceData.groupOrder = {};
        sourceData.openApprovalSessionIds = [];
        sourceData.openApprovalSessionIdCalls = 0;
        sourceData.sessionFolderAssignmentSubscriptions = 0;
        sourceData.settingMutableKeys = [];
        sourceData.fetchAndApplySessionFolderAssignments.mockClear();
        sourceData.deprecatedFetchAndApplySessionFolderAssignments.mockClear();
        sourceData.getCredentialsForServerUrl.mockClear();
        vi.useRealTimers();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        vi.mocked((await import('@/sync/store/hooks')).buildSessionListShellViewItemSignature).mockClear();
        standardCleanup();
    });

    it('keeps the visible list reference stable across unrelated rerenders', async () => {
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();

        const second = await hook.rerender();

        expect(second).toBe(first);
        await hook.unmount();
    });

    it('skips visible-row signature scans when recomputing to the same visible row references', async () => {
        const { buildSessionListShellViewItemSignature } = await import('@/sync/store/hooks');
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        let activeSessionId = 'session-a';
        const hook = await renderHook(() => useVisibleSessionListViewData('all', { activeSessionId }));
        const first = hook.getCurrent();
        vi.mocked(buildSessionListShellViewItemSignature).mockClear();

        activeSessionId = 'session-b';
        const second = await hook.rerender();

        expect(second).toBe(first);
        expect(buildSessionListShellViewItemSignature).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('uses organization pins and order instead of legacy pinned settings', async () => {
        const groupKey = 'server:server-a:active:project:repo';
        sourceData.pinnedKeys = ['server-a:legacy-pinned'];
        sourceData.groupOrder = {
            [groupKey]: ['server-a:legacy-first'],
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                serverId: 'server-a',
            },
            {
                type: 'header',
                title: '~/repo',
                headerKind: 'project',
                groupKey,
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('org-pinned'),
                section: 'active',
                groupKey,
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('org-first'),
                section: 'active',
                groupKey,
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('legacy-pinned'),
                section: 'active',
                groupKey,
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];
        sourceData.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 2,
            pinnedSessionIds: ['org-pinned'],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            labelsByLabelKey: {},
            orderEntriesByScopeKey: {
                'server-a:group:server:server-a:active:project:repo': [
                    { scopeKind: 'group', scopeKey: groupKey, itemKind: 'session', itemKey: 'server-a:org-first', sortKey: 'a' },
                    { scopeKind: 'group', scopeKey: groupKey, itemKind: 'session', itemKey: 'server-a:legacy-pinned', sortKey: 'b' },
                ],
            },
        };

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'session' ? item.session.id : `${item.headerKind}:${item.title}`)).toEqual([
            'pinned:Pinned',
            'org-pinned',
            'active:Active',
            'project:~/repo',
            'org-first',
            'legacy-pinned',
        ]);
        await hook.unmount();
    });

    it('returns a lightweight visible session count that matches hidden-inactive filtering', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('inactive-session', { active: false }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('active-session', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListSessionSummary } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListSessionSummary());

        expect(hook.getCurrent()).toEqual({
            sessionsReady: true,
            visibleSessionCount: 1,
        });
        expect(sourceData.fetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('keeps the lightweight visible session count out of folder assignment and ordering subscriptions', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';

        const { useVisibleSessionListSessionSummary } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListSessionSummary());

        expect(hook.getCurrent()).toEqual({
            sessionsReady: true,
            visibleSessionCount: 1,
        });
        expect(sourceData.openApprovalSessionIdCalls).toBe(0);
        expect(sourceData.sessionFolderAssignmentSubscriptions).toBe(0);
        expect(sourceData.settingMutableKeys).toEqual([]);
        expect(sourceData.fetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not subscribe to server-scoped list rows when server selection is inactive', async () => {
        sourceData.dataByServerId = {
            'server-b': [
                {
                    type: 'session',
                    session: makeRenderableSession('session-b'),
                    section: 'inactive',
                    groupKey: 'server:server-b:day:2026-05-04',
                    groupKind: 'date',
                    serverId: 'server-b',
                },
            ],
        };

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState());

        expect(hook.getCurrent().sessionListViewData?.map((item) => (
            item.type === 'session'
                ? `session:${item.serverId}:${item.session.id}`
                : `header:${item.title}`
        ))).toEqual([
            'header:Today',
            'session:server-a:session-a',
        ]);
        expect(sourceData.sessionListViewDataByServerIdSelections).toEqual([[]]);
        await hook.unmount();
    });

    it('reuses visible rows when a session refresh replaces equivalent source row objects', async () => {
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();

        sourceData.activeData = sourceData.activeData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        const second = await hook.rerender();

        expect(second).toBe(first);
        await hook.unmount();
    });

    it('rebuilds the visible list without signature scans when a push replaces rows around unchanged sessions', async () => {
        const { buildSessionListShellViewItemSignature } = await import('@/sync/store/hooks');
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();
        vi.mocked(buildSessionListShellViewItemSignature).mockClear();

        // A session-list rebuild replaces every row object while unchanged sessions keep their
        // renderable identity, which is what the store hands consumers on a server push.
        sourceData.activeData = sourceData.activeData.map((item) => ({ ...item }));
        const second = await hook.rerender();

        expect(second).toBe(first);
        expect(buildSessionListShellViewItemSignature).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('scans only the changed row when a push rebuilds many rows and one session changes', async () => {
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            ...['session-a', 'session-b', 'session-c', 'session-d'].map((id): SessionListViewItem => ({
                type: 'session',
                session: makeRenderableSession(id),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            })),
        ];
        const { buildSessionListShellViewItemSignature } = await import('@/sync/store/hooks');
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();
        expect(first).toHaveLength(5);
        vi.mocked(buildSessionListShellViewItemSignature).mockClear();

        sourceData.activeData = sourceData.activeData.map((item) => (
            item.type === 'session' && item.session.id === 'session-c'
                ? { ...item, session: { ...item.session, pendingCount: 3 } }
                : { ...item }
        ));
        const second = await hook.rerender();

        expect(second).not.toBe(first);
        expect(second?.[0]).toBe(first?.[0]);
        expect(second?.[1]).toBe(first?.[1]);
        expect(second?.[2]).toBe(first?.[2]);
        expect(second?.[3]).not.toBe(first?.[3]);
        expect(second?.[4]).toBe(first?.[4]);
        // Only the row that actually changed is worth a signature comparison.
        expect(vi.mocked(buildSessionListShellViewItemSignature).mock.calls).toHaveLength(2);
        await hook.unmount();
    });

    it('keeps the visible list shell stable when only row-subscribed session fields change', async () => {
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a', {
                    active: true,
                    seq: 1,
                    updatedAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    thinkingAt: 1,
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();

        sourceData.activeData = sourceData.activeData.map((item) => (
            item.type === 'session'
                ? {
                    ...item,
                    session: {
                        ...item.session,
                        seq: 12,
                        updatedAt: 12,
                        metadataVersion: 12,
                        agentStateVersion: 12,
                        thinkingAt: 12,
                    },
                }
                : item
        ));
        const second = await hook.rerender();

        expect(second).toBe(first);
        await hook.unmount();
    });

    it('replaces a stable-placement session row when visible shell payload changes', async () => {
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a', {
                    active: true,
                    pendingCount: 0,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        machineId: 'm-1',
                        summaryText: 'Initial summary',
                    },
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();
        const firstSessionRow = first?.[1];
        const sessionRow = sourceData.activeData[1];
        if (sessionRow?.type !== 'session' || !sessionRow.session.metadata) {
            throw new Error('expected session metadata test fixture');
        }

        sourceData.activeData = [
            sourceData.activeData[0],
            {
                ...sessionRow,
                session: {
                    ...sessionRow.session,
                    pendingCount: 2,
                    metadata: {
                        ...sessionRow.session.metadata,
                        summaryText: 'Updated summary',
                    },
                },
            },
        ];
        const second = await hook.rerender();

        expect(second).not.toBe(first);
        expect(second?.[1]).not.toBe(firstSessionRow);
        expect(second?.[1]).toMatchObject({
            type: 'session',
            session: {
                pendingCount: 2,
                metadata: {
                    summaryText: 'Updated summary',
                },
            },
        });
        await hook.unmount();
    });

    it('replaces a stable-placement folder header when visible metadata changes', async () => {
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Workspace folder',
                headerKind: 'folder',
                groupKey: 'server:server-a:folder:folder-a',
                folderId: 'folder-a',
                parentFolderId: null,
                depth: 0,
                sessionCount: 1,
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a', {
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        machineId: 'm-1',
                    },
                }),
                section: 'inactive',
                groupKey: 'server:server-a:folder:folder-a',
                groupKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 0,
                serverId: 'server-a',
            },
        ];
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();
        const firstHeader = first?.[0];
        const folderHeader = sourceData.activeData[0];
        const folderSession = sourceData.activeData[1];
        if (folderHeader?.type !== 'header' || folderSession?.type !== 'session') {
            throw new Error('expected folder view data test fixture');
        }

        sourceData.activeData = [
            {
                ...folderHeader,
                sessionCount: 2,
            },
            folderSession,
        ];
        const second = await hook.rerender();

        expect(second).not.toBe(first);
        expect(second?.[0]).not.toBe(firstHeader);
        expect(second?.[0]).toMatchObject({
            type: 'header',
            sessionCount: 2,
        });
        await hook.unmount();
    });

    it('keeps the pane list shell stable when only row-subscribed session fields change', async () => {
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a', {
                    active: true,
                    seq: 1,
                    updatedAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    thinkingAt: 1,
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState());
        const first = hook.getCurrent();

        sourceData.activeData = sourceData.activeData.map((item) => (
            item.type === 'session'
                ? {
                    ...item,
                    session: {
                        ...item.session,
                        seq: 12,
                        updatedAt: 12,
                        metadataVersion: 12,
                        agentStateVersion: 12,
                        thinkingAt: 12,
                    },
                }
                : item
        ));
        const second = await hook.rerender();

        expect(second).toBe(first);
        expect(second.sessionListViewData).toBe(first.sessionListViewData);
        expect(second.visibleSessionCount).toBe(first.visibleSessionCount);
        expect(second.hasHiddenInactiveSessions).toBe(first.hasHiddenInactiveSessions);
        await hook.unmount();
    });

    it('does not compute the unhidden list when hidden inactive filtering still leaves visible sessions', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState());
        const paneState = hook.getCurrent();

        expect(paneState.visibleSessionCount).toBe(1);
        expect(paneState.hasHiddenInactiveSessions).toBe(false);
        await hook.unmount();
    });

    it('does not compute hidden-session availability when the sidebar list is not empty', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useHasHiddenInactiveSessions } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useHasHiddenInactiveSessions());

        expect(hook.getCurrent()).toBe(false);
        const visibleComputeEvent = syncPerformanceTelemetry.snapshot().events.find((event) =>
            event.name === 'sync.sessions.list.visible.compute',
        );
        expect(visibleComputeEvent?.count).toBe(1);
        await hook.unmount();
    });

    it('does not fetch synced folder assignments for the Direct storage filter', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Folder',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 3,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {
                'folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: 'a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Planning',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                        },
                    },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {
                'assigned-session': 'folder-a',
            },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            labelsByLabelKey: {},
            orderEntriesByScopeKey: {
                'server-a:group:server:server-a:active:project:repo': [
                    { scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo', itemKind: 'folder', itemKey: 'folder-a', sortKey: 'a' },
                ],
            },
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('persisted-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('direct-session', {
                    active: true,
                    metadata: {
                        path: '/repo',
                        host: 'machine-a',
                        directSessionV1: { v: 1, providerId: 'codex' },
                    },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('direct'));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['direct-session']);
        expect(hook.getCurrent()?.some((item) => item.type === 'header' && item.headerKind === 'folder'))
            .toBe(false);
        expect(sourceData.fetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('refreshes visible folder assignments through the organization op', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('persisted-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        await vi.waitFor(() => {
            expect(sourceData.fetchAndApplySessionFolderAssignments).toHaveBeenCalledWith(expect.objectContaining({
                credentials: { token: 'token-a', secret: 'secret-a' },
                serverId: 'server-a',
                serverUrl: 'https://server-a.test',
                sessionIds: ['persisted-session'],
                fetchPolicy: 'missing',
            }));
        });
        expect(sourceData.deprecatedFetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not fetch synced folder assignments when the sessions surface is not data-active', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('persisted-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('all', {
            sessionListSurfaceDataActive: false,
        }));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['persisted-session']);
        expect(sourceData.fetchAndApplySessionFolderAssignments).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not write normalized folder order when the sessions surface is not data-active', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('persisted-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];
        sourceData.groupOrder = {
            'server:server-a:active:project:repo': ['server-a:missing-session', 'server-a:persisted-session'],
        };

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('all', {
            sessionListSurfaceDataActive: false,
        }));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['persisted-session']);
        expect(sourceData.setGroupOrder).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('passes created ordering mode into visible list derivation', async () => {
        sourceData.sessionListOrderingModeV1 = 'created';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('old-session', {
                    createdAt: 1,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('new-session', {
                    createdAt: 2,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];
        sourceData.groupOrder = {
            'server:server-a:active:project:repo': ['server-a:old-session', 'server-a:new-session'],
        };

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['new-session', 'old-session']);
        expect(sourceData.setGroupOrder).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('passes single section mode into visible list derivation', async () => {
        sourceData.sessionListOrderingModeV1 = 'updated';
        sourceData.sessionListSectionModeV1 = 'single';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Sessions',
                headerKind: 'sessions',
                groupKey: 'sessions:server-a',
                serverId: 'server-a',
            },
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:project:repo',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('active-old', {
                    active: true,
                    createdAt: 1,
                    meaningfulActivityAt: 1,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('inactive-new', {
                    active: false,
                    createdAt: 2,
                    meaningfulActivityAt: 900_000,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'inactive',
                groupKey: 'server:server-a:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['inactive-new', 'active-old']);
        await hook.unmount();
    });

    it('preserves dormant ordinary session order keys while normalizing structural order in date modes', async () => {
        sourceData.sessionListOrderingModeV1 = 'updated';
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 3,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {
                'folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: 'a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Planning',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                        },
                    },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {
                'assigned-session': 'folder-a',
            },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            labelsByLabelKey: {},
            orderEntriesByScopeKey: {
                'server-a:group:server:server-a:active:project:repo': [
                    { scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo', itemKind: 'folder', itemKey: 'folder-a', sortKey: 'a' },
                ],
            },
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('known-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];
        sourceData.groupOrder = {
            'server:server-a:active:project:repo': [
                'server-a:missing-session',
                'server-a:known-session',
                'folder:folder-a',
            ],
        };

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('persisted'));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['known-session']);
        expect(sourceData.setGroupOrder).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('preserves dormant folder structural order while folder view is off in date modes', async () => {
        sourceData.sessionListOrderingModeV1 = 'updated';
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'off';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('known-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];
        sourceData.groupOrder = {
            'server:server-a:active:project:repo': [
                'server-a:known-session',
                'folder:folder-a',
            ],
        };

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('persisted'));

        expect(hook.getCurrent()?.filter((item) => item.type === 'session').map((item) => item.session.id))
            .toEqual(['known-session']);
        expect(sourceData.setGroupOrder).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('passes the global attention placement setting into visible list derivation', async () => {
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('ready-session', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 20,
                    lastViewedSessionSeq: 1,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 10,
                    lastViewedSessionSeq: 4,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}`
        )).toEqual([
            'header:attention',
            'session:ready-session:attention',
            'header:date',
            'session:normal-session:date',
        ]);
        await hook.unmount();
    });

    it('promotes completed turns without ready-event metadata when they are newer than the read cursor', async () => {
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('completed-session', {
                    seq: 5,
                    updatedAt: 30,
                    latestTurnStatus: 'completed',
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    lastViewedSessionSeq: 4,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('read-session', {
                    seq: 5,
                    updatedAt: 20,
                    latestTurnStatus: 'completed',
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    lastViewedSessionSeq: 5,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:attention',
            'session:completed-session:attention:ready',
            'header:date',
            'session:read-session:date:none',
        ]);
        await hook.unmount();
    });

    it('promotes open approval artifacts even when the linked session is still in progress', async () => {
        const now = Date.now();
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.openApprovalSessionIds = ['server-a:approval-session'];
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('approval-session', {
                    active: true,
                    activeAt: now,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now,
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:attention',
            'session:approval-session:attention:permission_required',
            'header:active',
            'session:normal-session:active:none',
        ]);
        await hook.unmount();
    });

    it('demotes approval-backed attention rows after the approval closes', async () => {
        const now = Date.now();
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.openApprovalSessionIds = ['server-a:approval-session'];
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('approval-session', {
                    active: true,
                    activeAt: now,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now,
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const initialPromotedItem = hook.getCurrent()?.[1];
        expect(initialPromotedItem?.type === 'session' ? initialPromotedItem.groupKind : null).toBe('attention');

        sourceData.openApprovalSessionIds = [];
        const next = await hook.rerender();

        expect(next?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:active',
            'session:normal-session:active:none',
            'session:approval-session:active:none',
        ]);
        await hook.unmount();
    });

    it('promotes only the matching server row when open approvals share a session id across servers', async () => {
        const now = Date.now();
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.openApprovalSessionIds = ['server-a:shared-session'];
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Server A',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('shared-session', {
                    active: true,
                    activeAt: now,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now,
                }),
                section: 'active',
                groupKey: 'server:server-a:active',
                groupKind: 'active',
                serverId: 'server-a',
            },
            {
                type: 'header',
                title: 'Server B',
                headerKind: 'active',
                groupKey: 'server:server-b:active',
                serverId: 'server-b',
            },
            {
                type: 'session',
                session: makeRenderableSession('shared-session', {
                    active: true,
                    activeAt: now,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now,
                }),
                section: 'active',
                groupKey: 'server:server-b:active',
                groupKind: 'active',
                serverId: 'server-b',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.title}:${item.serverId ?? 'none'}`
            : `session:${item.session.id}:${item.serverId ?? 'none'}:${item.groupKind ?? 'unknown'}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:Needs attention:none',
            'session:shared-session:server-a:attention:permission_required',
            'header:Server B:server-b',
            'session:shared-session:server-b:active:none',
        ]);
        await hook.unmount();
    });

    it('passes the within-groups attention placement setting into visible list derivation', async () => {
        sourceData.sessionListAttentionPromotionMode = 'withinGroups';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('ready-session', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 20,
                    lastViewedSessionSeq: 1,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}`
        )).toEqual([
            'header:date',
            'session:ready-session:date',
            'session:normal-session:date',
        ]);
        await hook.unmount();
    });

    it('holds the selected attention row in place after its ready marker is acknowledged', async () => {
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('ready-session', {
                    latestReadyEventSeq: 4,
                    latestReadyEventAt: 30,
                    latestTurnStatusObservedAt: 30,
                    lastViewedSessionSeq: 1,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('later-ready-session', {
                    latestReadyEventSeq: 3,
                    latestReadyEventAt: 20,
                    latestTurnStatusObservedAt: 20,
                    lastViewedSessionSeq: 1,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('all', { activeSessionId: 'ready-session' }));

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}`
        )).toEqual([
            'header:attention',
            'session:ready-session:attention',
            'session:later-ready-session:attention',
            'header:date',
            'session:normal-session:date',
        ]);

        sourceData.activeData = sourceData.activeData.map((item) => item.type === 'session' && item.session.id === 'ready-session'
            ? {
                ...item,
                session: {
                    ...item.session,
                    lastViewedSessionSeq: 4,
                },
            }
            : item);

        const next = await hook.rerender();

        expect(next?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}`
        )).toEqual([
            'header:attention',
            'session:ready-session:attention',
            'session:later-ready-session:attention',
            'header:date',
            'session:normal-session:date',
        ]);
        await hook.unmount();
    });

    it('keeps a read standing session in the attention band behind the sessions that earned it', async () => {
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('standing-session', { seq: 4, lastViewedSessionSeq: 4 }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('unread-session', {
                    seq: 9,
                    lastViewedSessionSeq: 4,
                    hasUnreadMessages: true,
                    unreadSince: 20,
                }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('quiet-session', { seq: 4, lastViewedSessionSeq: 4 }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        sourceData.sessionOrganizationProjection = makeOrganizationProjection({
            'standing-session': { sessionId: 'standing-session', standing: true, updatedAt: 10 },
        });

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:attention',
            'session:unread-session:unread',
            'session:standing-session:standing',
            'header:date',
            'session:quiet-session:none',
        ]);
        await hook.unmount();
    });

    it('drops the session being viewed out of the attention band as soon as its standing is removed', async () => {
        sourceData.sessionListAttentionPromotionMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('standing-session', { seq: 4, lastViewedSessionSeq: 4 }),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        sourceData.sessionOrganizationProjection = makeOrganizationProjection({
            'standing-session': { sessionId: 'standing-session', standing: true, updatedAt: 10 },
        });

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('all', { activeSessionId: 'standing-session' }));

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:attention',
            'session:standing-session:standing',
        ]);

        sourceData.sessionOrganizationProjection = makeOrganizationProjection({
            'standing-session': { sessionId: 'standing-session', standing: false, updatedAt: 20 },
        });

        expect((await hook.rerender())?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.attentionPromotionReason ?? 'none'}`
        )).toEqual([
            'header:date',
            'session:standing-session:none',
        ]);
        await hook.unmount();
    });

    it('retains visible working rows across active session switches while local runtime freshness is stale', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        sourceData.sessionListWorkingPlacementMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('working-session', {
                    active: true,
                    activeAt: 1_000_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000_000,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('other-working-session', {
                    active: true,
                    activeAt: 1_000_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000_000,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', {
                    active: true,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        let activeSessionId = 'working-session';

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('all', { activeSessionId }));

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:working',
            'session:working-session:working:working',
            'session:other-working-session:working:working',
            'header:date',
            'session:normal-session:date:none',
        ]);

        vi.setSystemTime(1_130_001);
        activeSessionId = 'normal-session';
        const [header, selectedWorking, otherWorking, normal] = sourceData.activeData;
        sourceData.activeData = [header!, otherWorking!, selectedWorking!, normal!];

        const next = await hook.rerender();

        expect(next?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:working',
            'session:working-session:working:working',
            'session:other-working-session:working:working',
            'header:date',
            'session:normal-session:date:none',
        ]);
        await hook.unmount();
    });

    it('does not promote background activity into non-live global working placement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        sourceData.sessionListWorkingPlacementMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('runtime-active-session', {
                    active: false,
                    activeAt: 1_000_000,
                    presence: 0,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 999_000,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 999_000,
                    runtimeActivityRevision: 1,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', {
                    active: true,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:date',
            'session:runtime-active-session:date:none',
            'session:normal-session:date:none',
        ]);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 60_001 });

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:date',
            'session:runtime-active-session:date:none',
            'session:normal-session:date:none',
        ]);
        await hook.unmount();
    });

    it('recomputes pane-state placement from the shared runtime clock when working freshness expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        sourceData.sessionListWorkingPlacementMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('working-session', {
                    active: true,
                    activeAt: 999_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000_000,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState('all'));

        const readShape = () => hook.getCurrent().sessionListViewData?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`);

        expect(readShape()).toEqual([
            'header:working',
            'session:working-session:working:working',
        ]);

        // The working freshness window expires at observedAt + 120s. The
        // pane-state surface (tablet sidebar) must recompute placement from
        // the shared clock wake — previously it never re-evaluated and kept
        // presenting live 'working' placement indefinitely.
        await flushHookEffects({ advanceTimersMs: 121_000, cycles: 1, turns: 2 });

        expect(readShape()).toEqual([
            'header:working',
            'session:working-session:working:working-retained',
        ]);

        await hook.unmount();
    });

    it('renders the visible list without a Node stdout stream', async () => {
        const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
        Object.defineProperty(process, 'stdout', {
            configurable: true,
            value: undefined,
        });

        let hook: Awaited<ReturnType<typeof renderHook<SessionListViewItem[] | null>>> | null = null;
        try {
            const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
            hook = await renderHook(() => useVisibleSessionListViewData());

            expect(hook.getCurrent()?.map((item) => item.type === 'header'
                ? `header:${item.headerKind ?? 'unknown'}`
                : `session:${item.session.id}`
            )).toEqual([
                'header:date',
                'session:session-a',
            ]);
        } finally {
            if (hook) await hook.unmount();
            if (stdoutDescriptor) {
                Object.defineProperty(process, 'stdout', stdoutDescriptor);
            }
        }
    });

    it('uses a retained visible-list seed after the pane-state hook remounts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        sourceData.sessionListWorkingPlacementMode = 'global';
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('working-session', {
                    active: true,
                    activeAt: 1_000_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1_000_000,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('normal-session', {
                    active: true,
                }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const firstHook = await renderHook(() => useVisibleSessionListPaneState('all'));
        const retainedSessionListViewData = firstHook.getCurrent().sessionListViewData;
        expect(retainedSessionListViewData?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:working',
            'session:working-session:working:working',
            'header:date',
            'session:normal-session:date:none',
        ]);
        await firstHook.unmount();

        vi.setSystemTime(1_130_001);
        const remountOptions: Parameters<typeof useVisibleSessionListPaneState>[1] & Readonly<{
            retainedSessionListViewData: typeof retainedSessionListViewData;
        }> = {
            retainedSessionListViewData,
        };
        const remountedHook = await renderHook(() => useVisibleSessionListPaneState('all', remountOptions));

        expect(remountedHook.getCurrent().sessionListViewData?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.workingPlacementReason ?? 'none'}`
        )).toEqual([
            'header:working',
            // Signals are stale at the remount time, so the seed retains the
            // session in the working group with the distinct retained reason.
            'session:working-session:working:working-retained',
            'header:date',
            'session:normal-session:date:none',
        ]);
        await remountedHook.unmount();
    });

    it('keeps the workspace header when every visible workspace session is assigned to a folder', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 3,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {
                'folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: 'a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Planning',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                        },
                    },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {
                'assigned-session': 'folder-a',
            },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            labelsByLabelKey: {},
            orderEntriesByScopeKey: {
                'server-a:group:server:server-a:active:project:repo': [
                    { scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo', itemKind: 'folder', itemKey: 'folder-a', sortKey: 'a' },
                ],
            },
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('assigned-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('persisted'));

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.folderId ?? 'root'}`
        )).toEqual([
            'header:active:Active',
            'header:project:Project',
            'header:folder:Planning',
            'session:assigned-session:folder:folder-a',
        ]);
        await hook.unmount();
    });

    it('applies mixed root folder and session order after folder source normalization', async () => {
        sourceData.sessionFoldersEnabled = true;
        sourceData.sessionFolderViewModeV1 = 'tree';
        sourceData.sessionListFolderSortModeV1 = 'mixed';
        sourceData.sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sourceData.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 3,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {
                'folder-a': {
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: 'a',
                    display: {
                        t: 'plain',
                        v: {
                            name: 'Planning',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'server-a',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                        },
                    },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            folderAssignmentsBySessionId: {
                'assigned-session': 'folder-a',
            },
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            labelsByLabelKey: {},
            orderEntriesByScopeKey: {
                'server-a:group:server:server-a:active:project:repo': [
                    { scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo', itemKind: 'session', itemKey: 'root-session', sortKey: 'a' },
                    { scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo', itemKind: 'folder', itemKey: 'folder-a', sortKey: 'b' },
                ],
            },
        };
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server-a:active',
                serverId: 'server-a',
            },
            {
                type: 'header',
                title: 'Project',
                headerKind: 'project',
                groupKey: 'server:server-a:active:project:repo',
                serverId: 'server-a',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/repo',
                },
            },
            {
                type: 'session',
                session: makeRenderableSession('root-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('assigned-session', {
                    active: true,
                    metadata: { path: '/repo', host: 'machine-a' },
                }),
                section: 'active',
                groupKey: 'server:server-a:active:project:repo',
                groupKind: 'project',
                serverId: 'server-a',
            },
        ];

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData('persisted'));

        expect(hook.getCurrent()?.map((item) => item.type === 'header'
            ? `header:${item.headerKind ?? 'unknown'}:${item.title}`
            : `session:${item.session.id}:${item.groupKind ?? 'unknown'}:${item.folderId ?? 'root'}`
        )).toEqual([
            'header:active:Active',
            'header:project:Project',
            'session:root-session:project:root',
            'header:folder:Planning',
            'session:assigned-session:folder:folder-a',
        ]);
        expect(sourceData.setGroupOrder).not.toHaveBeenCalledWith({
            'server:server-a:active:project:repo': ['server-a:root-session'],
        });
        await hook.unmount();
    });
});
