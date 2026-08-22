/**
 * LANE-1 diagnosis (React level): the REAL store -> REAL useSessionOrganizationProjection
 * -> REAL buildSessionOrganizationListViewState -> REAL useSessionAttentionStandingInputs
 * -> REAL useVisibleSessionListViewData chain, driven by the REAL optimistic store action
 * `setSessionAttentionStandingOptimistic` that `setSessionAttentionStanding` calls.
 *
 * Only genuine boundaries are stood in for: the committed session-list source rows, the
 * settings reads, server selection, feature flags, credentials and the folder-assignment op.
 * `useSessionOrganizationProjection` is deliberately NOT mocked here (unlike
 * useVisibleSessionListViewData.test.tsx), so the store subscription is under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

const SERVER_ID = 'server-a';
const SESSION_ID = 'quiet-session';

function makeRenderableSession(id: string, overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id,
        seq: 4,
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
        lastViewedSessionSeq: 4,
        ...overrides,
    } as SessionListRenderableSession;
}

const sourceData = vi.hoisted(() => ({
    activeData: [] as unknown[],
    sessionListAttentionPromotionMode: 'global' as 'off' | 'global' | 'withinGroups',
    hideInactiveSessions: false,
    setSessionAttentionStandingApi: vi.fn(),
}));

sourceData.activeData = [
    {
        type: 'header',
        title: 'Today',
        headerKind: 'date',
        groupKey: `server:${SERVER_ID}:day:2026-05-04`,
        serverId: SERVER_ID,
    },
    {
        type: 'session',
        session: makeRenderableSession(SESSION_ID),
        section: 'inactive',
        groupKey: `server:${SERVER_ID}:day:2026-05-04`,
        groupKind: 'date',
        serverId: SERVER_ID,
    },
] satisfies SessionListViewItem[];

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sourceData.activeData as SessionListViewItem[],
            useSessionListViewDataByServerId: () => ({}),
            useOpenApprovalSessionIds: () => [],
            useSessionFolderAssignmentsBySessionKey: () => ({}),
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return sourceData.hideInactiveSessions;
                if (key === 'sessionListAttentionPromotionModeV1') return sourceData.sessionListAttentionPromotionMode;
                if (key === 'sessionListAttentionStandingDefaultV1') return false;
                if (key === 'sessionListWorkingPlacementModeV1') return 'off';
                if (key === 'sessionListOrderingModeV1') return 'custom';
                if (key === 'sessionListSectionModeV1') return 'activity';
                if (key === 'sessionFolderViewModeV1') return 'off';
                if (key === 'sessionFoldersV1') return { v: 1, folders: [] };
                return null;
            },
            useLocalSetting: <K extends keyof LocalSettings>(key: K): LocalSettings[K] => localSettingsDefaults[key],
            useSettingMutable: () => [null, vi.fn()],
        },
    });
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: false,
        activeServerId: SERVER_ID,
        allowedServerIds: [SERVER_ID],
        presentation: 'grouped',
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: (serverId: string) => (serverId === SERVER_ID
        ? { id: SERVER_ID, serverUrl: 'https://server-a.test' }
        : null),
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => (
        profile.serverIdentityId ?? profile.id
    ),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: { getCredentialsForServerUrl: vi.fn(async () => ({ token: 't', secret: 's' })) },
}));

vi.mock('@/sync/ops/sessionOrganization', () => ({
    fetchAndApplySessionFolderAssignments: vi.fn(async () => undefined),
}));

vi.mock('@/sync/ops/sessionFolders', () => ({
    fetchAndApplySessionFolderAssignments: vi.fn(async () => undefined),
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', () => ({
    setSessionAttentionStanding: sourceData.setSessionAttentionStandingApi,
}));

function describeRows(items: SessionListViewItem[] | null): string[] {
    return (items ?? []).map((item) => (item.type === 'header'
        ? `header:${item.headerKind ?? 'unknown'}`
        : `session:${item.session.id}:${item.groupKind ?? 'none'}:${item.attentionPromotionReason ?? 'none'}`));
}

describe('attention standing reaches the visible session list through the real store subscription', () => {
    afterEach(() => {
        sourceData.hideInactiveSessions = false;
        sourceData.setSessionAttentionStandingApi.mockReset();
        standardCleanup();
    });

    it('moves an ungrouped, reason-less session into the attention band when the keep lands in the store', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        act(() => {
            getStorage().getState().applySessionOrganizationSnapshot(SERVER_ID, {
                schemaVersion: 1,
                version: 1,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
                attentionStandings: [],
            });
        });

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(describeRows(hook.getCurrent())).toEqual([
            'header:date',
            `session:${SESSION_ID}:date:none`,
        ]);

        // Exactly the write `setSessionAttentionStanding` performs for "Keep in Needs attention".
        await act(async () => {
            getStorage().getState().setSessionAttentionStandingOptimistic(SERVER_ID, SESSION_ID, {
                sessionId: SESSION_ID,
                standing: true,
                updatedAt: Date.now(),
            });
        });

        expect(describeRows(hook.getCurrent())).toEqual([
            'header:attention',
            `session:${SESSION_ID}:attention:standing`,
        ]);

        await hook.unmount();
    });

    it('moves a quiet session into an existing attention band when the REAL keep op runs (hidden inactive sessions on)', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: `server:${SERVER_ID}:day:2026-05-04`,
                serverId: SERVER_ID,
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
                groupKey: `server:${SERVER_ID}:day:2026-05-04`,
                groupKind: 'date',
                serverId: SERVER_ID,
            },
            {
                type: 'session',
                session: makeRenderableSession(SESSION_ID),
                section: 'inactive',
                groupKey: `server:${SERVER_ID}:day:2026-05-04`,
                groupKind: 'date',
                serverId: SERVER_ID,
            },
        ] satisfies SessionListViewItem[];

        const { getStorage } = await import('@/sync/domains/state/storageStore');
        act(() => {
            getStorage().getState().applySessionOrganizationSnapshot(SERVER_ID, {
                schemaVersion: 1,
                version: 1,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
                attentionStandings: [],
            });
        });

        sourceData.setSessionAttentionStandingApi.mockResolvedValue({
            standing: { sessionId: SESSION_ID, standing: true, updatedAt: 99 },
        });

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());

        expect(describeRows(hook.getCurrent())).toEqual([
            'header:attention',
            'session:unread-session:attention:unread',
        ]);

        // The REAL op the row menu reaches through executeSessionAction.
        const { sessionSetAttentionStandingWithServerScope } = await import('@/sync/ops/sessionOrganization/setSessionAttentionStanding');
        let opResult: { success: boolean; message?: string } | undefined;
        await act(async () => {
            opResult = await sessionSetAttentionStandingWithServerScope(SESSION_ID, true, { serverId: SERVER_ID });
        });
        expect(opResult).toEqual({ success: true });

        expect(describeRows(hook.getCurrent())).toEqual([
            'header:attention',
            'session:unread-session:attention:unread',
            `session:${SESSION_ID}:attention:standing`,
        ]);

        await hook.unmount();
    });
});
