import { afterEach, describe, expect, it, vi } from 'vitest';

type ManagedConnectionState = Readonly<{
    phase: 'idle' | 'connecting' | 'online' | 'offline' | 'auth_failed' | 'shutting_down';
    reason: string | null;
    attempt: number;
    nextRetryAt: number | null;
    lastConnectedAt: number | null;
    lastDisconnectedAt: number | null;
    lastErrorMessage: string | null;
}>;

type TransportDisconnectEvent = Readonly<{
    intentional: boolean;
    reason?: string | null;
    error?: unknown;
}>;

type ManagedConnectionTransport = Readonly<{
    connect: () => Promise<void>;
    disconnect: (params?: { intentional?: boolean }) => Promise<void>;
    destroy: () => Promise<void>;
    isConnected: () => boolean;
    onConnected: (listener: () => void) => () => void;
    onDisconnected: (listener: (event: TransportDisconnectEvent) => void) => () => void;
    onError: (listener: (error: unknown) => void) => () => void;
}>;

const reachability = vi.hoisted(() => ({
    subscribeSpy: vi.fn(),
    startSpy: vi.fn(async (..._args: unknown[]) => {}),
    reportSpy: vi.fn((..._args: unknown[]) => {}),
    listenersByServerUrl: new Map<string, (state: ManagedConnectionState) => void>(),
}));

const transportFactory = vi.hoisted(() => ({
    createSyncSocketTransportSpy: vi.fn(),
    lastController: null as null | {
        transport: ManagedConnectionTransport;
        triggerConnected: () => void;
        triggerDisconnected: (event: TransportDisconnectEvent) => void;
        triggerError: (error: unknown) => void;
    },
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        subscribeServerReachabilityState: (serverUrl: string, listener: (state: ManagedConnectionState) => void) => {
            reachability.subscribeSpy(serverUrl, listener);
            reachability.listenersByServerUrl.set(serverUrl, listener);
            listener({
                phase: 'idle',
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            });
            return () => {
                reachability.listenersByServerUrl.delete(serverUrl);
            };
        },
        startServerReachabilitySupervisor: (...args: unknown[]) => reachability.startSpy(...args),
        reportServerUnreachable: (...args: unknown[]) => reachability.reportSpy(...args),
    };
});

vi.mock('@/sync/api/session/connection/createSyncSocketTransport', () => ({
    createSyncSocketTransport: (...args: unknown[]) => transportFactory.createSyncSocketTransportSpy(...args),
}));

async function settleAsyncWork() {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

async function advanceUntil(predicate: () => boolean, maxSteps = 25) {
    for (let step = 0; step < maxSteps; step += 1) {
        await settleAsyncWork();
        if (predicate()) return;
        if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
            try {
                await vi.advanceTimersToNextTimerAsync();
            } catch {
                // No more timers to advance.
                return;
            }
        }
    }
}

function createTransportController(): {
    transport: ManagedConnectionTransport;
    triggerConnected: () => void;
    triggerDisconnected: (event: TransportDisconnectEvent) => void;
    triggerError: (error: unknown) => void;
} {
    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    let connected = false;

    const controller = {
        transport: {
            async connect() {
                connected = true;
                connectedListeners.forEach((listener) => listener());
            },
            async disconnect(params?: { intentional?: boolean }) {
                const wasConnected = connected;
                connected = false;
                if (!wasConnected) return;
                disconnectedListeners.forEach((listener) =>
                    listener({
                        intentional: params?.intentional === true,
                        reason: params?.intentional === true ? 'manual' : 'disconnect',
                    }),
                );
            },
            async destroy() {
                connected = false;
                connectedListeners.clear();
                disconnectedListeners.clear();
                errorListeners.clear();
            },
            isConnected() {
                return connected;
            },
            onConnected(listener: () => void) {
                connectedListeners.add(listener);
                return () => connectedListeners.delete(listener);
            },
            onDisconnected(listener: (event: TransportDisconnectEvent) => void) {
                disconnectedListeners.add(listener);
                return () => disconnectedListeners.delete(listener);
            },
            onError(listener: (error: unknown) => void) {
                errorListeners.add(listener);
                return () => errorListeners.delete(listener);
            },
        },
        triggerConnected() {
            connected = true;
            connectedListeners.forEach((listener) => listener());
        },
        triggerDisconnected(event: TransportDisconnectEvent) {
            connected = false;
            disconnectedListeners.forEach((listener) => listener(event));
        },
        triggerError(error: unknown) {
            errorListeners.forEach((listener) => listener(error));
        },
    };

    return controller;
}

function emitReachability(serverUrl: string, state: ManagedConnectionState): void {
    const listener = reachability.listenersByServerUrl.get(serverUrl);
    if (!listener) {
        throw new Error(`Missing reachability listener for ${serverUrl}`);
    }
    listener(state);
}

describe('apiSocket reconnect semantics', () => {
    afterEach(() => {
        reachability.subscribeSpy.mockReset();
        reachability.startSpy.mockReset();
        reachability.reportSpy.mockReset();
        reachability.listenersByServerUrl.clear();
        transportFactory.createSyncSocketTransportSpy.mockReset();
        transportFactory.lastController = null;
        vi.resetModules();
        vi.useRealTimers();
    });

    it('fires onReconnected only after a transport outage cycle', async () => {
        const controller = createTransportController();
        transportFactory.lastController = controller;
        transportFactory.createSyncSocketTransportSpy.mockImplementation((params: any) => ({
            socket: { onAny: vi.fn() },
            transport: controller.transport,
            ...params,
        }));

        const { apiSocket } = await import('./apiSocket');
        const onReconnected = vi.fn();
        apiSocket.onReconnected(onReconnected);

        const endpoint = 'https://server.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, { getSessionEncryption: vi.fn(), getMachineEncryption: vi.fn() } as never);

        await settleAsyncWork();
        expect(onReconnected).not.toHaveBeenCalled();

        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        await settleAsyncWork();

        controller.triggerDisconnected({ intentional: false, reason: 'transport close', error: new Error('transport close') });
        await settleAsyncWork();

        emitReachability(endpoint, {
            phase: 'offline',
            reason: 'network_error',
            attempt: 2,
            nextRetryAt: Date.now() + 1000,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'offline',
        });
        await settleAsyncWork();

        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 3,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: null,
        });
        await settleAsyncWork();

        expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    it('does not fire onReconnected after an intentional disconnect cycle', async () => {
        const controller = createTransportController();
        transportFactory.lastController = controller;
        transportFactory.createSyncSocketTransportSpy.mockImplementation((params: any) => ({
            socket: { onAny: vi.fn() },
            transport: controller.transport,
            ...params,
        }));

        const { apiSocket } = await import('./apiSocket');
        const onReconnected = vi.fn();
        apiSocket.onReconnected(onReconnected);

        const endpoint = 'https://server.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, { getSessionEncryption: vi.fn(), getMachineEncryption: vi.fn() } as never);

        await settleAsyncWork();

        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        await settleAsyncWork();

        apiSocket.disconnect();
        await settleAsyncWork();

        apiSocket.connect();
        await settleAsyncWork();

        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: null,
        });
        await settleAsyncWork();

        expect(onReconnected).not.toHaveBeenCalled();
    });

    it('recreates the managed transport with the latest token after updateToken', async () => {
        const createControllers: Array<ReturnType<typeof createTransportController>> = [];
        transportFactory.createSyncSocketTransportSpy.mockImplementation((params: any) => {
            const controller = createTransportController();
            createControllers.push(controller);
            transportFactory.lastController = controller;
            return { socket: { onAny: vi.fn() }, transport: controller.transport, ...params };
        });

        const { apiSocket } = await import('./apiSocket');
        const endpoint = 'https://server.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, { getSessionEncryption: vi.fn(), getMachineEncryption: vi.fn() } as never);

        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        await advanceUntil(() => transportFactory.createSyncSocketTransportSpy.mock.calls.length >= 1);
        apiSocket.updateToken('token-2');
        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: null,
        });
        await advanceUntil(() => transportFactory.createSyncSocketTransportSpy.mock.calls.length >= 2);

        expect(transportFactory.createSyncSocketTransportSpy).toHaveBeenCalledTimes(2);
        const secondParams = transportFactory.createSyncSocketTransportSpy.mock.calls[1]?.[0] as { token?: string } | undefined;
        expect(secondParams?.token).toBe('token-2');
    });

    it('publishes richer managed connection state changes alongside legacy status listeners', async () => {
        const controller = createTransportController();
        transportFactory.lastController = controller;
        transportFactory.createSyncSocketTransportSpy.mockImplementation((params: any) => ({
            socket: { onAny: vi.fn() },
            transport: controller.transport,
            ...params,
        }));

        const { apiSocket } = await import('./apiSocket');
        const stateListener = vi.fn();
        apiSocket.onConnectionStateChange(stateListener);

        const endpoint = 'https://server.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, { getSessionEncryption: vi.fn(), getMachineEncryption: vi.fn() } as never);

        emitReachability(endpoint, {
            phase: 'connecting',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        await advanceUntil(() => stateListener.mock.calls.some((call) => call[0]?.phase === 'online'));
        expect(stateListener).toHaveBeenCalled();
        const phases = stateListener.mock.calls.map((call) => call[0]?.phase);
        expect(phases).toContain('idle');
        expect(phases).toContain('connecting');
        expect(phases).toContain('online');
    });

    it('keeps connected status when connect is called while already online', async () => {
        const controller = createTransportController();
        transportFactory.lastController = controller;
        transportFactory.createSyncSocketTransportSpy.mockImplementation((params: any) => ({
            socket: { onAny: vi.fn() },
            transport: controller.transport,
            ...params,
        }));

        const { apiSocket } = await import('./apiSocket');
        const statusListener = vi.fn();
        apiSocket.onStatusChange(statusListener);

        const endpoint = 'https://server.example.test';
        apiSocket.initialize({ endpoint, token: 'token-1' }, { getSessionEncryption: vi.fn(), getMachineEncryption: vi.fn() } as never);

        await settleAsyncWork();
        emitReachability(endpoint, {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        await settleAsyncWork();
        statusListener.mockClear();

        apiSocket.connect();
        await settleAsyncWork();

        expect(statusListener).not.toHaveBeenCalledWith('connecting');
    });
});
