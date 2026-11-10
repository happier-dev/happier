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
import {
    persistBadgeHomeAccountSettings,
    resolveBadgeHomeAccountId,
    resolveBadgeHomeServerUrl,
} from './activityBadgeRuntimeHomeFixtures';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

/** Both Homes carry the same Session id on purpose: only the Home qualifies the row. */
const SHARED_SESSION_ID = 'shared-session';

const activeHome = vi.hoisted(() => ({ serverId: 'server-1' }));

/**
 * How much of the badge corpus has actually answered. Startup is the interesting case: the
 * store is not ready yet and only one of the two Homes has contributed anything.
 */
const corpusReadiness = vi.hoisted(() => ({
    isDataReady: true,
    coverageComplete: true,
    homeServerIds: ['server-1', 'server-2'],
}));

/**
 * The store's Account settings follow the active Home, which is exactly why the badge may not read
 * them: one Account answering for a corpus that spans Homes is the defect under test.
 */
const accountPolicyByServerId: Record<string, Record<string, unknown>> = {
    'server-1': {
        attentionDeliveryPolicyV1: {
            v: 1,
            channels: { badge: { events: { ready: { enabled: false } } } },
        },
    },
    'server-2': {},
};

const applyExpoNativeBadgeState = vi.hoisted(() => vi.fn(async () => {}));
const serverFetch = vi.hoisted(() => vi.fn(async () => ({ ok: false, json: async () => ({}) })));

function createUnreadRenderable(serverId: string) {
    return {
        id: SHARED_SESSION_ID,
        serverId,
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
    };
}

function createMultiHomeStorageState(): StorageState {
    const state = {
        sessions: {},
        machines: {},
        sessionMessages: {},
        sessionPending: {},
        sessionListRowsByServerId: {
            'server-1': { [SHARED_SESSION_ID]: createUnreadRenderable('server-1') },
            'server-2': { [SHARED_SESSION_ID]: createUnreadRenderable('server-2') },
        },
        ordinarySessionListMembershipByServerId: {
            'server-1': [SHARED_SESSION_ID],
            'server-2': [SHARED_SESSION_ID],
        },
        sessionListIndexByServerId: {
            'server-1': [{ type: 'session', sessionId: SHARED_SESSION_ID, serverId: 'server-1', serverName: null }],
            'server-2': [{ type: 'session', sessionId: SHARED_SESSION_ID, serverId: 'server-2', serverName: null }],
        },
        concurrentSessionListCacheByServerId: {},
        isDataReady: corpusReadiness.isDataReady,
        profileScope: {
            serverId: activeHome.serverId,
            accountId: resolveBadgeHomeAccountId(activeHome.serverId),
        },
        localSettings: localSettingsDefaults,
    };
    // Only the badge selector slice is read here; the remaining domain methods are never called.
    return state as unknown as StorageState;
}

installActivityBadgeRuntimeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const storage = Object.assign(
            ((selector?: (state: StorageState) => unknown) => {
                const state = createMultiHomeStorageState();
                return typeof selector === 'function' ? selector(state) : state;
            }),
            {
                getState: createMultiHomeStorageState,
                getInitialState: createMultiHomeStorageState,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        );
        return createStorageModuleStub({
            storage,
            useAllSessions: () => [],
            useFriendRequestCount: () => 0,
            useLocalSetting: (key: string) => (
                key === 'attentionDeviceOverridesV1'
                    ? undefined
                    : localSettingsDefaults[key as keyof typeof localSettingsDefaults]
            ),
            useSetting: (key: string) => {
                const activeAccountSettings = accountSettingsParse(accountPolicyByServerId[activeHome.serverId] ?? {});
                return activeAccountSettings[key as keyof typeof activeAccountSettings];
            },
            useLocalSettings: () => localSettingsDefaults,
            useSettings: () => accountSettingsParse(accountPolicyByServerId[activeHome.serverId] ?? {}),
        });
    },
});

vi.mock('@/hooks/inbox/useUpdates', () => ({ useUpdates: () => ({ updateAvailable: false }) }));
vi.mock('@/hooks/inbox/useChangelog', () => ({ useChangelog: () => ({ hasUnread: false }) }));
vi.mock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false, desktopHostKind: () => null }));
vi.mock('@/sync/http/client', () => ({ serverFetch }));
vi.mock('./channels/applyExpoNativeBadgeState', () => ({ applyExpoNativeBadgeState }));
vi.mock('./channels/applyTauriBadgeState', () => ({ applyTauriBadgeState: vi.fn(async () => {}) }));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: activeHome.serverId,
        serverUrl: resolveBadgeHomeServerUrl(activeHome.serverId),
        generation: 1,
    }),
}));

vi.mock('@/activity/source/activityPersonalSessionMembership', () => ({
    useActivityPersonalSessionMembership: () => ({
        // The canonical Activity Home set: every saved Home, regardless of which one is active.
        membershipByServerId: Object.fromEntries(corpusReadiness.homeServerIds.map((serverId) => [serverId, []])),
        statesByServerId: {},
        coverageComplete: corpusReadiness.coverageComplete,
    }),
}));

// The Home profiles and the device credential store are installed in `beforeEach` through
// `installBadgeHomeIdentities`: the real Home owner, with a spy on the one genuine boundary. See
// the rule recorded at that helper for why neither module is `vi.mock`ed here.

// Collect the cold production graph before starting a case's assertion timeout.
const { ActivityBadgeRuntime } = await import('./ActivityBadgeRuntime');

async function renderBadgeRuntime(): Promise<renderer.ReactTestRenderer> {
    const { tree } = await renderScreen(<ActivityBadgeRuntime />);
    // Each Home's credential scope resolves asynchronously; nothing is written before it does.
    await flushHookEffects();
    return tree;
}

function readLastAppliedBadgeCount(): number | undefined {
    const calls = applyExpoNativeBadgeState.mock.calls as unknown as Array<[{ count: number }]>;
    return calls.at(-1)?.[0]?.count;
}

describe('ActivityBadgeRuntime multi-Home policy identity', () => {
    beforeEach(async () => {
        // The Home testkit may load the SDK port before this suite's mock options are installed.
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        activeHome.serverId = 'server-1';
        corpusReadiness.isDataReady = true;
        corpusReadiness.coverageComplete = true;
        corpusReadiness.homeServerIds = ['server-1', 'server-2'];
        await installBadgeHomeIdentities(['server-1', 'server-2']);
        await persistBadgeHomeAccountSettings('server-1', accountPolicyByServerId['server-1']);
        await persistBadgeHomeAccountSettings('server-2', accountPolicyByServerId['server-2']);
    });

    afterEach(() => {
        applyExpoNativeBadgeState.mockClear();
        serverFetch.mockClear();
    });

    it('counts only the Homes whose own Account policy admits the row, whichever Home is active', async () => {
        const countsByActiveHome: Array<number | undefined> = [];

        for (const serverId of ['server-1', 'server-2'] as const) {
            activeHome.serverId = serverId;
            applyExpoNativeBadgeState.mockClear();
            const tree = await renderBadgeRuntime();
            countsByActiveHome.push(readLastAppliedBadgeCount());
            await act(async () => { tree.unmount(); });
        }

        // Home A suppresses unread on its badge, Home B allows it, and both carry the same Session
        // id. One row qualifies, and switching the active Home cannot change which one.
        expect(countsByActiveHome).toEqual([1, 1]);
    });

    it('drops a Home with no persisted Account settings instead of borrowing the active Home policy', async () => {
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix({
            serverId: 'server-2',
            accountId: 'account-2',
        })}`);

        const tree = await renderBadgeRuntime();

        // Home A still suppresses unread and Home B can no longer be asked, so nothing qualifies.
        expect(readLastAppliedBadgeCount()).toBe(0);
        await act(async () => { tree.unmount(); });
    });

    it('leaves the OS badge alone while a second Home has not contributed its count yet', async () => {
        corpusReadiness.isDataReady = false;
        corpusReadiness.coverageComplete = false;

        const tree = await renderBadgeRuntime();

        // The closed-app badge is last-writer-wins, and the running app is the writer that
        // knows better: with two Homes in the corpus and one still warming, every number it
        // could write is one it already knows is short, so the last written value stands.
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });

    it('leaves the OS badge alone when the active Home is bootstrapped but another Home has not answered', async () => {
        corpusReadiness.isDataReady = true;
        corpusReadiness.coverageComplete = false;

        const tree = await renderBadgeRuntime();

        // `isDataReady` is the ACTIVE Home's bootstrap flag, not cross-Home coverage. A
        // warm active Home still knows a number that is short for a corpus spanning Homes,
        // which is exactly the write the coverage rule withholds.
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });

    it('still writes a warm count when the corpus is one Home', async () => {
        corpusReadiness.isDataReady = false;
        corpusReadiness.coverageComplete = false;
        corpusReadiness.homeServerIds = ['server-1'];

        const tree = await renderBadgeRuntime();

        // One Home cannot be partial across Homes: waiting here would delay every badge on
        // the ordinary single-Home launch for no gain.
        expect(applyExpoNativeBadgeState).toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });

    it('writes nothing while no Home has answered with its own badge policy', async () => {
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        for (const scope of [
            { serverId: 'server-1', accountId: 'account-1' },
            { serverId: 'server-2', accountId: 'account-2' },
        ]) {
            getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`);
        }

        const tree = await renderBadgeRuntime();

        // Clearing to 0 here would wipe a correct badge on every launch.
        expect(applyExpoNativeBadgeState).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });
});
