import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

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
async function boot(options: Readonly<{ autoConnect?: boolean; token?: string }> = {}) {
    const boundary = createSocketIoBoundaryStub(options);
    ioSpy.mockReturnValue(boundary.socket);
    const { apiSocket } = await import('./apiSocket');
    activeSocket = apiSocket;
    apiSocket.initialize({ endpoint, token: options.token ?? 'token-1' }, null);
    return { apiSocket, ...boundary };
}
async function connect(socket: ReturnType<typeof createSocketIoBoundaryStub>['socket']) {
    emitReachability('online');
    await vi.waitFor(() => expect(socket.connected).toBe(true));
}

describe('apiSocket reconnect semantics', () => {
    afterEach(() => {
        activeSocket?.disconnect(); activeSocket = undefined;
        for (const unsubscribe of ownedSubscriptions.splice(0)) unsubscribe();
        reachability.listeners.clear(); reachability.invalidate.mockClear();
        reachability.restart.mockClear(); reachability.report.mockClear();
        ioSpy.mockReset(); vi.useRealTimers();
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

    it('fires onReconnected only after an unintentional transport outage cycle', async () => {
        const { apiSocket, socket, trigger } = await boot();
        const onReconnected = vi.fn(); ownedSubscriptions.push(apiSocket.onReconnected(onReconnected));
        await connect(socket); expect(onReconnected).not.toHaveBeenCalled();
        trigger('disconnect', 'transport close');
        emitReachability('offline'); await connect(socket);
        expect(onReconnected).toHaveBeenCalledTimes(1);
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
        expect(readRpcRequestDisposition(await request.catch((error: unknown) => error))).toBe('notSent');
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
        expect(readRpcRequestDisposition(error)).toBe('notSent');
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
        expect(readRpcRequestDisposition(await request.catch((error: unknown) => error))).toBe('outcomeUnknown');
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
