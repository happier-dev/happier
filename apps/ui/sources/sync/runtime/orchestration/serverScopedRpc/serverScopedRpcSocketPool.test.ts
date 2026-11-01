import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import type { ScopedSocketClient } from './serverScopedRpcTypes';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

type Listener = (...args: any[]) => void;

function createFakeSocket(): Readonly<{
    socket: any;
    connectSpy: ReturnType<typeof vi.fn>;
    disconnectSpy: ReturnType<typeof vi.fn>;
    emitWithAckSpy: ReturnType<typeof vi.fn>;
    emitEvent: (event: string, ...args: any[]) => void;
}> {
    const listeners = new Map<string, Set<Listener>>();

    const on = (event: string, cb: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(cb);
        listeners.set(event, set);
    };

    const off = (event: string, cb: Listener) => {
        const set = listeners.get(event);
        set?.delete(cb);
    };

    const emit = (event: string, ...args: any[]) => {
        const set = listeners.get(event);
        if (!set) return;
        for (const cb of Array.from(set)) {
            cb(...args);
        }
    };

    const connectSpy = vi.fn(() => {
        socket.connected = true;
        emit('connect');
    });

    const disconnectSpy = vi.fn(() => {
        socket.connected = false;
        emit('disconnect', 'io client disconnect');
    });

    const emitWithAckSpy = vi.fn(async () => ({ ok: true }));
    const socket: any = {
        connected: false,
        on,
        off,
        connect: connectSpy,
        disconnect: disconnectSpy,
        timeout: (_ms: number) => ({
            emitWithAck: emitWithAckSpy,
        }),
        emitWithAck: emitWithAckSpy,
        emit: vi.fn(),
    };

    return { socket, connectSpy, disconnectSpy, emitWithAckSpy, emitEvent: emit };
}

describe('serverScopedRpcSocketPool', () => {
    it.each(['connect_error', 'error', 'disconnect'])('keeps healthy HTTP admissible after scoped socket %s', async (event) => {
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { peekServerReachabilityState, resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { runtimeFetchWithServerReachability } = await import('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
        const { socket, connectSpy, emitEvent } = createFakeSocket();
        const target = { serverUrl: `https://scoped-${event}.example.test`, token: 'accepted-token' };
        const failure = new Error('Scoped socket refused');
        if (event === 'connect_error') connectSpy.mockImplementation(() => emitEvent(event, failure));
        setRuntimeFetch(async () => new Response('{}', { status: 200 }));
        const pool = createServerScopedRpcSocketPool({ createSocket: () => socket, readIdleDisconnectMs: () => 0 });
        let client: ScopedSocketClient | undefined;
        try {
            if (event === 'connect_error') await expect(pool.acquire({ ...target, timeoutMs: 1000 })).rejects.toBe(failure);
            else {
                client = await pool.acquire({ ...target, timeoutMs: 1000 });
                emitEvent(event, event === 'disconnect' ? 'transport close' : failure);
            }
            // Let asynchronous failure reporting settle before observing the real HTTP owner.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(peekServerReachabilityState(target.serverUrl)?.phase).toBe('online');
            expect((await runtimeFetchWithServerReachability({ ...target, url: `${target.serverUrl}/ordinary`, init: { method: 'POST' } })).status).toBe(200);
        } finally {
            client?.disconnect(); await pool.stopAll(); pool.resetForTests();
            await resetServerReachabilitySupervisors(); resetRuntimeFetch();
        }
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('exposes direct acknowledgement emission without adding a Socket.IO timeout', async () => {
        const { socket, emitWithAckSpy } = createFakeSocket();
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 0,
        });
        const client = await pool.acquire({
            serverUrl: 'https://server.example.test',
            token: 'token-a',
            timeoutMs: 1_000,
        });

        await expect(client.emitWithAck('rpc-call', { value: 1 })).resolves.toEqual({ ok: true });
        expect(emitWithAckSpy).toHaveBeenCalledWith('rpc-call', { value: 1 });

        client.disconnect();
        await pool.stopAll();
        pool.resetForTests();
    });

    it.each([undefined, 'background-task'] as const)('uses the canonical authenticated Socket.IO updates path in %s mode', async (networkMode) => {
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
            networkMode,
        });
        client.disconnect();

        expect(ioSpy).toHaveBeenCalledWith(
            'https://server.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: expect.objectContaining({ token: 'token-a', connectedServiceIds: ConnectedServiceIdSchema.options }),
                withCredentials: false,
            }),
        );

        await pool.stopAll();
        pool.resetForTests();
    });

    it('disconnects a background connection that times out without starting foreground reachability', async () => {
        vi.useFakeTimers();
        const { socket, connectSpy, disconnectSpy } = createFakeSocket();
        connectSpy.mockImplementation(() => {});
        const waitForReachable = vi.fn(async () => {});
        const startReachability = vi.fn(async () => {});
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => socket,
            reachability: {
                waitForReachable,
                startReachability,
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5000,
        });
        const connection = pool.acquire({
            serverUrl: 'https://server.example.test', token: 'token-a', timeoutMs: 1000,
            networkMode: 'background-task',
        });
        const assertion = expect(connection).rejects.toThrow('Scoped RPC socket connection timeout');
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        expect(disconnectSpy).toHaveBeenCalledTimes(1);
        expect(waitForReachable).not.toHaveBeenCalled();
        expect(startReachability).not.toHaveBeenCalled();
        await pool.stopAll();
        pool.resetForTests();
    });

    it('immediately disposes a socket created while its background lifetime is being aborted', async () => {
        const controller = new AbortController();
        const { socket, connectSpy, disconnectSpy } = createFakeSocket();
        const pool = createServerScopedRpcSocketPool({
            createSocket: () => { controller.abort(); return socket; },
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                subscribeNetworkAllowed: () => () => {},
            },
        });
        await expect(pool.acquire({
            serverUrl: 'https://server.example.test', token: 'token-a', timeoutMs: 1000,
            networkMode: 'background-task', signal: controller.signal,
        })).rejects.toThrow('Scoped RPC socket connection aborted');
        expect(connectSpy).not.toHaveBeenCalled();
        expect(disconnectSpy).toHaveBeenCalledTimes(1);
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
        expect(disconnectSpy).toHaveBeenCalledTimes(1);

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
	            expect(disconnectSpy).toHaveBeenCalledTimes(1);
	        });

	        await pool.stopAll();
	        pool.resetForTests();
	    });

});
