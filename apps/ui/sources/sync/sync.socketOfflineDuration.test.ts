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

const socketStatusHandlers = vi.hoisted(() => new Set<(status: string) => void>());
const socketReconnectHandlers = vi.hoisted(() => new Set<() => void>());
const apiSocketDisconnect = vi.hoisted(() => vi.fn());
const apiSocketConnect = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn((handler: () => void) => {
            socketReconnectHandlers.add(handler);
            return () => socketReconnectHandlers.delete(handler);
        }),
        onStatusChange: vi.fn((handler: (status: string) => void) => {
            socketStatusHandlers.add(handler);
            return () => socketStatusHandlers.delete(handler);
        }),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: apiSocketConnect,
        disconnect: apiSocketDisconnect,
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync socket offline duration tracking', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.resetModules();
        kvStore.clear();
        socketStatusHandlers.clear();
        socketReconnectHandlers.clear();
        apiSocketDisconnect.mockClear();
        apiSocketConnect.mockClear();
    });

    it('captures the last offline duration across disconnected→connected transition', async () => {
        const { sync } = await import('./sync');
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        // Wire the socket listeners without forcing a full sync init sequence.
        (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();

        expect(socketStatusHandlers.size).toBeGreaterThan(0);
        const handler = Array.from(socketStatusHandlers)[0]!;

        handler('disconnected');
        await vi.advanceTimersByTimeAsync(2500);
        handler('connected');

        const state = sync as unknown as {
            lastSocketOfflineDurationMs?: number;
        };
        expect(typeof state.lastSocketOfflineDurationMs).toBe('number');
        expect(state.lastSocketOfflineDurationMs).toBeGreaterThanOrEqual(2500);
    });

    it('invalidates mounted daemon contribution projections on reconnect', async () => {
        const { sync } = await import('./sync');
        const projection = await import('./ops/machineContributionRegistryProjection');
        const scope = { machineId: 'machine-1', serverId: 'server-1' };
        const invalidated = vi.fn();
        const unsubscribe =
            projection.subscribeMachineContributionRegistryProjectionInvalidation(
                scope,
                invalidated,
            );
        vi.spyOn(sync, 'resumeSync').mockResolvedValue(undefined);

        (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();
        expect(socketReconnectHandlers.size).toBeGreaterThan(0);
        for (const handler of socketReconnectHandlers) handler();

        expect(projection.getMachineContributionRegistryProjectionRevision(scope)).toBe(1);
        expect(invalidated).toHaveBeenCalledOnce();
        unsubscribe();
    });
});
