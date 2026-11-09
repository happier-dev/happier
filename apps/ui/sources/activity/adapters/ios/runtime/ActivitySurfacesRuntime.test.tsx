import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    buildLiveActivityRemoteUpdateCapabilityDiagnostics,
    PUSH_NOTIFICATION_ACTION_IDS,
    type LiveActivityRemoteUpdateCapabilityDiagnostics,
} from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';

import { createSessionFixture as createBaseSessionFixture, createSessionOwnerViewerFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen as renderActivityScreen, standardCleanup } from '@/dev/testkit';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import type { StorageState } from '@/sync/store/types';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import * as actionExecutor from '@/sync/ops/actions/defaultActionExecutor';
import * as backgroundWake from '../backgroundWake/defineLiveActivityBackgroundWakeTask';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { saveLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';
import type { LiveActivityTargetRegistrationInput } from '@/sync/api/session/apiLiveActivityTargets';
import { projectSessionFollowFactsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveSessionEffectiveNotificationV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';

import {
    buildHappierFocusLiveActivityIdentity,
    buildLiveActivityInstanceKey,
} from '../liveActivities/liveActivityIdentity';

/** The production Activity identity encoder, so fixtures cannot drift from real keys. */
function liveActivityKey(serverId: string, sessionId: string): string {
    return buildLiveActivityInstanceKey(buildHappierFocusLiveActivityIdentity({ serverId, sessionId }));
}


function createSessionFixture(
    overrides: Parameters<typeof createBaseSessionFixture>[0] = {},
): ReturnType<typeof createBaseSessionFixture> {
    const observedAt = Date.now();
    const hasPendingRequest = (overrides.pendingPermissionRequestCount ?? 0) > 0
        || (overrides.pendingUserActionRequestCount ?? 0) > 0;

    const session = createBaseSessionFixture({
        // Activity routing is Home-qualified. Most runtime cases exercise the
        // exact default Home; tests for a genuinely unbound instance opt into
        // `serverId: null` explicitly instead of relying on an omitted fixture
        // field that the list projection later invents independently.
        ...(overrides.serverId === undefined ? { serverId: 'server-a' } : {}),
        ...(typeof overrides.seq === 'number' && overrides.latestReadyEventSeq === undefined
            ? { latestReadyEventSeq: overrides.seq }
            : {}),
        ...(overrides.active === true && overrides.activeAt === undefined ? { activeAt: observedAt } : {}),
        ...(overrides.thinking === true && overrides.thinkingAt === undefined
            ? { thinkingAt: observedAt }
            : {}),
        ...(hasPendingRequest && overrides.pendingRequestObservedAt === undefined
            ? { pendingRequestObservedAt: observedAt }
            : {}),
        ...overrides,
    });
    return { ...session, viewer: createSessionOwnerViewerFixture(session) };
}

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web' | 'android',
}));

const syncLiveActivityBackgroundWakeTaskRegistration = vi.hoisted(() => vi.fn());

const appStateState = vi.hoisted(() => ({
    currentState: 'active' as 'active' | 'inactive' | 'background',
    listeners: new Set<(state: 'active' | 'inactive' | 'background') => void>(),
}));

const sessionsState = vi.hoisted(() => ({
    value: [] as ReturnType<typeof createSessionFixture>[],
}));

const sessionIndexServerOverridesState = vi.hoisted(() => ({
    value: {} as Record<string, string>,
}));

function resolveFixtureServerId(session: ReturnType<typeof createSessionFixture>): string {
    const overrideServerId = sessionIndexServerOverridesState.value[session.id];
    return typeof overrideServerId === 'string' && overrideServerId.trim()
        ? overrideServerId.trim()
        : typeof session.serverId === 'string' && session.serverId.trim()
            ? session.serverId.trim()
            : 'server-a';
}

const dataReadyState = vi.hoisted(() => ({
    value: true,
}));

const constantsState = vi.hoisted(() => {
    type ExpoConfigFixture = {
        ios: { bundleIdentifier: string };
        plugins: Array<['expo-widgets', { widgets: unknown[]; enablePushNotifications?: boolean }]>;
        extra?: {
            app?: {
                happierLiveActivityApnsEnvironment?: 'sandbox' | 'production';
                iosBackgroundWakeNotificationsEnabled?: boolean;
            };
        };
    };
    const expoConfig: ExpoConfigFixture = {
        ios: {
            bundleIdentifier: 'dev.happier.custom',
        },
        plugins: [
            ['expo-widgets', { widgets: [] }],
        ],
    };
    return {
        expoConfig,
        installationId: 'device-1',
    };
});

const serverFeaturesMainSelectionState = vi.hoisted(() => ({
    value: {
        status: 'ready',
        serverIds: [] as string[],
        snapshotsByServerId: {} as Record<string, {
            status: 'ready';
            features: { capabilities: { liveActivities: { remoteUpdates: LiveActivityRemoteUpdateCapabilityDiagnostics } } };
        }>,
    },
}));

function createFeatureToggleState(overrides: Partial<{
    liveActivities: boolean;
    widgets: boolean;
    directApnsRemoteUpdates: boolean;
}> = {}) {
    const base = {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': overrides.liveActivities ?? true,
            'app.ui.homeScreenWidgets': overrides.widgets ?? true,
        },
    };
    if (overrides.directApnsRemoteUpdates !== true) {
        return base;
    }
    return {
        ...base,
        attentionDeliveryPolicyV1: {
            v: 1,
            liveActivityRemoteUpdates: {
                enabled: true,
                preferredMode: 'direct_apns',
                allowBackgroundWakeFallback: false,
            },
        },
    };
}

function createLocalSettingsState(overrides: Partial<{
    activitySurfacesEnabled: boolean;
    iosLiveActivitiesEnabled: boolean;
    iosWidgetsEnabled: boolean;
    liveActivitiesMode: 'focused' | 'attention' | 'running';
    liveActivitiesStrategy: 'dynamic_primary' | 'pinned_primary' | 'session_specific';
    liveActivitiesMaxConcurrent: 1 | 2 | 4;
    liveActivitiesIncludeThinking: boolean;
    activitySurfaceTapTarget: 'open_session' | 'open_sessions';
    attentionDeviceOverridesV1: Readonly<{
        v: 1;
        liveActivities?: Readonly<{
            privacyMode?: 'account' | 'status_only' | 'title_only' | 'include_preview';
            registerRemoteUpdateTargets?: boolean;
            allowBackgroundWakeFallback?: boolean;
            remoteUpdateModeOverride?: 'account' | 'local_only' | 'disabled';
        }>;
        widgets?: Readonly<{
            privacyMode?: 'account' | 'status_only' | 'title_only' | 'include_preview';
        }>;
    }>;
}> = {}) {
    return {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        liveActivitiesMode: 'focused' as const,
        liveActivitiesStrategy: 'dynamic_primary' as const,
        liveActivitiesMaxConcurrent: 1 as const,
        liveActivitiesIncludeThinking: true,
        activitySurfaceTapTarget: 'open_session' as const,
        ...overrides,
    };
}

const settingsState = vi.hoisted(() => ({
    value: createFeatureToggleState(),
}));

const localSettingsState = vi.hoisted(() => ({
    value: createLocalSettingsState(),
}));

type WidgetInteractionListener = Parameters<typeof import('expo-widgets')['addUserInteractionListener']>[0];
type WidgetInteractionFixtureEvent = Parameters<WidgetInteractionListener>[0] & {
    // Native action payloads may add routing fields beyond the SDK's base event.
    data?: Record<string, unknown>;
};
const widgetInteractionsState = vi.hoisted(() => ({
    listener: null as null | ((event: WidgetInteractionFixtureEvent) => void),
}));

const liveActivityAuthorizationState = vi.hoisted(() => ({
    module: null as null | {
        getLiveActivityAuthorizationDiagnostics: () => Promise<{
            areActivitiesEnabled?: boolean;
            frequentPushesEnabled?: boolean;
        }>;
    },
}));

const focusWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const sessionsWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const liveActivityPushTokenListeners = vi.hoisted(() =>
    [] as Array<(event: { activityId: string; pushToken: string }) => void>
);
const liveActivityHandleTokenApiState = vi.hoisted(() => ({
    enabled: false,
    currentPushToken: null as string | null,
    throwOnAddPushTokenListener: false,
}));
const liveActivityInstances = vi.hoisted(() => [] as Array<{
    update: (props: unknown) => Promise<void>;
    end: (dismissalPolicy?: unknown, props?: unknown, contentDate?: Date) => Promise<void>;
    addPushTokenListener?: (listener: (event: { activityId: string; pushToken: string }) => void) => { remove: () => void };
    getPushToken?: () => Promise<string | null>;
}>);
const liveActivityStart = vi.hoisted(() =>
    vi.fn((_props: LiveActivitySnapshot, _url?: string, _staleDate?: Date) => {
        const instance = {
            update: liveActivityUpdate,
            end: liveActivityEnd,
            ...(liveActivityHandleTokenApiState.enabled
                ? {
                    getPushToken: async () => liveActivityHandleTokenApiState.currentPushToken,
                    addPushTokenListener: (listener: (event: { activityId: string; pushToken: string }) => void) => {
                        if (liveActivityHandleTokenApiState.throwOnAddPushTokenListener) {
                            throw new Error('ActivityKit token listener unavailable');
                        }
                        liveActivityPushTokenListeners.push(listener);
                        return {
                            remove: () => {
                                const index = liveActivityPushTokenListeners.indexOf(listener);
                                if (index >= 0) liveActivityPushTokenListeners.splice(index, 1);
                            },
                        };
                    },
                }
                : {}),
        };
        liveActivityInstances.push(instance);
        return instance;
    }),
);
const liveActivityUpdate = vi.hoisted(() => vi.fn(async (_props: unknown, _staleDate?: Date) => {}));
const liveActivityEnd = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityGetInstances = vi.hoisted(() => vi.fn(() => liveActivityInstances));
// Recorded HTTP response ports, not replacements for the registration API.
// The real adapter serializes the input and validates each response below.
const registerLiveActivityTarget = vi.hoisted(() =>
    vi.fn(async (_input: LiveActivityTargetRegistrationInput) => ({ targetId: 'target-direct-1' }))
);
const markLiveActivityTargetEnded = vi.hoisted(() => vi.fn(async (_targetId: string, _options: { serverId: string }) => undefined));
const addUserInteractionListener = vi.hoisted(() =>
    vi.fn((listener: WidgetInteractionListener) => {
        if (widgetInteractionListenerAttachState.throwOnAttach) {
            throw new Error('Interaction listener unavailable');
        }
        widgetInteractionsState.listener = listener;
        return { remove: vi.fn() };
    }),
);
const widgetInteractionListenerAttachState = vi.hoisted(() => ({
    throwOnAttach: false,
}));
const routerPush = vi.hoisted(() => vi.fn());
const actionExecutorExecute = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

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
                if (eventName === 'change') {
                    appStateState.listeners.add(listener);
                }
                return {
                    remove: () => {
                        appStateState.listeners.delete(listener);
                    },
                };
            },
        },
    });
});

vi.mock('expo-constants', () => ({
    default: constantsState,
}));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: { push: routerPush } }).module);

vi.mock('expo-widgets', async (importOriginal) => {
    const { createExpoWidgetsModuleMock } = await import('@/dev/testkit/mocks/expoWidgets');
    return createExpoWidgetsModuleMock({
        importOriginal,
        addUserInteractionListener,
        widgets: {
            HappierFocusWidget: { updateSnapshot: focusWidgetUpdateSnapshot },
            HappierSessionsWidget: { updateSnapshot: sessionsWidgetUpdateSnapshot },
        },
        liveActivities: {
            HappierFocusLiveActivity: { start: liveActivityStart, getInstances: liveActivityGetInstances },
        },
    });
});

vi.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => liveActivityAuthorizationState.module,
    // Native view managers (the composer input) are resolved at import; none render in this runtime.
    requireNativeViewManager: () => () => null,
}));

function publishActivityFixture(): void {
        const sessionListRowsByServerId: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
        const ordinarySessionListMembershipByServerId: Record<string, string[]> = {};
        for (const session of sessionsState.value) {
            const serverId = resolveFixtureServerId(session);
            installSessionActionFixture({ homes: activityHomes, storage, serverId, session });
            (sessionListRowsByServerId[serverId] ??= {})[session.id] = buildSessionListRenderableFromSession(session);
            (ordinarySessionListMembershipByServerId[serverId] ??= []).push(session.id);
        }
        const sessionListIndexByServerId = sessionsState.value.reduce<Record<string, NonNullable<StorageState['sessionListIndexByServerId'][string]>>>((byServerId, session) => {
            const serverId = resolveFixtureServerId(session);
            const items = byServerId[serverId] ?? [];
            items.push({
                type: 'session',
                sessionId: session.id,
                serverId,
            });
            byServerId[serverId] = items;
            return byServerId;
        }, {});
        storage.setState({
            isDataReady: dataReadyState.value,
            settings: settingsParse(settingsState.value),
            localSettings: localSettingsParse(localSettingsState.value),
            sessions: Object.fromEntries(sessionsState.value.map((session) => [session.id, session])),
            sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId,
            sessionMessages: {},
            sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: {},
        });
}

// Fixture writes reach the actual Zustand owner, including mounted updates.
// The runtime's selectors and subscriptions are never replaced by test hooks.
for (const fixture of [sessionsState, sessionIndexServerOverridesState, dataReadyState, settingsState, localSettingsState]) {
    let value = fixture.value;
    Object.defineProperty(fixture, 'value', {
        get: () => value,
        set: (next: typeof value) => {
            value = next;
            publishActivityFixture();
        },
    });
}

const ACTIVITY_TEST_HOME_SERVER_IDS = ['server-a', 'server-b', 'local'] as const;
const activityHomes = createHomeGovernanceHarness();
function AccountDeliveryFixture({ children }: React.PropsWithChildren) {
    return <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>;
}
function renderScreen(element: Parameters<typeof renderActivityScreen>[0]) {
    return renderActivityScreen(element, { wrapper: AccountDeliveryFixture });
}

function persistDefaultActivityHomeAccountSettings(): void {
    for (const serverId of ACTIVITY_TEST_HOME_SERVER_IDS) {
        saveAccountSettings({ serverId, accountId: `account-${serverId}` }, settingsParse({}), 1);
    }
}

function persistActivityHomeAccountSettings(serverId: string): void {
    saveAccountSettings(
        { serverId, accountId: `account-${serverId}` },
        settingsParse(settingsState.value),
        1,
    );
}

async function configureDirectApnsRemoteUpdatesForServer(serverId: string): Promise<void> {
    constantsState.expoConfig.plugins = [
        ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
    ];
    settingsState.value = createFeatureToggleState({ directApnsRemoteUpdates: true });
    persistActivityHomeAccountSettings(serverId);
    serverFeaturesMainSelectionState.value = {
        status: 'ready',
        serverIds: [serverId],
        snapshotsByServerId: {
            [serverId]: {
                status: 'ready',
                features: {
                    capabilities: {
                        liveActivities: {
                            remoteUpdates: buildLiveActivityRemoteUpdateCapabilityDiagnostics({
                                expoWidgetsPushNotificationsEnabled: true,
                                hostedRelay: {
                                    allowed: false,
                                    capabilityAvailable: false,
                                    providerImplemented: false,
                                },
                                directApns: {
                                    configured: true,
                                },
                                backgroundWake: {
                                    enabled: false,
                                },
                            }),
                        },
                    },
                },
            },
        },
    };
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function configureHostedRelayRemoteUpdatesForServer(serverId: string): Promise<void> {
    constantsState.expoConfig.plugins = [
        ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
    ];
    settingsState.value = {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': true,
            'app.ui.homeScreenWidgets': true,
        },
        attentionDeliveryPolicyV1: {
            v: 1,
            liveActivityRemoteUpdates: {
                enabled: true,
                preferredMode: 'hosted_happier_relay',
                allowBackgroundWakeFallback: false,
            },
        },
    };
    persistActivityHomeAccountSettings(serverId);
    serverFeaturesMainSelectionState.value = {
        status: 'ready',
        serverIds: [serverId],
        snapshotsByServerId: {
            [serverId]: {
                status: 'ready',
                features: {
                    capabilities: {
                        liveActivities: {
                            remoteUpdates: buildLiveActivityRemoteUpdateCapabilityDiagnostics({
                                expoWidgetsPushNotificationsEnabled: true,
                                hostedRelay: {
                                    allowed: true,
                                    capabilityAvailable: true,
                                    providerImplemented: true,
                                },
                                directApns: {
                                    configured: false,
                                },
                                backgroundWake: {
                                    enabled: false,
                                },
                            }),
                        },
                    },
                },
            },
        },
    };
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function configureBackgroundWakeRemoteUpdatesForServer(serverId: string): Promise<void> {
    settingsState.value = {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': true,
            'app.ui.homeScreenWidgets': true,
        },
        attentionDeliveryPolicyV1: {
            v: 1,
            liveActivityRemoteUpdates: {
                enabled: true,
                preferredMode: 'background_wake_best_effort',
                allowBackgroundWakeFallback: true,
            },
        },
    };
    persistActivityHomeAccountSettings(serverId);
    serverFeaturesMainSelectionState.value = {
        status: 'ready',
        serverIds: [serverId],
        snapshotsByServerId: {
            [serverId]: {
                status: 'ready',
                features: {
                    capabilities: {
                        liveActivities: {
                            remoteUpdates: buildLiveActivityRemoteUpdateCapabilityDiagnostics({
                                expoWidgetsPushNotificationsEnabled: true,
                                hostedRelay: {
                                    allowed: false,
                                    capabilityAvailable: false,
                                    providerImplemented: false,
                                },
                                directApns: {
                                    configured: false,
                                },
                                backgroundWake: {
                                    enabled: true,
                                },
                            }),
                        },
                    },
                },
            },
        },
    };
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function configureVerifiedLocalServerContext(serverId: string): Promise<void> {
    await setActiveServerId(serverId);
}

// Compile real widget layouts before timed cases; reconciliation loads this
// same SDK-backed module lazily in the running app.
await import('./iosActivityWidgetModules');
await loadSyncSingletonForTests();

describe('ActivitySurfacesRuntime', () => {
    beforeEach(async () => {
        resetServerFeaturesClientForTests();
        for (const serverId of ACTIVITY_TEST_HOME_SERVER_IDS) {
            await activityHomes.addHome({ name: serverId, serverUrl: `https://${serverId}`,
                accountId: `account-${serverId}`, currentAccount: true, active: serverId === 'server-a' });
            activityHomes.answer(serverId, '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        }
        installSessionActionRpcBoundary(() => ({ ok: true }));
        // Observation only: dispatch, policy, admission and transport all remain real.
        const createExecutor = actionExecutor.createDefaultActionExecutor;
        vi.spyOn(actionExecutor, 'createDefaultActionExecutor').mockImplementation((options) => {
            const executor = createExecutor(options);
            return { ...executor, execute: (...args) => {
                actionExecutorExecute(...args);
                return executor.execute(...args);
            } };
        });
        // Inject the external OS task registry into its real registration owner.
        // The observer preserves the runtime-mount assertion without replacing policy.
        const registerWakeTask = backgroundWake.syncLiveActivityBackgroundWakeTaskRegistration;
        const registeredTasks = new Set<string>();
        vi.spyOn(backgroundWake, 'syncLiveActivityBackgroundWakeTaskRegistration').mockImplementation((options) => {
            syncLiveActivityBackgroundWakeTaskRegistration(options);
            return registerWakeTask({ ...options,
                taskManager: { isTaskRegisteredAsync: async (name) => registeredTasks.has(name) },
                notifications: {
                    registerTaskAsync: async (name) => { registeredTasks.add(name); },
                    unregisterTaskAsync: async (name) => { registeredTasks.delete(name); },
                },
            });
        });
        // These are HTTP response ports. The real feature parser/cache/hook and
        // Live Activity registration adapter run above this network boundary.
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const serverId = url.hostname;
            if (url.pathname === '/v1/features') {
                const remoteUpdates = serverFeaturesMainSelectionState.value.snapshotsByServerId[serverId]
                    ?.features.capabilities.liveActivities.remoteUpdates;
                return Response.json(createRootLayoutFeaturesResponse({ capabilities: {
                    liveActivities: remoteUpdates ? { remoteUpdates } : {},
                } }));
            }
            if (url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v2/account/session-delivery-mutes') return Response.json({ scopes: [] });
            if (url.pathname === '/v1/live-activity-targets' && init?.method === 'POST') {
                // This body was serialized by the real typed API adapter.
                const request = JSON.parse(String(init.body)) as LiveActivityTargetRegistrationInput;
                const target = await registerLiveActivityTarget(request);
                return Response.json({ success: true, target: { id: target.targetId } });
            }
            if (url.pathname.startsWith('/v1/live-activity-targets/') && init?.method === 'DELETE') {
                await markLiveActivityTargetEnded(decodeURIComponent(url.pathname.split('/').at(-1)!), { serverId });
                return Response.json({ success: true });
            }
            return activityHomes.request(input, init);
        });
        await setActiveServerId('server-a');
        saveLastRegisteredExpoPushToken('ExponentPushToken[background-wake]');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://server-a', { serverId: 'server-a' });
        if (!credentials) throw new Error('Activity Home credential unavailable');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        storage.setState({ isDataReady: false });
        await restoreConnectionToActiveServer(credentials);
        storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-server-a' });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        persistDefaultActivityHomeAccountSettings();
        publishActivityFixture();
    });

    afterEach(async () => {
        setScreenSharingPrivacyActive(false);
        standardCleanup();
        const { stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        stopConcurrentSessionCacheSync();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        platformState.os = 'ios';
        appStateState.currentState = 'active';
        appStateState.listeners.clear();
        sessionsState.value = [];
        sessionIndexServerOverridesState.value = {};
        dataReadyState.value = true;
        constantsState.expoConfig.plugins = [
            ['expo-widgets', { widgets: [] }],
        ];
        delete constantsState.expoConfig.extra;
        serverFeaturesMainSelectionState.value = {
            status: 'ready',
            serverIds: [],
            snapshotsByServerId: {},
        };
        settingsState.value = createFeatureToggleState();
        localSettingsState.value = createLocalSettingsState();
        widgetInteractionsState.listener = null;
        liveActivityAuthorizationState.module = null;
        liveActivityHandleTokenApiState.enabled = false;
        liveActivityHandleTokenApiState.currentPushToken = null;
        liveActivityHandleTokenApiState.throwOnAddPushTokenListener = false;
        liveActivityPushTokenListeners.length = 0;
        focusWidgetUpdateSnapshot.mockClear();
        sessionsWidgetUpdateSnapshot.mockClear();
        liveActivityStart.mockClear();
        liveActivityUpdate.mockClear();
        liveActivityEnd.mockClear();
        liveActivityGetInstances.mockClear();
        registerLiveActivityTarget.mockClear();
        markLiveActivityTargetEnded.mockClear();
        liveActivityInstances.length = 0;
        widgetInteractionListenerAttachState.throwOnAttach = false;
        addUserInteractionListener.mockClear();
        routerPush.mockClear();
        actionExecutorExecute.mockClear();
        syncLiveActivityBackgroundWakeTaskRegistration.mockClear();
        vi.restoreAllMocks();
        await activityHomes.reset();
    });

    // The Live Activity fallback wake is this runtime's own leg, and a
    // registration that silently stops happening is invisible until a device is
    // asleep. The collaborator `session_changed` wake is not registered here:
    // it belongs to `ActivityLocalNotificationRuntime`, which mounts on every
    // platform, and is asserted there.
    it('omits recording-private Sessions from widget and Live Activity bridges and restores them after sharing ends', async () => {
        sessionsState.value = [createSessionFixture({ id: 'private-ios', encryptionMode: 'plain', active: true,
            presence: 'online', pendingPermissionRequestCount: 1,
            metadata: { path: '/private', host: 'host', name: 'Private iOS work' } })];
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'server-a': ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic('server-a', 'private-ios', ['private']);
        setScreenSharingPrivacyActive(true);
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(<ActivitySurfacesRuntime />);
        await act(async () => {});
        expect(focusWidgetUpdateSnapshot).toHaveBeenCalled();
        expect(JSON.stringify(focusWidgetUpdateSnapshot.mock.calls.at(-1))).not.toContain('private-ios');
        expect(JSON.stringify(sessionsWidgetUpdateSnapshot.mock.calls.at(-1))).not.toContain('private-ios');
        expect(liveActivityStart).not.toHaveBeenCalled();
        await act(async () => { setScreenSharingPrivacyActive(false); });
        await waitForHomeGovernance(() => expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'private-ios' }), expect.any(String), expect.any(Date)));
        expect(JSON.stringify(sessionsWidgetUpdateSnapshot.mock.calls.at(-1))).toContain('private-ios');
        await screen.unmount();
    });

    it('registers the Live Activity closed-app background wake task on iOS', async () => {
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        await renderScreen(React.createElement(ActivitySurfacesRuntime));

        expect(syncLiveActivityBackgroundWakeTaskRegistration).toHaveBeenCalled();
    });

    it('immediately dismisses retained private Live Activity content when sharing starts', async () => {
        sessionsState.value = [createSessionFixture({ id: 'private-running', encryptionMode: 'plain', active: true,
            presence: 'online', thinking: true,
            metadata: { path: '/private', host: 'host', name: 'Private running work' } })];
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(<ActivitySurfacesRuntime />);
        await waitForHomeGovernance(() => expect(liveActivityStart).toHaveBeenCalled());
        await act(async () => {
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'server-a': ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic('server-a', 'private-running', ['private']);
            setScreenSharingPrivacyActive(true);
        });
        await waitForHomeGovernance(() => expect(liveActivityEnd).toHaveBeenCalled());
        expect(liveActivityEnd).toHaveBeenCalledWith('immediate', undefined, expect.any(Date));
        expect(JSON.stringify(sessionsWidgetUpdateSnapshot.mock.calls.at(-1))).not.toContain('private-running');
        await screen.unmount();
    });

    it('registers no Live Activity background wake task on another platform', async () => {
        platformState.os = 'android';

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        await renderScreen(React.createElement(ActivitySurfacesRuntime));

        expect(syncLiveActivityBackgroundWakeTaskRegistration).not.toHaveBeenCalled();
    });

    it('ends existing live activity instances when the store is ready but there are no eligible sessions', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [];
        dataReadyState.value = true;

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(existingEnd).toHaveBeenCalledTimes(1);
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('keeps existing live activities alive while the store is not hydrated and there is nothing to reconcile yet', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [];
        dataReadyState.value = false;
        expect(storage.getState().isDataReady).toBe(false);

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(storage.getState().isDataReady).toBe(false);
        expect(existingEnd).not.toHaveBeenCalled();
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('restarts existing native live activities once hydrated so the server-scoped route is rewritten', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(existingUpdate).not.toHaveBeenCalled();
        expect(existingEnd).toHaveBeenCalledTimes(1);
        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                activityInstanceKey: liveActivityKey('server-a', 'permission'),
                serverId: 'server-a',
                sessionId: 'permission',
            }),
            '/session/permission?serverId=server-a',
            expect.any(Date),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('pushes the shared snapshot into the focus and sessions widgets and starts the focused live activity', async () => {
        const unread = createSessionFixture({
            id: 'unread', serverId: 'server-a', seq: 5, lastViewedSessionSeq: 2,
            metadata: {
                path: '/Users/tester/project/unread', host: 'tester.local', homeDir: '/Users/tester',
                summary: { text: 'Unread work', updatedAt: 1 },
            },
        });
        // Important is the owner's default and does not select ordinary message
        // occurrences. This Home's explicit All messages Follow admits the unread
        // candidate through the real delivery owner, independently of its read state.
        const follow = projectSessionFollowFactsV1({ following: true,
            policy: { preset: 'everything' } });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
            { ...unread, viewer: { ...createSessionOwnerViewerFixture(unread), follow,
                notification: resolveSessionEffectiveNotificationV1({ facts: follow, isSessionOwner: true }) } },
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            primary: expect.objectContaining({
                sessionId: 'permission',
                title: 'Permission work',
                attentionState: 'permission_required',
                previewText: 'Permission work',
            }),
            sessions: expect.arrayContaining([
                expect.objectContaining({ sessionId: 'permission' }),
                expect.objectContaining({ sessionId: 'unread' }),
            ]),
        }));
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                permissionRequired: 1,
                unread: 1,
                totalAttention: 2,
            }),
        }));
        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'permission',
                title: 'Permission work',
                previewText: 'Permission work',
                attentionState: 'permission_required',
                defaultTarget: 'open-session:permission?serverId=server-a',
            }),
            '/session/permission?serverId=server-a',
            expect.any(Date),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('delivers only property-list values to the native widget timelines, with and without a focused Session', async () => {
        // expo-widgets stores timeline props in UserDefaults. A null becomes NSNull, which is not a
        // property-list value, so iOS rejects the whole timeline write and the widget keeps stale content.
        const countNulls = (value: unknown): number => {
            if (value === null) return 1;
            if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + countNulls(entry), 0);
            if (typeof value === 'object' && value !== undefined) {
                return Object.values(value as Record<string, unknown>).reduce<number>((total, entry) => total + countNulls(entry), 0);
            }
            return 0;
        };
        const deliveredNulls = () => [...focusWidgetUpdateSnapshot.mock.calls, ...sessionsWidgetUpdateSnapshot.mock.calls]
            .reduce((total, [snapshot]) => total + countNulls(snapshot), 0);

        sessionsState.value = [];
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));
        await act(async () => {});
        expect(focusWidgetUpdateSnapshot).toHaveBeenCalled();
        expect(deliveredNulls()).toBe(0);

        await act(async () => {
            sessionsState.value = [createSessionFixture({
                id: 'permission', serverId: 'server-a', seq: 10, lastViewedSessionSeq: 10, active: true, presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: { path: '/Users/tester/project/permission', host: 'tester.local', homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 } },
            })];
        });
        await act(async () => {});
        expect(focusWidgetUpdateSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
            primary: expect.objectContaining({ sessionId: 'permission' }),
        }));
        expect(deliveredNulls()).toBe(0);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('keeps the app running when one native widget bridge rejects a snapshot update', async () => {
        focusWidgetUpdateSnapshot.mockImplementationOnce(() => {
            throw new Error('native widget bridge unavailable');
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            sessions: expect.arrayContaining([
                expect.objectContaining({ sessionId: 'permission' }),
            ]),
        }));
        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'permission',
            }),
            '/session/permission?serverId=server-a',
            expect.any(Date),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('lets widgets opt into previews without exposing live-activity lock-screen text', async () => {
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'status_only',
                },
                widgets: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Sensitive approval details', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            primary: expect.objectContaining({
                previewText: 'Sensitive approval details',
            }),
        }));
        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.not.stringContaining('Sensitive approval details'),
                previewText: null,
                statusText: null,
            }),
            '/session/permission?serverId=server-a',
            expect.any(Date),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('backs off after a live activity start failure without leaving a stale handle', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];
        liveActivityStart.mockImplementationOnce(() => {
            throw new Error('Live Activities disabled');
        });

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityStart).toHaveBeenCalledTimes(1);
        expect(liveActivityInstances).toHaveLength(0);

        sessionsState.value = [...sessionsState.value];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T12:01:01.000Z'));
        sessionsState.value = [...sessionsState.value];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityStart).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('does not start live activities when authorization diagnostics report disabled', async () => {
        liveActivityAuthorizationState.module = {
            getLiveActivityAuthorizationDiagnostics: async () => ({
                areActivitiesEnabled: false,
                frequentPushesEnabled: false,
            }),
        };
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('caps urgent Live Activity APNs priority when frequent updates authorization is disabled', async () => {
        liveActivityAuthorizationState.module = {
            getLiveActivityAuthorizationDiagnostics: async () => ({
                areActivitiesEnabled: true,
                frequentPushesEnabled: false,
            }),
        };
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'permission',
                attentionState: 'permission_required',
                presentationTemplate: 'urgentAttention',
                apnsPriority: 5,
                relevanceScore: 90,
            }),
            '/session/permission?serverId=server-a',
            expect.any(Date),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('continues without direct widget actions when the interaction listener cannot attach', async () => {
        widgetInteractionListenerAttachState.throwOnAttach = true;
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

        await expect((async () => {
            screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));
            await act(async () => {});
        })()).resolves.toBeUndefined();

        expect(addUserInteractionListener).toHaveBeenCalled();
        expect(widgetInteractionsState.listener).toBeNull();
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen?.tree.unmount();
        });
    });

    it('drops and backs off a live activity handle after an update failure', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'include_preview',
                },
            },
        });
        const session = createSessionFixture({
            id: 'permission',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        liveActivityUpdate.mockRejectedValueOnce(new Error('Activity no longer exists'));
        vi.setSystemTime(new Date('2026-05-03T12:00:01.000Z'));
        sessionsState.value = [{
            ...session,
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Permission work changed', updatedAt: 2 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityUpdate).toHaveBeenCalledTimes(1);

        sessionsState.value = [{
            ...session,
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Permission work changed again', updatedAt: 3 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T12:01:01.000Z'));
        sessionsState.value = [{
            ...session,
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Permission work after backoff', updatedAt: 4 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });
        expect(liveActivityStart).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('drops a live activity handle after an end failure', async () => {
        const session = createSessionFixture({
            id: 'permission',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        liveActivityEnd.mockRejectedValueOnce(new Error('Activity already ended'));
        sessionsState.value = [];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityEnd).toHaveBeenCalled();

        sessionsState.value = [{ ...session, seq: 11 }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityStart).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('swallows native live activity end failures during unmount cleanup', async () => {
        const session = createSessionFixture({
            id: 'permission',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        liveActivityEnd.mockRejectedValueOnce(new Error('Activity already ended'));

        await act(async () => {
            screen.tree.unmount();
        });
        await act(async () => {});

        expect(liveActivityEnd).toHaveBeenCalled();
    });

    it('ends an urgent failed activity immediately using its canonical snapshot template', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        sessionsState.value = [createSessionFixture({ id: 'failed', seq: 10,
            viewer: createSessionViewerFixture({ latestFailureSeq: 10,
                readState: { state: 'tracking', lastViewedSessionSeq: 9, unreadSince: 10 },
                attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' } }),
            lastViewedSessionSeq: 9, active: true, activeAt: Date.now(), presence: 'online',
            latestTurnStatus: 'failed', latestTurnStatusObservedAt: Date.now(),
        })];
        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));
        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);
        sessionsState.value = [];
        await act(async () => { await screen.update(React.createElement(ActivitySurfacesRuntime)); });
        expect(liveActivityEnd).toHaveBeenCalledWith('immediate', undefined, new Date('2026-05-03T12:00:00.000Z'));
        await act(async () => { screen.tree.unmount(); });
    });

    it('ends non-urgent live activities with a short grace dismissal policy', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        const session = createSessionFixture({
            id: 'thinking',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            thinking: true,
            metadata: {
                path: '/Users/tester/project/thinking',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Thinking work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        sessionsState.value = [];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityEnd).toHaveBeenCalledWith(
            { after: new Date('2026-05-03T12:05:00.000Z') },
            undefined,
            new Date('2026-05-03T12:00:00.000Z'),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('skips live activity updates when only generated time changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        const session = createSessionFixture({
            id: 'permission',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T12:00:30.000Z'));
        sessionsState.value = [{ ...session }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityUpdate).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('rolls live activities after the local ActivityKit age cap instead of updating stale instances forever', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        const session = createSessionFixture({
            id: 'permission',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T20:00:01.000Z'));
        sessionsState.value = [{
            ...session,
            pendingRequestObservedAt: Date.now(),
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Permission work after rollover', updatedAt: 2 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityEnd).toHaveBeenCalledWith('immediate', undefined, new Date('2026-05-03T20:00:01.000Z'));
        expect(liveActivityUpdate).not.toHaveBeenCalled();
        expect(liveActivityStart).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('applies the background AppState update budget before updating quiet live activities', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        appStateState.currentState = 'background';
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'include_preview',
                },
            },
        });
        const session = createSessionFixture({
            id: 'thinking',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            thinking: true,
            metadata: {
                path: '/Users/tester/project/thinking',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Thinking work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T12:00:05.000Z'));
        const startedSnapshot = liveActivityStart.mock.calls[0]![0];
        expect(liveActivityStart).toHaveBeenLastCalledWith(
            startedSnapshot,
            expect.any(String),
            new Date(startedSnapshot.staleAt),
        );
        sessionsState.value = [{
            ...session,
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Thinking work changed', updatedAt: 2 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityUpdate).not.toHaveBeenCalled();

        vi.setSystemTime(new Date('2026-05-03T12:00:31.000Z'));
        sessionsState.value = [{
            ...session,
            metadata: {
                ...session.metadata,
                path: session.metadata?.path ?? '',
                host: session.metadata?.host ?? '',
                summary: { text: 'Thinking work after budget', updatedAt: 3 },
            },
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityUpdate).toHaveBeenCalledTimes(1);

        const appliedSnapshot = liveActivityUpdate.mock.calls[0]![0];
        if (typeof appliedSnapshot !== 'object' || appliedSnapshot === null
            || !('staleAt' in appliedSnapshot) || typeof appliedSnapshot.staleAt !== 'number') {
            throw new Error('Native live activity update omitted its numeric staleAt');
        }
        expect(liveActivityUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ staleAt: appliedSnapshot.staleAt }),
            new Date(appliedSnapshot.staleAt),
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('does not reuse a live activity handle when the same session id moves to a different server', async () => {
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        sessionsState.value = [{
            ...session,
            serverId: 'server-b',
            updatedAt: session.updatedAt + 1,
        }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityEnd).toHaveBeenCalled();
        expect(liveActivityUpdate).not.toHaveBeenCalled();
        expect(liveActivityStart).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('registers ActivityKit update tokens after native token rotation when direct APNs is selected', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityPushTokenListeners).toHaveLength(1);

        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token',
            });
        });

        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            deviceId: 'device-1',
            serverId: 'server-a',
            sessionId: 'permission',
            activityInstanceKey: liveActivityKey('server-a', 'permission'),
            activityId: 'native-activity-1',
            activityName: 'HappierFocusLiveActivity',
            transportMode: 'direct_apns',
            tokenKind: 'activitykit_update_token',
            rawToken: 'raw-activitykit-token',
            bundleId: 'dev.happier.custom',
            environment: 'sandbox',
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('registers an already available ActivityKit update token before waiting for rotation events', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        liveActivityHandleTokenApiState.currentPushToken = 'raw-activitykit-token-current';
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityPushTokenListeners).toHaveLength(1);
        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            deviceId: 'device-1',
            serverId: 'server-a',
            sessionId: 'permission',
            activityInstanceKey: liveActivityKey('server-a', 'permission'),
            activityId: liveActivityKey('server-a', 'permission'),
            activityName: 'HappierFocusLiveActivity',
            transportMode: 'direct_apns',
            tokenKind: 'activitykit_update_token',
            rawToken: 'raw-activitykit-token-current',
            bundleId: 'dev.happier.custom',
            environment: 'sandbox',
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('marks the current-token target ended when a later native token event replaces it', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        liveActivityHandleTokenApiState.currentPushToken = 'raw-activitykit-token-current';
        registerLiveActivityTarget
            .mockResolvedValueOnce({ targetId: 'target-current-token' })
            .mockResolvedValueOnce({ targetId: 'target-native-token' });
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            activityId: liveActivityKey('server-a', 'permission'),
            rawToken: 'raw-activitykit-token-current',
        }));

        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token-native',
            });
        });

        expect(registerLiveActivityTarget).toHaveBeenLastCalledWith(expect.objectContaining({
            activityId: 'native-activity-1',
            rawToken: 'raw-activitykit-token-native',
        }));
        expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-current-token', { serverId: 'server-a' });

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('registers the current Expo push token as a background-wake Live Activity target without ActivityKit token APIs', async () => {
        await configureBackgroundWakeRemoteUpdatesForServer('server-a');
        constantsState.expoConfig.extra = {
            app: {
                iosBackgroundWakeNotificationsEnabled: true,
            },
        };
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityPushTokenListeners).toHaveLength(0);
        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            deviceId: 'device-1',
            serverId: 'server-a',
            sessionId: 'permission',
            activityInstanceKey: liveActivityKey('server-a', 'permission'),
            activityId: liveActivityKey('server-a', 'permission'),
            activityName: 'HappierFocusLiveActivity',
            transportMode: 'background_wake_best_effort',
            tokenKind: 'expo_push_token',
            expoPushToken: 'ExponentPushToken[background-wake]',
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('does not register background-wake targets when the static background task config is disabled', async () => {
        await configureBackgroundWakeRemoteUpdatesForServer('server-a');
        constantsState.expoConfig.extra = {
            app: {
                iosBackgroundWakeNotificationsEnabled: false,
            },
        };
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(registerLiveActivityTarget).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('uses the configured APNs production environment for ActivityKit target registration', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        constantsState.expoConfig.extra = {
            app: {
                happierLiveActivityApnsEnvironment: 'production',
            },
        };
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token',
            });
        });

        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            environment: 'production',
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('normalizes runtime APNs environment metadata before ActivityKit target registration', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_IOS_APNS_ENVIRONMENT', 'PRODUCTION');
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token',
            });
        });

        expect(registerLiveActivityTarget).toHaveBeenCalledWith(expect.objectContaining({
            environment: 'production',
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('replaces ActivityKit token listeners when the selected remote transport rotates', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        registerLiveActivityTarget
            .mockResolvedValueOnce({ targetId: 'target-direct-1' })
            .mockResolvedValueOnce({ targetId: 'target-hosted-1' });
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityPushTokenListeners).toHaveLength(1);
        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token-1',
            });
        });
        expect(registerLiveActivityTarget).toHaveBeenLastCalledWith(expect.objectContaining({
            transportMode: 'direct_apns',
            rawToken: 'raw-activitykit-token-1',
        }));

        await act(async () => {
            await configureHostedRelayRemoteUpdatesForServer('server-a');
            sessionsState.value = [{
                ...session,
                updatedAt: session.updatedAt + 1,
            }];
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        // Keep the current transport target until its replacement registers, then retire it.
        // This avoids an update gap during transport rotation and keeps one registry authoritative.
        expect(markLiveActivityTargetEnded).not.toHaveBeenCalled();
        expect(liveActivityPushTokenListeners).toHaveLength(1);
        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-2',
                pushToken: 'raw-activitykit-token-2',
            });
        });

        expect(registerLiveActivityTarget).toHaveBeenLastCalledWith(expect.objectContaining({
            transportMode: 'hosted_happier_relay',
            rawToken: 'raw-activitykit-token-2',
        }));
        await vi.waitFor(() => {
            expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-direct-1', { serverId: 'server-a' });
        });

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('continues without a remote token listener when ActivityKit listener attachment fails', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(liveActivityStart).toHaveBeenCalledTimes(1);
        expect(liveActivityPushTokenListeners).toHaveLength(0);

        await expect(act(async () => {
            liveActivityHandleTokenApiState.throwOnAddPushTokenListener = true;
            await configureDirectApnsRemoteUpdatesForServer('server-a');
            sessionsState.value = [{
                ...session,
                updatedAt: session.updatedAt + 1,
            }];
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        })).resolves.toBeUndefined();

        expect(liveActivityPushTokenListeners).toHaveLength(0);
        expect(registerLiveActivityTarget).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('marks remembered Live Activity remote targets ended when the activity is removed locally', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        await act(async () => {
            liveActivityPushTokenListeners[0]?.({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token',
            });
        });
        expect(registerLiveActivityTarget).toHaveBeenCalledTimes(1);

        sessionsState.value = [];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-direct-1', { serverId: 'server-a' });

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('keeps and retries the exact remote target after end transport failure without blocking local teardown', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        await configureDirectApnsRemoteUpdatesForServer('server-a');
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];
        markLiveActivityTargetEnded
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValueOnce(undefined);

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await vi.waitFor(() => expect(liveActivityPushTokenListeners).toHaveLength(1));
        await act(async () => {
            liveActivityPushTokenListeners[0]!({
                activityId: 'native-activity-1',
                pushToken: 'raw-activitykit-token',
            });
        });
        expect(registerLiveActivityTarget).toHaveBeenCalledTimes(1);

        sessionsState.value = [];
        await expect(act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        })).resolves.toBeUndefined();
        await vi.waitFor(() => {
            expect(liveActivityEnd).toHaveBeenCalledTimes(1);
            expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-direct-1', { serverId: 'server-a' });
        });

        // A subsequent ordinary reconciliation is the retry trigger. No timer, outbox or
        // second lifecycle is involved, and the exact Home/target binding is preserved.
        settingsState.value = { ...settingsState.value };
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });
        await act(async () => {});

        expect(markLiveActivityTargetEnded.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of markLiveActivityTargetEnded.mock.calls) {
            expect(call).toEqual(['target-direct-1', { serverId: 'server-a' }]);
        }

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('routes live activity taps through the server-scoped command resolver', async () => {
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(widgetInteractionsState.listener).not.toBeNull();

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: 'open-session:permission',
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
            });
        });

        expect(routerPush).toHaveBeenCalledWith('/session/permission?serverId=server-a');

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('executes a verified Live Activity permission action when privacy and surface policy allow direct actions', async () => {
        await configureVerifiedLocalServerContext('server-a');
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(widgetInteractionsState.listener).not.toBeNull();

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: liveActivityKey('server-a', 'permission'),
                },
            });
        });

        expect(actionExecutorExecute).toHaveBeenCalledWith(
            'session.permission.respond',
            {
                decision: 'allow',
                sessionId: 'permission',
                requestId: 'request-1',
            },
            {
                surface: 'ui',
                defaultSessionId: 'permission',
                serverId: 'server-a',
            },
        );
        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('opens the session instead of executing a Live Activity action when lock-screen privacy is restricted', async () => {
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: { privacyMode: 'status_only' },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: liveActivityKey('server-a', 'permission'),
                },
            });
        });

        expect(actionExecutorExecute).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith('/session/permission?serverId=server-a');

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('opens the session instead of executing when the source target context is not locally verified', async () => {
        // The default fixture binds every saved Home. This case deliberately
        // withholds the secure credential that would verify the event's Home.
        for (const serverId of ACTIVITY_TEST_HOME_SERVER_IDS) {
            await TokenStorage.removeCredentialsForServerUrl(`https://${serverId}`);
        }
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: liveActivityKey('server-a', 'permission'),
                },
            });
        });

        expect(actionExecutorExecute).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith('/session/permission?serverId=server-a');

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('executes a verified widget permission action when widget privacy and surface policy allow direct actions', async () => {
        await configureVerifiedLocalServerContext('server-a');
        localSettingsState.value = createLocalSettingsState({
            iosLiveActivitiesEnabled: false,
            attentionDeviceOverridesV1: {
                v: 1,
                widgets: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusWidget',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                },
            });
        });

        expect(actionExecutorExecute).toHaveBeenCalledWith(
            'session.permission.respond',
            {
                decision: 'allow',
                sessionId: 'permission',
                requestId: 'request-1',
            },
            {
                surface: 'ui',
                defaultSessionId: 'permission',
                serverId: 'server-a',
            },
        );
        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('executes a verified widget permission action when shared source index owns the server scope', async () => {
        await configureVerifiedLocalServerContext('server-a');
        sessionIndexServerOverridesState.value = {
            permission: 'server-a',
        };
        localSettingsState.value = createLocalSettingsState({
            iosLiveActivitiesEnabled: false,
            attentionDeviceOverridesV1: {
                v: 1,
                widgets: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusWidget',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                },
            });
        });

        expect(actionExecutorExecute).toHaveBeenCalledWith(
            'session.permission.respond',
            {
                decision: 'allow',
                sessionId: 'permission',
                requestId: 'request-1',
            },
            {
                surface: 'ui',
                defaultSessionId: 'permission',
                serverId: 'server-a',
            },
        );
        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('ignores direct side effects for unverified Live Activity action payloads', async () => {
        localSettingsState.value = createLocalSettingsState({
            attentionDeviceOverridesV1: {
                v: 1,
                liveActivities: {
                    privacyMode: 'include_preview',
                },
            },
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
                data: {
                    serverId: 'server-b',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: liveActivityKey('server-b', 'permission'),
                },
            });
        });

        expect(actionExecutorExecute).not.toHaveBeenCalled();
        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('skips widget snapshot bridge updates when the shared source fingerprint is unchanged', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
        const session = createSessionFixture({
            id: 'permission',
            serverId: 'server-a',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 1 },
            },
        });
        sessionsState.value = [session];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        const focusWidgetUpdatesAfterMount = focusWidgetUpdateSnapshot.mock.calls.length;
        const sessionsWidgetUpdatesAfterMount = sessionsWidgetUpdateSnapshot.mock.calls.length;
        expect(focusWidgetUpdatesAfterMount).toBeGreaterThan(0);
        expect(sessionsWidgetUpdatesAfterMount).toBeGreaterThan(0);

        vi.setSystemTime(new Date('2026-05-03T12:00:30.000Z'));
        sessionsState.value = [{ ...session }];
        await act(async () => {
            await screen.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledTimes(focusWidgetUpdatesAfterMount);
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledTimes(sessionsWidgetUpdatesAfterMount);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('routes widget taps for local sessions when live activities are disabled', async () => {
        await activityHomes.selectHomes(['server-a', 'local']);
        const { startConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await waitForHomeGovernance(() => expect(storage.getState().concurrentSessionListCacheByServerId.local).toBeDefined());
        localSettingsState.value = createLocalSettingsState({
            iosLiveActivitiesEnabled: false,
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'local',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(widgetInteractionsState.listener).not.toBeNull();
        await waitForHomeGovernance(() => expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            primary: expect.objectContaining({ sessionId: 'permission' }),
        })));

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusWidget',
                target: 'open-session:permission',
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
            });
        });

        expect(routerPush).toHaveBeenCalledWith('/session/permission?serverId=local');

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('ignores a live activity action that targets an unknown session identity', async () => {
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                serverId: 'server-a',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});
        expect(widgetInteractionsState.listener).not.toBeNull();

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusLiveActivity',
                target: 'open-session:unknown-session',
                timestamp: Date.now(),
                type: 'ExpoWidgetsUserInteraction',
            });
        });

        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
