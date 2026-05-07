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

    it('quiesces native crypto worker dispatch on background and resumes it on active', async () => {
        const { Encryption } = await import('./encryption/encryption');
        const markQuiescentSpy = vi.spyOn(Encryption, 'markNativeCryptoWorkerQueueQuiescent');
        const markActiveSpy = vi
            .spyOn(Encryption, 'markNativeCryptoWorkerQueueActive')
            .mockResolvedValue();
        const { sync } = await import('./sync');

        try {
            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            handler!('background');

            expect(markQuiescentSpy).toHaveBeenCalledTimes(1);
            expect(markQuiescentSpy).toHaveBeenCalledWith({
                telemetryEnabled: false,
            });

            handler!('active');

            expect(markActiveSpy).toHaveBeenCalledTimes(1);
            expect(markActiveSpy).toHaveBeenCalledWith({
                telemetryEnabled: false,
                capabilityStalenessMs: 300_000,
                revalidateCapabilities: undefined,
            });
            expect(sync).toBeTruthy();
        } finally {
            markActiveSpy.mockRestore();
            markQuiescentSpy.mockRestore();
        }
    });

    it('debounces inactive before flushing durable checkpoints', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).sessionMaterializedMaxSeqById = { s1: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');

            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(kvStore.get('session-materialized-max-seq-v1')).toBeUndefined();

            await vi.advanceTimersByTimeAsync(299);
            expect(kvStore.get('session-materialized-max-seq-v1')).toBeUndefined();

            await vi.advanceTimersByTimeAsync(1);
            expect(JSON.parse(kvStore.get('session-materialized-max-seq-v1') ?? '{}')).toEqual({ s1: 5 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels inactive checkpoint debounce when active returns quickly', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).sessionMaterializedMaxSeqById = { s1: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');
            handler!('active');
            await vi.advanceTimersByTimeAsync(300);

            expect(kvStore.get('session-materialized-max-seq-v1')).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not flush inactive checkpoints after the server scope changes', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).sessionMaterializedMaxSeqById = { s_old: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');
            (sync as any).serverScopeGeneration += 1;

            await vi.advanceTimersByTimeAsync(300);

            expect(kvStore.get('session-materialized-max-seq-v1')).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not flush materialized seq checkpoints after the server scope changes', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');

            (sync as any).markSessionMaterializedMaxSeq('s_old', 5);
            (sync as any).serverScopeGeneration += 1;

            await vi.advanceTimersByTimeAsync(2_000);

            expect(kvStore.get('session-materialized-max-seq-v1')).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
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

            (sync as any).sessionMaterializedMaxSeqById = { s1: 7 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(true);
            expect(JSON.parse(kvStore.get('session-materialized-max-seq-v1') ?? '{}')).toEqual({ s1: 7 });

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

    it('resumes on BFCache pageshow even when visibility did not change', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const originalAddEventListener = globalThis.addEventListener;
        const originalRemoveEventListener = globalThis.removeEventListener;
        const documentHandlers = new Map<string, Set<() => void>>();
        const windowHandlers = new Map<string, Set<(event?: { persisted?: boolean }) => void>>();
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: (event: string, listener: () => void) => {
                const set = documentHandlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                documentHandlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                documentHandlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;
        globalThis.addEventListener = ((event: string, listener: (event?: { persisted?: boolean }) => void) => {
            const set = windowHandlers.get(event) ?? new Set<(event?: { persisted?: boolean }) => void>();
            set.add(listener);
            windowHandlers.set(event, set);
        }) as typeof globalThis.addEventListener;
        globalThis.removeEventListener = ((event: string, listener: (event?: { persisted?: boolean }) => void) => {
            windowHandlers.get(event)?.delete(listener);
        }) as typeof globalThis.removeEventListener;

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
            sync.setActiveEndpointSupervisor({
                start: vi.fn(async () => {}),
                stop: vi.fn(async () => {}),
                invalidate,
                reportFailure: vi.fn(),
                waitUntilOnline: vi.fn(async () => {}),
                getState: () => onlineState,
                subscribe: () => () => {},
            });

            expect(windowHandlers.has('pageshow')).toBe(true);
            for (const handler of windowHandlers.get('pageshow') ?? []) {
                handler({ persisted: true });
            }

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidate).toHaveBeenCalledTimes(1);
        } finally {
            globalWithDocument.document = originalDocument;
            globalThis.addEventListener = originalAddEventListener;
            globalThis.removeEventListener = originalRemoveEventListener;
        }
    });

    it('resumes on web startup when the browser reports the page was discarded', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const documentStub = {
            visibilityState: 'visible',
            wasDiscarded: true,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            await import('./sync');

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('resumes once when the web lifecycle heartbeat detects a forward clock jump', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');

            const invalidate = vi.fn();
            sync.setActiveEndpointSupervisor({
                start: vi.fn(async () => {}),
                stop: vi.fn(async () => {}),
                invalidate,
                reportFailure: vi.fn(),
                waitUntilOnline: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                    lastProbe: { status: 'ready' },
                }),
                subscribe: () => () => {},
            });
            apiSocketConnect.mockClear();

            vi.setSystemTime(91_000);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidate).toHaveBeenCalledTimes(1);
        } finally {
            globalWithDocument.document = originalDocument;
            vi.useRealTimers();
        }
    });

    it('does not enter a resume loop when the web lifecycle heartbeat sees a backwards clock jump', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            await import('./sync');
            apiSocketConnect.mockClear();

            vi.setSystemTime(1_000);
            await vi.advanceTimersByTimeAsync(30_000);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(apiSocketConnect).toHaveBeenCalledTimes(0);
        } finally {
            globalWithDocument.document = originalDocument;
            vi.useRealTimers();
        }
    });
});
