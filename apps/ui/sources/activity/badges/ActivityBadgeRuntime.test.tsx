import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import type { StorageState } from '@/sync/store/types';
import {
    installActivityBadgeRuntimeCommonModuleMocks,
    installBadgeHomeIdentities,
} from './activityBadgeRuntimeTestHelpers';
import { persistBadgeHomeAccountSettings } from './activityBadgeRuntimeHomeFixtures';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'web' | 'ios' | 'android',
}));

let isDesktopHostValue = false;
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
// The canonical Activity Home set the badge reads its per-Home policy for. Empty would mean "no
// Home has answered yet", which the runtime treats as "do not write the badge".
const DEFAULT_BADGE_HOME_MEMBERSHIP: Readonly<Record<string, readonly string[]>> = { 'server-1': [] };
const DEFAULT_BADGE_HOME_QUERY_STATES = {};
let personalSessionMembershipValue: Readonly<Record<string, readonly string[]>> = DEFAULT_BADGE_HOME_MEMBERSHIP;
let rejectBroadActivitySourceRead = false;
let rejectBroadLocalSettingsRead = false;
let rejectBroadAccountSettingsRead = false;

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

type BadgeRuntimeSessionListIndexItemFixture = Readonly<{
    type: 'session';
    sessionId: string;
    serverId: string;
    serverName: string | null;
}>;

/**
 * The badge reads per-Home projections, so every by-Home map is keyed by an
 * arbitrary `serverId` rather than the single Home this default builds.
 */
function createActivityAttentionSource(sessions: BadgeRuntimeSessionFixture[]) {
    const sessionsById: Record<string, BadgeRuntimeSessionFixture> = Object.fromEntries(
        sessions.map((session) => [session.id, session]),
    );
    const sessionListRowsByServerId: Record<string, Record<string, BadgeRuntimeSessionFixture>> = {
        'server-1': Object.fromEntries(sessions.map((session) => [session.id, session])),
    };
    const ordinarySessionListMembershipByServerId: Record<string, string[]> = {
        'server-1': sessions.map((session) => session.id),
    };
    const sessionListIndexByServerId: Record<string, BadgeRuntimeSessionListIndexItemFixture[]> = {
        'server-1': sessions.map((session) => ({
            type: 'session',
            sessionId: session.id,
            serverId: 'server-1',
            serverName: null,
        })),
    };
    return {
        isDataReady: true,
        sessionsById,
        sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: {},
        activeServerId: 'server-1',
    };
}

function setActivitySessions(sessions: BadgeRuntimeSessionFixture[]): void {
    // Full Sessions carry agentState; without it a row reads as a list summary that owns no request counts.
    const fullSessions = sessions.map((session) => ({ agentState: null, ...session }));
    sessionsValue = fullSessions;
    activityAttentionSourceValue = createActivityAttentionSource(fullSessions);
}

const EMPTY_BADGE_RUNTIME_MESSAGES = {};
const BADGE_RUNTIME_PROFILE_SCOPE = { serverId: 'server-1', accountId: 'account-1' };

function createBadgeRuntimeStorageState(): StorageState {
    const state = {
        sessions: activityAttentionSourceValue.sessionsById,
        machines: {},
        sessionMessages: EMPTY_BADGE_RUNTIME_MESSAGES,
        sessionPending: {},
        sessionListRowsByServerId: activityAttentionSourceValue.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: activityAttentionSourceValue.ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId: activityAttentionSourceValue.sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: activityAttentionSourceValue.concurrentSessionListCacheByServerId,
        isDataReady: activityAttentionSourceValue.isDataReady,
        profileScope: BADGE_RUNTIME_PROFILE_SCOPE,
        localSettings: localSettingsDefaults,
    };
    // Test storage only needs the badge selector slice; missing domain methods are never read here.
    return state as unknown as StorageState;
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
        const storage = Object.assign(
            ((selector?: (state: StorageState) => unknown) => {
                const state = createBadgeRuntimeStorageState();
                return typeof selector === 'function' ? selector(state) : state;
            }),
            {
                getState: createBadgeRuntimeStorageState,
                getInitialState: createBadgeRuntimeStorageState,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        );
        return createStorageModuleStub({
            storage,
            useAllSessions: () => sessionsValue,
            useFriendRequestCount: () => friendRequestsValue.length,
            useLocalSetting: (key: string) => (
                Object.prototype.hasOwnProperty.call(localSettingsValue, key)
                    ? localSettingsValue[key]
                    : key === 'attentionDeviceOverridesV1'
                        ? undefined
                    : localSettingsDefaults[key as keyof typeof localSettingsDefaults]
            ),
            useSetting: (key: string) => accountSettingsValue[key as keyof typeof accountSettingsValue],
            useLocalSettings: () => {
                if (rejectBroadLocalSettingsRead) {
                    throw new Error('ActivityBadgeRuntime must not subscribe to all local settings');
                }
                return localSettingsValue;
            },
            useSettings: () => {
                if (rejectBroadAccountSettingsRead) {
                    throw new Error('ActivityBadgeRuntime must not subscribe to all account settings');
                }
                return accountSettingsValue;
            },
        });
    },
});

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({ updateAvailable: updateAvailableValue }),
}));

vi.mock('@/hooks/inbox/useChangelog', () => ({
    useChangelog: () => ({ hasUnread: changelogUnreadValue }),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostValue,
}));

vi.mock('@/activity/source/useActivityAttentionSource', () => ({
    useActivityAttentionSource: () => {
        if (rejectBroadActivitySourceRead) {
            throw new Error('ActivityBadgeRuntime must not subscribe to the broad activity source');
        }
        return activityAttentionSourceValue;
    },
}));

vi.mock('@/activity/source/activityPersonalSessionMembership', () => ({
    useActivityPersonalSessionMembership: () => ({
        membershipByServerId: personalSessionMembershipValue,
        statesByServerId: DEFAULT_BADGE_HOME_QUERY_STATES,
        coverageComplete: true,
    }),
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

// Each Home's reachable address and the Account this device holds there are established in
// `beforeEach` through the real Home owner plus a spy on the device credential store — the one
// genuine boundary. The rule recorded at `installBadgeHomeIdentities` says why neither
// `serverProfiles` nor `tokenStorage` may be `vi.mock`ed from this corridor.

describe('ActivityBadgeRuntime', () => {
    beforeEach(async () => {
        // Home testkit imports may load this SDK port before the optional mock factory is installed.
        // Set the live platform boundary as well, so native cases cannot silently run as web.
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, get: () => platformState.os });
        // Every Home in the badge corpus starts saved, credentialled, and carrying its own
        // persisted Account settings; a Home without them fails closed, which several cases below
        // assert deliberately.
        await installBadgeHomeIdentities(['server-1', 'server-2']);
        await persistBadgeHomeAccountSettings('server-1');
        await persistBadgeHomeAccountSettings('server-2');
    });

    afterEach(() => {
        platformState.os = 'ios';
        isDesktopHostValue = false;
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
        personalSessionMembershipValue = DEFAULT_BADGE_HOME_MEMBERSHIP;
        rejectBroadActivitySourceRead = false;
        rejectBroadLocalSettingsRead = false;
        rejectBroadAccountSettingsRead = false;
        applyExpoNativeBadgeState.mockClear();
        applyTauriBadgeState.mockClear();
        serverFetch.mockReset();
        activeServerSnapshot.value = {
            serverId: 'server-1',
            serverUrl: 'https://api.example.test',
            generation: 1,
        };
        vi.useRealTimers();
    });

    it('applies the native mobile badge count from session and inbox activity', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        setActivitySessions([
            {
                id: 'session-1',
                seq: 3,
                lastViewedSessionSeq: 1,
                presence: 'online',
                active: true,
                pendingRequestObservedAt: 1_000,
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
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 3,
            showNonNumericDot: false,
        });
        expect(applyTauriBadgeState).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('wakes a mounted badge at quiet-hour boundaries without a session update', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
        await persistBadgeHomeAccountSettings('server-1', { attentionDeliveryPolicyV1: {
            quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }] },
            channels: { badge: { quietHoursBehavior: 'suppress' } },
        } }, 2);
        setActivitySessions([{ id: 'session-1', hasUnreadMessages: true, metadata: null }]);
        activityAttentionSourceValue = { ...activityAttentionSourceValue, sessionsById: {} };
        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');
        const screen = await renderScreen(<ActivityBadgeRuntime />);
        await flushHookEffects();
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({ count: 1, showNonNumericDot: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1_000); });
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({ count: 0, showNonNumericDot: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1_000); });
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({ count: 1, showNonNumericDot: false });
        await act(async () => { screen.tree.unmount(); });
    });

    it('keeps a mounted badge on a long-waiting pending request while its runtime is live', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000));
        setActivitySessions([{ id: 'session-1', seq: 0, active: true, presence: 'online',
            pendingUserActionRequestCount: 1, pendingRequestObservedAt: 1_000, metadata: null }]);
        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');
        const screen = await renderScreen(<ActivityBadgeRuntime />);
        await flushHookEffects();
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({ count: 1, showNonNumericDot: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000_000); });
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({ count: 1, showNonNumericDot: false });
        await act(async () => { screen.tree.unmount(); });
    });

    it('applies badge counts from unread session-list renderables without hydrated sessions', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            sessionsById: {},
            sessionListRowsByServerId: {
                'server-1': { 'session-renderable': {
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
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-renderable'],
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
        await flushHookEffects();

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
        isDesktopHostValue = true;
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
            sessionsById: {},
            sessionListRowsByServerId: {
                'server-1': { 'session-warm-unread': {
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
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-warm-unread'],
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

    it('keeps friend request badges local while activity source data is bootstrapping', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
        };
        friendRequestsValue = [{ id: 'friend-1' }];
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('keeps non-numeric inbox attention local while activity source data is bootstrapping', async () => {
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            isDataReady: false,
        };
        updateAvailableValue = true;
        serverFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ badgeCount: 4 }),
        });

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: true,
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
        await flushHookEffects();

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
        isDesktopHostValue = true;
        updateAvailableValue = true;

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

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
        await persistBadgeHomeAccountSettings('server-1', {
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: {
                    badge: { enabled: false },
                },
            },
        }, 2);

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

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
        await flushHookEffects();

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
            activeServerId: 'server-1',
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRowsByServerId: {
                'server-1': { 'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-normalized'],
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
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('counts a personal-query-only attention row across Homes while collective-only access stays quiet', async () => {
        sessionsValue = [];
        const quietCollective = {
            id: 'quiet-collective',
            serverId: 'server-1',
            seq: 8,
            metadata: { path: '', host: '' },
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'not_started' },
                relevance: { relevant: false, reasons: [] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'none', source: 'none' },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            },
        } as const;
        const personalAttention = {
            id: 'personal-attention',
            serverId: 'server-2',
            seq: 9,
            metadata: { path: '', host: '' },
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: 100 },
                relevance: { relevant: true, reasons: ['followed_by_me'] },
                follow: { follows: true, notificationLevel: 'important' },
                notification: { level: 'important', source: 'preference' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
            },
        } as const;
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            sessionsById: {},
            sessionListRowsByServerId: {
                'server-1': { [quietCollective.id]: quietCollective },
                'server-2': { [personalAttention.id]: personalAttention },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': [quietCollective.id],
                'server-2': [],
            },
            sessionListIndexByServerId: {
                'server-1': [{
                    type: 'session',
                    sessionId: quietCollective.id,
                    serverId: 'server-1',
                    serverName: null,
                }],
                'server-2': [],
            },
        };
        personalSessionMembershipValue = {
            'server-1': [],
            'server-2': [personalAttention.id],
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

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
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 10,
                metadata: null,
            },
        ]);

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        const screen = await renderScreen(<ActivityBadgeRuntime />);
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);
        expect(applyExpoNativeBadgeState).toHaveBeenLastCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        activityAttentionSourceValue = createActivityAttentionSource([
            {
                id: 'session-1',
                seq: 4,
                latestReadyEventSeq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 11,
                metadata: null,
            },
        ]);

        await screen.update(<ActivityBadgeRuntime />);

        expect(applyExpoNativeBadgeState).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('prefers hydrated session unread state over stale renderable state from the activity source', async () => {
        sessionsValue = [];
        activityAttentionSourceValue = {
            isDataReady: true,
            activeServerId: 'server-1',
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRowsByServerId: {
                'server-1': { 'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    metadata: { path: '', host: '' },
                    hasUnreadMessages: false,
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-normalized'],
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
        await flushHookEffects();

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
            activeServerId: 'server-1',
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRowsByServerId: {
                'server-1': { 'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                    hasUnreadMessages: true,
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-normalized'],
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
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 0,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses focused storage and settings subscriptions instead of broad activity/settings hooks', async () => {
        rejectBroadActivitySourceRead = true;
        rejectBroadLocalSettingsRead = true;
        rejectBroadAccountSettingsRead = true;
        activityAttentionSourceValue = {
            ...createActivityAttentionSource([]),
            sessionsById: {
                'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                },
            },
            sessionListRowsByServerId: {
                'server-1': { 'session-normalized': {
                    id: 'session-normalized',
                    seq: 4,
                    latestReadyEventSeq: 4,
                    lastViewedSessionSeq: 1,
                    metadata: { path: '', host: '' },
                } },
            },
            ordinarySessionListMembershipByServerId: {
                'server-1': ['session-normalized'],
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
        };

        const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityBadgeRuntime />)).tree;
        await flushHookEffects();

        expect(applyExpoNativeBadgeState).toHaveBeenCalledWith({
            count: 1,
            showNonNumericDot: false,
        });

        await act(async () => {
            tree?.unmount();
        });
    });
});
