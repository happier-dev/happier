import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { act } from 'react-test-renderer';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    createDeferred,
    createPlainAccountEncryptionCurrentnessFixture,
    createSessionFixture,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
    projectLegacySessionAccessCapabilitiesV1,
    type SessionListQueryV1,
    type V2SessionRecord,
} from '@happier-dev/protocol';
import * as cache from './concurrentSessionCache';
import { storage } from '@/sync/domains/state/storageStore';
import { useServerCredentialAccountScopes } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';

const secureStore = vi.hoisted(() => new Map<string, string>());
type TelemetrySocket = Socket & Readonly<{ dispatch: (event: string, payload: unknown) => void }>;
const socketState = vi.hoisted(() => ({
    byUrl: new Map<string, TelemetrySocket>(),
    failForToken: null as string | null,
}));
let restoreLocalStorage: (() => void) | null = null;

vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
    deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

// The barrel reaches this same transport boundary through providerSettingsHarness.
// Keep one factory so later graph imports cannot replace the recorder or failures.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    if (socketState.failForToken && typeof socket.auth === 'object' && socket.auth.token === socketState.failForToken) {
        throw new Error('Socket transport construction failed');
    }
    socket.connect = vi.fn(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    const observed = Object.assign(socket, {
        dispatch(event: string, payload: unknown) {
            for (const listener of socket.listeners(event)) listener(payload);
        },
    });
    if (serverUrl) socketState.byUrl.set(serverUrl, observed);
});

function sessionRow(id: string, overrides: Partial<V2SessionRecord> = {}): V2SessionRecord {
    const session = createSessionFixture({ id });
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        archivedAt: null, metadata: JSON.stringify(session.metadata), metadataVersion: 1,
        agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
        encryptionMode: 'plain', share: null,
        effectiveAccess: {
            v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
        },
        ...overrides,
    };
}

function sessionPage(
    id: string,
    nextCursor: string | null,
    overrides: Partial<V2SessionRecord> = {},
): Response {
    const row = sessionRow(id, overrides);
    return Response.json({ sessions: [row], nextCursor, hasNext: nextCursor !== null });
}

afterEach(async () => {
    standardCleanup();
    cache.stopConcurrentSessionCacheSync();
    await disposeIrohHomeTunnelRuntime();
    restoreLocalStorage?.();
    restoreLocalStorage = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    secureStore.clear();
    socketState.byUrl.clear();
    socketState.failForToken = null;
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
    delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('concurrent session cache telemetry', () => {
    it('retires only an auth-failed secondary Home corpus and repopulates after exact credential replacement', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const oldToken = token('auth-account-b');
        const replacementToken = token('auth-account-b-replacement');
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') return sessionPage('auth-row', null);
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://auth-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://auth-b.example.test', name: 'Auth B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(
                secondary.serverUrl,
                { serverId: secondary.id },
                { token: oldToken },
            );
        });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'auth-group', name: 'Auth', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'auth-group',
        });
        try {
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['auth-row']), { timeout: 15_000 });
            storage.getState().applyServerScopedSessionListRows(
                active.id,
                [createSessionListRenderableSessionFixture({ id: 'active-row' })],
                { source: 'ordinary', mode: 'replace' },
            );
            const rowsBeforeFailure = storage.getState().sessionListRowsByServerId[secondary.id];
            const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            reachability.reportServerAuthFailed(secondary.serverUrl, 401, undefined, oldToken);
            await vi.waitFor(() => {
                expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBeUndefined();
                expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
                expect(storage.getState().sessionListIndexByServerId[secondary.id]).toBeUndefined();
            });
            expect(rowsBeforeFailure?.['auth-row']).toBeDefined();
            expect(storage.getState().sessionListRowsByServerId[active.id]?.['active-row']).toBeDefined();
            expect(storage.getState().ordinarySessionListMembershipByServerId[active.id]).toEqual(['active-row']);
            const { createActivityAttentionStoreSourceSelector } = await import('@/activity/source/createActivityAttentionStoreSourceSelector');
            const activityAfterFailure = createActivityAttentionStoreSourceSelector()(storage.getState());
            expect(activityAfterFailure.ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
            expect(activityAfterFailure.ordinarySessionListMembershipByServerId[active.id]).toEqual(['active-row']);

            await act(async () => {
                await TokenStorage.setCredentialsForServerUrl(
                    secondary.serverUrl,
                    { serverId: secondary.id },
                    { token: replacementToken },
                );
            });
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['auth-row']), { timeout: 15_000 });
        } finally {
            cache.stopConcurrentSessionCacheSync();
        }
    });

    it('preserves verified secondary rows across bindings and retires changed Account rows before the new binding publishes', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const newAccountPage = createDeferred<void>();
        const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const originalToken = token('binding-account-b');
        const replacementToken = token('binding-account-next');
        let blockReplacement = false;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname.startsWith('/v2/sessions')) {
                if (blockReplacement && new Headers(init?.headers).get('authorization') === `Bearer ${replacementToken}`) {
                    await newAccountPage.promise;
                    return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                }
                if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
                return url.searchParams.has('cursor')
                    ? sessionPage('retained-page-two', null)
                    : sessionPage('retained-page-one', 'second-page');
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://binding-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://binding-b.example.test', name: 'Binding B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: originalToken });
        });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'binding-group', name: 'Binding', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'binding-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['retained-page-one', 'retained-page-two']), { timeout: 15_000 });
        const rows = storage.getState().sessionListRowsByServerId[secondary.id];
        const membership = storage.getState().ordinarySessionListMembershipByServerId[secondary.id];
        const frontier = cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier;
        const replacementBindingMemberships: Array<readonly string[] | undefined> = [];
        const first = await renderHook(() => {
            const bindings = useServerCredentialAccountScopes([secondary.id]);
            if (bindings.get(secondary.id)?.accountId === 'binding-account-next') {
                replacementBindingMemberships.push(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]);
            }
            return bindings;
        });
        const second = await renderHook(() => useServerCredentialAccountScopes([secondary.id]));
        await vi.waitFor(() => expect(second.getCurrent().get(secondary.id)?.accountId).toBe('binding-account-b'));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBe(membership);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);

        const previousBinding = first.getCurrent().get(secondary.id)!;
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: originalToken });
        });
        await vi.waitFor(() => expect(first.getCurrent().get(secondary.id)).not.toBe(previousBinding));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);

        blockReplacement = true;
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: replacementToken });
        });
        await vi.waitFor(() => expect(first.getCurrent().get(secondary.id)?.accountId).toBe('binding-account-next'));
        expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBeUndefined();
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBeUndefined();
        expect(replacementBindingMemberships.length).toBeGreaterThan(0);
        expect(replacementBindingMemberships.every((ids) => ids === undefined)).toBe(true);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({
            hasFetchedSnapshot: false, frontier: { nextCursor: null, hasNext: false },
        });
        newAccountPage.resolve();
    });

    it('preserves same-Account rows while replacement transport acquisition is pending or fails', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const acquiring = createDeferred<void>();
        const acquisition = createDeferred<void>();
        let ordinaryReads = 0;
        // Only the native byte-carrier lifecycle is substituted. The real
        // profile, carrier policy, supervisor, cache and credential owners run.
        getIrohHomeTunnelRuntime({
            native: {
                async ensureHomeTunnel() {
                    acquiring.resolve();
                    await acquisition.promise;
                    throw new Error('Native carrier is unavailable');
                },
                async releaseHomeTunnel() {},
            },
        });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                ordinaryReads += 1;
                return sessionPage('retained-during-acquisition', null);
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }));
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const runtime = await import('@/sync/domains/server/serverRuntime');
            const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://rotation-a.example.test', scope: 'tab' });
            const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://rotation-b.example.test', name: 'Rotation B' });
            const homeId = 'srv_rotation_b';
            await profiles.setServerProfileIdentityForUrl(secondary.serverUrl, homeId);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'rotation-account-b' })).toString('base64url')}.signature`;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: homeId }, { token });
            await profiles.saveHomeViewState({
                version: 1, groups: [{ id: 'rotation-group', name: 'Rotation', serverIds: [active.id, homeId] }],
                activeTargetKind: 'group', activeTargetId: 'rotation-group',
            });
            cache.startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[homeId])
                .toEqual(['retained-during-acquisition']), { timeout: 15_000 });
            const rows = storage.getState().sessionListRowsByServerId[homeId];
            const membership = storage.getState().ordinarySessionListMembershipByServerId[homeId];
            const frontier = cache.readConcurrentOrdinarySessionListLifecycle(homeId).frontier;
            // A completed HTTP snapshot is not proof that its socket exists.
            await vi.waitFor(() => expect(socketState.byUrl.has(secondary.serverUrl), JSON.stringify({
                socketEndpoints: [...socketState.byUrl.keys()],
                online: cache.isConcurrentSessionListQueryHomeOnline(homeId),
                observation: storage.getState().concurrentSessionListCacheByServerId[homeId]?.listObservation,
                ordinaryReads,
            })).toBe(true));
            const previousSocket = socketState.byUrl.get(secondary.serverUrl)!;
            await profiles.reconcileServerProfileHomeConnectionDescriptor({
                serverUrl: secondary.serverUrl, observedServerIdentityId: homeId,
                descriptor: {
                    v: 1, homeServerIdentityId: homeId, canonicalServerUrl: secondary.serverUrl, revision: 1,
                    endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test'] }],
                },
            });
            await acquiring.promise;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: homeId }, {
                token: token.replace('.signature', '.rotated-signature'),
            });
            const binding = await renderHook(() => useServerCredentialAccountScopes([homeId]));
            await vi.waitFor(() => expect(binding.getCurrent().get(homeId)?.accountId).toBe('rotation-account-b'));
            expect(storage.getState().sessionListRowsByServerId[homeId]).toBe(rows);
            expect(storage.getState().ordinarySessionListMembershipByServerId[homeId]).toBe(membership);
            expect(cache.readConcurrentOrdinarySessionListLifecycle(homeId).frontier).toBe(frontier);
            expect(previousSocket.connected).toBe(false);
            expect(cache.isConcurrentSessionListQueryHomeOnline(homeId)).toBe(false);
            const readsBeforeRefresh = ordinaryReads;
            await cache.refreshConcurrentOrdinarySessionList(homeId);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            acquisition.resolve();
            await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[homeId]?.listObservation?.phase)
                .toBe('offline'));
            expect(storage.getState().sessionListRowsByServerId[homeId]).toBe(rows);
            expect(cache.getConcurrentSessionListQueryHomeAvailability(homeId)).toBe('offline');
            await cache.refreshConcurrentOrdinarySessionList(homeId);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            const remounted = await renderHook(() => useServerCredentialAccountScopes([homeId]));
            await vi.waitFor(() => expect(remounted.getCurrent().get(homeId)?.accountId).toBe('rotation-account-b'));
            expect(storage.getState().ordinarySessionListMembershipByServerId[homeId]).toBe(membership);
        } finally {
            acquisition.resolve();
        }
    });

    it('preserves same-Account rows after socket construction fails and releases the failed subscription before retry', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        let recovered = false;
        let ordinaryReads = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                ordinaryReads += 1;
                return sessionPage(recovered ? 'recovered-after-connect-error' : 'retained-after-connect-error', null);
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://connect-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://connect-b.example.test', name: 'Connect B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'connect-account-b' })).toString('base64url')}.signature`;
        const rotatedToken = token.replace('.signature', '.rotated-signature');
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'connect-group', name: 'Connect', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group', activeTargetId: 'connect-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['retained-after-connect-error']), { timeout: 15_000 });
        const rows = storage.getState().sessionListRowsByServerId[secondary.id];
        const membership = storage.getState().ordinarySessionListMembershipByServerId[secondary.id];
        const frontier = cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier;
        const previousSocket = socketState.byUrl.get(secondary.serverUrl)!;
        // Another real reader already owns this Home's reachability. The new
        // cache subscription receives its online state synchronously, so a
        // socket-library construction failure must roll back that subscription.
        const otherReader = await reachability.acquireServerReachabilitySupervisor({
            serverUrl: secondary.serverUrl, token: rotatedToken,
        });
        try {
            expect(reachability.peekServerReachabilityState(secondary.serverUrl, rotatedToken)?.phase).toBe('online');
            socketState.failForToken = rotatedToken;
            await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token: rotatedToken });
            await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
                .toBe('offline'));
            const binding = await renderHook(() => useServerCredentialAccountScopes([secondary.id]));
            await vi.waitFor(() => expect(binding.getCurrent().get(secondary.id)?.accountId).toBe('connect-account-b'));
            expect(storage.getState().sessionListRowsByServerId[secondary.id]).toBe(rows);
            expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toBe(membership);
            expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id).frontier).toBe(frontier);
            expect(previousSocket.connected).toBe(false);
            expect(cache.getConcurrentSessionListQueryHomeAvailability(secondary.id)).toBe('offline');
            const readsBeforeRefresh = ordinaryReads;
            await cache.refreshConcurrentOrdinarySessionList(secondary.id);
            expect(ordinaryReads).toBe(readsBeforeRefresh);
            await otherReader.release();
            expect(reachability.peekServerReachabilityState(secondary.serverUrl, rotatedToken)).toBeNull();
            socketState.failForToken = null;
            recovered = true;
            await cache.retryConcurrentSessionListQueryHome(secondary.id);
            await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
                .toEqual(['recovered-after-connect-error']));
            expect(cache.getConcurrentSessionListQueryHomeAvailability(secondary.id)).toBe('online');
        } finally {
            socketState.failForToken = null;
            await otherReader.release();
        }
    });

    it('coalesces in-flight replacement requests and settles them only after page one replaces the corpus', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const continuation = createDeferred<Response>();
        const replacement = createDeferred<Response>();
        const requestedCursors: Array<string | null> = [];
        let failRefresh = false;
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions') {
                if (url.hostname === 'refresh-c.example.test') return sessionPage('other-home', null);
                const cursor = url.searchParams.get('cursor');
                requestedCursors.push(cursor);
                if (requestedCursors.length === 1) return sessionPage('old-first', 'second-page');
                if (requestedCursors.length === 2) return continuation.promise;
                if (requestedCursors.length === 3) return replacement.promise;
                return failRefresh ? Response.json({}, { status: 503 }) : sessionPage('after-retry', null);
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://refresh-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://refresh-b.example.test', name: 'Refresh B' });
        const other = await profiles.upsertServerProfile({ serverUrl: 'https://refresh-c.example.test', name: 'Refresh C' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'refresh-account-b' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await TokenStorage.setCredentialsForServerUrl(other.serverUrl, { serverId: other.id }, { token });
        await profiles.saveHomeViewState({
            version: 1, groups: [{ id: 'refresh-group', name: 'Refresh', serverIds: [active.id, secondary.id, other.id] }],
            activeTargetKind: 'group', activeTargetId: 'refresh-group',
        });
        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(requestedCursors).toEqual([null, 'second-page']), { timeout: 15_000 });
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['old-first']);
        let settled = 0;
        const refreshes = [cache.refreshConcurrentOrdinarySessionList(secondary.id), cache.refreshConcurrentOrdinarySessionList(secondary.id)];
        for (const refresh of refreshes) void refresh.then(() => { settled += 1; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(0);
        await cache.refreshConcurrentOrdinarySessionList(other.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[other.id]).toEqual(['other-home']);
        expect(settled).toBe(0);
        continuation.resolve(sessionPage('old-second', 'third-page'));
        await vi.waitFor(() => expect(requestedCursors).toHaveLength(3), { timeout: 5_000 });
        expect(requestedCursors).toEqual([null, 'second-page', null]);
        expect(settled).toBe(0);
        replacement.resolve(sessionPage('new-first', null));
        await Promise.all(refreshes);
        expect(settled).toBe(2);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['new-first']);
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({
            hasFetchedSnapshot: true, frontier: { nextCursor: null, hasNext: false },
        });
        failRefresh = true;
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('error');
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['new-first']);
        failRefresh = false;
        await cache.refreshConcurrentOrdinarySessionList(secondary.id);
        expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id]).toEqual(['after-retry']);
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready');
    });

    it('does not let strict-query hydration or disposal mark an unfetched Home ordinary list ready', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        const ordinaryPage = createDeferred<Response>();
        let secondaryServerUrl = '';
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {} });
            if (url.pathname.includes('/encryption')) return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (url.pathname === '/v2/sessions/query') {
                return Response.json(SessionListQueryResponseV1Schema.parse({
                    sessions: [{ ...sessionRow('query-only', {
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'unopenable-envelope',
                        metadata: 'encrypted-unopenable-metadata',
                    }), responsibleAccountId: null, responsibleAccount: null,
                    viewer: {
                        readState: { state: 'not_started' },
                        relevance: { relevant: true, reasons: ['owned_by_me'] },
                        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                        follow: { follows: false, notificationLevel: null },
                        notification: { level: 'important', source: 'owner' },
                    } }],
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: null,
                    attentionHasNext: false,
                }));
            }
            if (url.pathname === '/v2/sessions') {
                if (url.origin === secondaryServerUrl) return ordinaryPage.promise;
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (url.pathname === '/v1/machines') return Response.json([]);
            throw new Error(`Unexpected request: ${url.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://query-observation-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://query-observation-b.example.test', name: 'Query Observation B' });
        secondaryServerUrl = secondary.serverUrl;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'query-observation-account' })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(secondary.serverUrl, { serverId: secondary.id }, { token });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'query-observation-group', name: 'Query Observation', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'query-observation-group',
        });

        cache.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(cache.isConcurrentSessionListQueryHomeOnline(secondary.id)).toBe(true), { timeout: 15_000 });
        await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([input]) => {
            const url = new URL(String(input));
            return url.origin === secondaryServerUrl && url.pathname === '/v2/sessions';
        })).toBe(true), { timeout: 15_000 });
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');

        const query: SessionListQueryV1 = {
            v: 1,
            storage: 'active',
            includeInactive: false,
            scope: 'all_accessible',
            attention: 'any',
            audiences: [],
            tagIds: [],
            includeAttention: true,
        };
        const controller = createSessionListQueryHomeController({
            serverId: secondary.id,
            fetchPage: (page) => cache.fetchConcurrentSessionListQueryPage(secondary.id, page),
        });
        await controller.update({ query, selected: true, online: true, supported: true });
        expect(controller.getSnapshot(), JSON.stringify(controller.getSnapshot()))
            .toMatchObject({ phase: 'ready', appliedSourceKind: 'query' });
        expect(controller.getSnapshot().addresses.map((address) => address.sessionId)).toEqual(['query-only']);
        expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['query-only']).toBeDefined();
        // Observe real query hydration while its request is current. Disposing
        // first correctly cancels that work and cannot witness a hydration patch.
        await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[secondary.id]?.['query-only']?.metadataUnavailable)
            .toBe(true), { timeout: 15_000 });

        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');
        controller.dispose();
        expect(cache.readConcurrentOrdinarySessionListLifecycle(secondary.id)).toMatchObject({ hasFetchedSnapshot: false });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase)
            .toBe('loading');

        ordinaryPage.resolve(sessionPage('ordinary-after-query', null));
        await vi.waitFor(() => expect(storage.getState().ordinarySessionListMembershipByServerId[secondary.id])
            .toEqual(['ordinary-after-query']), { timeout: 15_000 });
        expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]?.listObservation?.phase).toBe('ready');
    });

    it('measures real secondary snapshots and socket coalescing without Home attribution', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `cache_telemetry_${Date.now()}`;
        const localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        let blockNextSessionSnapshot = false;
        const snapshotGate: { release?: () => void } = {};
        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/v1/auth/ping')) {
                return Response.json({ ok: true });
            }
            if (url.includes('/v2/sessions')) {
                if (blockNextSessionSnapshot) {
                    blockNextSessionSnapshot = false;
                    await new Promise<void>((resolve) => { snapshotGate.release = resolve; });
                }
                const body = JSON.stringify({ sessions: [], nextCursor: null, hasNext: false });
                return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
            }
            if (url.includes('/v1/machines')) {
                return new Response('[]', { status: 200, headers: { 'content-length': '2' } });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        const active = await runtime.upsertAndActivateServer({ serverUrl: 'https://home-a.example.test', scope: 'tab' });
        const secondary = await profiles.upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(
            secondary.serverUrl,
            { serverId: secondary.id },
            { token: 'secondary-token' },
        );
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'global-group', name: 'Global Group', serverIds: [active.id, secondary.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'global-group',
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        // Simulate a late focused-account projection carrying the pre-migration
        // selection. Once HomeView exists, this scoped copy has no authority.
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                serverSelectionGroups: [{
                    id: 'stale-group',
                    name: 'Stale Group',
                    serverIds: [active.id],
                    presentation: 'grouped',
                }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'stale-group',
            },
        }));

        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const cache = await import('./concurrentSessionCache');
        // Loading the real graph instantiates focused Sync, which applies the
        // runtime telemetry setting. Enable capture after that production
        // composition side effect so the test observes the cache owner itself.
        syncPerformanceTelemetry.configure({ enabled: true });
        expect(syncPerformanceTelemetry.isEnabled()).toBe(true);
        expect(await TokenStorage.getCredentialsForServerUrl(
            secondary.serverUrl,
            { serverId: secondary.id },
        )).toMatchObject({ token: 'secondary-token' });
        cache.startConcurrentSessionCacheSync();
        const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await vi.waitFor(() => {
            expect(reachability.peekServerReachabilityState(secondary.serverUrl)).toMatchObject({ phase: 'online' });
        }, { timeout: 5_000 });
        await vi.waitFor(() => {
            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'sync.concurrent.refresh')).toBe(true);
        }, { timeout: 15_000 });
        syncPerformanceTelemetry.reset();
        vi.useFakeTimers();

        blockNextSessionSnapshot = true;
        const secondarySocket = socketState.byUrl.get(secondary.serverUrl);
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        await vi.advanceTimersByTimeAsync(601);
        await Promise.resolve();
        secondarySocket?.dispatch('update', { body: { t: 'update-session' } });
        await vi.advanceTimersByTimeAsync(601);
        snapshotGate.release?.();
        await vi.waitFor(() => {
            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'sync.concurrent.refresh')).toBe(true);
        }, { timeout: 5_000 });

        const summary = syncPerformanceTelemetry.snapshot();
        const refresh = summary.events.find((event) => event.name === 'sync.concurrent.refresh');
        const socket = summary.events.find((event) => event.name === 'sync.concurrent.refresh.socket');
        expect(refresh?.fields.responseBytes).toBeGreaterThan(2);
        expect(refresh?.count).toBeGreaterThanOrEqual(1);
        expect(socket?.fields).toMatchObject({ enqueued: 2, coalesced: 1, inFlightQueued: 1 });
        expect(JSON.stringify(summary)).not.toContain(secondary.id);
        expect(JSON.stringify(summary)).not.toContain(secondary.serverUrl);

        const replacement = await profiles.upsertServerProfile({
            serverUrl: 'https://home-c.example.test',
            name: 'Home C',
        });
        await TokenStorage.setCredentialsForServerUrl(
            replacement.serverUrl,
            { serverId: replacement.id },
            { token: 'replacement-token' },
        );
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'global-next', name: 'Global Next', serverIds: [active.id, replacement.id] }],
            activeTargetKind: 'group',
            activeTargetId: 'global-next',
        });
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(601);
        await vi.waitFor(() => {
            expect(storage.getState().concurrentSessionListCacheByServerId[secondary.id]).toBeUndefined();
            expect(storage.getState().concurrentSessionListCacheByServerId[replacement.id]).toBeDefined();
        }, { timeout: 5_000 });

        cache.stopConcurrentSessionCacheSync();
        localStorageHandle.restore();
        restoreLocalStorage = null;
    });
});
