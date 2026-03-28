import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

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

const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appStateAddListener = vi.hoisted(() => vi.fn((_event: string, handler: (state: string) => void) => {
    appStateHandlers.add(handler);
    return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
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

const apiSocketDisconnect = vi.hoisted(() => vi.fn());
const apiSocketConnect = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
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

describe('sync AppState pause/resume', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateHandlers.clear();
        appStateAddListener.mockClear();
        apiSocketDisconnect.mockClear();
        apiSocketConnect.mockClear();
    });

    it('pauses on background and resumes on active (disconnect/connect socket + invalidate endpoint)', async () => {
        const { sync } = await import('./sync');

        const onlineState: ManagedEndpointSupervisorState = {
            phase: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
            lastProbe: { status: 'ready' },
        };

        const invalidate = vi.fn();
        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate,
            reportFailure: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState,
            subscribe: () => () => {},
        };

        sync.setActiveEndpointSupervisor(supervisor);

        expect(appStateAddListener).toHaveBeenCalled();
        const handler = Array.from(appStateHandlers)[0];
        expect(handler).toBeTruthy();

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        handler!('background');
        expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(true);

        handler!('active');
        expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(false);
    });

    it('seeds initial web visibility hidden as backgrounded (pauses immediately on startup)', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(true);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('pauses on web visibility hidden and resumes on visible', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');

            const onlineState: ManagedEndpointSupervisorState = {
                phase: 'online',
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: Date.now(),
                lastDisconnectedAt: null,
                lastErrorMessage: null,
                lastProbe: { status: 'ready' },
            };

            const invalidate = vi.fn();
            const supervisor: ManagedEndpointSupervisor = {
                start: vi.fn(async () => {}),
                stop: vi.fn(async () => {}),
                invalidate,
                reportFailure: vi.fn(),
                waitUntilOnline: vi.fn(async () => {}),
                getState: () => onlineState,
                subscribe: () => () => {},
            };

            sync.setActiveEndpointSupervisor(supervisor);

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(true);

            documentStub.visibilityState = 'visible';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidate).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(false);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });
});
