import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';

const ioSpy = vi.hoisted(() => vi.fn());
let activeSocket: typeof import('./apiSocket')['apiSocket'] | undefined;
const ownedSubscriptions: Array<() => unknown> = [];
const reachability = vi.hoisted(() => ({
    listeners: new Map<string, (state: ManagedConnectionState) => void>(),
    invalidate: vi.fn(async (..._args: unknown[]) => {}),
    restart: vi.fn((..._args: unknown[]) => {}),
    report: vi.fn((..._args: unknown[]) => {}),
}));
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>(),
    subscribeServerReachabilityState: (url: string, listener: (state: ManagedConnectionState) => void) => {
        reachability.listeners.set(url, listener);
        listener(state('idle'));
        return () => { reachability.listeners.delete(url); };
    },
    startServerReachabilitySupervisor: vi.fn(async () => {}),
    stopServerReachabilitySupervisor: vi.fn(async () => {}),
    invalidateServerReachabilitySupervisor: (...args: unknown[]) => reachability.invalidate(...args),
    reportServerRestarting: (...args: unknown[]) => reachability.restart(...args),
    reportServerUnreachable: (...args: unknown[]) => reachability.report(...args),
}));

const endpoint = 'https://server.example.test';
function state(phase: ManagedConnectionState['phase']): ManagedConnectionState {
    return { phase, reason: phase === 'offline' ? 'transport_disconnect' : null, attempt: 1,
        nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null };
}
function emitReachability(phase: ManagedConnectionState['phase']) {
    const listener = reachability.listeners.get(endpoint);
    if (!listener) throw new Error('Missing reachability listener');
    listener(state(phase));
}
async function readCurrentRpcRequestDisposition(error: unknown) {
    // resetModules replaces the private disposition Symbol as well as its writer.
    const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
    return readRpcRequestDisposition(error);
}
async function boot(options: Readonly<{ autoConnect?: boolean; token?: string; credentials?: AuthCredentials; serverId?: string }> = {}) {
    const boundary = createSocketIoBoundaryStub(options);
    ioSpy.mockReturnValue(boundary.socket);
    const { apiSocket } = await import('./apiSocket');
    activeSocket = apiSocket;
    const config = { endpoint, token: options.token ?? options.credentials?.token ?? 'token-1',
        ...(options.serverId ? { serverId: options.serverId } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}) };
    apiSocket.initialize(config, null);
    return { apiSocket, ...boundary };
}
async function connect(socket: ReturnType<typeof createSocketIoBoundaryStub>['socket']) {
    emitReachability('online');
    await vi.waitFor(() => expect(socket.connected).toBe(true));
}

await import('./apiSocket');

describe('apiSocket reconnect semantics', () => {
    afterEach(() => {
        activeSocket?.disconnect(); activeSocket = undefined;
        for (const unsubscribe of ownedSubscriptions.splice(0)) unsubscribe();
        reachability.listeners.clear(); reachability.invalidate.mockClear();
        reachability.restart.mockClear(); reachability.report.mockClear();
        ioSpy.mockReset(); vi.useRealTimers();
        resetRuntimeFetch(); vi.restoreAllMocks();
    });

    it('preserves finite Account currentness on transport loss while withdrawing disclosure', async () => {
        const { captureAccountEncryptionCurrentness, getAccountEncryptionModeCacheRevision } = await import('../account/apiAccountEncryptionMode');
        const { socket, trigger } = await boot();
        await connect(socket);
        const disclosure = captureAccountEncryptionCurrentness();
        try {
            expect(disclosure.isCurrent()).toBe(true);
            const revision = getAccountEncryptionModeCacheRevision();
            trigger('disconnect', 'transport close');
            expect(disclosure.isCurrent()).toBe(true);
            expect(getAccountEncryptionModeCacheRevision()).toBeGreaterThan(revision);
        } finally { disclosure.dispose(); }
    });

    it('keeps authentication failure terminal for finite Account currentness', async () => {
        const { captureAccountEncryptionCurrentness } = await import('../account/apiAccountEncryptionMode');
        const { socket } = await boot();
        await connect(socket);
        const currentness = captureAccountEncryptionCurrentness();
        try {
            emitReachability('auth_failed');
            expect(currentness.isCurrent()).toBe(false);
        } finally { currentness.dispose(); }
    });

    it.each([false, true])('preserves finite Account currentness on intentional transport withdrawal (observation: %s)', async withObservation => {
        const { captureAccountEncryptionCurrentness, getAccountEncryptionModeCacheRevision, invalidateAccountEncryptionModeCache } = await import('../account/apiAccountEncryptionMode');
        const { encodeBase64 } = await import('@/encryption/base64');
        const credentials: AuthCredentials = { token: `hdr.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'socket-account' })), 'base64')}.sig` };
        const { socket, apiSocket } = await boot(withObservation ? { credentials } : {});
        await connect(socket);
        const currentness = captureAccountEncryptionCurrentness();
        try {
            const revision = getAccountEncryptionModeCacheRevision();
            apiSocket.disconnect();
            expect(currentness.isCurrent()).toBe(true);
            expect(getAccountEncryptionModeCacheRevision()).toBeGreaterThan(revision);
            expect(apiSocket.getAccountEncryptionObservationBinding(credentials)).toBeNull();
            invalidateAccountEncryptionModeCache({ reason: 'scope-reset' });
            expect(currentness.isCurrent()).toBe(false);
        } finally { currentness.dispose(); }
    });

    it('borrows the admitted Account socket identity without recurring mode HTTP after warm-up', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: endpoint, scope: 'device' });
        const { encodeBase64 } = await import('@/encryption/base64');
        const credentials: AuthCredentials = { token: `hdr.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'socket-account' })), 'base64')}.sig` };
        const reads: string[] = [];
        setRuntimeFetch(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            reads.push(path);
            return Response.json(path === '/v1/account/encryption/currentness'
                ? createPlainAccountEncryptionCurrentnessFixture() : { mode: 'plain', updatedAt: 1 });
        });
        const activeApiSocket = (await import('./apiSocket')).apiSocket;
        const { subscribeAccountEncryptionModeCacheInvalidation } = await import('../account/apiAccountEncryptionMode');
        let immediateRead: Promise<unknown> | undefined;
        ownedSubscriptions.push(subscribeAccountEncryptionModeCacheInvalidation(() => {
            const binding = activeApiSocket.getAccountEncryptionObservationBinding(credentials);
            if (!immediateRead && binding) immediateRead = binding.read().then(value => ({ value }), error => ({ error }));
        }));
        const { socket, trigger, apiSocket } = await boot({ credentials });
        await connect(socket);
        expect(immediateRead).toBeDefined();
        await expect(immediateRead).resolves.toMatchObject({ value: { mode: 'plain' } });
        const { fetchAccountEncryptionMode } = await import('../account/apiAccountEncryptionMode');
        const binding = apiSocket.getAccountEncryptionObservationBinding(credentials);
        expect(binding).not.toBeNull();
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({ endpointUrl: endpoint, credentials,
            ...(binding ? { accountEncryptionObservation: binding } : {}) });
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ mode: 'plain' });
        clock.mockReturnValue(now + 6_000);
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ mode: 'plain' });
        expect(reads).toEqual(['/v1/account/encryption/currentness']);
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ mode: 'plain' });
        expect(reads).toHaveLength(1);
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        const updated = createPlainAccountEncryptionCurrentnessFixture({ version: 2, updatedAt: 2 });
        trigger('update', UpdateContainerSchema.parse({ id: 'other-update', seq: 2, createdAt: 2,
            body: { t: 'update-account', id: 'another-account', encryptionCurrentness: updated } }));
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ updatedAt: 1 });
        trigger('update', UpdateContainerSchema.parse({ id: 'own-update', seq: 2, createdAt: 2,
            body: { t: 'update-account', id: 'socket-account', encryptionCurrentness: updated } }));
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ updatedAt: 2 });
        expect(reads).toHaveLength(1);
        // A final authority check cannot borrow the still-connected socket fact.
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'fresh-authority' })).toMatchObject({ updatedAt: 1 });
        expect(reads).toEqual(['/v1/account/encryption/currentness', '/v1/account/encryption']);
        const foreignRequest = createServerFetchAtEndpoint({ endpointUrl: 'https://other-account-home.test', credentials,
            ...(binding ? { accountEncryptionObservation: binding } : {}) });
        await fetchAccountEncryptionMode(credentials, { request: foreignRequest, usage: 'identity' });
        await fetchAccountEncryptionMode({ ...credentials }, { request, usage: 'identity' });
        expect(reads).toHaveLength(3);
        await fetchAccountEncryptionMode({ ...credentials, secret: 'changed-key-material' }, { request, usage: 'identity' });
        await fetchAccountEncryptionMode({ token: `${credentials.token}-forged` }, { request, usage: 'identity' });
        expect(reads).toHaveLength(5);
        const changedOriginRequest = createServerFetchAtEndpoint({ endpointUrl: endpoint, runtimeOrigin: 'https://another-carrier.test', credentials,
            ...(binding ? { accountEncryptionObservation: binding } : {}) });
        await fetchAccountEncryptionMode(credentials, { request: changedOriginRequest, usage: 'identity' });
        expect(reads).toHaveLength(6);
        const cancelled = new AbortController();
        const cancelledRequest = createServerFetchAtEndpoint({ endpointUrl: endpoint, credentials, signal: cancelled.signal,
            ...(binding ? { accountEncryptionObservation: binding } : {}) });
        cancelled.abort();
        await expect(fetchAccountEncryptionMode(credentials, { request: cancelledRequest, usage: 'identity' })).rejects.toMatchObject({ name: 'AbortError' });
        expect(await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).toMatchObject({ updatedAt: 2 });
        expect(reads).toHaveLength(6);
        trigger('disconnect', 'transport close');
        await expect(fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).rejects.toMatchObject({
            code: 'account-encryption-currentness-unavailable',
        });
        expect(reads).toHaveLength(6);
    });

    it.each(['revoked', 'invalid-token'] as const)('retires the explicit frame authority on %s without Account supervision', async (failure) => {
        const boundary = createSocketIoBoundaryStub({ autoConnect: failure === 'revoked' });
        ioSpy.mockReturnValue(boundary.socket);
        const { apiSocket } = await import('./apiSocket');
        activeSocket = apiSocket;
        const onCredentialRejected = vi.fn();
        apiSocket.initialize({ endpoint, token: 'hap_v1_child',
            socketRole: { clientType: 'session-scoped', sessionId: 'frame-session' },
            request: async () => new Response(JSON.stringify({ cursor: 0 })),
            isCurrent: () => true, onCredentialRejected,
        }, null);
        await vi.waitFor(() => expect(failure === 'revoked' ? boundary.socket.connected : boundary.socket.active).toBe(true));
        if (failure === 'revoked') boundary.trigger('disconnect', 'io server disconnect');
        else boundary.trigger('connect_error', Object.assign(new Error('invalid-token'), { data: { statusCode: 401, error: 'invalid-token' } }));
        await vi.waitFor(() => expect(onCredentialRejected).toHaveBeenCalledOnce());
        await expect(apiSocket.emitWithAck('message', { sid: 'frame-session' })).rejects.toMatchObject({ code: 'not_authenticated' });
        expect(reachability.listeners.size).toBe(0);
        expect(reachability.invalidate).not.toHaveBeenCalled();
    });

    it('ignores a retired frame socket disconnect after its replacement authority connects', async () => {
        const predecessor = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(predecessor.socket);
        const { apiSocket } = await import('./apiSocket');
        activeSocket = apiSocket;
        const predecessorRejected = vi.fn();
        apiSocket.initialize({ endpoint, token: 'hap_v1_predecessor', serverId: 'home-a', generation: 1,
            socketRole: { clientType: 'session-scoped', sessionId: 'predecessor-session' },
            request: async () => Response.json({ cursor: 0 }),
            isCurrent: () => true, onCredentialRejected: predecessorRejected,
        }, null);
        await vi.waitFor(() => expect(predecessor.socket.connected).toBe(true));

        const replacement = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(replacement.socket);
        const replacementRejected = vi.fn();
        apiSocket.initialize({ endpoint, token: 'hap_v1_replacement', serverId: 'home-b', generation: 2,
            socketRole: { clientType: 'session-scoped', sessionId: 'replacement-session' },
            request: async () => Response.json({ cursor: 0 }),
            isCurrent: () => true, onCredentialRejected: replacementRejected,
        }, null);
        await vi.waitFor(() => expect(replacement.socket.connected).toBe(true));
        predecessor.trigger('disconnect', 'io server disconnect');

        expect(replacement.socket.connected).toBe(true);
        expect(apiSocket.getSessionScopedTarget()).toBe('replacement-session');
        expect(predecessorRejected).not.toHaveBeenCalled();
        expect(replacementRejected).not.toHaveBeenCalled();
        expect(reachability.listeners.size).toBe(0);
    });

    it('keeps a replacement frame connected when the retired concrete socket reports revocation or restart', async () => {
        const first = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(first.socket);
        const { apiSocket } = await import('./apiSocket');
        activeSocket = apiSocket;
        const onCredentialRejected = vi.fn();
        const connectionState = vi.fn();
        const detachState = apiSocket.onConnectionStateChange(connectionState);
        const config = { endpoint, token: 'hap_v1_child',
            socketRole: { clientType: 'session-scoped', sessionId: 'frame-session' } as const,
            request: async () => new Response(JSON.stringify({ cursor: 0 })),
            isCurrent: () => true, onCredentialRejected,
        };
        apiSocket.initialize(config, null);
        await vi.waitFor(() => expect(first.socket.connected).toBe(true));
        const staleRestart = [...first.listeners.get('server:restarting') ?? []];
        const next = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(next.socket);
        // Reapplying the very same configuration must still retire its concrete transport.
        apiSocket.initialize(config, null);
        await vi.waitFor(() => expect(next.socket.connected).toBe(true));
        first.trigger('disconnect', 'io server disconnect');
        for (const restart of staleRestart) restart({ retryAfterMs: 7_000 });
        await Promise.resolve();
        expect(next.socket.connected).toBe(true);
        expect(onCredentialRejected).not.toHaveBeenCalled();
        expect(connectionState.mock.lastCall?.[0]).toMatchObject({ phase: 'online' });
        next.trigger('disconnect', 'io server disconnect');
        await vi.waitFor(() => expect(onCredentialRejected).toHaveBeenCalledOnce());
        expect(connectionState.mock.lastCall?.[0]).toMatchObject({ phase: 'auth_failed' });
        detachState();
    });

    it('reports a frame restart through its scoped supervisor without Account supervision', async () => {
        const boundary = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(boundary.socket);
        const { apiSocket } = await import('./apiSocket');
        activeSocket = apiSocket;
        const onCredentialRejected = vi.fn();
        const connectionState = vi.fn();
        const detachState = apiSocket.onConnectionStateChange(connectionState);
        apiSocket.initialize({ endpoint, token: 'hap_v1_child',
            socketRole: { clientType: 'session-scoped', sessionId: 'frame-session' },
            request: async () => new Response(JSON.stringify({ cursor: 0 })),
            isCurrent: () => true, onCredentialRejected,
        }, null);
        await vi.waitFor(() => expect(boundary.socket.connected).toBe(true));
        boundary.trigger('server:restarting', { retryAfterMs: 7_000 });
        await vi.waitFor(() => expect(connectionState.mock.lastCall?.[0]).toMatchObject({
            phase: 'offline', reason: 'server_restarting',
        }));
        expect(boundary.socket.connected).toBe(false);
        expect(onCredentialRejected).not.toHaveBeenCalled();
        expect(reachability.restart).not.toHaveBeenCalled();
        detachState();
    });

    it('publishes rendered Session presence on the existing focused Home socket', async () => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
        const { apiSocket, socket } = await boot({ token });
        const { markSessionSurfaceVisible, markSessionSurfaceHidden } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const serverId = getActiveServerSnapshot().serverId;
        markSessionSurfaceVisible('presence-session', serverId);
        try {
            socket.emitWithAck.mockResolvedValue({ v: 1, ok: true, admittedSessionIds: ['presence-session'] });
            await connect(socket);
            await vi.waitFor(() => expect(socket.emitWithAck.mock.calls).toContainEqual([
                'session-human-presence:visible-replace', { v: 1, sessionIds: ['presence-session'] },
            ]), { timeout: 15_000 });
        } finally { apiSocket.disconnect(); markSessionSurfaceHidden('presence-session', serverId); }
    });

    it('declares current transcript demand on the real focused socket registration and repeats admitted catch-up after reconnect', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { apiSocket, socket, trigger } = await boot();
        const serverId = getActiveServerSnapshot().serverId;
        const release = registerSessionRealtimeTranscriptConsumer('consumed-session', serverId);
        const admitted: unknown[] = [];
        const stop = apiSocket.onSessionConsumptionAdmitted(value => admitted.push(value));
        try {
            await connect(socket);
            await vi.waitFor(() => expect(admitted).toEqual([{ serverId, sessionIds: ['consumed-session'] }]), { timeout: 15_000 });
            expect(socket.emitWithAck.mock.calls).toContainEqual(['session-consumption-replace', {
                v: 1, liveSessionIds: ['consumed-session'], durableSessionIds: ['consumed-session'],
            }]);
            trigger('disconnect', 'transport close');
            emitReachability('offline'); await connect(socket);
            await vi.waitFor(() => expect(admitted).toHaveLength(2));
        } finally { stop(); release(); apiSocket.disconnect(); }
    });

    it('warns about a refused consumption declaration while preserving the connected socket and connection error state', async () => {
        const { apiSocket, socket } = await boot();
        const respond = socket.emitWithAck.getMockImplementation();
        if (!respond) throw new Error('Expected the canonical socket boundary ACK implementation');
        socket.emitWithAck.mockImplementation(async (event, ...args) => event === 'session-consumption-replace'
            ? { ok: false, error: 'not_allowed' } : respond(event, ...args));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const onError = vi.fn();
        ownedSubscriptions.push(apiSocket.onError(onError));
        await connect(socket);
        await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[session-consumption]', 'session_consumption_not_allowed'));
        expect(socket.connected).toBe(true);
        expect(onError.mock.calls.every(([error]) => error === null)).toBe(true);
    });

    it('fires onReconnected only after an unintentional transport outage cycle', async () => {
        const { apiSocket, socket, trigger } = await boot();
        const onReconnected = vi.fn(); ownedSubscriptions.push(apiSocket.onReconnected(onReconnected));
        await connect(socket); expect(onReconnected).not.toHaveBeenCalled();
        trigger('disconnect', 'transport close');
        emitReachability('offline'); await connect(socket);
        expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    it('catches demanded Run activity up through the actual focused Home reconnect', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { subscribeExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const activity = vi.fn();
        ownedSubscriptions.push(subscribeExecutionRunActivity({
            serverId: getActiveServerSnapshot().serverId, sessionId: 'roster-session',
        }, activity));
        const { socket, trigger } = await boot();
        await connect(socket);
        expect(activity).toHaveBeenCalledWith({ runId: null });
        activity.mockClear();
        trigger('disconnect', 'transport close');
        emitReachability('offline');
        await connect(socket);
        expect(activity).toHaveBeenCalledTimes(1);
        expect(activity).toHaveBeenCalledWith({ runId: null });
    });

    it.each(['socket-drop', 'home-outage', 'first-connection', 'daemon-restart'] as const)('recovers a demanded retired inventory watch through the focused Home connection (%s)', async recovery => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'self' })).toString('base64')}.signature`;
        const serverId = 'inventory-reconnect-home';
        const { apiSocket, socket, trigger } = await boot({ token, serverId });
        if (recovery !== 'first-connection') await connect(socket);
        const inventory = await import('@/sync/domains/local/services/inventory/sharedStore');
        const key = { serverId, machineId: 'inventory-machine' };
        expect(apiSocket.getMachineRequestScope()).toEqual({ serverId: key.serverId, accountId: 'self' });
        const snapshot = { v: 1 as const, machineId: key.machineId, generatedAt: 1,
            refreshState: 'idle' as const, entries: [], diagnostics: [] };
        let watches = 0;
        const dispose = inventory.subscribeLocalServiceInventoryStore(key, () => {}, {
            snapshotClient: async () => ({ ok: true, snapshot }),
            watchClient: async input => {
                if (input.observationOnly) return new Promise(() => {});
                if (++watches === 1) return { ok: false, reason: 'request_failed' };
                if (watches === 2) return { ok: true, changed: true, snapshot: { ...snapshot, generatedAt: 2 } };
                return new Promise(() => {});
            },
        });
        try {
            await vi.waitFor(() => expect(watches).toBe(1));
            if (recovery === 'daemon-restart') {
                trigger('ephemeral', { type: 'machine-activity', id: key.machineId, active: true, activeAt: 1 });
                trigger('ephemeral', { type: 'machine-activity', id: 'another-machine', active: true, activeAt: 2, reconnected: true });
                await Promise.resolve();
                expect(watches).toBe(1);
                trigger('ephemeral', { type: 'machine-activity', id: key.machineId, active: true, activeAt: 3, reconnected: true });
            } else {
                if (recovery === 'socket-drop') trigger('disconnect', 'transport close');
                if (recovery !== 'first-connection') emitReachability('offline');
                await connect(socket);
            }
            await vi.waitFor(() => expect(inventory.getLocalServiceInventoryState(key).generatedAt).toBe(2));
        } finally { dispose(); inventory.resetLocalServiceInventoryStoreForTests(); }
    });

    it('invalidates reachability when the network transport drops', async () => {
        const { socket, trigger } = await boot(); await connect(socket);
        trigger('disconnect', 'transport close');
        expect(reachability.invalidate).toHaveBeenCalledWith({ serverUrl: endpoint, token: 'token-1' });
        expect(reachability.report).not.toHaveBeenCalled();
    });

    it('reports planned server restart events to the reachability owner', async () => {
        const { socket, trigger } = await boot(); await connect(socket);
        trigger('server:restarting', { retryAfterMs: 7_000 });
        expect(reachability.restart).toHaveBeenCalledWith(endpoint, 7_000, 'token-1');
    });

    it('feeds ephemerals to handlers with the immutable Home captured by the concrete socket', async () => {
        const { apiSocket, socket, trigger } = await boot();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const serverId = getActiveServerSnapshot().serverId;
        const { replaceExternalSessionStatusDemandViewport, resetExternalSessionStatusDemandCoordinatorForTests } =
            await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
        replaceExternalSessionStatusDemandViewport('active-server-test', [{ serverId, sessionId: 'session-1',
            machineId: 'machine-1', linkGeneration: 'generation-1', demand: 'open' }]);
        const config = { endpoint, token: 'token-1', serverId };
        apiSocket.initialize(config, null);
        const handler = vi.fn(); ownedSubscriptions.push(apiSocket.onMessage('ephemeral', handler));
        await connect(socket); config.serverId = 'later-home'; socket.emit.mockClear();
        const payload = { type: 'machine-activity', id: 'machine-1', active: true, activeAt: 1_000 };
        trigger('ephemeral', payload);
        expect(handler).toHaveBeenCalledWith(payload, { serverId });
        expect(socket.emit.mock.calls.filter(([event]) => event === 'external-session-status-demand-v1')
            .map(([, demand]) => demand)).toEqual([expect.objectContaining({ revision: 3 })]);
        resetExternalSessionStatusDemandCoordinatorForTests();
    });

    it('disconnects a pending network connect when reachability becomes offline', async () => {
        const { socket } = await boot({ autoConnect: false });
        emitReachability('online');
        await vi.waitFor(() => expect(socket.active).toBe(true));
        expect(socket.connected).toBe(false);
        emitReachability('offline');
        await vi.waitFor(() => expect(socket.active).toBe(false));
        expect(socket.disconnect).toHaveBeenCalled();
    });

    it('does not fire onReconnected after an intentional disconnect cycle', async () => {
        const { apiSocket, socket } = await boot();
        const onReconnected = vi.fn(); ownedSubscriptions.push(apiSocket.onReconnected(onReconnected));
        await connect(socket); apiSocket.disconnect(); apiSocket.connect(); await connect(socket);
        expect(onReconnected).not.toHaveBeenCalled();
    });

    it('recreates the socket with the latest token after updateToken', async () => {
        const { apiSocket, socket } = await boot(); await connect(socket);
        const next = createSocketIoBoundaryStub(); ioSpy.mockReturnValue(next.socket);
        apiSocket.updateToken('token-2'); await connect(next.socket);
        expect(ioSpy.mock.calls.at(-1)?.[1]).toMatchObject({ auth: { token: 'token-2' } });
        expect(socket.connected).toBe(false);
    });

    it('rejects Session RPC before emission when reachability is auth_failed', async () => {
        const { apiSocket, socket } = await boot(); await connect(socket); emitReachability('auth_failed');
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture()]);
        const request = apiSocket.sessionRPC('session-1', 'send_message', { text: 'hello' }, { timeoutMs: 5 });
        await expect(request).rejects.toMatchObject({
            kind: 'auth', code: 'not_authenticated', canTryAgain: false,
        });
        expect(await readCurrentRpcRequestDisposition(await request.catch((error: unknown) => error))).toBe('notSent');
        expect(socket.emitWithAck.mock.calls.filter(([event]) => event === 'rpc-call')).toEqual([]);
    });

    it('marks a disconnected Session RPC as not sent before any network emission', async () => {
        const { apiSocket, socket } = await boot(); await connect(socket);
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture()]);
        apiSocket.disconnect();
        const error: unknown = await apiSocket.sessionRPC('session-1', 'send_message', { text: 'hello' })
            .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect(await readCurrentRpcRequestDisposition(error)).toBe('notSent');
        expect(socket.emitWithAck.mock.calls.filter(([event]) => event === 'rpc-call')).toEqual([]);
    });

    it.each(['online', 'auth_failed'] as const)('coerces ack timeout only when reachability settles to %s', async (phase) => {
        const { apiSocket, socket } = await boot(); await connect(socket);
        const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture()]);
        socket.emitWithAck.mockRejectedValue(new Error('operation has timed out'));
        const request = apiSocket.sessionRPC('session-1', 'send_message', { text: 'hello' }, { timeoutMs: 5 });
        await vi.waitFor(() => expect(socket.emitWithAck.mock.calls.some(([event]) => event === 'rpc-call')).toBe(true));
        emitReachability(phase);
        if (phase === 'auth_failed') await expect(request).rejects.toMatchObject({ kind: 'auth', code: 'not_authenticated' });
        else await expect(request).rejects.toThrow('operation has timed out');
        expect(await readCurrentRpcRequestDisposition(await request.catch((error: unknown) => error))).toBe('outcomeUnknown');
    });

    it('publishes managed connection phases alongside legacy status', async () => {
        const { apiSocket, socket } = await boot(); const listener = vi.fn(); ownedSubscriptions.push(apiSocket.onConnectionStateChange(listener));
        emitReachability('connecting'); await connect(socket);
        expect(listener.mock.calls.map(([value]) => value.phase)).toEqual(expect.arrayContaining(['idle', 'connecting', 'online']));
    });

    it('keeps connected status when connect is called while already online', async () => {
        const { apiSocket, socket } = await boot(); await connect(socket);
        const listener = vi.fn(); ownedSubscriptions.push(apiSocket.onStatusChange(listener)); listener.mockClear();
        apiSocket.connect();
        expect(listener).not.toHaveBeenCalledWith('connecting');
    });
});
