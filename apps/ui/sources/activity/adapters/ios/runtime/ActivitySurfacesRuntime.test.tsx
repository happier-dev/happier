import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { buildLiveActivityRemoteUpdateCapabilityDiagnostics, PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';

import { createSessionFixture as createBaseSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit';

function createSessionFixture(
    overrides: Parameters<typeof createBaseSessionFixture>[0] = {},
): ReturnType<typeof createBaseSessionFixture> {
    const observedAt = Date.now();
    const hasPendingRequest = (overrides.pendingPermissionRequestCount ?? 0) > 0
        || (overrides.pendingUserActionRequestCount ?? 0) > 0;

    return createBaseSessionFixture({
        ...(typeof overrides.seq === 'number' && overrides.latestReadyEventSeq === undefined
            ? { latestReadyEventSeq: overrides.seq }
            : {}),
        ...(overrides.thinking === true && overrides.thinkingAt === undefined
            ? { thinkingAt: observedAt }
            : {}),
        ...(hasPendingRequest && overrides.pendingRequestObservedAt === undefined
            ? { pendingRequestObservedAt: observedAt }
            : {}),
        ...overrides,
    });
}

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web' | 'android',
}));

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
        snapshotsByServerId: {} as Record<string, unknown>,
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

const serverProfilesState = vi.hoisted(() => {
    type ServerProfileFixture = Readonly<{
        id: string;
        name: string;
        serverUrl: string;
        createdAt: number;
        updatedAt: number;
        lastUsedAt: number;
    }>;
    type ActiveServerSnapshotFixture = Readonly<{
        serverId: string;
        serverUrl: string;
        generation: number;
    }>;
    return {
        profiles: [] as ServerProfileFixture[],
        generation: 0,
        active: {
            serverId: '',
            serverUrl: '',
            generation: 0,
        } as ActiveServerSnapshotFixture,
    };
});

const widgetInteractionsState = vi.hoisted(() => ({
    listener: null as null | ((event: {
        source: string;
        target: string;
        timestamp: number;
        type: string;
        data?: Record<string, unknown>;
    }) => void),
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
const lastRegisteredExpoPushTokenState = vi.hoisted(() => ({
    value: 'ExponentPushToken[background-wake]',
}));
const liveActivityInstances = vi.hoisted(() => [] as Array<{
    update: (props: unknown) => Promise<void>;
    end: (dismissalPolicy?: unknown, props?: unknown, contentDate?: Date) => Promise<void>;
    addPushTokenListener?: (listener: (event: { activityId: string; pushToken: string }) => void) => { remove: () => void };
    getPushToken?: () => Promise<string | null>;
}>);
const liveActivityStart = vi.hoisted(() =>
    vi.fn(() => {
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
const liveActivityUpdate = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityEnd = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityGetInstances = vi.hoisted(() => vi.fn(() => liveActivityInstances));
const registerLiveActivityTarget = vi.hoisted(() =>
    vi.fn(async () => ({ targetId: 'target-direct-1' }))
);
const markLiveActivityTargetEnded = vi.hoisted(() => vi.fn(async () => undefined));
const addUserInteractionListener = vi.hoisted(() =>
    vi.fn((listener: typeof widgetInteractionsState.listener) => {
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
const actionExecutorExecute = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

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

vi.mock('expo-router', () => ({
    router: {
        push: routerPush,
    },
}));

vi.mock('expo-widgets', () => ({
    addUserInteractionListener,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: actionExecutorExecute,
    }),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => liveActivityAuthorizationState.module,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: () => serverFeaturesMainSelectionState.value,
    };
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => serverProfilesState.profiles,
    getServerProfilesGeneration: () => serverProfilesState.generation,
    subscribeServerProfiles: () => () => undefined,
    getActiveServerSnapshot: () => serverProfilesState.active,
    subscribeActiveServer: () => () => undefined,
}));

vi.mock('@/sync/api/session/apiLiveActivityTargets', () => ({
    registerLiveActivityTarget,
    markLiveActivityTargetEnded,
}));

vi.mock('@/sync/domains/state/pushTokenRegistration', () => ({
    loadLastRegisteredExpoPushToken: () => lastRegisteredExpoPushTokenState.value,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const createActivitySourceStorageState = () => ({
        isDataReady: dataReadyState.value,
        sessions: Object.fromEntries(sessionsState.value.map((session) => [session.id, session])),
        sessionListRenderables: {},
        sessionMessages: {},
        sessionListIndexByServerId: sessionsState.value.reduce<Record<string, Array<{
            type: 'session';
            sessionId: string;
            serverId?: string;
        }>>>((byServerId, session) => {
            const overrideServerId = sessionIndexServerOverridesState.value[session.id];
            const serverId = typeof overrideServerId === 'string' && overrideServerId.trim()
                ? overrideServerId.trim()
                : typeof session.serverId === 'string' && session.serverId.trim()
                ? session.serverId.trim()
                : 'local';
            const items = byServerId[serverId] ?? [];
            items.push({
                type: 'session',
                sessionId: session.id,
                ...(serverId === 'local' ? {} : { serverId }),
            });
            byServerId[serverId] = items;
            return byServerId;
        }, {}),
        concurrentSessionListCacheByServerId: {},
    });
    const storage = Object.assign(
        (selector?: (state: ReturnType<typeof createActivitySourceStorageState>) => unknown) => {
            const state = createActivitySourceStorageState();
            return typeof selector === 'function' ? selector(state) : state;
        },
        {
            getState: createActivitySourceStorageState,
            getInitialState: createActivitySourceStorageState,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({
        storage,
        useAllSessions: () => {
            throw new Error('ActivitySurfacesRuntime should use the shared activity source');
        },
        useSettings: () => settingsState.value,
        useLocalSettings: () => localSettingsState.value,
        useIsDataReady: () => dataReadyState.value,
    });
});

vi.mock('./iosActivityWidgetModules', () => ({
    HappierFocusWidget: {
        updateSnapshot: focusWidgetUpdateSnapshot,
    },
    HappierSessionsWidget: {
        updateSnapshot: sessionsWidgetUpdateSnapshot,
    },
    HappierFocusLiveActivity: {
        start: liveActivityStart,
        getInstances: liveActivityGetInstances,
    },
}));

function configureDirectApnsRemoteUpdatesForServer(serverId: string): void {
    constantsState.expoConfig.plugins = [
        ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
    ];
    settingsState.value = createFeatureToggleState({ directApnsRemoteUpdates: true });
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
}

function configureHostedRelayRemoteUpdatesForServer(serverId: string): void {
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
}

function configureBackgroundWakeRemoteUpdatesForServer(serverId: string): void {
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
}

function configureVerifiedLocalServerContext(serverId: string): void {
    serverProfilesState.profiles = [{
        id: serverId,
        name: serverId,
        serverUrl: `https://${serverId}.example.test`,
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    }];
    serverProfilesState.generation += 1;
    serverProfilesState.active = {
        serverId,
        serverUrl: `https://${serverId}.example.test`,
        generation: serverProfilesState.generation,
    };
}

describe('ActivitySurfacesRuntime', () => {
    afterEach(() => {
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
        serverProfilesState.profiles = [];
        serverProfilesState.generation = 0;
        serverProfilesState.active = {
            serverId: '',
            serverUrl: '',
            generation: 0,
        };
        settingsState.value = createFeatureToggleState();
        localSettingsState.value = createLocalSettingsState();
        widgetInteractionsState.listener = null;
        liveActivityAuthorizationState.module = null;
        liveActivityHandleTokenApiState.enabled = false;
        liveActivityHandleTokenApiState.currentPushToken = null;
        liveActivityHandleTokenApiState.throwOnAddPushTokenListener = false;
        lastRegisteredExpoPushTokenState.value = 'ExponentPushToken[background-wake]';
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

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

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
                activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
                serverId: 'server-a',
                sessionId: 'permission',
            }),
            '/session/permission?serverId=server-a',
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('pushes the shared snapshot into the focus and sessions widgets and starts the focused live activity', async () => {
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
            createSessionFixture({
                id: 'unread',
                serverId: 'server-a',
                seq: 5,
                lastViewedSessionSeq: 2,
                metadata: {
                    path: '/Users/tester/project/unread',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Unread work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            primary: expect.objectContaining({
                sessionId: 'permission',
                title: 'Permission work',
                attentionState: 'permission_required',
                previewText: null,
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
                title: expect.not.stringContaining('Permission work'),
                previewText: null,
                statusText: null,
                defaultTarget: 'open-session:permission?serverId=server-a',
            }),
            '/session/permission?serverId=server-a',
        );

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

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledTimes(1);
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
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('lets widgets opt into previews without exposing live-activity lock-screen text', async () => {
        localSettingsState.value = createLocalSettingsState({
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-05-03T12:01:01.000Z'));
        sessionsState.value = [...sessionsState.value];
        await act(async () => {
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
                relevanceScore: 100,
            }),
            '/session/permission',
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityEnd).toHaveBeenCalled();

        sessionsState.value = [{ ...session, seq: 11 }];
        await act(async () => {
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(liveActivityUpdate).toHaveBeenCalledTimes(1);

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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
            activityId: 'server-a:HappierFocusLiveActivity:permission',
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
            activityId: 'server-a:HappierFocusLiveActivity:permission',
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
        configureBackgroundWakeRemoteUpdatesForServer('server-a');
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
            activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
            activityId: 'server-a:HappierFocusLiveActivity:permission',
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
        configureBackgroundWakeRemoteUpdatesForServer('server-a');
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
        configureDirectApnsRemoteUpdatesForServer('server-a');
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

        configureHostedRelayRemoteUpdatesForServer('server-a');
        sessionsState.value = [{
            ...session,
            updatedAt: session.updatedAt + 1,
        }];
        await act(async () => {
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-direct-1', { serverId: 'server-a' });
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

        liveActivityHandleTokenApiState.throwOnAddPushTokenListener = true;
        configureDirectApnsRemoteUpdatesForServer('server-a');
        sessionsState.value = [{
            ...session,
            updatedAt: session.updatedAt + 1,
        }];

        await expect(act(async () => {
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        })).resolves.toBeUndefined();

        expect(liveActivityPushTokenListeners).toHaveLength(0);
        expect(registerLiveActivityTarget).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('marks remembered Live Activity remote targets ended when the activity is removed locally', async () => {
        liveActivityHandleTokenApiState.enabled = true;
        configureDirectApnsRemoteUpdatesForServer('server-a');
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(markLiveActivityTargetEnded).toHaveBeenCalledWith('target-direct-1', { serverId: 'server-a' });

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
                type: 'tap',
            });
        });

        expect(routerPush).toHaveBeenCalledWith('/session/permission?serverId=server-a');

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('executes a verified Live Activity permission action when privacy and surface policy allow direct actions', async () => {
        configureVerifiedLocalServerContext('server-a');
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
                type: 'action',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
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
                type: 'action',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
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
                type: 'action',
                data: {
                    serverId: 'server-a',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
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
        configureVerifiedLocalServerContext('server-a');
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
                type: 'action',
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
        configureVerifiedLocalServerContext('server-a');
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
                type: 'action',
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
                type: 'action',
                data: {
                    serverId: 'server-b',
                    sessionId: 'permission',
                    requestId: 'request-1',
                    activityName: 'HappierFocusLiveActivity',
                    activityInstanceKey: 'server-b:HappierFocusLiveActivity:permission',
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
            screen.tree.update(React.createElement(ActivitySurfacesRuntime));
        });

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledTimes(focusWidgetUpdatesAfterMount);
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledTimes(sessionsWidgetUpdatesAfterMount);

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('routes widget taps for local sessions when live activities are disabled', async () => {
        localSettingsState.value = createLocalSettingsState({
            iosLiveActivitiesEnabled: false,
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
        expect(widgetInteractionsState.listener).not.toBeNull();

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusWidget',
                target: 'open-session:permission',
                timestamp: Date.now(),
                type: 'tap',
            });
        });

        expect(routerPush).toHaveBeenCalledWith('/session/permission');

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
                type: 'tap',
            });
        });

        expect(routerPush).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
