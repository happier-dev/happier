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
const apiSocketMock = vi.hoisted(() => ({
    onMessage: vi.fn(),
    onError: vi.fn(),
    onReconnected: vi.fn(),
    onStatusChange: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    initialize: vi.fn(),
    request: vi.fn(async () => new Response('ok', { status: 200 })),
}));
const reachabilityMock = vi.hoisted(() => ({
    invalidateAllServerReachabilitySupervisors: vi.fn(async () => {}),
}));
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
    apiSocket: apiSocketMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        invalidateAllServerReachabilitySupervisors: reachabilityMock.invalidateAllServerReachabilitySupervisors,
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync manual retry', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateAddListener.mockClear();
        apiSocketMock.connect.mockClear();
        apiSocketMock.disconnect.mockClear();
        reachabilityMock.invalidateAllServerReachabilitySupervisors.mockClear();
    });

    it('manual retry forces reachability invalidation before resuming sync', async () => {
        const { sync } = await import('./sync');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;

        sync.retryNow();

        expect(apiSocketMock.disconnect).toHaveBeenCalledTimes(1);
        expect(apiSocketMock.connect).toHaveBeenCalledTimes(1);
        expect(reachabilityMock.invalidateAllServerReachabilitySupervisors).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledWith('manual');
    });

    it('manual retry still invalidates reachability when socket reconnect throws', async () => {
        const { sync } = await import('./sync');
        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy;
        apiSocketMock.disconnect.mockImplementationOnce(() => {
            throw new Error('disconnect failed');
        });

        sync.retryNow();

        expect(reachabilityMock.invalidateAllServerReachabilitySupervisors).toHaveBeenCalledTimes(1);
        expect(resumeSpy).toHaveBeenCalledWith('manual');
    });
});
