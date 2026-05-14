import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { accountSettingsParse } from '@happier-dev/protocol';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installActivityBadgeRuntimeCommonModuleMocks } from './activityBadgeRuntimeTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'web' | 'ios' | 'android',
}));

let isTauriDesktopValue = false;
type BadgeRuntimeSessionFixture = { id: string } & Record<string, unknown>;

let sessionsValue: BadgeRuntimeSessionFixture[] = [];
let activityAttentionSourceValue = createActivityAttentionSource([]);
let friendRequestsValue: Array<{ id: string }> = [];
let localSettingsValue: Record<string, unknown> = {
    activityBadgesEnabled: true,
    activityBadgeShowUnread: true,
    activityBadgeShowPendingPermissionRequests: true,
    activityBadgeShowPendingUserActionRequests: true,
    activityBadgeShowQueuedUserInput: true,
    activityBadgeShowFriendRequestsInboxCount: true,
    activityBadgeShowDesktopNonNumericDot: true,
};
let accountSettingsValue = accountSettingsParse({});
let updateAvailableValue = false;
let changelogUnreadValue = false;

const applyExpoNativeBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const applyTauriBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const serverFetch = vi.hoisted(() => vi.fn());
const activeServerSnapshot = vi.hoisted(() => ({
    value: {
        serverId: 'server-1',
        serverUrl: 'https://api.example.test',
        generation: 1,
    },
}));

function createActivityAttentionSource(sessions: BadgeRuntimeSessionFixture[]) {
    return {
        isDataReady: true,
        sessionsById: Object.fromEntries(sessions.map((session) => [session.id, session])),
        sessionListRenderablesById: Object.fromEntries(sessions.map((session) => [session.id, session])),
        sessionListIndexByServerId: {
            'server-1': sessions.map((session) => ({
                type: 'session',
                sessionId: session.id,
                serverId: 'server-1',
                serverName: null,
            })),
        },
        concurrentSessionListCacheByServerId: {},
    };
}

function setActivitySessions(sessions: BadgeRuntimeSessionFixture[]): void {
    sessionsValue = sessions;
    activityAttentionSourceValue = createActivityAttentionSource(sessions);
}

installActivityBadgeRuntimeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllSessions: () => sessionsValue,
            useFriendRequests: () => friendRequestsValue,
            useLocalSettings: () => localSettingsValue,
            useSettings: () => accountSettingsValue,
        });
    },
});

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({ updateAvailable: updateAvailableValue }),
}));

vi.mock('@/hooks/inbox/useChangelog', () => ({
    useChangelog: () => ({ hasUnread: changelogUnreadValue }),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopValue,
}));

vi.mock('@/activity/source/useActivityAttentionSource', () => ({
    useActivityAttentionSource: () => activityAttentionSourceValue,
}));

vi.mock('./channels/applyExpoNativeBadgeState', () => ({
    applyExpoNativeBadgeState,
}));

vi.mock('./channels/applyTauriBadgeState', () => ({
    applyTauriBadgeState,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshot.value,
}));

describe('ActivityBadgeRuntime', () => {
    afterEach(() => {
        platformState.os = 'ios';
        isTauriDesktopValue = false;
        setActivitySessions([]);
        friendRequestsValue = [];
        localSettingsValue = {
            activityBadgesEnabled: true,
            activityBadgeShowUnread: true,
            activityBadgeShowPendingPermissionRequests: true,
            activityBadgeShowPendingUserActionRequests: true,
            activityBadgeShowQueuedUserInput: true,
            activityBadgeShowFriendRequestsInboxCount: true,
            activityBadgeShowDesktopNonNumericDot: true,
        };
        accountSettingsValue = accountSettingsParse({});
        updateAvailableValue = false;
        changelogUnreadValue = false;
        applyExpoNativeBadgeState.mockClear();
        applyTauriBadgeState.mockClear();
        serverFetch.mockReset();
        activeServerSnapshot.value = {
            serverId: 'server-1',
            serverUrl: 'https://api.example.test',
            generation: 1,
        };
    });

    it('applies the native mobile badge count from session and inbox activity', async () => {
        setActivitySessions([
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                pendingPermissionRequestCount: 2,
                pendingUserActionRequestCount: 0,
                pendingCount: 1,
                metadata: { path: '', host: '' },
            },
        ]);
        friendRequestsValue = [{ id: 'friend-1' }, { id: 'friend-2' }];

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 3,
            showNonNumericDot: false,
        });
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies badge counts from unread session-list renderables without hydrated sessions', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            sessionsById: {},
            sessionListRenderablesById: {
                'session-renderable': {
                    id: 'session-renderable',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    hasUnreadMessages: true,
                },
            },
            sessionListIndexByServerId: {
                'server-1': [{
                    type: 'session',
                    sessionId: 'session-renderable',
                    serverId: 'server-1',
                    serverName: null,
                }],
            },
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not clear native badges while activity source data is still bootstrapping', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('applies tauri badge counts from warm activity source rows before full data readiness', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
            sessionsById: {},
            sessionListRenderablesById: {
                'session-warm-unread': {
                    id: 'session-warm-unread',
                    seq: 4,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    hasUnreadMessages: true,
                },
            },
            sessionListIndexByServerId: {
                'server-1': [{
                    type: 'session',
                    sessionId: 'session-warm-unread',
                    serverId: 'server-1',
                    serverName: null,
                }],
            },
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });
        expect(serverFetch).toHaveBeenCalledWith('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('seeds the native badge from the server snapshot while activity source data is bootstrapping', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
        };
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(serverFetch).toHaveBeenCalledWith('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });
        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 4,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('clears badge channels when badges are disabled on this device', async () => {
        setActivitySessions([
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
            },
        ]);
        friendRequestsValue = [{ id: 'friend-1' }];
        localSettingsValue = {
            ...localSettingsValue,
            activityBadgesEnabled: false,
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows the tauri dock dot only for non-numeric inbox attention when enabled', async () => {
        platformState.os = 'web';
        isTauriDesktopValue = true;
        updateAvailableValue = true;

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyTauriBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: true,
        });
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('clears badge channels when the account badge channel is disabled', async () => {
        setActivitySessions([
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
            },
        ]);
        friendRequestsValue = [{ id: 'friend-1' }];
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: {
                    badge: { enabled: false },
                },
            },
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses nested device badge overrides for session attention filters', async () => {
        setActivitySessions([
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                metadata: { path: '', host: '' },
            },
        ]);
        localSettingsValue = {
            ...localSettingsValue,
            attentionDeviceOverridesV1: {
                v: 1,
                badge: {
                    includeUnread: false,
                },
            },
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('reads badge session attention from the normalized activity source', async () => {
        sessionsValue = [];
        activityAttentionSourceValue = {
            isDataReady: true,
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRenderablesById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListIndexByServerId: {
                'server-1': [
                    {
                        type: 'session',
                        sessionId: 'session-normalized',
                        serverId: 'server-1',
                        serverName: null,
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not reapply native badge channels when activity source identity changes without badge state changes', async () => {
        activityAttentionSourceValue = createActivityAttentionSource([
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 10,
                metadata: null,
            },
        ]);

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        activityAttentionSourceValue = createActivityAttentionSource([
            {
                id: 'session-1',
                seq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 11,
                metadata: null,
            },
        ]);

        await act(async () => {
            tree?.update(<ActivityBadgeRuntime />);
        });

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('prefers hydrated session unread state over stale renderable state from the activity source', async () => {
        sessionsValue = [];
        activityAttentionSourceValue = {
            isDataReady: true,
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRenderablesById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    metadata: { path: '', host: '' },
                    hasUnreadMessages: false,
                },
            },
            sessionListIndexByServerId: {
                'server-1': [
                    {
                        type: 'session',
                        sessionId: 'session-normalized',
                        serverId: 'server-1',
                        serverName: null,
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not count stale renderable unread state when the hydrated activity-source session is read', async () => {
        sessionsValue = [];
        activityAttentionSourceValue = {
            isDataReady: true,
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRenderablesById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                    hasUnreadMessages: true,
                },
            },
            sessionListIndexByServerId: {
                'server-1': [
                    {
                        type: 'session',
                        sessionId: 'session-normalized',
                        serverId: 'server-1',
                        serverName: null,
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });
});
