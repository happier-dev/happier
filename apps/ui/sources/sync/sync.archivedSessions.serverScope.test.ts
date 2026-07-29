import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
type FetchAndApplySessionsCall = Readonly<{
    sessionListPath?: string;
    shouldContinue?: () => boolean;
    applySessions: (sessions: unknown[]) => void;
}>;
const fetchAndApplySessionsSpy = vi.hoisted(() => vi.fn(async (_params: FetchAndApplySessionsCall) => ({
    hasNext: false,
    nextCursor: null,
})));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: appStateAddListener as any,
        },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
        emitWithAck: vi.fn(),
        send: vi.fn(),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

vi.mock('./engine/sessions/syncSessions', async () => {
    const actual = await vi.importActual<typeof import('./engine/sessions/syncSessions')>('./engine/sessions/syncSessions');
    return {
        ...actual,
        fetchAndApplySessions: (params: FetchAndApplySessionsCall) => fetchAndApplySessionsSpy(params),
    };
});

vi.mock('./engine/artifacts/syncArtifacts', async () => {
    const actual = await vi.importActual<typeof import('./engine/artifacts/syncArtifacts')>('./engine/artifacts/syncArtifacts');
    return {
        ...actual,
        fetchAndApplyArtifactsList: vi.fn(async () => {}),
    };
});

describe('sync archived session fetch server-scope guards', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateAddListener.mockClear();
        fetchAndApplySessionsSpy.mockReset();
    });

    it('passes a scope guard and suppresses stale archived apply callbacks after a server switch', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { sync } = await import('./sync');

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };
        (sync as any).sessionDataKeys = new Map<string, Uint8Array>();

        const applySessionsSpy = vi.spyOn(sync as any, 'applySessions').mockImplementation(() => {});

        await (sync as any).fetchArchivedSessions();

        expect(fetchAndApplySessionsSpy).toHaveBeenCalledTimes(1);
        const params = fetchAndApplySessionsSpy.mock.calls[0]?.[0];
        if (!params) {
            throw new Error('Expected archived session fetch parameters.');
        }

        expect(params.sessionListPath).toBe('/v2/sessions/archived');
        expect(typeof params.shouldContinue).toBe('function');
        expect(params.shouldContinue?.()).toBe(true);

        params.applySessions([{ id: 'session-before-switch' }]);
        expect(applySessionsSpy).toHaveBeenCalledWith([{ id: 'session-before-switch' }]);

        (sync as any).resetServerScopedRuntimeState();

        expect(params.shouldContinue?.()).toBe(false);

        params.applySessions([{ id: 'session-after-switch' }]);
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
    });

    it('replays an archived sessions fetch requested before credentials are restored', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { sync } = await import('./sync');

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        await (sync as any).fetchArchivedSessions();

        expect(fetchAndApplySessionsSpy).not.toHaveBeenCalled();

        await (sync as any).restore(
            { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' },
            {
                anonID: 'anon-test',
                configureAesBatchConcurrencyLimit: () => {},
                configureNativeCryptoWorker: () => {},
                warmNativeCryptoWorkerForDiagnostics: async () => {},
                decryptEncryptionKey: async () => null,
                initializeSessions: async () => {},
                getSessionEncryption: () => null,
            },
        );

        await expect.poll(() => (
            fetchAndApplySessionsSpy.mock.calls.some((call) => call[0]?.sessionListPath === '/v2/sessions/archived')
        )).toBe(true);
    });

    it('replays an archived sessions fetch aborted by an active server switch', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { sync } = await import('./sync');
        const encryption = {
            anonID: 'anon-test',
            configureAesBatchConcurrencyLimit: () => {},
            configureNativeCryptoWorker: () => {},
            warmNativeCryptoWorkerForDiagnostics: async () => {},
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
        (sync as any).encryption = encryption;
        (sync as any).sessionDataKeys = new Map<string, Uint8Array>();

        const serverSwitchAbort = new Error('Aborted request due to an active server switch');
        serverSwitchAbort.name = 'ServerFetchAbortedForServerSwitchError';
        fetchAndApplySessionsSpy.mockRejectedValueOnce(serverSwitchAbort);

        await expect((sync as any).fetchArchivedSessions()).resolves.toBeUndefined();

        await (sync as any).restore(
            { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' },
            encryption,
        );

        await expect.poll(() => (
            fetchAndApplySessionsSpy.mock.calls
                .filter((call) => call[0]?.sessionListPath === '/v2/sessions/archived')
                .length
        )).toBeGreaterThanOrEqual(2);
    });
});
