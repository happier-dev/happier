import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

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

function createStubEndpointSupervisor(initial: ManagedEndpointSupervisorState) {
    let state = initial;
    const listeners = new Set<(next: ManagedEndpointSupervisorState) => void>();

    const publish = (next: ManagedEndpointSupervisorState) => {
        state = next;
        for (const listener of Array.from(listeners)) {
            listener(next);
        }
    };

    const supervisor: ManagedEndpointSupervisor = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: vi.fn(async () => {}),
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(state);
            return () => listeners.delete(listener);
        },
    };

    return { supervisor, publish };
}

describe('sync endpoint online resume', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateAddListener.mockClear();
    });

    it('triggers one consolidated resume pipeline when endpoint supervision returns online', async () => {
        const now = Date.now();
        const offlineState: ManagedEndpointSupervisorState = {
            phase: 'offline',
            reason: 'server_unreachable',
            attempt: 1,
            nextRetryAt: now + 1000,
            lastConnectedAt: null,
            lastDisconnectedAt: now,
            lastErrorMessage: 'Network request failed',
            lastProbe: { status: 'server_unreachable', errorMessage: 'Network request failed' },
        };
        const onlineState: ManagedEndpointSupervisorState = {
            phase: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: now,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
            lastProbe: { status: 'ready' },
        };

        const { supervisor, publish } = createStubEndpointSupervisor(offlineState);
        const { sync } = await import('./sync');

        const resumeSpy = vi.fn(async () => {});
        (sync as unknown as { resumeSync: (reason: string) => Promise<void> }).resumeSync = resumeSpy as any;

        sync.setActiveEndpointSupervisor(supervisor);
        publish(onlineState);

        await new Promise<void>((resolve) => queueMicrotask(resolve));

        expect(resumeSpy).toHaveBeenCalledWith('endpoint-online');
    });
});
