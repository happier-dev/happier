import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { MMKV } from 'react-native-mmkv';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { pendingServerScopedKey } from '@/sync/domains/pending/pendingServerScopedKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeUI = vi.hoisted(() => ({
    alerts: vi.fn<typeof import('react-native')['Alert']['alert']>(),
    appStateListeners: new Set<(state: string) => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' },
        Alert: { alert: nativeUI.alerts },
        AppState: { currentState: 'active', addEventListener: (event: string, listener: (state: string) => void) => {
            if (event === 'change') nativeUI.appStateListeners.add(listener);
            return { remove: () => { nativeUI.appStateListeners.delete(listener); } };
        } },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: pushSpy } }).module;
});

const pushSpy = vi.hoisted(() => vi.fn());

// Native desktop invocation/events are the OS boundary; routing and Account admission stay real.
const desktop = vi.hoisted(() => ({ enabled: false, failListener: false, pending: [] as unknown[], wake: null as (() => void) | null, registrationWait: null as Promise<void> | null, removals: 0 }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => true,
    requestPermission: async () => 'granted', sendNotification: vi.fn() }));
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => desktop.enabled,
    desktopHostKind: () => desktop.enabled ? 'tauri' : null,
    listenDesktopHostEvent: async (_event: string, listener: () => void) => {
        if (_event !== 'desktop-notification-action') return () => {};
        if (desktop.failListener) throw new Error('OS listener unavailable');
        await desktop.registrationWait;
        desktop.wake = listener; return () => { desktop.removals += 1; desktop.wake = null; };
    },
    invokeDesktopHost: async (command: string) => {
        if (command === 'desktop_notification_take_responses') return desktop.pending.splice(0);
        if (command === 'desktop_notification_list') return [];
        throw new Error(`Unexpected desktop command ${command}`);
    },
}));

const nativeBackground = vi.hoisted(() => ({
    pending: [] as Array<{ deliveryId: string; response: unknown }>,
    listeners: new Map<string, (event: unknown) => void>(),
    claims: [] as string[], completed: [] as string[],
    admitted: true, claimWait: null as Promise<void> | null,
}));
// The Expo native module is the OS response/admission boundary.
vi.mock('expo-modules-core', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => name === 'ExpoNotificationsEmitter' ? {
        getPendingBackgroundNotificationResponses: async () => nativeBackground.pending,
        claimBackgroundNotificationResponse: async (id: string) => {
            nativeBackground.claims.push(id);
            await nativeBackground.claimWait;
            return nativeBackground.admitted;
        },
        completeBackgroundNotificationResponse: async (id: string) => {
            nativeBackground.completed.push(id); return true;
        },
        addListener: (event: string, listener: (event: unknown) => void) => {
            nativeBackground.listeners.set(event, listener);
            return { remove: () => { nativeBackground.listeners.delete(event); } };
        },
    } : actual.requireOptionalNativeModule(name) };
});

const network = { healthy: false, serviceOnly: false, requests: [] as string[] };
async function serveNotificationHttp(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        network.requests.push(String(url));
        if (rpcBoundary && servedHomeUrls.has(new URL(String(url)).origin)) return rpcBoundary.request(url, init);
        if (!network.healthy) return new Response('', { status: 503 });
        const path = String(url);
        if (path.endsWith('/health')) return new Response('{}', { status: 200 });
        if (path.endsWith('/v1/features')) {
            const { createRootLayoutFeaturesResponse, createSignInServiceFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
            if (network.serviceOnly) return new Response(JSON.stringify(createSignInServiceFeaturesResponse('https://unsaved.example.test')), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
            return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                capabilities: {
                    server: { canonicalServerUrl: 'https://unsaved.example.test' },
                    serverIdentity: { serverIdentityId: 'srv_verified_notification_home' },
                },
            })), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (path.endsWith('/v1/auth/entry')) return new Response('{}', { status: 404 });
        throw new Error(`Unexpected network request: ${path}`);
}


// Native notification module boundary: the test delivers responses through its listener.
const notifications = vi.hoisted(() => ({
    listener: null as ((response: unknown) => void) | null,
    lastResponse: null as unknown,
}));
vi.mock('@/utils/platform/loadExpoNotifications', () => ({
    loadExpoNotifications: async () => ({
        setNotificationCategoryAsync: async (identifier: string, actions: readonly unknown[]) => ({ identifier, actions }),
        DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
        getLastNotificationResponseAsync: async () => notifications.lastResponse,
        addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
            notifications.listener = listener;
            return { remove: () => {
                if (notifications.listener === listener) notifications.listener = null;
            } };
        },
    }),
}));

// Observe serialized permission calls at Socket.IO; all internal owners remain real.
const rpc = { calls: [] as Array<Readonly<{ serverUrl: string; method: string; payload: unknown;
    token: string | undefined }>>, wait: null as Promise<void> | null };
let rpcBoundary: import('@/dev/testkit/harness/sessionOpsNetworkBoundary').SessionOpsNetworkBoundary | null = null;
const servedHomeUrls = new Set<string>();
const servedHomeTokens = new Map<string, string>();
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>> | null = null;

const SESSION_ID = 'same-session';
const REQUEST_ID = 'same-request';

// Load the real graph once outside test deadlines, after installing its SDK boundaries.
const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await import('./useNotificationResponseRouting');
await initialNetwork.dispose();

function permissionResponse(params: Readonly<{ serverId?: string; serverUrl?: string; identifier: string; turnId?: string; accountId?: string; actionIdentifier?: string }>) {
    return {
        actionIdentifier: params.actionIdentifier ?? PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
        notification: {
            request: {
                identifier: params.identifier,
                content: {
                    data: {
                        ...(params.serverId ? { serverId: params.serverId } : {}),
                        serverUrl: params.serverUrl,
                        sessionId: SESSION_ID,
                        requestId: REQUEST_ID,
                        ...(params.turnId ? { turnId: params.turnId } : {}),
                        ...(params.accountId ? { accountId: params.accountId } : {}),
                    },
                },
            },
        },
    };
}

async function installNotificationRpcBoundary() {
        rpcBoundary = await installSessionOpsNetworkBoundary();
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        rpcBoundary.setHttpResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname === `/v1/sessions/${SESSION_ID}` || url.pathname === `/v2/sessions/${SESSION_ID}`) {
                return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: SESSION_ID })));
            }
            return null;
        });
        rpcBoundary.setRpcResponder(async request => {
            if (request.method !== 'session.permission.respond' && request.method !== 'session.user_action.answer') return undefined;
            rpc.calls.push({ serverUrl: request.serverUrl, method: request.method, payload: request.payload,
                token: request.token });
            await rpc.wait;
            return undefined;
        });
}

async function saveNotificationAccount(home: Readonly<{ id: string; serverUrl: string }>) {
    const added = await rpcBoundary!.addHome(home.serverUrl, 'notification-account');
    servedHomeTokens.set(home.serverUrl, added.token);
    servedHomeUrls.add(home.serverUrl);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(serveNotificationHttp);
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(condition(), JSON.stringify({ rpc: rpcBoundary?.requests, http: rpcBoundary?.httpRequests })).toBe(true);
}

async function setupHomes() {
    const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const { storage } = await import('@/sync/domains/state/storage');
    const homeA = await upsertServerProfile({ serverUrl: 'https://home-a.example.test', name: 'Home A', source: 'manual' });
    const homeB = await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B', source: 'manual' });
    // The same Session id is also a listed Session on Home B: local evidence that
    // points the bare id at B, as the list owner produces for a duplicate id.
    storage.setState((state) => ({
        ...state,
        ordinarySessionListMembershipByServerId: {
            ...state.ordinarySessionListMembershipByServerId,
            [homeB.id]: [SESSION_ID],
        },
    }));
    return { homeA, homeB, setActiveServerId };
}

function sessionNavigationResponse(home: Readonly<{ id: string; serverUrl: string }>, actionIdentifier: string, identifier: string) {
    const current = permissionResponse({ serverId: home.id, serverUrl: home.serverUrl, identifier,
        turnId: 'navigation-turn', accountId: 'notification-account', actionIdentifier });
    return { ...current, userText: 'a private answer', notification: { request: { ...current.notification.request,
        content: { data: { ...current.notification.request.content.data,
            questionAnswerV1: { kind: 'text', questionKey: 'Which?', allowEmpty: false } } } } } };
}

async function markRecoveryForHome(serverId: string): Promise<void> {
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    const target = await resolveServerCredentialAccountScope(serverId);
    if (target.kind !== 'bound') throw new Error('Fixture Home has no Account');
    (await import('./notificationPermissionRecovery')).markNotificationPermissionRecoveryNeeded(target.scope);
}

let routingScreen: Awaited<ReturnType<typeof renderScreen>> | null = null;
async function prepareNotificationRuntime() {
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(serveNotificationHttp);
    syncBridge = await loadSyncSingletonForTests();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const active = getActiveServerSnapshot();
    const credentials = await TokenStorage.getCredentialsForServerUrl(active.serverUrl, { serverId: active.serverId });
    if (credentials) {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer(credentials);
    }
}

async function mountRouting(refreshAuth: () => Promise<void> = async () => {}, wrap?: (content: React.ReactElement) => React.ReactElement) {
    await prepareNotificationRuntime();
    const { useNotificationResponseRouting } = await import('./useNotificationResponseRouting');
    function Probe() {
        useNotificationResponseRouting({ enabled: true, refreshAuth });
        return null;
    }
    const content = React.createElement(Probe);
    routingScreen = await renderScreen(wrap ? wrap(content) : content);
}

function disableConfiguredHomeSeeds(): void {
    // A native default build seeds Happier Cloud. These cases exercise the supported
    // serverless build policy, through its environment boundary rather than a profile mock.
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_SERVER_URL', '');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', '[]');
    const denied = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', [denied, 'setup.relay.allowHappierCloud'].filter(Boolean).join(','));
}

describe('useNotificationResponseRouting exact-Home permission dispatch', () => {
    beforeEach(async () => {
        vi.resetModules();
        desktop.enabled = false; desktop.failListener = false; desktop.pending = []; desktop.wake = null; desktop.registrationWait = null; desktop.removals = 0;
        notifications.listener = null;
        notifications.lastResponse = null;
        rpc.wait = null;
        nativeUI.alerts.mockClear();
        nativeUI.appStateListeners.clear();
        nativeBackground.pending = [];
        nativeBackground.listeners.clear();
        nativeBackground.claims.length = 0;
        nativeBackground.completed.length = 0;
        nativeBackground.admitted = true;
        nativeBackground.claimWait = null;
        rpc.calls.length = 0;
        pushSpy.mockClear();
        network.healthy = false;
        network.serviceOnly = false;
        network.requests.length = 0;
        await installNotificationRpcBoundary();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(serveNotificationHttp);
    });

    afterEach(async () => {
        await routingScreen?.unmount();
        routingScreen = null;
        if (syncBridge) {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
        await rpcBoundary?.dispose();
        rpcBoundary = null;
        servedHomeUrls.clear();
        servedHomeTokens.clear();
        syncBridge?.dispose();
        syncBridge = null;
        vi.unstubAllEnvs();
    });

    it('keeps a newer Expo navigation after an older legacy Home switch finishes', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        const refreshStarted = createDeferred<void>();
        const releaseRefresh = createDeferred<void>();
        await mountRouting(async () => { refreshStarted.resolve(); await releaseRefresh.promise; });
        await waitFor(() => notifications.listener !== null);
        const response = (sessionId: string) => ({
            actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
            notification: { request: { identifier: `legacy-${sessionId}`, content: { data: {
                sessionId, serverId: homeA.id, serverUrl: homeA.serverUrl,
            } } } },
        });
        // Only the OS delivery and the caller's refresh completion are controlled;
        // saved-Home lookup, credential admission, switching and routing remain real.
        await act(async () => { notifications.listener!(response('older')); });
        await refreshStarted.promise;
        try {
            await act(async () => { notifications.listener!(response('newer')); });
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy).toHaveBeenCalledWith(`/session/newer?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            await act(async () => { releaseRefresh.resolve(); });
        }
        // Wait for the older Home switch's public completion before checking that
        // it cannot take navigation back from the newer accepted response.
        await act(async () => {});
        expect(pushSpy.mock.calls).toEqual([[`/session/newer?serverId=${encodeURIComponent(homeA.id)}`]]);
    });

    it('keeps newer notification navigation after an older Account switch finishes', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await prepareNotificationRuntime();
        const { navigateWithNotificationAccount } = await import('./navigateWithNotificationAccount');
        const refreshStarted = createDeferred<void>();
        const releaseRefresh = createDeferred<void>();
        const target = { serverId: homeA.id, serverUrl: homeA.serverUrl,
            accountId: 'notification-account', route: `/session/older?serverId=${encodeURIComponent(homeA.id)}` };
        // The caller's auth-refresh boundary stays pending after selecting the original Home.
        const older = navigateWithNotificationAccount({ target, isDisposed: () => false,
            refreshAuth: async () => { refreshStarted.resolve(); await releaseRefresh.promise; },
            navigate: () => pushSpy('older') });
        await refreshStarted.promise;
        const newer = navigateWithNotificationAccount({ target: { ...target, route: `/session/newer?serverId=${encodeURIComponent(homeA.id)}` },
            isDisposed: () => false, refreshAuth: async () => {}, navigate: () => pushSpy('newer') });
        try {
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy.mock.calls).toEqual([['newer']]);
        } finally {
            releaseRefresh.resolve();
            await Promise.all([older, newer]);
        }
        expect(pushSpy.mock.calls).toEqual([['newer']]);
    });

    it('leaves a queued desktop click for the next mount when registration outlives its subscriber', async () => {
        desktop.enabled = true;
        const registration = createDeferred<void>();
        desktop.registrationWait = registration.promise;
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        const response = sessionNavigationResponse(homeA, 'default', 'registration-outlived-mount');
        desktop.pending.push({ ...response, notification: { request: { ...response.notification.request,
            content: { ...response.notification.request.content, accountId: 'notification-account' } } } });
        await mountRouting();
        await routingScreen!.unmount();
        routingScreen = null;
        registration.resolve();
        await waitFor(() => desktop.removals === 1);
        expect(desktop.pending).toHaveLength(1);
        expect(pushSpy).not.toHaveBeenCalled();
        desktop.registrationWait = null;
        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        expect(desktop.pending).toEqual([]);
    });

    it.each([false, true])('opens a queued desktop Activity click from another Home when listener failure is %s', async (failListener) => {
        desktop.enabled = true; desktop.failListener = failListener;
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        const response = sessionNavigationResponse(homeA, 'default', 'desktop-original-home');
        desktop.pending = [{ ...response, notification: { request: { ...response.notification.request,
            content: { ...response.notification.request.content, accountId: 'notification-account' } } } }];
        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        expect(rpc.calls).toEqual([]);
        expect(desktop.pending).toEqual([]);
    });

    it('refuses a desktop Activity click after its Home is rebound to another Account', async () => {
        desktop.enabled = true;
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        const response = sessionNavigationResponse(homeA, 'default', 'desktop-rebound');
        desktop.pending = [{ ...response, notification: { request: { ...response.notification.request,
            content: { ...response.notification.request.content, accountId: 'notification-account' } } } }];
        await mountRouting();
        await waitFor(() => nativeUI.alerts.mock.calls.length === 1);
        expect(pushSpy).not.toHaveBeenCalled(); expect(rpc.calls).toEqual([]);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
    });

    it.each([
        { action: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, envelopeAccount: 'notification-account' },
        { action: 'default', envelopeAccount: 'forged-account' },
        { action: 'open-settings:notifications', envelopeAccount: 'notification-account' },
        { action: 'happier.pluginNotification.v1/acme.tasks/review/Show', envelopeAccount: 'notification-account', topic: 'plugin_session' },
        { action: 'default', envelopeAccount: 'notification-account', topic: 'plugin_session' },
        { action: 'default', envelopeAccount: 'notification-account', topic: 'malformed' },
    ])('rejects desktop non-session or unbound action $action', async ({ action, envelopeAccount, topic }) => {
        desktop.enabled = true;
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await setActiveServerId(homeA.id);
        const response = sessionNavigationResponse(homeA, action, `desktop-reject-${action}`);
        desktop.pending = [{ ...response, notification: { request: { ...response.notification.request,
            content: { ...response.notification.request.content, accountId: envelopeAccount, data: topic ? { ...response.notification.request.content.data, v: 1, topic: 'plugin_session', ...(topic === 'malformed' ? { sessionId: null } : {}), pluginNotification: { pluginId: 'acme.tasks', categoryId: 'review', occurrenceId: 'current', clientRequestId: 'send-one' } } : response.notification.request.content.data } } } }];
        await mountRouting();
        await waitFor(() => desktop.pending.length === 0 && desktop.wake !== null);
        await act(async () => {});
        expect(pushSpy).not.toHaveBeenCalled(); expect(rpc.calls).toEqual([]);
    });

    it.each([
        { entry: 'cached Reply', action: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, cached: true },
        { entry: 'cached permission', action: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, cached: true },
        { entry: 'DEFAULT session tap', action: 'expo.modules.notifications.actions.DEFAULT', cached: false },
    ])('keeps $entry navigation bound to its supplied Account', async ({ entry, action, cached }) => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        const response = sessionNavigationResponse(homeA, action, `wrong-account-${entry}`);
        if (cached) notifications.lastResponse = response;
        await mountRouting();
        if (!cached) {
            await waitFor(() => notifications.listener !== null);
            await act(async () => { notifications.listener!(response); });
        }
        await waitFor(() => pushSpy.mock.calls.length > 0 || nativeUI.alerts.mock.calls.length > 0);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect(rpc.calls).toEqual([]);
    });

    it.each([
        { entry: 'cached Reply', action: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, cached: true },
        { entry: 'DEFAULT session tap', action: 'expo.modules.notifications.actions.DEFAULT', cached: false },
    ])('opens $entry navigation for its matching supplied Account without replaying input', async ({ entry, action, cached }) => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        const response = sessionNavigationResponse(homeA, action, `matching-account-${entry}`);
        if (cached) notifications.lastResponse = response;
        await mountRouting();
        if (!cached) {
            await waitFor(() => notifications.listener !== null);
            await act(async () => { notifications.listener!(response); });
        }
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        expect(rpc.calls).toEqual([]);
    });

    it('revalidates supplied Account navigation after switching to its saved Home', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await mountRouting(async () => { await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account'); });
        await waitFor(() => notifications.listener !== null);
        await act(async () => { notifications.listener!(sessionNavigationResponse(homeA,
            'expo.modules.notifications.actions.DEFAULT', 'account-switch-race')); });
        await waitFor(() => pushSpy.mock.calls.length > 0 || nativeUI.alerts.mock.calls.length > 0);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect(rpc.calls).toEqual([]);
    });

    it('keeps resumed supplied Account navigation bound through pending persistence', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        await prepareNotificationRuntime();
        const { setPendingNotificationNav } = await import('@/sync/domains/pending/pendingNotificationNav');
        setPendingNotificationNav({ serverUrl: homeA.serverUrl, serverId: homeA.id,
            route: `/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`, accountId: 'notification-account' });
        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length > 0 || nativeUI.alerts.mock.calls.length > 0);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect(rpc.calls).toEqual([]);
    });

    it('preserves Add Home presentation and the supplied Account through signed-out pending resume', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await mountRouting();
        const unknownUrl = 'https://unknown-account-home.example.test';
        const response = sessionNavigationResponse({ id: '', serverUrl: unknownUrl },
            'expo.modules.notifications.actions.DEFAULT', 'unknown-account-home');
        await waitFor(() => notifications.listener !== null);
        await act(async () => { notifications.listener!(response); });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/?step=home&server=${encodeURIComponent(unknownUrl)}`);
        await routingScreen?.unmount();
        routingScreen = null;
        pushSpy.mockClear();
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const added = await upsertServerProfile({ serverUrl: unknownUrl, name: 'Added Home', source: 'manual' });
        await (await import('@/sync/domains/server/activeServerSwitch')).setActiveServerAndSwitch({ serverId: added.id });
        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length > 0 || nativeUI.alerts.mock.calls.length > 0);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect(rpc.calls).toEqual([]);
    });

    it('keeps live mismatched supplied Account recovery pinned before credential admission', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        await act(async () => { notifications.listener!(permissionResponse({ serverId: homeA.id,
            serverUrl: homeA.serverUrl, identifier: 'live-account-recovery', turnId: 'live-account-turn', accountId: 'notification-account' })); });
        await waitFor(() => nativeUI.alerts.mock.calls.length === 1);
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        expect(review?.onPress).toEqual(expect.any(Function));
        await act(async () => { review?.onPress?.(); });
        await waitFor(() => nativeUI.alerts.mock.calls.length === 2);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
    });

    it('keeps typed Session route ownership when a supplied Account payload URL names another Home', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await mountRouting();
        const current = sessionNavigationResponse(homeA, 'expo.modules.notifications.actions.DEFAULT', 'typed-account-url');
        const response = { ...current, notification: { request: { ...current.notification.request, content: { data: {
            ...current.notification.request.content.data, url: `/session/other/info?serverId=${encodeURIComponent(homeB.id)}`,
        } } } } };
        await waitFor(() => notifications.listener !== null);
        await act(async () => { notifications.listener!(response); });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        expect(rpc.calls).toEqual([]);
    });

    it('preserves non-session Settings routing with supplied Account metadata', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        await act(async () => { notifications.listener!(sessionNavigationResponse(homeA,
            'open-settings:notifications', 'settings-account-url')); });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith('/settings/notifications');
        expect(rpc.calls).toEqual([]);
    });

    it('offers recovery review only after foregrounding a legacy unknown notice', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        const { AppState } = await import('react-native');
        AppState.currentState = 'background';
        const legacy = new MMKV({ id: scopedStorageId('notification-permission-actions', readStorageScopeFromEnv()) });
        legacy.set('recovery-needed', '1');
        try {
            await mountRouting();
            expect(nativeUI.alerts).not.toHaveBeenCalled();
            expect(pushSpy).not.toHaveBeenCalled();
            AppState.currentState = 'active';
            await act(async () => {
                for (const listener of [...nativeUI.appStateListeners]) listener('active');
            });
            expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
            const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            expect(pushSpy).not.toHaveBeenCalled();
            await act(async () => { review?.onPress?.(); });
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy).toHaveBeenCalledWith('/inbox');
            expect(rpc.calls).toEqual([]);
            expect((await import('./notificationPermissionRecovery')).consumeNotificationPermissionRecoveryNeeded()).toBe(false);
        } finally { AppState.currentState = 'active'; }
    });

    it('opens known recovery in its saved Home only after an explicit review press', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await markRecoveryForHome(homeA.id);
        await mountRouting();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
        expect(pushSpy).not.toHaveBeenCalled();
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        expect(review?.onPress).toEqual(expect.any(Function));
        await act(async () => { review?.onPress?.(); });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith('/inbox');
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
        expect(rpc.calls).toEqual([]);
    });

    it('does not let a delayed recovery Review replace newer Session navigation', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA); await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await markRecoveryForHome(homeA.id);
        const refreshStarted = createDeferred<void>();
        const releaseRefresh = createDeferred<void>();
        await mountRouting(async () => { refreshStarted.resolve(); await releaseRefresh.promise; });
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        if (!review?.onPress) throw new Error('Expected the native recovery Review choice');
        await act(async () => { review.onPress!(); });
        await refreshStarted.promise;
        try {
            await waitFor(() => notifications.listener !== null);
            await act(async () => { notifications.listener!(sessionNavigationResponse(homeA,
                'expo.modules.notifications.actions.DEFAULT', 'newer-than-review')); });
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            await act(async () => { releaseRefresh.resolve(); });
        }
        await act(async () => {});
        expect(pushSpy.mock.calls).toEqual([[`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`]]);
        expect(rpc.calls).toEqual([]);
    });

    it('refuses known recovery when its saved Home changes Account before review', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id);
        await markRecoveryForHome(homeA.id);
        await mountRouting();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        expect(review?.onPress).toEqual(expect.any(Function));
        await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account');
        await act(async () => { review?.onPress?.(); });
        await waitFor(() => nativeUI.alerts.mock.calls.length === 2);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
    });

    it('refuses known recovery when Account changes during its saved Home switch', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await markRecoveryForHome(homeA.id);
        await mountRouting(async () => { await rpcBoundary!.setAccount(homeA.serverUrl, 'replacement-account'); });
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        expect(review?.onPress).toEqual(expect.any(Function));
        await act(async () => { review?.onPress?.(); });
        await waitFor(() => nativeUI.alerts.mock.calls.length === 2);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(rpc.calls).toEqual([]);
    });

    it('does not borrow the current Home for recovery after its saved Home is removed', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await saveNotificationAccount(homeB);
        await setActiveServerId(homeB.id);
        await markRecoveryForHome(homeA.id);
        await (await import('@/sync/domains/server/serverProfiles')).removeServerProfile(homeA.id);
        await mountRouting();
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        const review = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.onPress);
        expect(review?.onPress).toEqual(expect.any(Function));
        await act(async () => { review?.onPress?.(); });
        await waitFor(() => nativeUI.alerts.mock.calls.length === 2);
        expect(pushSpy).not.toHaveBeenCalled();
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
        expect(rpc.calls).toEqual([]);
    });

    it('routes a registered external plugin button through current declaration admission once', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id, { scope: 'device' });
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
        const { PluginProjectedNotificationCategoryEntryV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const category = PluginProjectedNotificationCategoryEntryV1Schema.parse({ id: 'acme.tasks/review', pluginId: 'acme.tasks',
            pluginVersion: '1.0.0', occurrenceId: 'current-category', definition: { id: 'review', title: 'Review', kind: 'plugin', eventIds: [],
                buttons: [{ id: 'Details / ✨', label: 'Details', effect: { kind: 'open', page: { pageId: 'reviews', subPath: 'items/42' } } }] } });
        const unpublish = publishCommittedAppShellPluginUiProjection(() => ({ ...EMPTY_PLUGIN_UI_PROJECTION,
            notificationCategoriesById: { [category.id]: category } }));
        try {
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            const response = { actionIdentifier: 'happier.pluginNotification.v1/acme.tasks/review/Details%20%2F%20%E2%9C%A8',
                notification: { request: { identifier: 'external-native-open', content: { data: {
                    v: 1, topic: 'plugin_session', serverId: homeA.id, serverUrl: homeA.serverUrl, accountId: 'notification-account',
                    sessionId: 'source-session', pluginNotification: { pluginId: 'acme.tasks', categoryId: 'review',
                        occurrenceId: 'current-category', clientRequestId: 'external-send' },
                } } } } };
            await act(async () => { notifications.listener!(response); notifications.listener!(response); });
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy).toHaveBeenCalledWith(`/plugins/acme.tasks/reviews/items/42?serverId=${encodeURIComponent(homeA.id)}`);
            expect(rpc.calls).toEqual([]);
        } finally { unpublish(); }
    });

    it('stages a notification tap as an explicit plugin-page launch before routing', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id, { scope: 'device' });
        const { normalizePluginUiDestinationBindingV1 } = await import('@happier-dev/protocol/plugins/ui');
        const { resolvePluginPages } = await import('@/components/plugins/pages/pluginPages');
        const { PluginPageLaunchInputScope, usePluginPageLaunch } = await import('@/components/plugins/pages/pluginPageNavigation');
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.tasks', destinationId: 'review',
            rendererId: 'review-renderer', container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Expected an admitted notice page');
        const pages = resolvePluginPages({ target: { kind: 'app' }, placements: [{
            id: 'surfacePlacement:acme.tasks:review', pluginId: 'acme.tasks', occurrenceId: 'review-occurrence',
            contributionKind: 'surfacePlacement', descriptorId: 'review', binding, target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'review-renderer' },
            display: { developerFallback: 'Review' }, headerActions: [],
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            hostOrigin: { serverId: homeA.id, machineId: 'notice-machine', phase: 'current', interactionEnabled: true,
                executionOrigin: null },
        }] });
        let launch: ReturnType<typeof usePluginPageLaunch> = null;
        function LaunchProbe() {
            launch = usePluginPageLaunch({ pluginId: 'acme.tasks', localId: 'review', subPath: 'repo/one' });
            return null;
        }
        await mountRouting(undefined, content => <PluginPageLaunchInputScope target={{ kind: 'app' }} pages={pages} pluginUiProjection={null}>
            {content}<LaunchProbe />
        </PluginPageLaunchInputScope>);
        await waitFor(() => notifications.listener !== null);
        expect(launch).toBeNull();
        const response = { actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: {
            identifier: 'explicit-page-tap', content: { data: { v: 1, topic: 'account_notice',
                serverId: homeA.id, serverUrl: homeA.serverUrl, accountId: 'notification-account', artifactId: 'notice-1',
                source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'review-1' },
                page: { pageId: 'review', subPath: 'repo/one' } } },
        } } };
        await act(async () => { notifications.listener!(response); });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        await vi.waitFor(() => expect(launch).toMatchObject({ pageId: 'plugin:acme.tasks:review', subPath: 'repo/one', input: undefined }));
        expect(pushSpy).toHaveBeenCalledWith('/plugins/acme.tasks/review/repo/one');
        expect(rpc.calls).toEqual([]);
    });

    it.each(['account_notice', 'plugin_session'] as const)('opens a %s plugin notice only for its saved Account and never answers a permission', async topic => {
        const { homeA, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeA.id, { scope: 'device' });
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        const respond = (accountId: string, id: string) => ({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
            notification: { request: { identifier: id, content: { data: { v: 1,
                serverId: homeA.id, serverUrl: homeA.serverUrl, accountId, topic,
                ...(topic === 'plugin_session' ? { sessionId: 'session-bound' } : { artifactId: 'notice-1',
                    source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'review-1' },
                    page: { pageId: 'review', subPath: 'repo/one' } }) } } } } });
        await act(async () => notifications.listener!(respond('notification-account', 'notice-right')));
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenLastCalledWith(topic === 'account_notice' ? '/plugins/acme.tasks/review/repo/one'
            : `/session/session-bound?serverId=${encodeURIComponent(homeA.id)}`);
        expect(rpc.calls).toHaveLength(0);
        await act(async () => notifications.listener!(respond('other-account', 'notice-wrong')));
        // A different signed-in Account must not inherit this notice's navigation.
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        expect(pushSpy).toHaveBeenCalledTimes(1);
        expect(rpc.calls).toHaveLength(0);
    });

    it('claims a native pending iOS response before the exact saved-Home send and finishes after acknowledgement', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeB.id);
        let release: (() => void) | undefined;
        rpc.wait = new Promise<void>(resolve => { release = resolve; });
        const delivery = { deliveryId: 'native-held', response: permissionResponse({ serverId: homeA.id,
            serverUrl: homeA.serverUrl, identifier: 'native-pending', turnId: 'native-original-turn' }) };
        nativeBackground.pending = [delivery];
        const { initializeIOSNotificationBackgroundResponses } = await import('./iosNotificationBackgroundResponses');
        expect(await initializeIOSNotificationBackgroundResponses()).toBe(true);
        nativeBackground.listeners.get('onDidReceiveBackgroundNotificationResponse')!(delivery);
        await waitFor(() => rpc.calls.length === 1);
        expect(nativeBackground.claims).toEqual(['native-held']);
        expect(nativeBackground.completed).toEqual([]);
        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl,
            token: servedHomeTokens.get(homeA.serverUrl), payload: { turnId: 'native-original-turn', approved: true } });
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
        expect(pushSpy).not.toHaveBeenCalled();
        release!();
        await waitFor(() => nativeBackground.completed.length === 1);
    });

    it('does not send or finish a native iOS delivery whose prior runtime already claimed it', async () => {
        const { homeA } = await setupHomes();
        await saveNotificationAccount(homeA);
        nativeBackground.admitted = false;
        nativeBackground.pending = [{ deliveryId: 'already-claimed', response: permissionResponse({
            serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'reload-replay', turnId: 'reload-turn' }) }];
        const { initializeIOSNotificationBackgroundResponses } = await import('./iosNotificationBackgroundResponses');
        expect(await initializeIOSNotificationBackgroundResponses()).toBe(true);
        await waitFor(() => nativeBackground.claims.length === 1);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(rpc.calls).toEqual([]);
        expect(nativeBackground.completed).toEqual([]);
    });

    it('cancels native iOS preparation when the OS expires its held response before admission settles', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        const { AppState } = await import('react-native');
        AppState.currentState = 'background';
        await mountRouting();
        let release: (() => void) | undefined;
        nativeBackground.claimWait = new Promise<void>(resolve => { release = resolve; });
        nativeBackground.pending = [{ deliveryId: 'expired-preflight', response: permissionResponse({
            serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'expired-preflight', turnId: 'expired-turn' }) }];
        const { initializeIOSNotificationBackgroundResponses } = await import('./iosNotificationBackgroundResponses');
        expect(await initializeIOSNotificationBackgroundResponses()).toBe(true);
        nativeBackground.listeners.get('onDidExpireBackgroundNotificationResponse')!({ deliveryId: 'expired-preflight' });
        release!();
        await waitFor(() => nativeBackground.completed.length === 1);
        expect(rpc.calls).toEqual([]);
        expect(nativeUI.alerts).not.toHaveBeenCalled();
        AppState.currentState = 'active';
        await act(async () => {
            for (const listener of [...nativeUI.appStateListeners]) listener('active');
        });
        expect(nativeUI.alerts).toHaveBeenCalledTimes(1);
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('requires review for an Android legacy permission action without switching Home or navigating', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await act(async () => {
                notifications.listener!(permissionResponse({ serverId: homeA.id,
                    serverUrl: homeA.serverUrl, identifier: 'android-legacy-action' }));
            });
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).not.toHaveBeenCalled();
        } finally {
            Platform.OS = 'ios';
        }
    });

    it('coalesces live Android decisions on their exact saved Account without switching or navigating', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        await saveNotificationAccount(homeA);
        let release: (() => void) | undefined;
        rpc.wait = new Promise<void>(resolve => { release = resolve; });
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            const response = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: 'android-bound-action', turnId: 'bound-turn', accountId: 'notification-account' });
            await act(async () => {
                notifications.listener!(response);
                notifications.listener!({ ...response, notification: { ...response.notification,
                    request: { ...response.notification.request, identifier: 'another-delivery' } } });
            });
            await waitFor(() => rpc.calls.length === 1);
            expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
                payload: { id: REQUEST_ID, turnId: 'bound-turn', approved: true } });
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            // Expo's task and listener are independently scheduled: a second
            // execution may arrive after the real first ACK and socket cleanup.
            const { parseNotificationTap } = await import('../notificationRouting');
            const { executeNotificationPermissionAction } = await import('./notificationPermissionActions');
            const repeated = parseNotificationTap({ response,
                defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!repeated) throw new Error('Expected the original permission response');
            await expect(executeNotificationPermissionAction(repeated)).resolves.toEqual({ status: 'confirmed' });
            await act(async () => {
                notifications.listener!(response);
                await new Promise(resolve => setImmediate(resolve));
            });
            expect(rpc.calls).toHaveLength(1);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
            await routingScreen?.unmount();
            routingScreen = null;
            notifications.lastResponse = response;
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            expect(rpc.calls).toHaveLength(1);
            expect(pushSpy).not.toHaveBeenCalled();
            const conflict = parseNotificationTap({ response: { ...response,
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1 },
                defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!conflict) throw new Error('Expected the opposing permission response');
            await expect(executeNotificationPermissionAction(conflict)).resolves.toEqual({ status: 'conflict' });
            expect(rpc.calls).toHaveLength(1);
            const nextTurn = parseNotificationTap({ response: permissionResponse({
                serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'next-turn-action',
                turnId: 'next-bound-turn', accountId: 'notification-account',
            }), defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
            if (!nextTurn) throw new Error('Expected the next bound permission response');
            await expect(executeNotificationPermissionAction(nextTurn)).resolves.toEqual({ status: 'confirmed' });
            expect(rpc.calls).toHaveLength(2);
            expect(rpc.calls[1]).toMatchObject({ serverUrl: homeA.serverUrl,
                token: servedHomeTokens.get(homeA.serverUrl), payload: { id: REQUEST_ID, turnId: 'next-bound-turn', approved: true } });
            expect(pushSpy).not.toHaveBeenCalled();
        } finally {
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            Platform.OS = 'ios';
        }
    });

    it.each([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1])(
        'answers a live iOS button %s on its saved Home without switching or navigating', async actionIdentifier => {
            const { homeA, homeB, setActiveServerId } = await setupHomes();
            await setActiveServerId(homeB.id);
            await saveNotificationAccount(homeA);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: `ios-background-${actionIdentifier}`, turnId: 'original-ios-turn',
                actionIdentifier, accountId: 'notification-account' }));
            await waitFor(() => rpc.calls.length === 1);
            expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
                payload: { id: REQUEST_ID, turnId: 'original-ios-turn',
                    approved: actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1 } });
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
        },
    );

    it.each([
        { target: 'active Home', otherHomeActive: false, coldStart: false },
        { target: 'saved other Home', otherHomeActive: true, coldStart: false },
        { target: 'saved other Home at cold start', otherHomeActive: true, coldStart: true },
    ])('opens a push-only PR update on its $target without an Inbox notice or effect', async ({ otherHomeActive, coldStart }) => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(otherHomeActive ? homeB.id : homeA.id);
        const response = {
            actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
            notification: { request: { identifier: `pr-update-${otherHomeActive}-${coldStart}`, content: { data: {
                sessionId: SESSION_ID, serverId: homeA.id, serverUrl: homeA.serverUrl,
                bindingId: 'binding-a', occurrenceId: 'pr-batch-a',
            } } } },
        };
        if (coldStart) notifications.lastResponse = response;
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        if (!coldStart) notifications.listener!(response);
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
        expect(rpc.calls).toEqual([]);
    });

    it('routes a signed-out push-only PR update for an unknown Home through the welcome connection step', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        notifications.listener!({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
            notification: { request: { identifier: 'pr-update-unknown', content: { data: {
                sessionId: SESSION_ID, serverId: 'unknown-home', serverUrl: 'https://new-home.example.test',
                bindingId: 'binding-a', occurrenceId: 'pr-batch-a',
            } } } },
        });
        expect(pushSpy).toHaveBeenCalledExactlyOnceWith('/?step=home&server=https%3A%2F%2Fnew-home.example.test');
        expect(rpc.calls).toEqual([]);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
    });

    it('opens a cached bound iOS permission response for review without sending a decision', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        notifications.lastResponse = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
            identifier: 'ios-cached-bound', turnId: 'cached-original-turn' });
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(rpc.calls).toEqual([]);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
    });

    it('does not issue an iOS permission response after its caller lifetime has expired', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        await prepareNotificationRuntime();
        const { parseNotificationTap } = await import('../notificationRouting');
        const { executeNotificationPermissionAction } = await import('./notificationPermissionActions');
        const parsed = parseNotificationTap({ response: permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
            identifier: 'ios-expired-before-issue', turnId: 'expired-turn' }),
            defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
        if (!parsed) throw new Error('Expected a bound permission response');
        const lifetime = new AbortController();
        lifetime.abort();
        await expect(executeNotificationPermissionAction(parsed, { signal: lifetime.signal })).resolves.toEqual({ status: 'not_sent' });
        expect(rpc.calls).toEqual([]);
        expect(pushSpy).not.toHaveBeenCalled();
        // Stall only the genuine bundler boundary; late loading must not resume
        // an OS action whose caller has already expired.
        const loading = new AbortController();
        let release!: (module: typeof import('./notificationPermissionActionExecution')) => void;
        const imported = new Promise<typeof import('./notificationPermissionActionExecution')>(resolve => { release = resolve; });
        const importExecution = vi.fn(() => imported);
        const pending = executeNotificationPermissionAction(parsed, { signal: loading.signal, importExecution });
        await waitFor(() => importExecution.mock.calls.length === 1);
        loading.abort();
        await expect(pending).resolves.toEqual({ status: 'not_sent' });
        release(await import('./notificationPermissionActionExecution'));
        await vi.dynamicImportSettled();
        expect(rpc.calls).toEqual([]);
    });

    it('opens an unhandled cached Android permission response for review without answering it', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        Platform.OS = 'android';
        try {
            await setActiveServerId(homeB.id);
            notifications.lastResponse = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: 'cached-android-action', turnId: 'old-turn' });
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            await waitFor(() => pushSpy.mock.calls.length > 0);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            Platform.OS = 'ios';
        }
    });

    it.each([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1])(
        'requires review for a live iOS legacy button %s without answering or navigating', async (actionIdentifier) => {
            const { homeA, setActiveServerId } = await setupHomes();
            await setActiveServerId(homeA.id);
            await saveNotificationAccount(homeA);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
                identifier: `ios-legacy-${actionIdentifier}`, actionIdentifier }));
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).not.toHaveBeenCalled();
        });

    it('keeps an iOS notification bound to turn A when request id has loaded turn B', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        storage.getState().applySessions([createSessionFixture({ id: SESSION_ID, serverId: homeA.id,
            agentState: { requests: { [REQUEST_ID]: { tool: 'Write', arguments: {}, turnId: 'turn-b' } } },
        })]);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
            identifier: 'ios-bound-turn-a', turnId: 'turn-a', accountId: 'notification-account' }));
        await waitFor(() => rpc.calls.length === 1);
        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
            payload: { id: REQUEST_ID, turnId: 'turn-a', approved: true } });
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('keeps a URL-only iOS permission send on its admitted Home without navigating after an ACK and focus change', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        let release: (() => void) | undefined;
        rpc.wait = new Promise<void>(resolve => { release = resolve; });
        try {
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            notifications.listener!(permissionResponse({ serverUrl: homeA.serverUrl,
                identifier: 'url-only-delayed-permission', turnId: 'url-only-original-turn', accountId: 'notification-account' }));
            await waitFor(() => rpc.calls.length === 1);
            expect(pushSpy).not.toHaveBeenCalled();
            const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
            await expect(setActiveServerAndSwitch({ serverId: homeB.id })).resolves.toBe('switched');
            const { storage } = await import('@/sync/domains/state/storage');
            storage.setState(state => ({ ordinarySessionListMembershipByServerId: {
                ...state.ordinarySessionListMembershipByServerId, [homeB.id]: [SESSION_ID],
            } }));
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
            expect(rpc.calls).toMatchObject([{ serverUrl: homeA.serverUrl, token: servedHomeTokens.get(homeA.serverUrl),
                payload: { id: REQUEST_ID, turnId: 'url-only-original-turn', approved: true } }]);
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
            expect(pushSpy).not.toHaveBeenCalled();
        } finally {
            release?.();
            await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
        }
    });

    it.each([
        { entry: 'cached iOS legacy permission button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, cached: true },
        { entry: 'notification body', actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', cached: false },
        { entry: 'Answer button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, cached: false },
        { entry: 'cached Android permission button', actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, cached: true },
    ])('keeps the admitted Home in a URL-only $entry route without answering', async ({ entry, actionIdentifier, cached }) => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        Platform.OS = entry === 'cached Android permission button' ? 'android' : 'ios';
        try {
            await setActiveServerId(homeA.id);
            await saveNotificationAccount(homeA);
            const response = permissionResponse({ serverUrl: homeA.serverUrl, identifier: `url-only-${entry}`, actionIdentifier });
            if (cached) notifications.lastResponse = response;
            await mountRouting();
            await waitFor(() => notifications.listener !== null);
            if (!cached) notifications.listener!(response);
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(rpc.calls).toEqual([]);
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
        } finally {
            Platform.OS = previousPlatform;
        }
    });

    it('sends Allow to the notification\'s focused Home, not to the Home a bare id resolves to', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        await saveNotificationAccount(homeA);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-active', turnId: 'turn-active' }));
        await waitFor(() => rpc.calls.length === 1);

        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, payload: expect.objectContaining({ id: REQUEST_ID, approved: true }) });
    });

    it.each([
        ['HAPPIER_QUESTION_CHOICE_1_V1', { kind: 'choices', questionKey: 'Branch?', values: ['main-value', 'dev-value'] }, undefined, 'main-value'],
        ['HAPPIER_QUESTION_TEXT_V1', { kind: 'text', questionKey: 'Branch?', allowEmpty: false }, 'my branch', 'my branch'],
    ] as const)('answers a live simple question on its exact Home and turn: %s', async (actionIdentifier, descriptor, userText, answer) => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await saveNotificationAccount(homeA);
        await setActiveServerId(homeB.id);
        await prepareNotificationRuntime();
        const original = permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl,
            identifier: 'question-native', turnId: 'turn-question', accountId: 'notification-account', actionIdentifier });
        const response = { ...original, ...(userText === undefined ? {} : { userText }), notification: { request: {
            ...original.notification.request, content: { data: { ...original.notification.request.content.data, questionAnswerV1: descriptor } },
        } } };
        const { handleNotificationBackgroundTask, executeNotificationPermissionAction } = await import('./notificationPermissionActions');
        await expect(handleNotificationBackgroundTask({ data: response })).resolves.toMatchObject({ status: 'confirmed' });
        expect(rpc.calls).toHaveLength(1);
        expect(rpc.calls[0]).toMatchObject({ serverUrl: homeA.serverUrl, method: 'session.user_action.answer',
            payload: { id: REQUEST_ID, turnId: 'turn-question', approved: true, answers: { 'Branch?': [answer] } } });
        expect(rpc.calls[0]?.token).toBe(servedHomeTokens.get(homeA.serverUrl));
        const { parseNotificationTap } = await import('../notificationRouting');
        const parsed = parseNotificationTap({ response, defaultActionIdentifier: 'default' });
        if (!parsed) throw new Error('Question response must parse');
        await expect(executeNotificationPermissionAction(parsed, { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        expect(rpc.calls).toHaveLength(1);
        expect(pushSpy).not.toHaveBeenCalled();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        expect(getActiveServerSnapshot().serverId).toBe(homeB.id);
    });

    it('sends Allow to the saved Home while keeping the other Home focused', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeB.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        await saveNotificationAccount(homeA);
        notifications.listener!(permissionResponse({ serverId: homeA.id, serverUrl: homeA.serverUrl, identifier: 'n-saved', turnId: 'turn-saved' }));
        await waitFor(() => rpc.calls.length === 1);

        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeB.id);
        expect(rpc.calls[0]!.serverUrl).toBe(homeA.serverUrl);
    });

    it('opens a machine vitals notice on its verified saved Home without inventing a Session action', async () => {
        const { homeA, homeB, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeB.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        notifications.listener!({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', notification: { request: {
            identifier: 'machine-saved', content: { data: { topic: 'resource_limit', kind: 'cpu_busy', phase: 'started', machineId: 'machine/a',
                notificationId: 'notice', nextSteps: ['review_processes'], serverId: homeA.id, serverUrl: homeA.serverUrl } },
        } } });
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe(homeA.id);
        expect(pushSpy).toHaveBeenCalledWith(`/machines/machine%2Fa?serverId=${encodeURIComponent(homeA.id)}&tab=processes&sort=cpu`);
        expect(rpc.calls).toEqual([]);
    });

    it('qualifies an old URL-only pending route without losing its suffix, query or hash', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { setPendingNotificationNav } = await import('@/sync/domains/pending/pendingNotificationNav');
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        await prepareNotificationRuntime();
        setPendingNotificationNav({ serverUrl: homeA.serverUrl,
            route: `/session/${SESSION_ID}/discussions/discussion-1?sourceSurface=notification&view=changes%2Ffiles&view=staged#comment-1` });
        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length === 1);
        const href: unknown = pushSpy.mock.calls[0]?.[0];
        if (typeof href !== 'string') throw new Error('Expected an admitted internal route');
        const route = new URL(href, 'https://app.happier.dev');
        expect(route.pathname).toBe(`/session/${SESSION_ID}/discussions/discussion-1`);
        expect(route.searchParams.getAll('view')).toEqual(['changes/files', 'staged']);
        expect(route.searchParams.get('sourceSurface')).toBe('notification');
        expect(route.searchParams.getAll('serverId')).toEqual([homeA.id]);
        expect(route.hash).toBe('#comment-1');
        expect(rpc.calls).toEqual([]);
    });

    it('opens an old pending Allow for review without replaying its decision', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        const { setPendingNotificationAction } = await import('@/sync/domains/pending/pendingNotificationAction');
        await setActiveServerId(homeA.id);
        await saveNotificationAccount(homeA);
        await prepareNotificationRuntime();
        setPendingNotificationAction({
            serverUrl: homeA.serverUrl,
            sessionId: SESSION_ID,
            requestId: REQUEST_ID,
            action: 'allow',
        });

        await mountRouting();
        await waitFor(() => pushSpy.mock.calls.length === 1);
        expect(rpc.calls).toEqual([]);
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(homeA.id)}`);
    });

    it('does not route or act on an unsaved Home when its notification address is unreachable', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `notification_connect_${Date.now()}`;
        try {
            disableConfiguredHomeSeeds();
            vi.resetModules();
            const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
            expect(listServerProfiles()).toHaveLength(0);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);

            notifications.listener!(permissionResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
                serverId: 'unsaved-home',
                serverUrl: 'https://unsaved.example.test',
                identifier: 'n-unsaved',
            }));
            await waitFor(() => network.requests.some((url) => url.endsWith('/health')));

            expect(pushSpy).not.toHaveBeenCalled();
            expect(rpc.calls).toHaveLength(0);
            expect(listServerProfiles()).toHaveLength(0);
            const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE) });
            const pendingKey = pendingServerScopedKey('record:server:v1', 'https://unsaved.example.test');
            expect(JSON.parse(pendingStorage.getString(pendingKey)!)).toMatchObject({
                serverUrl: 'https://unsaved.example.test',
            });
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('opens the welcome Home step with an unknown notification address when other Homes are saved but signed out', async () => {
        const { homeA, setActiveServerId } = await setupHomes();
        await setActiveServerId(homeA.id);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);

        notifications.listener!(permissionResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
            serverId: 'unknown-home',
            serverUrl: 'https://new-home.example.test',
            identifier: 'n-new-home',
        }));

        expect(pushSpy).toHaveBeenCalledWith(
            '/?step=home&server=https%3A%2F%2Fnew-home.example.test',
        );
        expect(rpc.calls).toHaveLength(0);

        const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? null) });
        const pendingKey = pendingServerScopedKey('record:server:v1', 'https://new-home.example.test');
        const pending = pendingStorage.getString(pendingKey);
        expect(JSON.parse(pending!)).toMatchObject({ serverUrl: 'https://new-home.example.test' });

        // Completing the separate draft at its canonical URL does not transfer the
        // notification's entered-address custody or automatically replay its route.
        network.healthy = true;
        const { connectHomeAtAddress } = await import('@/sync/ops/home/connectHomeAtAddress');
        const connected = await connectHomeAtAddress({
            serverUrl: 'https://new-home.example.test',
            source: 'notification',
            confirmInsecureHttp: async () => true,
            confirmCanonicalUrl: async () => true,
        });
        expect(connected.kind).toBe('connected');
        if (connected.kind !== 'connected') throw new Error('Expected the draft Home to connect');
        expect(connected.profile.serverUrl).toBe('https://unsaved.example.test');
        await setActiveServerId(connected.profile.id);
        pushSpy.mockClear();
        await mountRouting();
        expect(pushSpy).not.toHaveBeenCalled();
        expect(rpc.calls).toHaveLength(0);
        expect(pendingStorage.getString(pendingKey)).toBe(pending);
    });

    it('adopts a Directory-capable notification Home without selecting a service or replaying Allow', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `notification_service_${Date.now()}`);
        disableConfiguredHomeSeeds();
        vi.resetModules();
        network.healthy = true;
        network.serviceOnly = true;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
        expect(profiles.listServerProfiles()).toHaveLength(0);
        await mountRouting();
        await waitFor(() => notifications.listener !== null);
        notifications.listener!(permissionResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT', serverId: 'unverified-id', serverUrl: 'https://unsaved.example.test', identifier: 'n-service' }));
        await waitFor(() => pushSpy.mock.calls.length > 0);
        const [connected] = profiles.listServerProfiles();
        expect(connected?.serverUrl).toBe('https://unsaved.example.test');
        expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(connected!.id)}`);
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
        expect(rpc.calls).toHaveLength(0);
        expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe('srv_accounts_entry');
        const pendingStorage = new MMKV({ id: scopedStorageId('pending-notification-nav', process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ?? null) });
        const key = pendingServerScopedKey('record:server:v1', 'https://unsaved.example.test');
        expect(pendingStorage.getString(key)).toBeUndefined();
    });

    it('preserves a later explicit Home confirmation as a new navigation intent', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `notification_connected_${Date.now()}`;
        try {
            disableConfiguredHomeSeeds();
            vi.resetModules();
            network.healthy = true;
            const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
            expect(listServerProfiles()).toHaveLength(0);
            await mountRouting();
            await waitFor(() => notifications.listener !== null);

            notifications.listener!(permissionResponse({ actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
                serverId: 'unverified-notification-id',
                serverUrl: 'https://entered-home.example.test',
                identifier: 'n-connected',
            }));
            await waitFor(() => nativeUI.alerts.mock.calls.length === 1);
            await act(async () => { notifications.listener!(permissionResponse({
                actionIdentifier: 'open-settings:notifications', identifier: 'n-newer-settings',
            })); });
            await waitFor(() => pushSpy.mock.calls.length === 1);
            expect(pushSpy).toHaveBeenCalledWith('/settings/notifications');
            const useCanonical = nativeUI.alerts.mock.calls[0]?.[2]?.find(button => button.style === 'default');
            if (!useCanonical?.onPress) throw new Error('Expected the native Home address choice');
            await act(async () => { useCanonical.onPress!(); });
            await waitFor(() => pushSpy.mock.calls.length === 2);

            const [connected] = listServerProfiles();
            expect(connected).toBeDefined();
            expect((await import('@/sync/domains/server/serverProfiles')).getActiveServerId()).toBe('srv_verified_notification_home');
            expect(pushSpy).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${encodeURIComponent(connected!.id)}`);
            expect(rpc.calls).toHaveLength(0);
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });
});
