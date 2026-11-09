import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { createDeferred } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import {
    configureConnectedServerSocketBoundary,
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; vi.useRealTimers(); });

describe('Home reachability through public Sync and captured Session HTTP', () => {
    it('recovers the Account socket and confirms request failures before withdrawing a healthy Home', async () => {
        const serverUrl = 'https://home-reachability.example.test';
        const session = createPlainSessionCurrentProjectionRecordFixture({ id: 'reachable-session' });
        const sockets: Socket[] = [];
        let failedRequests = 0;
        let sessionReads = 0;
        let probes = 0;
        let networkDown = false;
        let probeGate: ReturnType<typeof createDeferred<void>> | undefined;
        const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
            const path = new URL(String(input)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') {
                probes += 1;
                await probeGate?.promise;
                if (networkDown) throw new TypeError('Home network unavailable');
                return Response.json({ ok: true });
            }
            if (path === '/v1/request-failure') {
                failedRequests += 1;
                throw new TypeError('One HTTP request failed');
            }
            if (path === `/v2/sessions/${session.id}`) { sessionReads += 1; return Response.json({ session }); }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/machines') return Response.json([]);
            return createEmptyAccountBootstrapHttpResponse(path, init);
        };
        const home = await restoreServerAccountForTest({
            serverUrl, accountId: 'reachable-account', request,
            configureSocket: socket => { sockets.push(socket); configureConnectedServerSocketBoundary(socket); },
        });
        disposeHome = home.dispose;
        setRuntimeFetch(async (input, init) => await request(input, init) ?? new Response('{}', { status: 404 }));
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { resolveServerAccountRequestContext, ServerScopedTransportUnavailableError } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext');
        const { invalidateServerReachabilitySupervisor, peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: home.serverId });
        if (!credentials) throw new Error('Restored Home has no authentication');
        await vi.waitFor(() => expect(storage.getState().socketStatus).toBe('connected'));
        expect(storage.getState().endpointStatus).toBe('online');
        const socket = sockets.find(candidate => candidate.auth && 'clientPurpose' in candidate.auth && candidate.auth.clientPurpose === 'sync');
        if (!socket) throw new Error('Sync Account socket was not constructed');

        // A failed WebSocket upgrade on an already connected polling socket
        // must not turn the healthy HTTP Home into an outage.
        socket.io.emitReserved('error', new Error('WebSocket upgrade failed; polling remains connected'));
        await invalidateServerReachabilitySupervisor({ serverUrl, token: credentials.token });
        expect(storage.getState().endpointStatus).toBe('online');
        expect(socket.connected).toBe(true);

        // Deliver the SDK disconnect and its next polling connection through
        // the real adapter, Sync subscription and realtime store binding.
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(300);
        socket.connected = false;
        socket.emitReserved('disconnect', 'transport close');
        await invalidateServerReachabilitySupervisor({ serverUrl, token: credentials.token });
        expect(storage.getState().socketStatus).toBe('connected');
        expect(storage.getState().endpointStatus).toBe('online');
        await vi.advanceTimersByTimeAsync(300);

        const phases: string[] = [];
        const unsubscribe = storage.subscribe(state => { phases.push(state.endpointStatus); });
        const beforeProbes = probes;
        probeGate = createDeferred<void>();
        try {
            const failures = await Promise.allSettled(Array.from({ length: 5 }, () =>
                apiSocket.request('/v1/request-failure', { method: 'POST' }, { retry: 'none' })));
            expect(failures.every(result => result.status === 'rejected' && result.reason instanceof TypeError)).toBe(true);
            expect(failedRequests).toBe(5);
            expect.soft(phases).not.toContain('offline');
            expect.soft(probes - beforeProbes).toBe(1);

            // This is the captured request path that formerly rejects before
            // any Session HTTP request when a single operation poisons Home state.
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                serverId: home.serverId, activeRequest: apiSocket.request.bind(apiSocket),
            });
            try {
                const response = await authority.request(`/v2/sessions/${session.id}`, undefined, { retry: 'none' });
                expect(await response.json()).toMatchObject({ session: { id: session.id } });
                expect(sessionReads).toBe(1);
            } finally { await authority.release(); }
        } finally { probeGate.resolve(); probeGate = undefined; unsubscribe(); }

        // A confirmed readiness failure still withdraws the Home and settles
        // captured requests with the existing typed unavailable result.
        await invalidateServerReachabilitySupervisor({ serverUrl, token: credentials.token });
        await vi.advanceTimersByTimeAsync(300);
        networkDown = true;
        await invalidateServerReachabilitySupervisor({ serverUrl, token: credentials.token });
        await vi.advanceTimersByTimeAsync(0);
        expect(peekServerReachabilityState(serverUrl, credentials.token)).toMatchObject({ phase: 'offline', reason: 'server_unreachable' });
        expect(storage.getState().endpointStatus).toBe('offline');
        await expect(resolveServerAccountRequestContext({ serverId: home.serverId, preferScoped: true }))
            .rejects.toBeInstanceOf(ServerScopedTransportUnavailableError);
        networkDown = false;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(storage.getState().endpointStatus).toBe('online');
        const recoveredProbes = probes;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(probes).toBe(recoveredProbes);
    });
});

describe('Home that was down when its cold restore ran', () => {
    async function restoreWhileHomeIsDown(serverUrl: string, options: Readonly<{ silent?: boolean }> = {}) {
        const sockets: Socket[] = [];
        const home = { down: true, silent: options.silent === true, probes: 0 };
        const restored = await restoreServerAccountForTest({
            serverUrl,
            // Account material is what makes cold restore read the Home's encryption identity before its socket starts.
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'down-at-boot-account' })).toString('base64url')}.sig`, secret: Buffer.alloc(32, 7).toString('base64url'), custody: 'historical' },
            requestOwnsReachabilityProbes: true, retainFailedColdRestore: true,
            configureSocket: socket => { sockets.push(socket); configureConnectedServerSocketBoundary(socket); },
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/health' || path === '/v1/auth/ping') home.probes += 1;
                if (home.silent) return await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
                if (home.down) throw new TypeError('fetch failed: Could not connect to the server.');
                if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
                if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/machines') return Response.json([]);
                return createEmptyAccountBootstrapHttpResponse(path, init);
            },
        });
        disposeHome = restored.dispose;
        const { isAppliedActiveServerRuntimeAvailable, isColdActiveServerRestorePending } = await import('@/sync/runtime/orchestration/connectionManager');
        if (!options.silent) await vi.waitFor(() => expect(isColdActiveServerRestorePending()).toBe(false));
        expect(isAppliedActiveServerRuntimeAvailable()).toBe(false);
        expect(sockets).toHaveLength(0);
        return home;
    }

    async function expectConnectedInStoreAndOwner(): Promise<void> {
        const { isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/connectionManager');
        expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
        expect(storage.getState().socketStatus).toBe('connected');
        expect(storage.getState().endpointStatus).toBe('online');
    }

    it('connects at the reachability owner\'s next retry once the Home answers', async () => {
        const home = await restoreWhileHomeIsDown('https://down-at-boot-retry.example.test');
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(home.probes).toBeGreaterThan(0);
        home.down = false;
        await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs * 1.2);
        await vi.waitFor(expectConnectedInStoreAndOwner, { timeout: 15_000 });
    });

    it('lets a foreground reprobe supersede a long reachability backoff', async () => {
        const home = await restoreWhileHomeIsDown('https://down-at-boot-foreground.example.test');
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(300_000);
        home.down = false;
        const { invalidateAllServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await invalidateAllServerReachabilitySupervisors();
        // No backoff elapses: the reprobe itself ends the wait, and module loads run in real time.
        await vi.waitFor(expectConnectedInStoreAndOwner, { timeout: 15_000, interval: 50 });
    });

    it('lets a visible Retry supersede a cold restore parked on a silent read', async () => {
        const home = await restoreWhileHomeIsDown('https://down-at-boot-silent.example.test', { silent: true });
        const { isColdActiveServerRestorePending, retryActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await vi.waitFor(() => expect(isColdActiveServerRestorePending()).toBe(true));
        home.silent = false;
        home.down = false;
        await retryActiveServerConnection();
        await vi.waitFor(expectConnectedInStoreAndOwner, { timeout: 15_000 });
    });

    it('publishes the connection a visible Retry establishes', async () => {
        const home = await restoreWhileHomeIsDown('https://down-at-boot-manual.example.test');
        home.down = false;
        const { retryActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await retryActiveServerConnection();
        await vi.waitFor(expectConnectedInStoreAndOwner, { timeout: 5_000 });
    });
});
