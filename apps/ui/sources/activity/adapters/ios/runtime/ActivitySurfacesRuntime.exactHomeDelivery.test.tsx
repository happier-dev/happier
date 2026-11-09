import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { settingsParse } from '@/sync/domains/settings/settings';

import { createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import type { StorageState } from '@/sync/store/types';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';

vi.hoisted(async () => {
    const { mkdirSync, realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cache = join(realpathSync('node_modules'), '.cache', 'ci03-ios-runtime-exact-home');
    mkdirSync(cache, { recursive: true });
    vi.stubEnv('TMPDIR', cache);
});

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_A = 'server-a';
const HOME_B = 'server-b';
/** A Home this device can name but whose Account settings it has never persisted. */
const HOME_UNRESOLVED = 'server-c';
/** One Session ID on two Homes: exact-Home policy must never collapse them. */
const SHARED_SESSION_ID = 'shared-session';

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' | 'android' }));
const appStateState = vi.hoisted(() => ({
    currentState: 'active' as 'active' | 'inactive' | 'background',
    listeners: new Set<(state: 'active' | 'inactive' | 'background') => void>(),
}));
const sessionRowsState = vi.hoisted(() => ({
    value: [] as Array<{ serverId: string; session: Session }>,
}));
const settingsState = vi.hoisted(() => ({
    value: {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': true,
            'app.ui.homeScreenWidgets': true,
        },
    } as Record<string, unknown>,
}));
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        liveActivitiesMode: 'attention',
        liveActivitiesMaxConcurrent: 4,
        liveActivitiesStrategy: 'session_specific',
        widgetsPresetMode: 'attention',
        activitySurfaceTapTarget: 'open_session',
    } as Record<string, unknown>,
}));

const focusWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const sessionsWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const liveActivityUpdate = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityEnd = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityInstances = vi.hoisted(() => [] as Array<{
    serverId: string | null;
    update: typeof liveActivityUpdate;
    end: () => Promise<void>;
}>);
const liveActivityStart = vi.hoisted(() => vi.fn((snapshot: LiveActivitySnapshot, _route?: string) => {
    const instance = {
        serverId: snapshot.serverId,
        update: liveActivityUpdate,
        end: vi.fn(async () => { await liveActivityEnd(); }),
    };
    liveActivityInstances.push(instance);
    return instance;
}));
const liveActivityGetInstances = vi.hoisted(() => vi.fn(() => liveActivityInstances));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
        },
        AppState: {
            get currentState() {
                return appStateState.currentState;
            },
            addEventListener: (
                eventName: string,
                listener: (state: 'active' | 'inactive' | 'background') => void,
            ) => {
                if (eventName === 'change') appStateState.listeners.add(listener);
                return { remove: () => appStateState.listeners.delete(listener) };
            },
        },
    });
});

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            ios: { bundleIdentifier: 'dev.happier.custom' },
            plugins: [['expo-widgets', { widgets: [] }]],
        },
        installationId: 'device-1',
    },
}));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('expo-widgets', async (importOriginal) => {
    const { createExpoWidgetsModuleMock } = await import('@/dev/testkit/mocks/expoWidgets');
    return createExpoWidgetsModuleMock({
        importOriginal,
        addUserInteractionListener: () => ({ remove: vi.fn() }),
        widgets: {
            HappierFocusWidget: { updateSnapshot: focusWidgetUpdateSnapshot },
            HappierSessionsWidget: { updateSnapshot: sessionsWidgetUpdateSnapshot },
        },
        liveActivities: {
            HappierFocusLiveActivity: { start: liveActivityStart, getInstances: liveActivityGetInstances },
        },
    });
});

// Start from the canonical stub (dev/expoModulesCoreStub.ts) so native view managers resolved at import stay available.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
}));

function seedActivityState(activeServerId = HOME_A): void {
    const sessionListRowsByServerId: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
    const ordinarySessionListMembershipByServerId: Record<string, string[]> = {};
    const sessionListIndexByServerId: Record<string, NonNullable<StorageState['sessionListIndexByServerId'][string]>> = {};
    const sessions: Record<string, Session> = {};
    for (const { serverId, session } of sessionRowsState.value) {
        const sessionId = String(session.id);
        (sessionListRowsByServerId[serverId] ??= {})[sessionId] =
            buildSessionListRenderableFromSession(session);
        (ordinarySessionListMembershipByServerId[serverId] ??= []).push(sessionId);
        (sessionListIndexByServerId[serverId] ??= []).push({ type: 'session', sessionId, serverId });
        // Only the active Home's copy is hydrated, exactly like the real store.
        if (serverId === activeServerId) sessions[sessionId] = session;
    }
    storage.setState({
        isDataReady: true,
        settings: settingsParse(settingsState.value),
        localSettings: localSettingsParse(localSettingsState.value),
        sessions,
        sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId,
        sessionMessages: {},
        sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: {},
    });
}

function createAttentionSession(serverId: string, sessionId: string, title: string): Session {
    const observedAt = Date.now();
    const session = createSessionFixture({
        id: sessionId,
        serverId,
        active: true,
        updatedAt: observedAt,
        seq: 4,
        pendingVersion: 1,
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: observedAt,
        agentStateVersion: 1,
        agentState: {
            controlledByUser: null,
            requests: {
                'permission-1': { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: observedAt },
            },
        },
        metadata: {
            summary: { text: title, updatedAt: 1 },
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        },
    } as Partial<Session>);
    return { ...session, viewer: createSessionOwnerViewerFixture(session) };
}

async function persistHomeAccountSettings(
    serverId: string,
    settings: Record<string, unknown>,
    version = 1,
): Promise<void> {
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    saveAccountSettings({ serverId, accountId: `account-${serverId}` }, settingsParse(settings), version);
}

function liveActivityStartAddresses(): string[] {
    return liveActivityStart.mock.calls
        .map((call) => call[0])
        .map((snapshot) => `${snapshot.serverId ?? ''}/${snapshot.sessionId}`)
        .sort();
}

function latestWidgetSnapshot(): ActivitySurfaceSnapshot {
    const calls = focusWidgetUpdateSnapshot.mock.calls;
    return calls[calls.length - 1]?.[0] as ActivitySurfaceSnapshot;
}

function widgetAddresses(): string[] {
    return (latestWidgetSnapshot()?.sessions ?? [])
        .map((session) => `${session.serverId ?? ''}/${session.sessionId}`)
        .sort();
}

/**
 * Live Activity authorization is read asynchronously and re-runs reconciliation,
 * so each observation point drains both passes.
 */
async function flushActivitySurfacesRuntime(): Promise<void> {
    await flushHookEffects();
}

async function renderActivitySurfacesRuntime() {
    const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
    let deliveryInputsReady = false;
    function ObserveDeliveryInputs() {
        const source = useActivityAttentionSource();
        deliveryInputsReady = sessionRowsState.value.every(({ serverId }) =>
            source.accountDeliveryMutesByServerId?.[serverId] != null && source.audienceScopes?.has(serverId));
        return <ActivitySurfacesRuntime />;
    }
    const rendered = await renderScreen(<ActivityPersonalSessionMembershipProvider enabled={false}>
        <ObserveDeliveryInputs />
    </ActivityPersonalSessionMembershipProvider>);
    await waitForHomeGovernance(() => expect(deliveryInputsReady).toBe(true));
    await flushActivitySurfacesRuntime();
    return rendered;
}

// Preserve the real widget module while keeping its cold layout compilation
// outside the per-case reconciliation observation window.
await import('./iosActivityWidgetModules');
const homes = createHomeGovernanceHarness();
await loadSyncSingletonForTests();

describe('ActivitySurfacesRuntime exact-Home Account delivery', () => {
    beforeEach(async () => {
        await homes.reset();
        resetServerFeaturesClientForTests();
        for (const serverId of [HOME_A, HOME_B, HOME_UNRESOLVED]) {
            await homes.addHome({ serverUrl: `https://${serverId}`, name: serverId,
                accountId: `account-${serverId}`, currentAccount: true, active: serverId === HOME_A });
            homes.answer(serverId, '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        }
        await setActiveServerId(HOME_A);
        installSessionActionRpcBoundary(() => ({ ok: true }));
        const credentials = await TokenStorage.getCredentialsForServerUrl(`https://${HOME_A}`, { serverId: HOME_A });
        if (!credentials) throw new Error('Expected stored Activity Home credentials');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        storage.setState({ isDataReady: false });
        await restoreConnectionToActiveServer(credentials);
        storage.getState().activateProfileScope({ serverId: HOME_A, accountId: `account-${HOME_A}` });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        await homes.selectHomes([HOME_A, HOME_B, HOME_UNRESOLVED]);
        const { startConcurrentSessionCacheSync, isConcurrentOrdinarySessionListHome } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await waitForHomeGovernance(() => {
            expect(isConcurrentOrdinarySessionListHome(HOME_B)).toBe(true);
            expect(isConcurrentOrdinarySessionListHome(HOME_UNRESOLVED)).toBe(true);
        });
        sessionRowsState.value = [
            { serverId: HOME_A, session: createAttentionSession(HOME_A, SHARED_SESSION_ID, 'Home A work') },
            { serverId: HOME_B, session: createAttentionSession(HOME_B, SHARED_SESSION_ID, 'Home B work') },
        ];
        // Both Homes have attention, so any absence below can only come from policy.
        await persistHomeAccountSettings(HOME_A, {});
        await persistHomeAccountSettings(HOME_B, {});
        seedActivityState();
    });

    afterEach(async () => {
        standardCleanup();
        const { stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        stopConcurrentSessionCacheSync();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await homes.reset();
        vi.restoreAllMocks();
        focusWidgetUpdateSnapshot.mockClear();
        sessionsWidgetUpdateSnapshot.mockClear();
        liveActivityStart.mockClear();
        liveActivityUpdate.mockClear();
        liveActivityEnd.mockClear();
        liveActivityInstances.length = 0;
        appStateState.listeners.clear();
    });

    it('admits each Home through its own Account policy for each surface', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
        });
        await persistHomeAccountSettings(HOME_B, {
            attentionDeliveryPolicyV1: { v: 1, channels: { home_widget: { enabled: false } } },
        });

        await renderActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(widgetAddresses()).toEqual([`${HOME_A}/${SHARED_SESSION_ID}`]);
    });

    it('fails closed for a Home with no persisted Account settings', async () => {
        sessionRowsState.value = [
            ...sessionRowsState.value,
            {
                serverId: HOME_UNRESOLVED,
                session: createAttentionSession(HOME_UNRESOLVED, 'session-unresolved', 'Unresolved Home work'),
            },
        ];
        seedActivityState();

        await renderActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        expect(widgetAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
    });

    it('does not retarget another Home when the active Home changes', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
        });

        await renderActivitySurfacesRuntime();
        const beforeSwitch = liveActivityStartAddresses();
        const widgetsBeforeSwitch = widgetAddresses();

        standardCleanup();
        liveActivityStart.mockClear();
        liveActivityEnd.mockClear();
        liveActivityInstances.length = 0;
        focusWidgetUpdateSnapshot.mockClear();
        await setActiveServerId(HOME_B);
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await switchConnectionToActiveServer();
        storage.getState().activateProfileScope({ serverId: HOME_B, accountId: `account-${HOME_B}` });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const { isConcurrentOrdinarySessionListHome } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        await waitForHomeGovernance(() => {
            expect(isConcurrentOrdinarySessionListHome(HOME_A)).toBe(true);
            expect(isConcurrentOrdinarySessionListHome(HOME_UNRESOLVED)).toBe(true);
        });
        seedActivityState(HOME_B);
        await renderActivitySurfacesRuntime();

        expect(beforeSwitch).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(liveActivityStartAddresses()).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(widgetsBeforeSwitch).toEqual([`${HOME_A}/${SHARED_SESSION_ID}`, `${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(widgetAddresses()).toEqual(widgetsBeforeSwitch);
    });

    it('reconciles immediately when the other Home rewrites its persisted Account policy', async () => {
        await renderActivitySurfacesRuntime();
        expect(liveActivityStartAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        const homeA = liveActivityInstances.find((instance) => instance.serverId === HOME_A)!;
        const homeB = liveActivityInstances.find((instance) => instance.serverId === HOME_B)!;

        liveActivityStart.mockClear();
        focusWidgetUpdateSnapshot.mockClear();
        await act(async () => {
            await persistHomeAccountSettings(HOME_B, {
                attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
            }, 2);
        });
        await flushActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([]);
        expect(homeA.end).not.toHaveBeenCalled();
        expect(homeB.end).toHaveBeenCalledTimes(1);
    });

    it('withholds the title for a Home whose Account permits status only', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { home_widget: 'include_preview' } } },
        });
        await persistHomeAccountSettings(HOME_B, {
            attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { home_widget: 'status_only' } } },
        });

        await renderActivitySurfacesRuntime();

        const sessions = latestWidgetSnapshot().sessions;
        const homeA = sessions.find((session) => session.serverId === HOME_A);
        const homeB = sessions.find((session) => session.serverId === HOME_B);
        expect(homeA?.title).toBe('Home A work');
        expect(homeB).toBeDefined();
        expect(homeB?.title).not.toBe('Home B work');
        expect(homeB?.title).not.toBe('Home A work');
        // The widget bridge drops null keys (UserDefaults rejects NSNull); absent reads as null.
        expect(homeB?.subtitle ?? null).toBeNull();
        expect(homeB?.statusText ?? null).toBeNull();
        expect(homeB?.previewText ?? null).toBeNull();
    });
});
