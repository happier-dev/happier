import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.fn();
const listServerProfilesSpy = vi.fn();
const getActiveServerSnapshotSpy = vi.fn();
const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appState = vi.hoisted(() => ({ currentState: 'active' as string }));
const appStateAddListener = vi.hoisted(() =>
    vi.fn((_event: string, handler: (state: string) => void) => {
        appStateHandlers.add(handler);
        return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
    }),
);
const runtimeFetchSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            get currentState() {
                return appState.currentState;
            },
            addEventListener: appStateAddListener as any,
        },
    });
});

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
        io: (...args: unknown[]) => ioSpy(...args),
    }));
    vi.doMock('@/auth/storage/tokenStorage', () => ({
        TokenStorage: {
            getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
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
        fetchAndApplySessions: async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
            applySessions([]);
        },
    }));
    vi.doMock('@/sync/engine/machines/syncMachines', () => ({
        fetchAndApplyMachines: async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
            applyMachines([]);
        },
    }));
    vi.doMock('@/log', () => ({
        log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('@/utils/system/runtimeFetch', () => ({
        runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
    }));
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
    runtimeFetchSpy.mockReset();
    appStateHandlers.clear();
    appState.currentState = 'active';
    appStateAddListener.mockClear();
    process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
});

afterEach(() => {
    vi.useRealTimers();
    delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
});

describe('concurrent session cache supervised sockets', () => {
    it('does not connect sockets while backgrounded, then connects when active', async () => {
        appState.currentState = 'background';
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));

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

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();

        await vi.waitFor(() => {
            expect(appStateAddListener).toHaveBeenCalled();
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(ioSpy).toHaveBeenCalledTimes(0);
        expect(fakeSocket.connect).toHaveBeenCalledTimes(0);

        appState.currentState = 'active';
        expect(appStateHandlers.size).toBeGreaterThan(0);
        for (const handler of appStateHandlers) {
            handler('active');
        }

        await vi.waitFor(() => {
            expect(ioSpy).toHaveBeenCalled();
        });

        stopConcurrentSessionCacheSync();
    });

    it('opens non-active server sockets with server-scoped credentials', async () => {
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
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
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
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
        runtimeFetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: new Headers() }));
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
});
