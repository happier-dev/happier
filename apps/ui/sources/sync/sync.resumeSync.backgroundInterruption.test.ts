import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PauseController } from '@/utils/timing/pauseController';

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
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            currentState: 'active',
                            addEventListener: appStateAddListener as any,
                        },
                    }
    );
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

const fetchChangesBarrier = vi.hoisted(() => {
    let resolve: (() => void) | null = null;
    let promise: Promise<void> = new Promise<void>((r) => {
        resolve = r;
    });
    return {
        get promise() {
            return promise;
        },
        resolve: () => resolve?.(),
        reset: () => {
            promise = new Promise<void>((r) => {
                resolve = r;
            });
        },
    };
});

vi.mock('./api/session/apiChanges', () => ({
    fetchChanges: vi.fn(async () => {
        await fetchChangesBarrier.promise;
        return {
            status: 'ok' as const,
            changes: [],
            nextCursor: '0',
        };
    }),
    fetchCurrentChangesCursor: vi.fn(async () => ({ status: 'ok' as const, cursor: '0' })),
}));

describe('sync resumeSync background interruption', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateAddListener.mockClear();
        fetchChangesBarrier.reset();
        vi.unstubAllGlobals();
    });

    it('does not continue issuing HTTP sync requests after app is backgrounded mid-resume', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url: string =
                typeof input === 'string'
                    ? input
                    : input instanceof Request
                      ? input.url
                      : 'url' in input
                        ? String(input.url)
                        : input.toString();

            if (url.includes('/v2/sessions')) {
                return new Response(
                    JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }
            if (url.includes('/v1/machines')) {
                return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);

        const { storage } = await import('./domains/state/storage');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { sync } = await import('./sync');

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
        (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
        (sync as any).serverID = 'test-account';
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            initializeMachines: async () => {},
            getSessionEncryption: () => null,
        };
        (sync as any).isForeground = true;
        (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        const promise = (sync as any).resumeSync('socket-reconnect') as Promise<void>;

        // Pause the app while resume is in-flight (right before changes reconcile unblocks).
        pauseController.pause();

        // Allow changes reconcile to finish; resumeSync should see the pause before issuing HTTP work.
        fetchChangesBarrier.resolve();

        await new Promise<void>((resolve) => queueMicrotask(resolve));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(fetchMock).toHaveBeenCalledTimes(0);

        pauseController.resume();
        await promise;

        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
            expect.arrayContaining([expect.stringContaining('/v2/sessions')]),
        );
    }, 60_000);

    it('does not checkpoint an in-flight changes cursor after the server scope is reset', async () => {
        const { fetchChanges } = await import('./api/session/apiChanges');
        vi.mocked(fetchChanges).mockImplementationOnce(async () => {
            await fetchChangesBarrier.promise;
            return {
                status: 'ok' as const,
                changes: [],
                nextCursor: 'stale-server-tail',
            };
        });

        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { sync } = await import('./sync');

        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
        (sync as any).serverID = 'test-account';
        (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0LWFjY291bnQifQ.sig', secret: 'secret' };
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeMachines: async () => {},
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };
        (sync as any).isForeground = true;
        (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

        const promise = (sync as any).resumeSync('socket-reconnect') as Promise<void>;
        await new Promise<void>((resolve) => queueMicrotask(resolve));

        (sync as unknown as { disconnectServer: () => void }).disconnectServer();
        upsertAndActivateServer({ serverUrl: 'http://localhost:53289', scope: 'tab' });
        const switchedServerId = String(getActiveServerSnapshot().serverId ?? '').trim();

        fetchChangesBarrier.resolve();
        await promise;

        expect(loadChangesCursor({ serverScope: switchedServerId, accountId: 'test-account' })).toBeNull();
    }, 60_000);
});
