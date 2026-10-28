import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PauseController } from '@/utils/timing/pauseController';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { SyncTuning } from '@/sync/runtime/syncTuning';

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

function emptySessionOrganizationSnapshotResponse(): Response {
    return new Response(
        JSON.stringify({
            snapshot: {
                schemaVersion: 1,
                version: 1,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function stubAccountHttp(override?: (url: string) => Response | Promise<Response> | undefined) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url: string =
            typeof input === 'string'
                ? input
                : input instanceof Request
                  ? input.url
                  : 'url' in input
                    ? String(input.url)
                    : input.toString();

        const response = override?.(url);
        if (response) return await response;

        if (url.includes('/v2/session-organization')) {
            return emptySessionOrganizationSnapshotResponse();
        }
        if (url.includes('/v2/sessions')) {
            return new Response(
                JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        }
        if (url.includes('/v1/machines') || url.includes('/v1/artifacts')) {
            return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/v1/feed')) {
            return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/v1/account/profile')) return Response.json({ id: 'test-account' });
        if (url.includes('/v1/account/encryption')) return Response.json({ mode: 'e2ee', updatedAt: 0 });
        if (url.includes('/v2/account/settings')) return Response.json({ content: null, version: 0 });
        if (url.includes('/v1/kv')) return Response.json({ items: [] });
        if (url.includes('/v2/automations')) return Response.json([]);
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function loadSignedInSyncAfterSocketOutage() {
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
    return sync;
}

describe('sync resumeSync background interruption', () => {
    beforeEach(async () => {
        vi.resetModules();
        appStateAddListener.mockClear();
        fetchChangesBarrier.reset();
        vi.unstubAllGlobals();
        const { fetchChanges, fetchCurrentChangesCursor } = await import('./api/session/apiChanges');
        vi.mocked(fetchChanges).mockReset().mockImplementation(async () => {
            await fetchChangesBarrier.promise;
            return { status: 'ok', changes: [], nextCursor: '0' };
        });
        vi.mocked(fetchCurrentChangesCursor).mockReset().mockResolvedValue({ status: 'ok', cursor: '0' });
    });

    afterEach(async () => {
        const { sync } = await import('./sync');
        (sync as unknown as { disconnectServer: () => void }).disconnectServer();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('starts Retry before an apply invalidation parked in backoff completes and preserves the unapplied cursor', async () => {
        let changesReads = 0;
        let artifactReads = 0;
        const manualChanges = createDeferred<Response>();
        const fetchMock = stubAccountHttp((url) => {
            if (url.includes('/v2/changes')) {
                changesReads += 1;
                if (changesReads > 1) return manualChanges.promise;
                return Response.json({ changes: [
                    { cursor: 8, kind: 'artifact', entityId: 'a1', changedAt: 8, hint: null },
                    { cursor: 9, kind: 'session', entityId: 's1', changedAt: 9, hint: null },
                ], nextCursor: 9 });
            }
            if (url.includes('/v1/artifacts')) {
                artifactReads += 1;
                return new Response('', { status: 503 });
            }
        });
        const sync = await loadSignedInSyncAfterSocketOutage();
        const { fetchChanges } = await import('./api/session/apiChanges');
        const actualChanges = await vi.importActual<typeof import('./api/session/apiChanges')>('./api/session/apiChanges');
        vi.mocked(fetchChanges).mockImplementation(actualChanges.fetchChanges);
        const internals = sync as unknown as {
            changesCursor: string;
            resumeInFlight: Promise<void> | null;
            artifactsSync: { stop: () => void };
            syncTuning: SyncTuning;
        };
        internals.changesCursor = '7';
        internals.syncTuning = { ...internals.syncTuning, resumeConcurrencyLimit: 1 };
        vi.useFakeTimers();
        const superseded = sync.resumeSync('socket-reconnect');
        try {
            await vi.waitFor(() => expect(artifactReads).toBe(1));
            // Finish the failed attempt's microtasks without advancing its backoff timer.
            await vi.advanceTimersByTimeAsync(0);
            sync.retryNow();
            await vi.advanceTimersByTimeAsync(0);
            expect(changesReads).toBe(2);
            expect(artifactReads).toBe(1);
            expect(internals.changesCursor).toBe('7');
            // The session action was queued behind artifacts in the retired apply.
            // The new manual run is still reading changes, so it cannot own a list read yet.
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/sessions'))).toBe(false);

            manualChanges.resolve(Response.json({ changes: [], nextCursor: 7 }));
            await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v2/sessions'))).toBe(true));
            await superseded;
            expect(internals.changesCursor).toBe('7');
        } finally {
            internals.artifactsSync.stop();
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 7 }));
            await vi.advanceTimersByTimeAsync(0);
            await internals.resumeInFlight;
        }
    }, 60_000);

    it('starts Retry during snapshot repair without waiting for the old core phase or checkpointing its base', async () => {
        let changesReads = 0;
        let machineReads = 0;
        const manualChanges = createDeferred<Response>();
        const fetchMock = stubAccountHttp((url) => {
            if (url.includes('/v2/cursor')) return Response.json({ cursor: 9, changesFloor: 0 });
            if (url.includes('/v2/changes')) {
                changesReads += 1;
                return manualChanges.promise;
            }
            if (url.includes('/v1/machines')) {
                machineReads += 1;
                return new Response('', { status: 503 });
            }
        });
        const sync = await loadSignedInSyncAfterSocketOutage();
        const { fetchChanges, fetchCurrentChangesCursor } = await import('./api/session/apiChanges');
        const actualChanges = await vi.importActual<typeof import('./api/session/apiChanges')>('./api/session/apiChanges');
        vi.mocked(fetchChanges).mockImplementation(actualChanges.fetchChanges);
        vi.mocked(fetchCurrentChangesCursor).mockImplementation(actualChanges.fetchCurrentChangesCursor);
        const internals = sync as unknown as {
            changesCursor: string | null;
            resumeInFlight: Promise<void> | null;
            machinesSync: { stop: () => void };
        };
        internals.changesCursor = null;
        vi.useFakeTimers();
        const superseded = sync.resumeSync('socket-reconnect');
        try {
            await vi.waitFor(() => expect(machineReads).toBe(1));
            await vi.advanceTimersByTimeAsync(0);
            // The manual run has an incremental basis, allowing its start to be observed
            // independently of the old snapshot's still-retrying machines unit.
            internals.changesCursor = '7';
            const readsBeforeRetry = fetchMock.mock.calls.length;
            sync.retryNow();
            await vi.advanceTimersByTimeAsync(0);
            expect(changesReads).toBe(1);
            await superseded;
            expect(internals.changesCursor).toBe('7');
            expect(fetchMock.mock.calls.slice(readsBeforeRetry).some(([url]) => String(url).includes('/v1/artifacts'))).toBe(false);
        } finally {
            internals.machinesSync.stop();
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 7 }));
            await vi.advanceTimersByTimeAsync(0);
            await internals.resumeInFlight;
        }
    }, 60_000);

    it('does not continue issuing HTTP sync requests after app is backgrounded mid-resume', async () => {
        const fetchMock = stubAccountHttp();
        const sync = await loadSignedInSyncAfterSocketOutage();

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

        // The interrupted resume must settle without HTTP work; the foreground transition owns catch-up.
        await promise;
        expect(fetchMock).toHaveBeenCalledTimes(0);

        pauseController.resume();
        await (sync as any).resumeSync('app-foreground');

        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
            expect.arrayContaining([expect.stringContaining('/v2/sessions')]),
        );
    }, 60_000);

    it('runs the manual resume after Retry even when a socket reconnect queues catch-up behind the superseded run', async () => {
        const fetchMock = stubAccountHttp();
        const sync = await loadSignedInSyncAfterSocketOutage();
        (sync as any).changesCursor = '7';
        const { fetchChanges } = await import('./api/session/apiChanges');

        const superseded = (sync as any).resumeSync('socket-reconnect') as Promise<void>;
        await vi.waitFor(() => expect(fetchChanges).toHaveBeenCalledTimes(1));

        sync.retryNow();
        // The reconnected socket asks for catch-up while the superseded resume is still unwinding.
        (sync as any).requestChangesCatchUp();
        const callsBeforeReplacement = fetchMock.mock.calls.length;
        fetchChangesBarrier.resolve();
        await superseded;
        await vi.waitFor(() => expect((sync as any).resumeInFlight).toBeNull(), { timeout: 30_000 });

        // Only the manual resume repairs the outage window; an incremental catch-up returns before it.
        const replacementUrls = fetchMock.mock.calls.slice(callsBeforeReplacement).map((call) => String(call[0]));
        expect(replacementUrls).toEqual(expect.arrayContaining([expect.stringContaining('/v2/sessions')]));
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
