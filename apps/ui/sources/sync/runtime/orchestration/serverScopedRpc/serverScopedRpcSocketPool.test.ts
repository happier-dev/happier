import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { SESSION_CONSUMPTION_REPLACE_EVENT, type SessionConsumptionReplaceAckV1, type SessionConsumptionReplaceV1 } from '@happier-dev/protocol/sessions';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { createOwnedHomeCarrierRelease } from '@/sync/runtime/homeCarrierPolicy';
import type { ScopedSocketClient } from './serverScopedRpcTypes';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

/**
 * A semantic Home carrier is only ever identified here; the pool never moves bytes
 * through it in these tests because `createSocket` is supplied directly.
 */
function createFakeHomeCarrier(endpointId: string): HomeCarrier {
    return {
        endpointId,
        readObservedPath: () => 'relay',
        request: async () => {
            throw new Error('unused');
        },
        createWebSocket: () => ({}),
    };
}

function createFakeSocket(options: Readonly<{
    disconnectEventDelayMs?: number;
    connectionId?: string;
    connectError?: Error;
}> = {}) {
    const { socket, trigger } = createSocketIoBoundaryStub();
    socket.id = options.connectionId ?? '';
    if (options.connectError) {
        socket.connect.mockImplementation(() => {
            socket.active = true;
            trigger('connect_error', options.connectError);
        });
    }
    if (typeof options.disconnectEventDelayMs === 'number') {
        // Some platform bridges deliver disconnect asynchronously; keep the
        // canonical stub's inactive/disconnected behavior beneath that delay.
        const delayMs = Math.max(0, options.disconnectEventDelayMs);
        socket.disconnect.mockImplementation(() => {
            const wasConnected = socket.connected;
            socket.active = false;
            socket.connected = false;
            if (wasConnected) setTimeout(() => trigger('disconnect', 'io client disconnect'), delayMs);
        });
    }
    return { socket, trigger, connectSpy: socket.connect, disconnectSpy: socket.disconnect };
}

describe('serverScopedRpcSocketPool', () => {
    it.each([
        { scope: 'Account relay', sessionId: undefined },
        { scope: 'Session relay', sessionId: 'session-relay' },
    ])('restores an observed $scope after a transport drop', async ({ sessionId }) => {
        const http = createServer();
        const home = new Server(http, { path: '/v1/updates/' });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing Home listener');
        const declarations: Array<{ socketId: string; sessionIds: readonly string[] }> = [];
        home.on('connection', socket => {
            socket.on(SESSION_CONSUMPTION_REPLACE_EVENT,
                (declaration: SessionConsumptionReplaceV1, ack: (result: SessionConsumptionReplaceAckV1) => void) => {
                    declarations.push({ socketId: socket.id, sessionIds: declaration.liveSessionIds });
                    ack({ ok: true, ...declaration });
                });
        });
        const pool = createServerScopedRpcSocketPool({
            readIdleDisconnectMs: () => 0,
            reachability: {
                startReachability: async () => {},
                waitForReachable: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
        });
        try {
            const client = await pool.acquire({ serverUrl: `http://127.0.0.1:${address.port}`,
                token: 'relay-test', sessionId, timeoutMs: 2_000 });
            const original = client.getSocketId();
            expect(declarations).toEqual(sessionId ? [{ socketId: original, sessionIds: [sessionId] }] : []);
            const replacements: string[] = [];
            client.on('connect', () => { replacements.push(client.getSocketId()); });
            home.sockets.sockets.get(original)!.conn.close();
            await expect.poll(() => replacements).toHaveLength(1);
            expect(replacements[0]).not.toBe(original);
            expect(declarations).toEqual(sessionId ? [
                { socketId: original, sessionIds: [sessionId] },
                { socketId: replacements[0], sessionIds: [sessionId] },
            ] : []);
            client.disconnect();
            await expect.poll(() => home.sockets.sockets.size).toBe(0);
        } finally {
            await pool.stopAll();
            pool.resetForTests();
            await home.close();
        }
    });

    it('keeps one-shot background sockets outside foreground pause and socket reuse', async () => {
        vi.useFakeTimers();
        const { setServerReachabilityNetworkAllowed, isServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const sockets: ReturnType<typeof createFakeSocket>[] = [];
        // Substitute only the external socket. Foreground reachability stays real.
        const pool = createServerScopedRpcSocketPool({ createSocket: () => {
            const boundary = createFakeSocket();
            sockets.push(boundary);
            return boundary.socket;
        } });
        const clients: ScopedSocketClient[] = [];
        try {
            setServerReachabilityNetworkAllowed(false);
            const params = { serverUrl: 'https://background.example.test', token: 'background-token', timeoutMs: 1_000,
                networkMode: 'background-task' as const };
            const first = pool.acquire(params).then(client => { clients.push(client); return client; }, error => error);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await first).toHaveProperty('connected', true);
            const second = pool.acquire(params).then(client => { clients.push(client); return client; }, error => error);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await second).toHaveProperty('connected', true);
            expect(sockets).toHaveLength(2);
            setServerReachabilityNetworkAllowed(true);
            setServerReachabilityNetworkAllowed(false);
            await vi.advanceTimersByTimeAsync(0);
            expect(sockets.every(({ socket }) => socket.connected)).toBe(true);
            clients[0]!.disconnect();
            await vi.advanceTimersByTimeAsync(0);
            expect(sockets[0]!.socket.active).toBe(false);
            expect(sockets[1]!.socket.connected).toBe(true);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
            // An ordinary acquisition still observes the foreground pause.
            const foreground = pool.acquire({ serverUrl: params.serverUrl, token: params.token, timeoutMs: 1_000 })
                .catch(error => error);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await foreground).toMatchObject({ connectionPhase: expect.stringMatching(/^reachability-/) });
        } finally {
            clients.forEach(client => client.disconnect());
            await pool.stopAll();
            pool.resetForTests();
            setServerReachabilityNetworkAllowed(true);
        }
    });

    it('aborts a stalled background handshake and releases its Home carrier without a late RPC', async () => {
        vi.useFakeTimers();
        const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const boundary = createSocketIoBoundaryStub({ autoConnect: false });
        const emitWithAck = boundary.socket.emitWithAck;
        const controller = new AbortController();
        const releaseCarrier = vi.fn(async () => {});
        const pool = createServerScopedRpcSocketPool({ createSocket: () => boundary.socket });
        try {
            setServerReachabilityNetworkAllowed(false);
            const result = pool.acquire({ serverUrl: 'https://background.example.test', token: 'background-token',
                carrier: 'iroh', homeCarrier: createFakeHomeCarrier('background-endpoint'),
                takeCarrierRelease: () => releaseCarrier, timeoutMs: 1_000,
                networkMode: 'background-task', signal: controller.signal }).catch(error => error);
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.socket.active).toBe(true);
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            expect(await result).toMatchObject({ code: 'SOCKET_RPC_ABORTED' });
            expect(boundary.socket.active).toBe(false);
            expect(releaseCarrier).toHaveBeenCalledTimes(1);
            boundary.trigger('connect');
            await vi.advanceTimersByTimeAsync(0);
            expect(emitWithAck).not.toHaveBeenCalled();
        } finally {
            await pool.stopAll();
            pool.resetForTests();
            setServerReachabilityNetworkAllowed(true);
        }
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses the canonical Socket.IO updates path', async () => {
        vi.resetModules();
        const { socket } = createFakeSocket();
        const ioSpy = vi.fn(() => socket);
        vi.doMock('socket.io-client', () => ({
            io: ioSpy,
        }));

        const { createServerScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
        const pool = createServerScopedRpcSocketPool({
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const client: ScopedSocketClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1000,
        });
        client.disconnect();

        expect(socket.io.timeout()).toBe(false);

        expect(ioSpy).toHaveBeenCalledWith(
            'https://server.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                withCredentials: false,
                auth: expect.objectContaining({
                    // Assert the canonical declaration rather than a copied literal: the
                    // protocol owns this version and bumping it must not fail this test.
                    accountStoredContentCompatibility:
                        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                }),
            }),
        );

        await pool.stopAll();
        pool.resetForTests();
    });

    it('uses WebSocket-only for Iroh and does not pool it with HTTPS at the same origin', async () => {
        vi.resetModules();
        const first = createFakeSocket();
        const second = createFakeSocket();
        const ioSpy = vi.fn()
            .mockReturnValueOnce(first.socket)
            .mockReturnValueOnce(second.socket);
        vi.doMock('socket.io-client', () => ({ io: ioSpy }));

        const { createServerScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
        const pool = createServerScopedRpcSocketPool({
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        const irohClient = await pool.acquire({
            serverUrl: 'http://127.0.0.1:4312',
            reachabilityServerUrl: 'https://home.example.test',
            carrier: 'iroh',
            token: 'token-a',
            timeoutMs: 1_000,
        });
        const httpsClient = await pool.acquire({
            serverUrl: 'http://127.0.0.1:4312',
            reachabilityServerUrl: 'https://home.example.test',
            carrier: 'https',
            token: 'token-a',
            timeoutMs: 1_000,
        });

        expect(ioSpy).toHaveBeenCalledTimes(2);
        expect(ioSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ transports: ['websocket'] }));
        expect(ioSpy.mock.calls[1]?.[1]).not.toHaveProperty('transports');

        irohClient.disconnect();
        httpsClient.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('passes the selected browser carrier to reachability before probing an ingress-less canonical URL', async () => {
        const { socket } = createFakeSocket();
        const homeCarrier = createFakeHomeCarrier('browser-endpoint');
        let observedReachability: Readonly<{ serverUrl: string; token: string; signal?: AbortSignal; homeCarrier?: HomeCarrier | null }> | null = null;
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async (params) => {
                    observedReachability = params;
                },
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const client = await pool.acquire({
            // `.invalid` is syntactically valid but intentionally has no ingress;
            // the selected browser carrier is the only viable readiness path.
            serverUrl: 'https://home.invalid',
            reachabilityServerUrl: 'https://home.invalid',
            carrier: 'iroh',
            homeCarrier,
            token: 'token-browser',
            timeoutMs: 1_000,
        });

        expect(observedReachability).toMatchObject({
            serverUrl: 'https://home.invalid',
            token: 'token-browser',
            signal: expect.any(AbortSignal),
            homeCarrier,
        });
        client.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('keeps one live socket entry for the same private credential regardless of unrelated tokens', async () => {
        const createdTokens: string[] = [];
        const pool = createServerScopedRpcSocketPool({
            createSocket: ({ token }) => {
                createdTokens.push(token);
                return createFakeSocket().socket;
            },
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 60_000,
        });

        const retained = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'retained-token',
            timeoutMs: 1_000,
        });
        for (let index = 0; index < 520; index += 1) {
            const client = await pool.acquire({
                serverUrl: 'https://server.example.test',
                token: `unrelated-token-${index}`,
                timeoutMs: 1_000,
            });
            client.disconnect();
        }
        const sameCredential = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'retained-token',
            timeoutMs: 1_000,
        });

        expect(createdTokens.filter((token) => token === 'retained-token')).toHaveLength(1);

        retained.disconnect();
        sameCredential.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('surfaces the underlying socket.io connection id so per-tab transports can target this socket', async () => {
        const ioSpy = vi.fn();
        const { socket } = createFakeSocket({ connectionId: 'conn-xyz' });
        ioSpy.mockReturnValue(socket);

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => ioSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const client: ScopedSocketClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-id',
            timeoutMs: 1000,
        });

        expect(client.getSocketId()).toBe('conn-xyz');

        client.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('returns an empty connection id when the socket has not completed a handshake', async () => {
        const ioSpy = vi.fn();
        const { socket } = createFakeSocket();
        // A fake socket whose connect handshake never assigns `id`.
        ioSpy.mockReturnValue(socket);

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => ioSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const client: ScopedSocketClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-noid',
            timeoutMs: 1000,
        });

        expect(client.getSocketId()).toBe('');

        client.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('reuses a single underlying socket across sequential acquires within the idle window', async () => {
        const ioSpy = vi.fn();
        const { socket, disconnectSpy } = createFakeSocket();
        ioSpy.mockReturnValue(socket);

	        const pool = createServerScopedRpcSocketPool({
	            createSocket: () => ioSpy(),
	            reachability: {
	                waitForReachable: async () => {},
	                startReachability: async () => {},
	                subscribeNetworkAllowed: () => () => {},
	            },
	            readIdleDisconnectMs: () => 5_000,
	        });

        vi.useFakeTimers();

        const c1: ScopedSocketClient = await pool.acquire({ serverUrl: 'https://server.example.test', token: 't', timeoutMs: 1000 });
        expect(ioSpy).toHaveBeenCalledTimes(1);
        c1.disconnect();

        // No immediate disconnect; should remain cached/connected for the idle window.
        expect(disconnectSpy).toHaveBeenCalledTimes(0);

        const c2: ScopedSocketClient = await pool.acquire({ serverUrl: 'https://server.example.test', token: 't', timeoutMs: 1000 });
        expect(ioSpy).toHaveBeenCalledTimes(1);
        c2.disconnect();

        vi.advanceTimersByTime(5_000);
        expect(socket.connected).toBe(false);

        await pool.stopAll();
        pool.resetForTests();
    });

	    it('disconnects pooled sockets when reachability network becomes disallowed', async () => {
	        const ioSpy = vi.fn();
	        const { socket, disconnectSpy } = createFakeSocket();
	        ioSpy.mockReturnValue(socket);

	        let capturedListener: ((allowed: boolean) => void) | null = null;
	        const pool = createServerScopedRpcSocketPool({
	            createSocket: () => ioSpy(),
	            reachability: {
	                waitForReachable: async () => {},
	                startReachability: async () => {},
	                subscribeNetworkAllowed: (listener: (allowed: boolean) => void) => {
	                    capturedListener = listener;
	                    return () => {
	                        if (capturedListener === listener) {
	                            capturedListener = null;
	                        }
	                    };
	                },
	            },
	            readIdleDisconnectMs: () => 5_000,
	        });

        const c1: ScopedSocketClient = await pool.acquire({ serverUrl: 'https://server.example.test', token: 't', timeoutMs: 1000 });
	        c1.disconnect();

	        expect(disconnectSpy).toHaveBeenCalledTimes(0);
	        if (!capturedListener) {
	            throw new Error('Expected reachability.subscribeNetworkAllowed to capture a listener');
	        }
	        const listenerFn: (allowed: boolean) => void = capturedListener as unknown as (allowed: boolean) => void;
	        listenerFn(false);
	        await vi.waitFor(() => {
	            expect(socket.connected).toBe(false);
	        });

	        await pool.stopAll();
	        pool.resetForTests();
	    });

    it('exposes raw socket event subscription on acquired scoped clients', async () => {
        const { socket, trigger } = createFakeSocket();
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        const client: ScopedSocketClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });
        const listener = vi.fn();

        client.on('custom-event', listener);
        trigger('custom-event', { ok: true });
        expect(listener).toHaveBeenCalledWith({ ok: true });

        client.off('custom-event', listener);
        trigger('custom-event', { ok: false });
        expect(listener).toHaveBeenCalledTimes(1);

        client.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('removes and destroys the exact idle entry so token rotation cannot accumulate stale sockets', async () => {
        const first = createFakeSocket();
        const second = createFakeSocket();
        const createdSockets: unknown[] = [];
        const createSocketSpy = vi.fn(() => {
            const next = createdSockets.length === 0 ? first.socket : second.socket;
            createdSockets.push(next);
            return next;
        });

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => createSocketSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const client: ScopedSocketClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });
        expect(first.connectSpy).toHaveBeenCalledTimes(1);

        // Idle teardown must detach the socket AND remove the exact pool entry, so the
        // next acquire for the same Home constructs a fresh entry instead of reusing a
        // torn-down socket (which is how token rotation accumulated stale entries).
        client.disconnect();
        await vi.waitFor(() => {
            expect(first.disconnectSpy).toHaveBeenCalled();
        });

        await pool.acquire({ serverUrl: 'https://server.example.test', token: 'token-a', timeoutMs: 1_000 });
        expect(createSocketSpy).toHaveBeenCalledTimes(2);
        expect(second.connectSpy).toHaveBeenCalledTimes(1);

        // stopAll must clear the exact map: a later acquire starts from a fresh entry.
        await pool.stopAll();
        await pool.acquire({ serverUrl: 'https://server.example.test', token: 'token-a', timeoutMs: 1_000 });
        expect(createSocketSpy).toHaveBeenCalledTimes(3);
        expect(second.connectSpy).toHaveBeenCalledTimes(2);

        pool.resetForTests();
    });

    it('does not reuse a same-key entry while its reachability release is still in flight', async () => {
        const first = createFakeSocket();
        const second = createFakeSocket();
        const createSocketSpy = vi.fn()
            .mockReturnValueOnce(first.socket)
            .mockReturnValueOnce(second.socket);
        let signalReleaseStarted!: () => void;
        const releaseStarted = new Promise<void>((resolve) => {
            signalReleaseStarted = resolve;
        });
        let finishFirstRelease!: () => void;
        const firstReleaseFinished = new Promise<void>((resolve) => {
            finishFirstRelease = resolve;
        });
        const releaseSpy = vi.fn()
            .mockImplementationOnce(async () => {
                signalReleaseStarted();
                await firstReleaseFinished;
            })
            .mockResolvedValue(undefined);
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => createSocketSpy(),
            reachability: {
                acquireReachability: async () => ({ release: releaseSpy }),
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const firstClient = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });
        firstClient.disconnect();
        await releaseStarted;

        let secondAcquireSettled = false;
        const secondAcquire = pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        }).finally(() => {
            secondAcquireSettled = true;
        });
        for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
        }

        expect(secondAcquireSettled).toBe(false);
        expect(first.connectSpy).toHaveBeenCalledTimes(1);
        expect(createSocketSpy).toHaveBeenCalledTimes(1);

        finishFirstRelease();
        const secondClient = await secondAcquire;
        expect(createSocketSpy).toHaveBeenCalledTimes(2);
        expect(second.connectSpy).toHaveBeenCalledTimes(1);

        secondClient.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('retains failed reachability release custody and surfaces stopAll failure', async () => {
        const first = createFakeSocket();
        const second = createFakeSocket();
        const createSocketSpy = vi.fn()
            .mockReturnValueOnce(first.socket)
            .mockReturnValueOnce(second.socket);
        const releaseError = new Error('release failed');
        const releaseSpy = vi.fn()
            .mockRejectedValueOnce(releaseError)
            .mockResolvedValue(undefined);
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => createSocketSpy(),
            reachability: {
                acquireReachability: async () => ({ release: releaseSpy }),
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });

        await expect(pool.stopAll()).rejects.toBe(releaseError);
        expect(releaseSpy).toHaveBeenCalledTimes(1);

        await pool.stopAll();
        expect(releaseSpy).toHaveBeenCalledTimes(2);

        await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });
        expect(createSocketSpy).toHaveBeenCalledTimes(2);

        pool.resetForTests();
    });

    it('holds one carrier custody across concurrent logical clients and releases it once after the socket is gone', async () => {
        const { socket, disconnectSpy } = createFakeSocket();
        const createSocketSpy = vi.fn(() => socket);
        const homeCarrier = createFakeHomeCarrier('endpoint-shared');
        const releaseCarrier = vi.fn(async () => {
            expect(socket.connected).toBe(false);
            expect(socket.active).toBe(false);
        });

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => createSocketSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const params = {
            serverUrl: 'https://home.example.test',
            carrier: 'iroh' as const,
            homeCarrier,
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        };
        const first = await pool.acquire(params);
        const second = await pool.acquire(params);
        expect(createSocketSpy).toHaveBeenCalledTimes(1);

        // A logical client only drops its own use of the pooled socket. The carrier
        // still moves bytes for the other client, so releasing its lease here would
        // pull the transport out from under a live socket.
        first.disconnect();
        await Promise.resolve();
        expect(releaseCarrier).not.toHaveBeenCalled();
        expect(disconnectSpy).not.toHaveBeenCalled();

        second.disconnect();
        await vi.waitFor(() => {
            expect(releaseCarrier).toHaveBeenCalledTimes(1);
        });
        expect(disconnectSpy).toHaveBeenCalled();
        expect(releaseCarrier.mock.invocationCallOrder[0]).toBeGreaterThan(
            disconnectSpy.mock.invocationCallOrder[0] as number,
        );

        await pool.stopAll();
        expect(releaseCarrier).toHaveBeenCalledTimes(1);
        pool.resetForTests();
    });

    it('takes authority carrier custody only when creating a physical entry and never again while that entry is reusable', async () => {
        const { socket } = createFakeSocket();
        const releaseCarrier = vi.fn(async () => {});
        const takeFirstCarrierRelease = vi.fn(() => releaseCarrier);
        const takeSecondCarrierRelease = vi.fn(() => {
            throw new Error('a reusable entry must not take a second carrier release');
        });
        const homeCarrier = createFakeHomeCarrier('endpoint-shared');
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        const first = await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier,
            takeCarrierRelease: takeFirstCarrierRelease,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });
        first.disconnect();
        const second = await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier,
            takeCarrierRelease: takeSecondCarrierRelease,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });

        expect(takeFirstCarrierRelease).toHaveBeenCalledTimes(1);
        expect(takeSecondCarrierRelease).not.toHaveBeenCalled();
        expect(releaseCarrier).not.toHaveBeenCalled();

        second.disconnect();
        await pool.stopAll();
        expect(releaseCarrier).toHaveBeenCalledTimes(1);
        pool.resetForTests();
    });

    it('keeps serving the retained carrier and releases a redundant one acquired for the same endpoint', async () => {
        const { socket } = createFakeSocket();
        const retainedCarrier = createFakeHomeCarrier('endpoint-shared');
        const redundantCarrier = createFakeHomeCarrier('endpoint-shared');
        const releaseRetained = vi.fn(async () => {});
        const releaseRedundant = vi.fn(async () => {});
        const socketCarriers: (HomeCarrier | null)[] = [];

        const pool = createServerScopedRpcSocketPool({
            createSocket: (createParams) => {
                socketCarriers.push(createParams.homeCarrier ?? null);
                return socket;
            },
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        const first = await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: retainedCarrier,
            releaseCarrier: releaseRetained,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });
        const second = await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: redundantCarrier,
            releaseCarrier: releaseRedundant,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });

        // The live socket keeps the carrier it was built on, and the caller's now
        // redundant acquisition is released instead of replacing it.
        expect(socketCarriers).toEqual([retainedCarrier]);
        // Settled by the time the acquire resolves, not left in flight behind it.
        expect(releaseRedundant).toHaveBeenCalledTimes(1);
        expect(releaseRetained).not.toHaveBeenCalled();

        first.disconnect();
        second.disconnect();
        await pool.stopAll();
        expect(releaseRetained).toHaveBeenCalledTimes(1);
        expect(releaseRedundant).toHaveBeenCalledTimes(1);
        pool.resetForTests();
    });

    it('retains failed carrier release custody and never hands out an entry whose carrier was released', async () => {
        const first = createFakeSocket();
        const second = createFakeSocket();
        const createSocketSpy = vi.fn()
            .mockReturnValueOnce(first.socket)
            .mockReturnValueOnce(second.socket);
        const releaseError = new Error('carrier release failed');
        const releasePhysicalCarrier = vi.fn()
            .mockRejectedValueOnce(releaseError)
            .mockResolvedValue(undefined);
        const releaseCarrier = createOwnedHomeCarrierRelease(releasePhysicalCarrier);
        const homeCarrier = createFakeHomeCarrier('endpoint-shared');

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => createSocketSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier,
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });

        await expect(pool.stopAll()).rejects.toBe(releaseError);
        expect(releasePhysicalCarrier).toHaveBeenCalledTimes(1);

        // Lane 06 custody survives the failure, so the pool's explicit drain completes it.
        await pool.stopAll();
        expect(releasePhysicalCarrier).toHaveBeenCalledTimes(2);

        await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier,
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });
        expect(createSocketSpy).toHaveBeenCalledTimes(2);
        expect(second.connectSpy).toHaveBeenCalledTimes(1);
        expect(releasePhysicalCarrier).toHaveBeenCalledTimes(2);

        pool.resetForTests();
    });

    it('holds the entry across a deferred redundant release and keeps its custody when it fails', async () => {
        const { socket, disconnectSpy } = createFakeSocket();
        const retainedCarrier = createFakeHomeCarrier('endpoint-shared');
        const redundantCarrier = createFakeHomeCarrier('endpoint-shared');
        const releaseRetained = vi.fn(async () => {});
        const redundantReleaseError = new Error('redundant release failed');
        let failRedundantRelease!: () => void;
        const redundantReleaseSettled = new Promise<void>((_resolve, reject) => {
            failRedundantRelease = () => reject(redundantReleaseError);
        });
        const releaseRedundantPhysicalCarrier = vi.fn()
            .mockImplementationOnce(() => redundantReleaseSettled)
            .mockResolvedValue(undefined);
        const releaseRedundant = createOwnedHomeCarrierRelease(releaseRedundantPhysicalCarrier);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        const first = await pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: retainedCarrier,
            releaseCarrier: releaseRetained,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });
        const secondAcquire = pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: redundantCarrier,
            releaseCarrier: releaseRedundant,
            token: 'token-carrier',
            timeoutMs: 1_000,
        });
        await vi.waitFor(() => {
            expect(releaseRedundantPhysicalCarrier).toHaveBeenCalledTimes(1);
        });

        // The last settled client leaves while the redundant release is still in
        // flight. The pending acquisition already reserved the entry, so idle
        // teardown must not pull the socket or its carrier out from under it.
        first.disconnect();
        for (let index = 0; index < 6; index += 1) {
            await Promise.resolve();
        }
        expect(disconnectSpy).not.toHaveBeenCalled();
        expect(releaseRetained).not.toHaveBeenCalled();

        failRedundantRelease();
        const second = await secondAcquire;
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[scoped-rpc] redundant carrier release failed',
            redundantReleaseError,
        );
        expect(releaseRedundantPhysicalCarrier).toHaveBeenCalledTimes(1);

        second.disconnect();
        await vi.waitFor(() => {
            expect(socket.connected).toBe(false);
            expect(releaseRetained).toHaveBeenCalledTimes(1);
        });

        // Custody is Lane 06's, not the removed entry's, so the failure is retried.
        await pool.stopAll();
        expect(releaseRedundantPhysicalCarrier).toHaveBeenCalledTimes(2);
        expect(releaseRetained).toHaveBeenCalledTimes(1);
        consoleErrorSpy.mockRestore();
        pool.resetForTests();
    });

    it('releases carrier custody when socket creation fails before an entry can retain it', async () => {
        const releaseCarrier = vi.fn(async () => {});
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => {
                throw new Error('socket construction failed');
            },
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        await expect(pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: createFakeHomeCarrier('endpoint-shared'),
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        })).rejects.toThrow('socket construction failed');

        expect(releaseCarrier).toHaveBeenCalledTimes(1);
        pool.resetForTests();
    });

    it('reports the acquire failure and keeps custody when its carrier cleanup also fails', async () => {
        const cleanupError = new Error('carrier release failed');
        const releasePhysicalCarrier = vi.fn()
            .mockRejectedValueOnce(cleanupError)
            .mockResolvedValue(undefined);
        const releaseCarrier = createOwnedHomeCarrierRelease(releasePhysicalCarrier);
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => {
                throw new Error('socket construction failed');
            },
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        // The caller still sees why its acquire failed, not why cleanup failed...
        await expect(pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: createFakeHomeCarrier('endpoint-shared'),
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        })).rejects.toThrow('socket construction failed');
        expect(releasePhysicalCarrier).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[scoped-rpc] carrier release failed after acquire failure',
            cleanupError,
        );

        // ...and the lease is not lost: the Lane 06 owner retains it for a retry.
        await pool.stopAll();
        expect(releasePhysicalCarrier).toHaveBeenCalledTimes(2);
        consoleErrorSpy.mockRestore();
        pool.resetForTests();
    });

    it('releases retained carrier custody when the connect attempt fails', async () => {
        const { socket } = createFakeSocket({ connectError: new Error('connect refused') });
        const releaseCarrier = vi.fn(async () => {});
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });

        await expect(pool.acquire({
            serverUrl: 'https://home.example.test',
            carrier: 'iroh',
            homeCarrier: createFakeHomeCarrier('endpoint-shared'),
            releaseCarrier,
            token: 'token-carrier',
            timeoutMs: 1_000,
        })).rejects.toThrow('connect refused');

        await vi.waitFor(() => {
            expect(releaseCarrier).toHaveBeenCalledTimes(1);
        });
        pool.resetForTests();
    });
});
