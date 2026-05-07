import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
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
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync session viewport', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
    });

    it('distinguishes default visibility from observed viewport intent', async () => {
        const { sync } = await import('./sync');

        expect(sync.getSessionViewport('session-1')).toBeNull();

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
        });

        sync.onSessionViewportChange('session-1', { isPinned: false, offsetY: 420 });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });
    });

    it('includes the actively viewed session in hydration priority before viewport tracking exists', async () => {
        const { sync } = await import('./sync');
        const { clearActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        try {
            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds[0]).toBe('session-active');
        } finally {
            clearActiveViewingSessionId('session-active', 1);
        }
    });

    it('clears active viewing hydration priority when server-scoped runtime state resets', async () => {
        const { sync } = await import('./sync');
        const { getActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        expect(getActiveViewingSessionId()).toBe('session-active');

        sync.disconnectServer();

        const priorityIds = (
            sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
        ).getPrioritizedSessionHydrationIds();

        expect(getActiveViewingSessionId()).toBeNull();
        expect(priorityIds).not.toContain('session-active');
    });
});
