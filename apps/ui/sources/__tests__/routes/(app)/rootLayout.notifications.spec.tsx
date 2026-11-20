import { afterEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { PUSH_NOTIFICATION_ACTION_IDS} from '@happier-dev/protocol/push/pushNotificationActions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createRootLayoutFeaturesResponse, createSessionFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { clearPendingTerminalConnect, getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { getActiveServerSnapshot, getDeviceDefaultServerId, listServerProfiles, saveHomeViewState, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { restoreConnectionToActiveServer, disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { clearPendingNotificationAction, getPendingNotificationAction, setPendingNotificationAction } from '@/sync/domains/pending/pendingNotificationAction';
import { getPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import { pendingServerScopedKey } from '@/sync/domains/pending/pendingServerScopedKeys';
import { setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { initializeRootLayoutRuntimeForTests, installRootLayoutRouteCommonModuleMocks, renderRootLayoutRoute } from './rootLayoutRouteTestHelpers';

const nativeNotifications = vi.hoisted(() => ({ response: null as Notifications.NotificationResponse | null }));
const routerBoundary = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), setParams: vi.fn() }));
// Static transport consumers must see the genuine Socket.IO boundary before import.
vi.mock('socket.io-client', async (importOriginal) => {
    const { createSocketIoClientBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    return createSocketIoClientBoundary(importOriginal);
});
vi.mock('expo-notifications', async () => ({
    ...await import('@/dev/expoNotificationsStub'),
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: vi.fn(async () => nativeNotifications.response),
    clearLastNotificationResponseAsync: vi.fn(async () => {}),
    addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
    setBadgeCountAsync: vi.fn(async () => {}),
}));
installRootLayoutRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/', segments: ['(app)'], router: routerBoundary,
    }).module,
});

type RpcObservation = Readonly<{ origin: string; event: unknown; payload: unknown }>;
const rpcObservations: RpcObservation[] = [];
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    const origin = new URL(serverUrl ?? 'https://api.happier.dev').origin;
    vi.spyOn(socket, 'connect').mockImplementation(() => {
        socket.connected = true;
        queueMicrotask(() => { for (const listener of socket.listeners('connect')) listener(); });
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        rpcObservations.push({ origin, event, payload });
        return { ok: true, result: undefined };
    });
});
await initializeRootLayoutRuntimeForTests();
const RootLayout = (await import('@/app/(app)/_layout')).default;
const credentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature' };
const activeUrl = 'https://api.happier.dev';
let profiles: ServerProfile[] = [];
const sessionRows = new Map<string, ReturnType<typeof createPlainV2SessionRecordFixture>>();
const httpObservations: Array<{ origin: string; pathname: string; method: string; body?: string }> = [];
const terminalKeyDisclosures: Array<{ origin: string; pathname: string }> = [];
const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];

function profile(id: string, serverUrl: string): ServerProfile {
    return { id, serverIdentityId: id, serverUrl, canonicalServerUrl: serverUrl, name: id, createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' };
}
async function arrangeHomes(saved = [profile('srv_server_1', activeUrl)], activeId = 'srv_server_1') {
    profiles = saved;
    sessionRows.clear();
    await seedPersistedHomeProfilesForTests({ activeServerId: activeId, profiles: saved });
    if (saved.length > 0) await saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: activeId });
    resetServerFeaturesClientForTests();
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input, init) => {
        const url = new URL(String(input));
        httpObservations.push({ origin: url.origin, pathname: url.pathname, method: init?.method ?? 'GET',
            ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
        if (url.href.includes('abc123') || String(init?.body ?? '').includes('abc123')) {
            terminalKeyDisclosures.push({ origin: url.origin, pathname: url.pathname });
        }
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
        if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-1' });
        if (url.pathname === '/v1/kv/bulk') return Response.json({ values: [] });
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (url.pathname.startsWith('/v2/sessions/')) {
            const row = sessionRows.get(url.origin + url.pathname);
            if (row) return Response.json({ session: row });
        }
        return new Response('{}', { status: 404 });
    }));
    for (const home of saved) {
        const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.serverIdentityId ?? home.id }, credentials);
        expect(write).toBeTruthy();
        if (write) credentialWrites.push(write);
    }
    if (saved.length > 0) {
        await restoreConnectionToActiveServer(credentials);
        await vi.waitFor(() => expect(getActiveServerAccountScope()).toEqual({ serverId: activeId, accountId: 'account-1' }));
    }
    storage.setState({ settings: { ...settingsDefaults, voice: { ...settingsDefaults.voice, providerId: 'off' } },
        localSettings: { ...localSettingsDefaults, activityBadgesEnabled: false } });
    rpcObservations.length = 0;
    httpObservations.length = 0;
    terminalKeyDisclosures.length = 0;
}
function response(data: Record<string, unknown>, actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER): Notifications.NotificationResponse {
    return { actionIdentifier, notification: { date: 1, request: { identifier: 'notification-1', trigger: null, content: {
        title: null, subtitle: null, body: null, categoryIdentifier: null, sound: null, data,
    } } } };
}
async function renderNotification(data: Record<string, unknown>, actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER) {
    nativeNotifications.response = response(data, actionIdentifier);
    await renderRootLayoutRoute(RootLayout, credentials);
    await vi.waitFor(() => expect(routerBoundary.push).toHaveBeenCalled());
    await flushHookEffects();
}
async function renderLiveNotification(data: Record<string, unknown>, actionIdentifier: string) {
    let listener: ((response: Notifications.NotificationResponse) => void) | undefined;
    vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(callback => {
        listener = callback;
        return { remove: vi.fn() };
    });
    await renderRootLayoutRoute(RootLayout, credentials);
    await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)));
    listener!(response(data, actionIdentifier));
    await flushHookEffects();
}
function permissionRequests() {
    return rpcObservations.filter(observation => typeof observation.payload === 'object' && observation.payload !== null
        && 'method' in observation.payload && typeof observation.payload.method === 'string'
        && observation.payload.method.endsWith(':' + RPC_METHODS.SESSION_PERMISSION_RESPOND));
}
function arrangeSession(id: string, homeId = getActiveServerSnapshot().serverId) {
    storage.getState().applySessions([createSessionFixture({ id, serverId: homeId, active: true })]);
    const home = profiles.find(profile => profile.id === homeId);
    if (!home) throw new Error(`Missing fixture Home ${homeId}`);
    sessionRows.set(new URL(home.serverUrl).origin + '/v2/sessions/' + encodeURIComponent(id), createPlainV2SessionRecordFixture({ id, active: true }));
}
function expectNoTargetMutation() {
    expect(permissionRequests()).toHaveLength(0);
    expect(getActiveServerSnapshot().serverId).toBe('srv_server_1');
    expect(listServerProfiles()).toHaveLength(1);
    expect(httpObservations.filter(request => request.origin !== activeUrl)).toEqual([]);
}
function expectPendingNavigation(serverUrl: string, route: string) {
    const persistence = new MMKV({ id: scopedStorageId('pending-notification-nav', readStorageScopeFromEnv()) });
    const raw = persistence.getString(pendingServerScopedKey('record:server:v1', serverUrl));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({ serverUrl, route });
}
async function captureSavedHomeInventoryBaseline(foreignOrigin: string) {
    const screen = await renderRootLayoutRoute(RootLayout, credentials);
    await vi.waitFor(() => expect(httpObservations).toContainEqual({ origin: foreignOrigin, pathname: '/v2/session-organization', method: 'GET' }));
    await flushHookEffects();
    await screen.unmount();
    await flushHookEffects();
    // The reminder reads authenticated saved Homes without selecting them.
    // Active-Home KV bulk reads legitimately use POST, so isolate foreign reads.
    expect(httpObservations.filter(request => request.origin !== activeUrl).every(request => request.method === 'GET')).toBe(true);
    const baseline = new Set(httpObservations.map(request => JSON.stringify(request)));
    httpObservations.length = 0;
    rpcObservations.length = 0;
    terminalKeyDisclosures.length = 0;
    routerBoundary.push.mockClear();
    routerBoundary.replace.mockClear();
    return baseline;
}
afterEach(async () => {
    try {
        await standardCleanup();
        clearPendingTerminalConnect();
        clearPendingNotificationAction();
        await disconnectActiveServerConnection();
        // Retire pooled Socket.IO custody before restoring its boundary responders.
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
    } finally {
        for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
        nativeNotifications.response = null;
        rpcObservations.length = 0;
        httpObservations.length = 0;
        terminalKeyDisclosures.length = 0;
        routerBoundary.push.mockClear();
        routerBoundary.replace.mockClear();
        vi.restoreAllMocks();
    }
});

describe('App RootLayout notifications', () => {
    it('keeps a saved pending terminal key private while another Home Account is active', async () => {
        await arrangeHomes([profile('srv_server_1', activeUrl), profile('srv_server_2', 'https://company.example.test')]);
        // The real reminder clock reads every authenticated saved Home, even offscreen.
        // Capture that read-only baseline before admitting any pending terminal intent.
        const baselineReads = await captureSavedHomeInventoryBaseline('https://company.example.test');
        const savedProfiles = listServerProfiles();
        const credentialSet = vi.spyOn(SecureStore, 'setItemAsync');
        const credentialDelete = vi.spyOn(SecureStore, 'deleteItemAsync');
        httpObservations.length = 0;
        routerBoundary.replace.mockClear();
        setPendingTerminalConnect({ publicKeyB64Url: 'abc123', serverUrl: 'https://company.example.test', serverIdentityId: 'srv_server_2' });
        await renderRootLayoutRoute(RootLayout, credentials);
        await flushHookEffects();
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_1');
        expect(getDeviceDefaultServerId()).toBe('srv_server_1');
        expect(routerBoundary.replace).not.toHaveBeenCalled();
        expect(httpObservations.filter(request => request.origin !== activeUrl && !baselineReads.has(JSON.stringify(request)))).toEqual([]);
        expect(httpObservations.filter(request => request.origin !== activeUrl).every(request => request.method === 'GET')).toBe(true);
        // These active-Account projection reads can settle after the baseline mount.
        // Their protocol uses POST with an empty query, not a write operation.
        const activeProjectionReadPaths: readonly string[] = [
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ];
        expect(httpObservations.filter(request => request.method !== 'GET'
            && !baselineReads.has(JSON.stringify(request))
            && !(request.origin === activeUrl && request.method === 'POST' && request.body === '{}'
                && activeProjectionReadPaths.includes(request.pathname)))).toEqual([]);
        expect(permissionRequests()).toHaveLength(0);
        expect(listServerProfiles()).toEqual(savedProfiles);
        expect(terminalKeyDisclosures).toEqual([]);
        expect(rpcObservations).toEqual([]);
        expect(credentialSet.mock.calls.filter(([key]) => key.includes('auth_credentials'))).toEqual([]);
        expect(credentialDelete.mock.calls.filter(([key]) => key.includes('auth_credentials'))).toEqual([]);
        expect(await TokenStorage.getCredentialsForServerUrl('https://company.example.test', { serverId: 'srv_server_2' })).toEqual(credentials);
        expect(getPendingTerminalConnect()).toBeNull();
    });
    it('navigates to the session when a notification contains sessionId', async () => {
        await arrangeHomes();
        await renderNotification({ sessionId: 's_123' });
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_123');
    });
    it('dedupes one delivery and permits the same live body tap after remount', async () => {
        await arrangeHomes();
        vi.mocked(Notifications.clearLastNotificationResponseAsync).mockClear();
        const delivered = response({ sessionId: 's_123' });
        nativeNotifications.response = delivered;
        let listener: ((response: Notifications.NotificationResponse) => void) | undefined;
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(callback => { listener = callback; return { remove: vi.fn() }; });
        const first = await renderRootLayoutRoute(RootLayout, credentials);
        await vi.waitFor(() => expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_123'));
        await vi.waitFor(() => expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledOnce());
        listener?.(delivered);
        await flushHookEffects();
        expect(routerBoundary.push.mock.calls.filter(([route]) => route === '/session/s_123')).toHaveLength(1);
        expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledOnce();
        const firstListener = listener;
        await first.unmount();
        nativeNotifications.response = null;
        await renderRootLayoutRoute(RootLayout, credentials);
        await vi.waitFor(() => expect(listener).not.toBe(firstListener));
        listener?.(delivered);
        await vi.waitFor(() => expect(routerBoundary.push.mock.calls.filter(([route]) => route === '/session/s_123')).toHaveLength(2));
    });
    it('switches the device Home and navigates when a notification includes a saved serverUrl', async () => {
        await arrangeHomes([profile('srv_server_1', activeUrl), profile('srv_server_2', 'https://company.example.test')]);
        await renderNotification({ sessionId: 's_456', serverUrl: 'https://company.example.test' });
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_2');
        expect(getDeviceDefaultServerId()).toBe('srv_server_2');
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_456?serverId=srv_server_2');
    });
    it('uses the exact notification server id when saved profiles share a URL', async () => {
        await arrangeHomes([profile('srv_server_1', activeUrl), profile('srv_server_2', 'https://shared.example.test'), profile('srv_server_3', 'https://shared.example.test')]);
        await renderNotification({ sessionId: 's_shared', serverId: 'srv_server_3', serverUrl: 'https://shared.example.test' });
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_3');
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_shared?serverId=srv_server_3');
    });
    it('opens a retained permission action on its exact active Home for review without replaying', async () => {
        await arrangeHomes([profile('srv_server_2', 'https://shared.example.test'), profile('srv_server_3', 'https://shared.example.test')], 'srv_server_3');
        arrangeSession('s_pending', 'srv_server_3');
        setPendingNotificationAction({ serverUrl: 'https://shared.example.test', serverId: 'srv_server_3', sessionId: 's_pending', requestId: 'r_pending', action: 'allow' });
        await renderRootLayoutRoute(RootLayout, credentials);
        await vi.waitFor(() => expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_pending?serverId=srv_server_3'));
        expect(permissionRequests()).toHaveLength(0);
        expect(getPendingNotificationAction()).toBeNull();
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_pending?serverId=srv_server_3');
    });
    it('retains only review navigation for another exact Home sharing the active URL', async () => {
        await arrangeHomes([profile('srv_server_2', 'https://shared.example.test'), profile('srv_server_3', 'https://shared.example.test')], 'srv_server_3');
        const pending = { serverUrl: 'https://shared.example.test', serverId: 'srv_server_2', sessionId: 's_pending', requestId: 'r_pending', action: 'allow' } as const;
        setPendingNotificationAction(pending);
        await renderRootLayoutRoute(RootLayout, credentials);
        await flushHookEffects();
        expect(permissionRequests()).toHaveLength(0);
        expect(getPendingNotificationAction()).toBeNull();
        expect(getPendingNotificationNav()).toMatchObject({ serverId: pending.serverId,
            route: '/session/s_pending?serverId=srv_server_2' });
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it('does not choose the first saved profile for an ambiguous legacy URL-only notification', async () => {
        await arrangeHomes([profile('srv_server_1', activeUrl), profile('srv_server_2', 'https://shared.example.test'), profile('srv_server_3', 'https://shared.example.test')]);
        const baselineReads = await captureSavedHomeInventoryBaseline('https://shared.example.test');
        const savedProfiles = listServerProfiles();
        const credentialSet = vi.spyOn(SecureStore, 'setItemAsync');
        const credentialDelete = vi.spyOn(SecureStore, 'deleteItemAsync');
        await renderNotification({ sessionId: 's_shared', serverUrl: 'https://shared.example.test' });
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_1');
        expect(getDeviceDefaultServerId()).toBe('srv_server_1');
        expect(routerBoundary.push).toHaveBeenCalledWith('/settings/server/add?address=https%3A%2F%2Fshared.example.test&source=notification');
        expect(httpObservations.filter(request => request.origin !== activeUrl && !baselineReads.has(JSON.stringify(request)))).toEqual([]);
        expect(httpObservations.filter(request => request.origin !== activeUrl).every(request => request.method === 'GET')).toBe(true);
        expect(listServerProfiles()).toEqual(savedProfiles);
        expect(credentialSet.mock.calls.filter(([key]) => key.includes('auth_credentials'))).toEqual([]);
        expect(credentialDelete.mock.calls.filter(([key]) => key.includes('auth_credentials'))).toEqual([]);
        expect(permissionRequests()).toHaveLength(0);
        expectPendingNavigation('https://shared.example.test', '/session/s_shared');
    });
    it('does not auto-switch to loopback serverUrl from notifications', async () => {
        await arrangeHomes();
        await renderNotification({ sessionId: 's_789', serverUrl: 'http://localhost:3005' });
        expectNoTargetMutation();
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_789');
    });
    it.each([
        [PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, true, 'approved'],
        [PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, false, 'denied'],
    ] as const)('sends the live %s permission response to its admitted Home without switching or navigating', async (actionIdentifier, approved, decision) => {
        const originalTurn = `original-turn-${decision}`;
        await arrangeHomes();
        arrangeSession('s_permission');
        await renderLiveNotification({ sessionId: 's_permission', requestId: 'p_permission', turnId: originalTurn, serverUrl: activeUrl }, actionIdentifier);
        await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
        expect(permissionRequests()[0]).toMatchObject({ origin: activeUrl, payload: {
            method: 's_permission:' + RPC_METHODS.SESSION_PERMISSION_RESPOND, params: { id: 'p_permission', turnId: originalTurn, approved, decision },
        } });
        if (!approved) {
            expect(permissionRequests()[0]).toMatchObject({ payload: { params: {
                reason: expect.stringMatching(/\S/),
            } } });
        }
        await flushHookEffects();
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_1');
        expect(getDeviceDefaultServerId()).toBe('srv_server_1');
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it('sends live permission allow to a saved inactive Home without selecting it or navigating', async () => {
        await arrangeHomes([profile('srv_server_1', activeUrl), profile('srv_server_2', 'https://company.example.test')]);
        arrangeSession('s_allow_2', 'srv_server_2');
        await renderLiveNotification({ sessionId: 's_allow_2', requestId: 'p_allow_2', turnId: 'inactive-turn', serverUrl: 'https://company.example.test' }, PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1);
        await vi.waitFor(() => expect(permissionRequests()).toHaveLength(1));
        expect(permissionRequests()[0]).toMatchObject({ origin: 'https://company.example.test', payload: { params: { id: 'p_allow_2', turnId: 'inactive-turn', approved: true } } });
        await flushHookEffects();
        expect(getActiveServerSnapshot().serverId).toBe('srv_server_1');
        expect(getDeviceDefaultServerId()).toBe('srv_server_1');
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it.each([
        { sessionId: 's_allow_3', requestId: 'p_allow_3', turnId: 'missing-home-turn' },
        { sessionId: 's_allow_3', requestId: 'p_allow_3', serverUrl: activeUrl },
    ])('keeps an incomplete live permission target for review without navigation: %j', async (data) => {
        await arrangeHomes();
        await renderLiveNotification(data, PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1);
        expectNoTargetMutation();
        expect(getPendingNotificationAction()).toBeNull();
        expect(getPendingNotificationNav()).toBeNull();
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it('opens a cached modern permission response for review without replaying the decision', async () => {
        await arrangeHomes();
        arrangeSession('s_cached_permission');
        await renderNotification({ sessionId: 's_cached_permission', requestId: 'p_cached_permission',
            turnId: 'cached-turn', serverUrl: activeUrl }, PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1);
        expect(permissionRequests()).toHaveLength(0);
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_cached_permission?serverId=srv_server_1');
    });
    it('does not perform permission allow or send a request to an unsaved Home', async () => {
        await arrangeHomes();
        await renderLiveNotification({ sessionId: 's_allow_4', requestId: 'p_allow_4', turnId: 'unknown-home-turn',
            serverUrl: 'https://unknown.example.test' }, PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1);
        expectNoTargetMutation();
        expect(getPendingNotificationAction()).toBeNull();
        expect(getPendingNotificationNav()).toBeNull();
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it('ignores unknown actions without adding a Home, writing a pending action, or navigating', async () => {
        await arrangeHomes();
        nativeNotifications.response = response({ sessionId: 's_unknown', serverUrl: 'https://unknown.example.test' }, 'UNKNOWN_ACTION');
        const profilesBefore = listServerProfiles();
        await renderRootLayoutRoute(RootLayout, credentials);
        await flushHookEffects();
        expect(listServerProfiles()).toEqual(profilesBefore);
        expect(getPendingNotificationAction()).toBeNull();
        expect(getPendingNotificationNav()).toBeNull();
        expectNoTargetMutation();
        expect(routerBoundary.push).not.toHaveBeenCalled();
    });
    it('connects an unsaved Home from a body tap when no profiles exist', async () => {
        await arrangeHomes([]);
        await renderNotification({ sessionId: 's_allow_5', serverUrl: 'https://new.example.test' });
        expect(permissionRequests()).toHaveLength(0);
        expect(getActiveServerSnapshot().serverUrl).toBe('https://new.example.test');
        expect(listServerProfiles().map(home => home.serverUrl)).toContain('https://new.example.test');
        expect(routerBoundary.push).toHaveBeenCalledWith('/session/s_allow_5?serverId=' + getActiveServerSnapshot().serverId);
    });
    it('routes to Home settings with a prefilled address when profiles already exist', async () => {
        await arrangeHomes();
        await renderNotification({ sessionId: 's_999', serverUrl: 'https://unknown2.example.test' });
        expectNoTargetMutation();
        expect(routerBoundary.push).toHaveBeenCalledWith('/settings/server/add?address=https%3A%2F%2Funknown2.example.test&source=notification');
        expectPendingNavigation('https://unknown2.example.test', '/session/s_999');
    });
});
