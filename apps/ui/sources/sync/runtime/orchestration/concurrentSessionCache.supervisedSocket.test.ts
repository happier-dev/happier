import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();
const fetchAndApplySessionsSpy = vi.hoisted(() => vi.fn(async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
    applySessions([]);
}));
const fetchAndApplyMachinesSpy = vi.hoisted(() => vi.fn(async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
    applyMachines([]);
}));

type SocketEventHandler = (...args: unknown[]) => void;

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
        off: vi.fn((event: string, handler?: SocketEventHandler) => {
            if (!handler) {
                listeners.delete(event);
                return socket;
            }
            listeners.get(event)?.delete(handler);
            return socket;
        }),
        onAny: vi.fn(),
        connect: vi.fn(() => {
            socket.connected = true;
            for (const listener of listeners.get('connect') ?? []) {
                listener();
            }
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (!wasConnected) {
                return;
            }
            for (const listener of listeners.get('disconnect') ?? []) {
                listener('io client disconnect');
            }
        }),
        removeAllListeners: vi.fn(() => {
            listeners.clear();
        }),
    };
    return socket;
}

function mockConcurrentSessionCacheDeps() {
    vi.doMock('socket.io-client', () => ({
        io: (uri?: unknown, opts?: unknown) => ioSpy(uri, opts),
    }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentialsForServerUrl: (serverUrl: string, options?: unknown) => getCredentialsForServerUrlSpy(serverUrl, options),
        },
        isLegacyAuthCredentials: (credentials: unknown) =>
            Boolean(credentials && typeof credentials === 'object' && typeof (credentials as { secret?: unknown }).secret === 'string'),
    }));
    vi.doMock('@/sync/domains/server/serverProfiles', () => ({
        listServerProfiles: () => listServerProfilesSpy(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => getActiveServerSnapshotSpy(),
        subscribeActiveServer: () => () => {},
    }));
    vi.doMock('@/sync/encryption/encryption', () => ({
        Encryption: {
            create: async () => ({}) as unknown,
        },
    }));
    vi.doMock('@/encryption/base64', () => ({
        decodeBase64: () => new Uint8Array(32),
    }));
    vi.doMock('@/sync/engine/sessions/sessionSnapshot', () => ({
        fetchAndApplySessions: fetchAndApplySessionsSpy,
    }));
    vi.doMock('@/sync/engine/machines/syncMachines', () => ({
        fetchAndApplyMachines: fetchAndApplyMachinesSpy,
    }));
}

function mockRuntimeFetchReachabilityReady() {
    const runtimeFetchMock = vi.fn(async (_input: RequestInfo | URL) => {
        return new Response(null, { status: 200, headers: new Headers() });
    });
    vi.doMock('@/utils/system/runtimeFetch', () => ({
        runtimeFetch: runtimeFetchMock,
        resetRuntimeFetch: () => {},
        setRuntimeFetch: () => {},
    }));
    return runtimeFetchMock;
}

async function configureConcurrentSelection(): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState((state) => ({
        ...state,
        settings: {
            ...state.settings,
            ...settingsDefaults,
            serverSelectionGroups: [
                {
                    id: 'group-main',
                    name: 'Main',
                    serverIds: ['server-a', 'server-b'],
                    presentation: 'grouped',
                },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'group-main',
        },
    }));
}

async function startConcurrentCacheAndWaitForReconcile(): Promise<{
    stopConcurrentSessionCacheSync: () => void;
}> {
    const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
    startConcurrentSessionCacheSync();
    await vi.waitFor(() => {
        expect(ioSpy).toHaveBeenCalled();
    });
    return { stopConcurrentSessionCacheSync };
}

beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    ioSpy.mockReset();
    getCredentialsForServerUrlSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    fetchAndApplySessionsSpy.mockReset();
    fetchAndApplyMachinesSpy.mockReset();
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});

afterEach(() => {
    vi.useRealTimers();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

afterEach(async () => {
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
});

describe('concurrent session cache supervised sockets', () => {
    it('does not connect sockets while server reachability is offline', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS = '10000';

        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(null, { status: 200, headers: new Headers() });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => {
            expect(listServerProfilesSpy).toHaveBeenCalled();
        });

        expect(ioSpy).not.toHaveBeenCalled();
        expect(fakeSocket.connect).not.toHaveBeenCalled();

        stopConcurrentSessionCacheSync();
        delete process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS;
        vi.useRealTimers();
    });

    it('does not refresh HTTP snapshots while reachability is offline', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS = '10000';

        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String(input);
            if (url.endsWith('/health')) {
                throw new TypeError('Network request failed');
            }
            return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: runtimeFetchMock,
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => {
            expect(listServerProfilesSpy).toHaveBeenCalled();
        });

        await vi.advanceTimersByTimeAsync(10_000 + 1_000);

        expect(fetchAndApplySessionsSpy).not.toHaveBeenCalled();

        stopConcurrentSessionCacheSync();
        delete process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS;
        vi.useRealTimers();
    });

    it('opens non-active server sockets with server-scoped credentials', async () => {
        mockRuntimeFetchReachabilityReady();
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockImplementation(async (serverUrl: string) => {
            if (serverUrl === 'https://stack-b.example.test') {
                return { token: 'token-b', secret: 'secret-b' };
            }
            return null;
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://stack-b.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-b',
                    clientType: 'user-scoped',
                }),
                reconnection: false,
                autoConnect: false,
            }),
        );
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
    });

    it('does not subscribe to socket.onAny or socket update events', async () => {
        mockRuntimeFetchReachabilityReady();
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        expect(fakeSocket.onAny).not.toHaveBeenCalled();
        expect(fakeSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(fakeSocket.on).not.toHaveBeenCalledWith('update', expect.any(Function));

        stopConcurrentSessionCacheSync();
    });

    it('uses supervised sockets without built-in socket.io reconnect loops', async () => {
        mockRuntimeFetchReachabilityReady();
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { stopConcurrentSessionCacheSync } = await startConcurrentCacheAndWaitForReconcile();

        const opts = ioSpy.mock.calls[0]?.[1] as { reconnection?: boolean; autoConnect?: boolean } | undefined;
        expect(opts?.reconnection).toBe(false);
        expect(opts?.autoConnect).toBe(false);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(1);

        stopConcurrentSessionCacheSync();
        await vi.waitFor(() => {
            expect(fakeSocket.disconnect).toHaveBeenCalled();
            expect(fakeSocket.removeAllListeners).toHaveBeenCalled();
        });
    });

    it('does not report server unreachable during stop teardown', async () => {
        const fakeSocket = createSocketStub();
        ioSpy.mockReturnValue(fakeSocket);
        getCredentialsForServerUrlSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
            { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
        ]);
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://stack-a.example.test',
            kind: 'stack',
            generation: 1,
        });

        const reportServerUnreachableSpy = vi.fn();
        const createConcurrentServerSocketTransportSpy = vi.fn();
        const destroySpy = vi.fn(() => {});
        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
            return {
                ...actual,
                subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                    const timer = setTimeout(() => {
                        listener({
                            phase: 'online',
                            reason: 'initial_connect',
                            attempt: 0,
                            nextRetryAt: null,
                            lastConnectedAt: Date.now(),
                            lastDisconnectedAt: null,
                            lastErrorMessage: null,
                        });
                    }, 0);
                    return () => clearTimeout(timer);
                },
                startServerReachabilitySupervisor: async () => {},
                reportServerUnreachable: (serverUrl: string, error: unknown) => reportServerUnreachableSpy(serverUrl, error),
                resetServerReachabilitySupervisors: async () => {},
            };
        });

        vi.doMock('./concurrentServerConnections/createConcurrentServerSocketTransport', () => {
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
                    destroySpy();
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
                createConcurrentServerSocketTransport: () => {
                    createConcurrentServerSocketTransportSpy();
                    return { socket: fakeSocket, transport };
                },
            };
        });

        mockRuntimeFetchReachabilityReady();
        mockConcurrentSessionCacheDeps();
        await configureConcurrentSelection();

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await vi.waitFor(() => {
            expect(listServerProfilesSpy).toHaveBeenCalled();
            expect(getCredentialsForServerUrlSpy).toHaveBeenCalled();
            expect(createConcurrentServerSocketTransportSpy).toHaveBeenCalled();
        });
        stopConcurrentSessionCacheSync();

        expect(destroySpy).toHaveBeenCalled();
        expect(reportServerUnreachableSpy).not.toHaveBeenCalled();
    });
});
