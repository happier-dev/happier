import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Encryption } from '@/sync/encryption/encryption';

type SocketEventHandler = (...args: any[]) => void;

function createSocketStub() {
    const listeners = new Map<string, Set<SocketEventHandler>>();
    const socket = {
        connected: false,
        on: vi.fn((event: string, handler: SocketEventHandler) => {
            const bucket = listeners.get(event) ?? new Set<SocketEventHandler>();
            bucket.add(handler);
            listeners.set(event, bucket);
            return socket;
        }),
        onAny: vi.fn((_handler: SocketEventHandler) => socket),
        connect: vi.fn(() => {
            // Do not auto-fire 'connect' — tests control readiness separately.
        }),
        disconnect: vi.fn(() => {
            socket.connected = false;
            for (const handler of listeners.get('disconnect') ?? []) {
                handler('io client disconnect');
            }
        }),
        emit: vi.fn(),
        removeAllListeners: vi.fn(() => {
            listeners.clear();
        }),
    };
    return socket;
}

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unmock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    vi.resetModules();
    vi.clearAllMocks();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
});

describe('apiSocket reachability supervision', () => {
    it('re-subscribes to reachability when initialized with a new endpoint', async () => {
        const unsubscribeSpy = vi.fn();
        const subscribeSpy = vi.fn((_serverUrl: string, listener: (state: any) => void) => {
            listener({
                phase: 'offline',
                reason: 'initial_connect',
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: Date.now(),
                lastErrorMessage: null,
            });
            return unsubscribeSpy;
        });

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: subscribeSpy,
                startServerReachabilitySupervisor: vi.fn(async () => {}),
            };
        });

        vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => ({
            createSyncSocketTransport: () => {
                throw new Error('createSyncSocketTransport should not be called in this test');
            },
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;

        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        expect(subscribeSpy).toHaveBeenCalledTimes(1);

        apiSocket.initialize({ endpoint: 'https://api2.example.test', token: 'token-a' }, encryption);

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(subscribeSpy).toHaveBeenCalledTimes(2);
    });

    it('restarts reachability supervision when the token changes before the socket is created', async () => {
        const startSpy = vi.fn(async () => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'offline',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: null,
                        lastDisconnectedAt: Date.now(),
                        lastErrorMessage: null,
                    });
                    return () => {};
                },
                startServerReachabilitySupervisor: startSpy,
            };
        });

        vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => ({
            createSyncSocketTransport: () => {
                throw new Error('createSyncSocketTransport should not be called in this test');
            },
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        expect(startSpy).toHaveBeenCalledTimes(1);

        apiSocket.updateToken('token-b');
        expect(startSpy).toHaveBeenCalledTimes(2);
    });

    it('fires onReconnected after reachability outage cycles', async () => {
        const reachability = {
            listener: (_state: any): void => {},
        };
        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    reachability.listener = listener;
                    return () => {};
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
            };
        });

        const fakeSocket = createSocketStub();
        vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => {
            const connectedListeners = new Set<() => void>();
            const disconnectedListeners = new Set<(event: any) => void>();
            let connected = false;
            const transport = {
                async connect() {
                    connected = true;
                    connectedListeners.forEach((listener) => listener());
                },
                async disconnect(params?: { intentional?: boolean }) {
                    connected = false;
                    disconnectedListeners.forEach((listener) => listener({
                        intentional: params?.intentional === true,
                        reason: params?.intentional === true ? 'manual' : 'disconnect',
                    }));
                },
                async destroy() {},
                isConnected() {
                    return connected;
                },
                onConnected(listener: () => void) {
                    connectedListeners.add(listener);
                    return () => connectedListeners.delete(listener);
                },
                onDisconnected(listener: (event: any) => void) {
                    disconnectedListeners.add(listener);
                    return () => disconnectedListeners.delete(listener);
                },
                onError(_listener: (error: unknown) => void) {
                    return () => {};
                },
            };
            return {
                createSyncSocketTransport: () => ({ socket: fakeSocket, transport }),
            };
        });

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        const reconnectedSpy = vi.fn();
        apiSocket.onReconnected(reconnectedSpy);

        reachability.listener({
            phase: 'online',
            reason: 'initial_connect',
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });

        reachability.listener({
            phase: 'offline',
            reason: 'disconnect',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: null,
        });

        reachability.listener({
            phase: 'online',
            reason: 'reconnect',
            attempt: 2,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });

        expect(reconnectedSpy).toHaveBeenCalledTimes(1);
    });

    it('delays socket.connect() until reachability is online', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);

        const fakeSocket = createSocketStub();
        const ioSpy = vi.fn((..._args: any[]) => fakeSocket);
        vi.doMock('socket.io-client', () => ({
            io: (uri?: unknown, opts?: unknown) => ioSpy(uri, opts),
        }));

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        expect(fakeSocket.connect).not.toHaveBeenCalled();
    });

    it('does not report server unreachable during intentional disconnect teardown', async () => {
        const fakeSocket = createSocketStub();

        const reportServerUnreachableSpy = vi.fn<(...args: any[]) => void>();
        const startServerReachabilitySupervisorSpy = vi.fn<(...args: any[]) => Promise<void>>(async () => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'online',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    });
                    return () => {};
                },
                startServerReachabilitySupervisor: startServerReachabilitySupervisorSpy,
                reportServerUnreachable: reportServerUnreachableSpy,
            };
        });

        vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => {
            const connectedListeners = new Set<() => void>();
            const disconnectedListeners = new Set<(event: any) => void>();
            const errorListeners = new Set<(error: unknown) => void>();
            let connected = false;

            const transport = {
                async connect() {
                    connected = true;
                    connectedListeners.forEach((listener) => listener());
                },
                async disconnect(params?: { intentional?: boolean }) {
                    connected = false;
                    disconnectedListeners.forEach((listener) => listener({
                        intentional: params?.intentional === true,
                        reason: params?.intentional === true ? 'manual' : 'disconnect',
                    }));
                },
                async destroy() {
                    // Simulate a buggy transport that emits a non-intentional disconnect during teardown.
                    disconnectedListeners.forEach((listener) => listener({ intentional: false, reason: 'destroy' }));
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
                onDisconnected(listener: (event: any) => void) {
                    disconnectedListeners.add(listener);
                    return () => disconnectedListeners.delete(listener);
                },
                onError(listener: (error: unknown) => void) {
                    errorListeners.add(listener);
                    return () => errorListeners.delete(listener);
                },
            };

            return {
                createSyncSocketTransport: () => ({ socket: fakeSocket, transport }),
            };
        });

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        apiSocket.disconnect();

        expect(startServerReachabilitySupervisorSpy).toHaveBeenCalled();
        expect(reportServerUnreachableSpy).not.toHaveBeenCalled();
    });

    it('gates apiSocket.request when server reachability cannot be established', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS = '5';

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
                getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
                invalidateCredentialsToken: vi.fn(async () => false),
            },
        }));

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            if (url.endsWith('/v1/account/profile')) {
                return new Response(null, { status: 200, headers: new Headers() });
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);

        await expect(apiSocket.request('/v1/account/profile', { method: 'GET' })).rejects.toMatchObject({
            name: 'ServerFetchConnectivityTimeoutError',
        });

        expect(runtimeFetchMock.mock.calls.some(([input]) => String(input).includes('/v1/account/profile'))).toBe(false);
    });

    it('stops reachability supervision when disconnecting', async () => {
        const unsubscribeSpy = vi.fn();
        const stopSpy = vi.fn(async (_serverUrl: string) => {});

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    listener({
                        phase: 'offline',
                        reason: 'initial_connect',
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: null,
                        lastDisconnectedAt: Date.now(),
                        lastErrorMessage: null,
                    });
                    return unsubscribeSpy;
                },
                startServerReachabilitySupervisor: vi.fn(async () => {}),
                stopServerReachabilitySupervisor: stopSpy,
            };
        });

        vi.doMock('@/sync/api/session/connection/createSyncSocketTransport', () => ({
            createSyncSocketTransport: () => {
                throw new Error('createSyncSocketTransport should not be called in this test');
            },
        }));

        const { apiSocket } = await import('./apiSocket');
        const encryption = { getSessionEncryption: () => null } as unknown as Encryption;

        apiSocket.initialize({ endpoint: 'https://api.example.test', token: 'token-a' }, encryption);
        apiSocket.disconnect();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy.mock.calls[0]?.[0]).toBe('https://api.example.test');
    });
});
