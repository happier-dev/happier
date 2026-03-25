import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScopedSocketClient } from './serverScopedRpcTypes';
import { createServerScopedRpcSocketPool } from './serverScopedRpcSocketPool';

type Listener = (...args: any[]) => void;

function createFakeSocket(): Readonly<{
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

        const networkAllowedListeners = new Set<(allowed: boolean) => void>();
	        const pool = createServerScopedRpcSocketPool({
	            createSocket: () => ioSpy(),
	            reachability: {
	                waitForReachable: async () => {},
	                startReachability: async () => {},
	                reportUnreachable: () => {},
	                subscribeNetworkAllowed: (listener: (allowed: boolean) => void) => {
	                    networkAllowedListeners.add(listener);
	                    return () => {
	                        networkAllowedListeners.delete(listener);
	                    };
	                },
	            },
	            readIdleDisconnectMs: () => 5_000,
	        });

        const c1: ScopedSocketClient = await pool.acquire({ serverUrl: 'https://server.example.test', token: 't', timeoutMs: 1000 });
        c1.disconnect();

        expect(disconnectSpy).toHaveBeenCalledTimes(0);
        const listener = networkAllowedListeners.values().next().value as ((allowed: boolean) => void) | undefined;
        if (!listener) throw new Error('Expected reachability.subscribeNetworkAllowed to capture a listener');
	        listener(false);
	        await vi.waitFor(() => {
	            expect(disconnectSpy).toHaveBeenCalledTimes(1);
	        });

	        await pool.stopAll();
	        pool.resetForTests();
	    });
});
