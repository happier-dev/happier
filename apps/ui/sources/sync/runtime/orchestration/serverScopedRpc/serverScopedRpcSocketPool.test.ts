import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScopedSocketClient } from './serverScopedRpcTypes';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

type Listener = (...args: any[]) => void;

function createFakeSocket(options: Readonly<{ disconnectEventDelayMs?: number }> = {}): Readonly<{
    socket: any;
    connectSpy: ReturnType<typeof vi.fn>;
    disconnectSpy: ReturnType<typeof vi.fn>;
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
        if (typeof options.disconnectEventDelayMs === 'number') {
            setTimeout(() => emit('disconnect', 'io client disconnect'), Math.max(0, options.disconnectEventDelayMs));
            return;
        }
        emit('disconnect', 'io client disconnect');
    });

    const socket: any = {
        connected: false,
        on,
        off,
        connect: connectSpy,
        disconnect: disconnectSpy,
        timeout: (_ms: number) => ({
            emitWithAck: async () => ({ ok: true }),
        }),
        emit: vi.fn(),
    };

    return { socket, connectSpy, disconnectSpy };
}

describe('serverScopedRpcSocketPool', () => {
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
                reportUnreachable: () => {},
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

        expect(ioSpy).toHaveBeenCalledWith(
            'https://server.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                withCredentials: false,
            }),
        );

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
	                reportUnreachable: () => {},
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
	                reportUnreachable: () => {},
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

    it('does not report unreachable when an intentional disconnect emits asynchronously', async () => {
        vi.useFakeTimers();
        const ioSpy = vi.fn();
        const { socket } = createFakeSocket({ disconnectEventDelayMs: 0 });
        ioSpy.mockReturnValue(socket);
        const reportUnreachableSpy = vi.fn();

        const pool = createServerScopedRpcSocketPool({
            createSocket: () => ioSpy(),
            reachability: {
                waitForReachable: async () => {},
                startReachability: async () => {},
                reportUnreachable: reportUnreachableSpy,
                subscribeNetworkAllowed: () => () => {},
            },
            readIdleDisconnectMs: () => 5_000,
        });

        const c1: ScopedSocketClient = await pool.acquire({ serverUrl: 'https://server.example.test', token: 't', timeoutMs: 1000 });
        c1.disconnect();

        await pool.stopAll();
        await vi.runAllTimersAsync();
        expect(reportUnreachableSpy).not.toHaveBeenCalled();

        pool.resetForTests();
    });
});
