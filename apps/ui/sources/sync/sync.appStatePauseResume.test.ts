import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PauseController } from '@/utils/timing/pauseController';
import type { ServerAccountScope } from './domains/scope/serverAccountScope';
import { createAccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import { loadSessionMaterializedMaxSeqById } from './domains/state/persistence';

const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appStateAddListener = vi.hoisted(() => vi.fn((_event: string, handler: (state: string) => void) => {
    appStateHandlers.add(handler);
    return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
}));
const isTauriDesktopState = vi.hoisted(() => ({ value: false }));

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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopState.value,
}));

const apiSocketDisconnect = vi.hoisted(() => vi.fn());
const apiSocketConnect = vi.hoisted(() => vi.fn());
const checkpointScope = createAccountSettingsScope('server-a', 'account-a');

if (!checkpointScope) {
    throw new Error('Expected valid checkpoint scope test fixture');
}

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

const invalidateAllServerReachabilitySupervisorsMock = vi.hoisted(() => vi.fn(async () => {}));
const stopServerReachabilitySupervisorsMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        invalidateAllServerReachabilitySupervisors: invalidateAllServerReachabilitySupervisorsMock,
        stopServerReachabilitySupervisors: stopServerReachabilitySupervisorsMock,
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync AppState pause/resume', () => {
    const resolveTestSettingsScope = () => {
        const scope = createAccountSettingsScope('server-appstate-test', 'account-appstate-test');
        expect(scope).toBeTruthy();
        return scope!;
    };

    beforeEach(() => {
        vi.resetModules();
        appStateHandlers.clear();
        appStateAddListener.mockClear();
        apiSocketDisconnect.mockClear();
        apiSocketConnect.mockClear();
        invalidateAllServerReachabilitySupervisorsMock.mockClear();
        stopServerReachabilitySupervisorsMock.mockClear();
        isTauriDesktopState.value = false;
    });

    it('rearms only current-scope durable outbox sessions once without mounting a session route', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { savePendingOutboxMessage } = await import('./domains/state/pendingOutboxPersistence');
        const profile = upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const activeScope = {
            serverId: String(getActiveServerSnapshot().serverId ?? profile.id),
            accountId: 'account-a',
        } as const;
        const otherScope = { ...activeScope, accountId: 'account-b' } as const;
        storage.getState().activateProfileScope(activeScope);

        const save = (sessionId: string, localId: string, scope: ServerAccountScope) => {
            savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 100,
                text: localId,
                rawRecord: { role: 'user' },
                request: {
                    v: 1,
                    body: JSON.stringify({
                        localId,
                        content: { t: 'plain', v: { role: 'user' } },
                        messageRole: 'user',
                    }),
                },
            }, scope);
        };
        save('session-b', 'local-b', activeScope);
        save('session-a', 'local-a', activeScope);
        save('other-account-session', 'other-local', otherScope);

        const { sync } = await import('./sync');
        let releaseReplay!: () => void;
        const replayBarrier = new Promise<void>((resolve) => {
            releaseReplay = resolve;
        });
        const fetchPendingMessages = vi.spyOn(sync, 'fetchPendingMessages')
            .mockImplementation(async () => replayBarrier);

        const first = (sync as any).rearmPendingOutboxForActiveScope() as Promise<void>;
        const second = (sync as any).rearmPendingOutboxForActiveScope() as Promise<void>;
        await Promise.resolve();

        expect(second).toBe(first);
        expect(fetchPendingMessages.mock.calls).toEqual([
            ['session-a', activeScope],
            ['session-b', activeScope],
        ]);

        releaseReplay();
        await first;
    });

    it('invokes durable outbox rearm from both bootstrap and the foreground resume pipeline', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        storage.getState().activateProfileScope({
            serverId: String(getActiveServerSnapshot().serverId ?? ''),
            accountId: 'account-a',
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'token', secret: 'secret' };
        (sync as any).serverID = 'account-a';
        const rearm = vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        const syncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => undefined),
        };
        for (const field of [
            'settingsSync',
            'profileSync',
            'sessionsSync',
            'machinesSync',
            'purchasesSync',
            'artifactsSync',
            'automationsSync',
            'todosSync',
            'friendsSync',
            'friendRequestsSync',
            'feedSync',
            'pushTokenSync',
            'nativeUpdateSync',
        ]) {
            (sync as any)[field] = syncUnit;
        }

        await (sync as any).bootstrapSync();
        expect(rearm).toHaveBeenCalledTimes(1);

        vi.spyOn(sync as any, 'resumeViaChanges').mockResolvedValue({
            status: 'aborted',
            refreshedByCatchUp: { sessions: false, machines: false },
        });
        await sync.resumeSync('app-foreground');
        expect(rearm).toHaveBeenCalledTimes(2);
    });

    it('pauses on background and resumes on active (disconnect/connect socket + invalidate reachability)', async () => {
        const { sync } = await import('./sync');

        expect(appStateAddListener).toHaveBeenCalled();
        const handler = Array.from(appStateHandlers)[0];
        expect(handler).toBeTruthy();

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        handler!('background');
        expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
        expect(stopServerReachabilitySupervisorsMock).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(true);

        handler!('active');
        expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        expect(invalidateAllServerReachabilitySupervisorsMock).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(false);
    });

    it('keeps Tauri desktop sync active when AppState reports background', async () => {
        isTauriDesktopState.value = true;
        const { sync } = await import('./sync');

        expect(appStateAddListener).toHaveBeenCalled();
        const handler = Array.from(appStateHandlers)[0];
        expect(handler).toBeTruthy();

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        handler!('background');

        expect(apiSocketDisconnect).not.toHaveBeenCalled();
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
                revalidationTimeoutMs: 5_000,
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
            const scope = resolveTestSettingsScope();

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).pendingSettingsScope = scope;
            (sync as any).sessionMaterializedMaxSeqById = { s1: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');

            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({});

            await vi.advanceTimersByTimeAsync(299);
            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({});

            await vi.advanceTimersByTimeAsync(1);
            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ s1: 5 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels inactive checkpoint debounce when active returns quickly', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');
            const scope = resolveTestSettingsScope();

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).pendingSettingsScope = scope;
            (sync as any).sessionMaterializedMaxSeqById = { s1: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');
            handler!('active');
            await vi.advanceTimersByTimeAsync(300);

            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({});
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not flush inactive checkpoints after the server scope changes', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');
            const scope = resolveTestSettingsScope();

            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            (sync as any).pendingSettingsScope = scope;
            (sync as any).sessionMaterializedMaxSeqById = { s_old: 5 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            handler!('inactive');
            (sync as any).serverScopeGeneration += 1;

            await vi.advanceTimersByTimeAsync(300);

            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({});
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not flush materialized seq checkpoints after the server scope changes', async () => {
        vi.useFakeTimers();
        try {
            const { sync } = await import('./sync');
            const scope = resolveTestSettingsScope();

            (sync as any).pendingSettingsScope = scope;
            (sync as any).markSessionMaterializedMaxSeq('s_old', 5);
            (sync as any).serverScopeGeneration += 1;

            await vi.advanceTimersByTimeAsync(2_000);

            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({});
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

    it('keeps Tauri desktop sync active when document visibility is hidden', async () => {
        isTauriDesktopState.value = true;
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
            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;

            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).not.toHaveBeenCalled();
            expect(handlers.has('visibilitychange')).toBe(false);
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
            const scope = resolveTestSettingsScope();

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);

            (sync as any).pendingSettingsScope = scope;
            (sync as any).sessionMaterializedMaxSeqById = { s1: 7 };
            (sync as any).sessionMaterializedMaxSeqDirty = true;

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(true);
            expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ s1: 7 });

            documentStub.visibilityState = 'visible';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidateAllServerReachabilitySupervisorsMock).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(false);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('defers routine hidden teardown only until every in-flight user request lease is released', async () => {
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
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');
            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            const releaseFirst = sync.acquireUserRequestLease();
            const releaseSecond = sync.acquireUserRequestLease();

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) handler();

            expect(apiSocketDisconnect).not.toHaveBeenCalled();
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
            expect(pauseController.isPaused()).toBe(false);

            releaseFirst();
            expect(apiSocketDisconnect).not.toHaveBeenCalled();

            releaseSecond();
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
            expect(pauseController.isPaused()).toBe(true);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it.each(['pagehide', 'freeze'] as const)('keeps %s as a hard boundary while a user request lease exists', async (eventName) => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const originalAddEventListener = globalThis.addEventListener;
        const originalRemoveEventListener = globalThis.removeEventListener;
        const windowHandlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;
        globalThis.addEventListener = ((event: string, listener: () => void) => {
            const set = windowHandlers.get(event) ?? new Set<() => void>();
            set.add(listener);
            windowHandlers.set(event, set);
        }) as typeof globalThis.addEventListener;
        globalThis.removeEventListener = ((event: string, listener: () => void) => {
            windowHandlers.get(event)?.delete(listener);
        }) as typeof globalThis.removeEventListener;

        try {
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');
            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            const release = sync.acquireUserRequestLease();

            for (const handler of windowHandlers.get(eventName) ?? []) handler();

            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
            expect(pauseController.isPaused()).toBe(true);
            release();
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
        } finally {
            globalWithDocument.document = originalDocument;
            globalThis.addEventListener = originalAddEventListener;
            globalThis.removeEventListener = originalRemoveEventListener;
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
            await import('./sync');

            expect(windowHandlers.has('pageshow')).toBe(true);
            for (const handler of windowHandlers.get('pageshow') ?? []) {
                handler({ persisted: true });
            }

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidateAllServerReachabilitySupervisorsMock).toHaveBeenCalledTimes(1);
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
            await import('./sync');
            apiSocketConnect.mockClear();
            invalidateAllServerReachabilitySupervisorsMock.mockClear();

            vi.setSystemTime(91_000);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidateAllServerReachabilitySupervisorsMock).toHaveBeenCalledTimes(1);
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
