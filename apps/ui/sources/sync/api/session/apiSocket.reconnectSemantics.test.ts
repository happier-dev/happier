import { afterEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.hoisted(() => vi.fn());
const runtimeFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
    io: (...args: unknown[]) => ioSpy(...args),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

type EventHandler = (...args: unknown[]) => void;

type SocketStub = {
    connected: boolean;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    simulateTransportDisconnect: (reason?: string) => void;
    removeAllListeners: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    onAny: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitWithAck: ReturnType<typeof vi.fn>;
    timeout: ReturnType<typeof vi.fn>;
};

function createSocketStub(): SocketStub {
    const listeners = new Map<string, Set<EventHandler>>();
    const anyListeners = new Set<(event: string, data: unknown) => void>();

    const emitEvent = (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) {
            listener(...args);
        }
        if (args.length > 0) {
            for (const listener of anyListeners) {
                listener(event, args[0]);
            }
        }
    };

    const socket: SocketStub = {
        connected: false,
        connect: vi.fn(() => {
            socket.connected = true;
            emitEvent('connect');
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (wasConnected) {
                emitEvent('disconnect', 'io client disconnect');
            }
        }),
        simulateTransportDisconnect: (reason = 'transport close') => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (wasConnected) {
                emitEvent('disconnect', reason);
            }
        },
        removeAllListeners: vi.fn(() => {
            listeners.clear();
            anyListeners.clear();
        }),
        on: vi.fn((event: string, handler: EventHandler) => {
            const bucket = listeners.get(event) ?? new Set<EventHandler>();
            bucket.add(handler);
            listeners.set(event, bucket);
            return socket;
        }),
        off: vi.fn((event: string, handler?: EventHandler) => {
            if (!handler) {
                listeners.delete(event);
                return socket;
            }
            listeners.get(event)?.delete(handler);
            return socket;
        }),
        onAny: vi.fn((handler: (event: string, data: unknown) => void) => {
            anyListeners.add(handler);
            return socket;
        }),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        timeout: vi.fn(() => socket),
    };

    return socket;
}

describe('apiSocket reconnect semantics', () => {
    afterEach(() => {
        ioSpy.mockReset();
        runtimeFetchSpy.mockReset();
        vi.resetModules();
        vi.useRealTimers();
    });

    it('fires onReconnected only after a transport outage cycle', async () => {
        vi.useFakeTimers();
        const socket = createSocketStub();
        ioSpy.mockImplementation(() => socket);
        runtimeFetchSpy.mockResolvedValue({ status: 200, headers: new Headers() });

        const { apiSocket } = await import('./apiSocket');
        const onReconnected = vi.fn();
        apiSocket.onReconnected(onReconnected);

        apiSocket.initialize(
            { endpoint: 'https://server.example.test', token: 'token-1' },
            {
                getSessionEncryption: vi.fn(),
                getMachineEncryption: vi.fn(),
            } as never,
        );

        await Promise.resolve();
        expect(onReconnected).not.toHaveBeenCalled();

        socket.simulateTransportDisconnect();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(250);

        expect(onReconnected).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('does not fire onReconnected after an intentional disconnect cycle', async () => {
        ioSpy.mockImplementation(() => createSocketStub());
        runtimeFetchSpy.mockResolvedValue({ status: 200, headers: new Headers() });

        const { apiSocket } = await import('./apiSocket');
        const onReconnected = vi.fn();
        apiSocket.onReconnected(onReconnected);

        apiSocket.initialize(
            { endpoint: 'https://server.example.test', token: 'token-1' },
            {
                getSessionEncryption: vi.fn(),
                getMachineEncryption: vi.fn(),
            } as never,
        );

        await Promise.resolve();

        apiSocket.disconnect();
        await Promise.resolve();

        apiSocket.connect();
        await Promise.resolve();

        expect(onReconnected).not.toHaveBeenCalled();
    });

    it('recreates the managed transport with the latest token after updateToken', async () => {
        ioSpy.mockImplementation(() => createSocketStub());
        runtimeFetchSpy.mockResolvedValue({ status: 200, headers: new Headers() });

        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize(
            { endpoint: 'https://server.example.test', token: 'token-1' },
            {
                getSessionEncryption: vi.fn(),
                getMachineEncryption: vi.fn(),
            } as never,
        );

        await Promise.resolve();
        apiSocket.updateToken('token-2');
        await Promise.resolve();

        expect(ioSpy).toHaveBeenCalledTimes(2);
        const secondOpts = ioSpy.mock.calls[1]?.[1] as { auth?: { token?: string } } | undefined;
        expect(secondOpts?.auth?.token).toBe('token-2');
    });

    it('publishes richer managed connection state changes alongside legacy status listeners', async () => {
        ioSpy.mockImplementation(() => createSocketStub());
        runtimeFetchSpy.mockResolvedValue({ status: 200, headers: new Headers() });

        const { apiSocket } = await import('./apiSocket');
        const stateListener = vi.fn();
        apiSocket.onConnectionStateChange(stateListener);

        apiSocket.initialize(
            { endpoint: 'https://server.example.test', token: 'token-1' },
            {
                getSessionEncryption: vi.fn(),
                getMachineEncryption: vi.fn(),
            } as never,
        );

        await Promise.resolve();
        expect(stateListener).toHaveBeenCalled();
        const phases = stateListener.mock.calls.map((call) => call[0]?.phase);
        expect(phases).toContain('idle');
        expect(phases).toContain('connecting');
        expect(phases).toContain('online');
    });

    it('keeps connected status when connect is called while already online', async () => {
        ioSpy.mockImplementation(() => createSocketStub());
        runtimeFetchSpy.mockResolvedValue({ status: 200, headers: new Headers() });

        const { apiSocket } = await import('./apiSocket');
        const statusListener = vi.fn();
        apiSocket.onStatusChange(statusListener);

        apiSocket.initialize(
            { endpoint: 'https://server.example.test', token: 'token-1' },
            {
                getSessionEncryption: vi.fn(),
                getMachineEncryption: vi.fn(),
            } as never,
        );

        await Promise.resolve();
        statusListener.mockClear();

        apiSocket.connect();
        await Promise.resolve();

        expect(statusListener).not.toHaveBeenCalledWith('connecting');
    });
});
