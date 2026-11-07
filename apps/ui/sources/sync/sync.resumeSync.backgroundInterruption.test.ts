import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SESSION_DRAFT_V2_ROUTE_LIST, SessionDraftListResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { PauseController } from '@/utils/timing/pauseController';
import type { SyncTuning } from '@/sync/runtime/syncTuning';
import { createDeferred } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('sync resumeSync background interruption', () => {
    let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
    let home: Awaited<ReturnType<typeof network.addHome>>;
    let changesStarted: Promise<void>;
    let releaseChanges: () => void;
    let startChanges: () => void;
    let changesResponse: Promise<void>;
    let holdChanges: boolean;
    let nextCursor: number;
    let now: number;
    let manualRetryPhase: 'headers' | 'body' | 'profile' | null;
    let stalledSignal: AbortSignal | null | undefined;
    let releaseStall: (() => void) | undefined;
    let mutationSignal: AbortSignal | null | undefined;
    let finishMutation: (() => void) | undefined;
    let onSessionListRead: (() => Promise<Response>) | undefined;
    let onMachineListRead: (() => Promise<Response>) | undefined;
    let onChangesRead: (() => Promise<Response>) | undefined;
    let onProfileRead: (() => Promise<Response>) | undefined;
    let snapshotCursor: number;

    beforeEach(async () => {
        vi.resetModules();
        holdChanges = false;
        manualRetryPhase = null;
        stalledSignal = undefined;
        releaseStall = undefined;
        mutationSignal = undefined;
        finishMutation = undefined;
        onSessionListRead = undefined;
        onMachineListRead = undefined;
        onChangesRead = undefined;
        onProfileRead = undefined;
        snapshotCursor = 0;
        nextCursor = 0;
        now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        changesStarted = new Promise((resolve) => { startChanges = resolve; });
        changesResponse = new Promise((resolve) => { releaseChanges = resolve; });
        network = await installSessionOpsNetworkBoundary();
        home = await network.addHome('https://resume-a.example.test', 'account-resume');
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/mutation-under-retry') return await new Promise<Response>(resolve => {
                mutationSignal = init?.signal;
                finishMutation = () => resolve(Response.json({ ok: true }));
            });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (path === SESSION_DRAFT_V2_ROUTE_LIST) return Response.json(SessionDraftListResponseV2Schema.parse({ items: [] }));
            if (path === '/v1/account/profile') {
                if (onProfileRead) return await onProfileRead();
                if (holdChanges && manualRetryPhase === 'profile') return await new Promise<Response>((_resolve, reject) => {
                    stalledSignal = init?.signal;
                    releaseStall = () => reject(new DOMException('Aborted', 'AbortError'));
                    init?.signal?.addEventListener('abort', releaseStall, { once: true });
                    startChanges();
                });
                return Response.json({ ...profileDefaults, id: home.accountId });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { sessions: { enabled: true, drafts: { enabled: true } } },
            }));
            if (path === '/v2/cursor') return Response.json({ cursor: snapshotCursor, changesFloor: 0 });
            if (path === '/v2/changes') {
                if (onChangesRead) return await onChangesRead();
                if (manualRetryPhase === 'profile') {
                    const after = Number(new URL(String(input)).searchParams.get('after') ?? 0);
                    return Response.json({ changes: after < 1
                        ? [{ cursor: 1, kind: 'account', entityId: 'self', changedAt: 1 }] : [], nextCursor: 1 });
                }
                if (holdChanges && manualRetryPhase) {
                    stalledSignal = init?.signal;
                    startChanges();
                    if (manualRetryPhase === 'headers') return await new Promise<Response>((_resolve, reject) => {
                        releaseStall = () => reject(new DOMException('Aborted', 'AbortError'));
                        init?.signal?.addEventListener('abort', releaseStall, { once: true });
                    });
                    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                        controller.enqueue(new TextEncoder().encode(JSON.stringify({ changes: [], nextCursor: 99 })));
                        releaseStall = () => controller.error(new DOMException('Aborted', 'AbortError'));
                        init?.signal?.addEventListener('abort', releaseStall, { once: true });
                    } }));
                }
                if (holdChanges) { startChanges(); await changesResponse; }
                return Response.json({ changes: [], nextCursor });
            }
            if (path === '/v2/sessions' || path === '/v2/sessions/active') {
                if (path === '/v2/sessions' && onSessionListRead) return await onSessionListRead();
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (path === '/v1/machines') return onMachineListRead ? await onMachineListRead() : Response.json([]);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        const { storage } = await import('./domains/state/storage');
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        // Core readiness precedes catch-up. Settle the real initial resume before
        // holding a subsequent recovery read; first-cursor repair now owns a snapshot.
        const { sync } = await import('./sync');
        await sync.resumeSync('socket-reconnect');
        // The elapsed downtime comes from a real transport disconnect and clock,
        // not synthetic private Sync credentials/encryption or disconnected state.
        // Reachability and Sync have distinct Socket.IO connections for this
        // Home. Only the direct Sync socket owns its measured offline duration.
        const socket = network.socketBoundaries.find((boundary) => (
            boundary.serverUrl === home.serverUrl && boundary.socket.onAny.mock.calls.length > 0
        ));
        expect(socket).toBeDefined();
        socket!.trigger('disconnect', 'transport close');
        now += 1_000;
        network.httpRequests.length = 0;
        holdChanges = true;
    });

    afterEach(async () => {
        releaseStall?.();
        finishMutation?.();
        releaseChanges();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await network.dispose();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(['headers', 'body', 'profile'] as const)('manual Retry releases stalled recovery %s and admits fresh catch-up without a stale checkpoint', async phase => {
        manualRetryPhase = phase;
        const { sync } = await import('./sync');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { apiSocket } = await import('./api/session/apiSocket');
        const { userRequestLeaseOwner } = await import('./runtime/connectivity/userRequestLease');
        const releaseUserRequest = userRequestLeaseOwner.acquire();
        const mutation = apiSocket.request('/mutation-under-retry', { method: 'POST' }, { retry: 'none' })
            .then(response => ({ response }), (error: unknown) => ({ error })).finally(releaseUserRequest);
        await waitForHomeGovernance(() => expect(mutationSignal).toBeDefined());
        const pending = sync.resumeSync('changes-catch-up');
        await changesStarted;
        // The next read returns the real empty-page cursor. The superseded
        // body must never checkpoint its unaccepted response (99).
        holdChanges = false;
        nextCursor = 0;
        try {
            sync.retryNow();
            await waitForHomeGovernance(() => expect(stalledSignal?.aborted).toBe(true));
            expect(mutationSignal?.aborted).toBe(false);
            expect(userRequestLeaseOwner.hasActiveLease()).toBe(true);
            await pending;
            await waitForHomeGovernance(() => expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v2/changes').length).toBeGreaterThanOrEqual(2));
            if (phase === 'profile') {
                expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/account/profile').length).toBeGreaterThanOrEqual(2);
                const { resolveRuntimeFeatureDecisionOrThrow } = await import('./domains/features/featureDecisionInputs');
                expect(await resolveRuntimeFeatureDecisionOrThrow({ featureId: 'sessions.drafts', serverId: home.id }))
                    .toMatchObject({ state: 'enabled' });
                await waitForHomeGovernance(() => expect(network.httpRequests.some(({ url }) => new URL(url).pathname === SESSION_DRAFT_V2_ROUTE_LIST)).toBe(true));
            }
            expect(loadChangesCursor({ serverScope: home.id, accountId: home.accountId })).not.toBe('99');
            finishMutation?.();
            expect(await mutation).toMatchObject({ response: { ok: true } });
        } finally { releaseStall?.(); finishMutation?.(); await Promise.allSettled([pending, mutation]); }
    }, 60_000);

    it('starts Retry while apply is parked in backoff without running retired queued actions or checkpointing', async () => {
        const { sync } = await import('./sync');
        const { profileDefaults } = await import('./domains/profiles/profile');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const owner = sync as unknown as { syncTuning: SyncTuning; resumeInFlight: Promise<void> | null };
        owner.syncTuning = { ...owner.syncTuning, resumeConcurrencyLimit: 1 };
        const manualChanges = createDeferred<Response>();
        const profileAttempt = createDeferred<void>();
        const replacementStarted = createDeferred<void>();
        let changesReads = 0;
        let profileReads = 0;
        onChangesRead = async () => {
            if (++changesReads > 1) {
                replacementStarted.resolve();
                return manualChanges.promise;
            }
            return Response.json({ changes: [
                { cursor: 8, kind: 'account', entityId: 'self', changedAt: 8, hint: null },
                { cursor: 9, kind: 'session', entityId: 'queued-session', changedAt: 9, hint: null },
            ], nextCursor: 9 });
        };
        onProfileRead = async () => {
            profileReads++;
            profileAttempt.resolve();
            return new Response('', { status: 503 });
        };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        const retired = sync.resumeSync('changes-catch-up');
        try {
            await profileAttempt.promise;
            await vi.advanceTimersByTimeAsync(0);
            const requestsAtRetry = network.httpRequests.length;
            sync.retryNow();
            await vi.advanceTimersByTimeAsync(0);
            // IndexedDB/transport phases need real event-loop turns, not backoff time.
            await replacementStarted.promise;
            expect(changesReads).toBe(2);
            expect(profileReads).toBe(1);
            expect(network.httpRequests.slice(requestsAtRetry).some(({ url }) => new URL(url).pathname === '/v2/sessions')).toBe(false);
            await retired;
            expect(loadChangesCursor({ serverScope: home.id, accountId: home.accountId })).not.toBe('9');
            // The autonomous cycle still owns its backoff and can recover later.
            onProfileRead = async () => Response.json({ ...profileDefaults, id: home.accountId });
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 0 }));
            await vi.advanceTimersByTimeAsync(30_000);
            await owner.resumeInFlight;
        } finally {
            onProfileRead = undefined;
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 0 }));
            await vi.advanceTimersByTimeAsync(30_000);
            await Promise.allSettled([retired, owner.resumeInFlight]);
        }
    }, 60_000);

    it('starts Retry during snapshot repair without waiting for its core backoff or accepting its base cursor', async () => {
        const { sync } = await import('./sync');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const owner = sync as unknown as { resumeInFlight: Promise<void> | null };
        const manualChanges = createDeferred<Response>();
        const machineAttempt = createDeferred<void>();
        const replacementStarted = createDeferred<void>();
        let changesReads = 0;
        let machineReads = 0;
        snapshotCursor = 9;
        onChangesRead = async () => {
            if (++changesReads === 1) return Response.json({ error: 'cursor_gone', currentCursor: 9 }, { status: 410 });
            replacementStarted.resolve();
            return manualChanges.promise;
        };
        onMachineListRead = async () => {
            machineReads++;
            machineAttempt.resolve();
            return new Response('', { status: 503 });
        };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        const retired = sync.resumeSync('socket-reconnect');
        try {
            await machineAttempt.promise;
            await vi.advanceTimersByTimeAsync(0);
            const requestsAtRetry = network.httpRequests.length;
            sync.retryNow();
            await vi.advanceTimersByTimeAsync(0);
            await replacementStarted.promise;
            expect(changesReads).toBe(2);
            expect(machineReads).toBe(1);
            await retired;
            expect(loadChangesCursor({ serverScope: home.id, accountId: home.accountId })).not.toBe('9');
            expect(network.httpRequests.slice(requestsAtRetry).some(({ url }) => new URL(url).pathname === '/v1/artifacts')).toBe(false);
            onMachineListRead = undefined;
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 0 }));
            await vi.advanceTimersByTimeAsync(30_000);
            await owner.resumeInFlight;
        } finally {
            onMachineListRead = undefined;
            manualChanges.resolve(Response.json({ changes: [], nextCursor: 0 }));
            await vi.advanceTimersByTimeAsync(30_000);
            await Promise.allSettled([retired, owner.resumeInFlight]);
        }
    }, 60_000);

    it('does not continue issuing HTTP sync requests after app is backgrounded mid-resume', async () => {
        const { sync } = await import('./sync');
        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);
        let resumeFinished = false;
        const resumed = sync.resumeSync('socket-reconnect').then(() => { resumeFinished = true; });
        await changesStarted;

        // Startup can issue a Session census while we await the held changes
        // read. Only requests issued after this boundary describe continuation
        // after backgrounding; earlier traffic cannot falsify that contract.
        const requestsAtBackground = network.httpRequests.length;
        pauseController.pause();
        try {
            releaseChanges();
            await vi.waitFor(() => expect(resumeFinished).toBe(true));
            expect(network.httpRequests.slice(requestsAtBackground)).toEqual([]);
            await resumed;
        } finally {
            holdChanges = false;
            pauseController.resume();
            await Promise.allSettled([resumed]);
        }
        const requestsAtForeground = network.httpRequests.length;
        await sync.resumeSync('app-foreground');
        // Foreground recovery uses changes catch-up, without the snapshot
        // fallback removed in 717576ac290e.
        expect(network.httpRequests.slice(requestsAtForeground)
            .map(({ url }) => new URL(url).pathname)).toContain('/v2/changes');
    }, 60_000);

    it('completes snapshot repair only after a list read started after the old acquisition drains', async () => {
        const { sync } = await import('./sync');
        // Exercise actual owner entrypoints; only the HTTP response is held.
        const owner = sync as unknown as {
            fetchSessions(): Promise<unknown>;
            snapshotRefreshOnResume(opts: { mode: 'long-offline'; reason: string }): Promise<{ status: string }>;
        };
        let reads = 0;
        let releaseOld!: () => void;
        let releaseFresh!: () => void;
        const old = new Promise<void>(resolve => { releaseOld = resolve; });
        const fresh = new Promise<void>(resolve => { releaseFresh = resolve; });
        onSessionListRead = async () => {
            const read = ++reads;
            await (read === 1 ? old : fresh);
            return Response.json({ sessions: [], nextCursor: null, hasNext: false });
        };
        const acquisition = owner.fetchSessions();
        await vi.waitFor(() => expect(reads).toBe(1));
        let finished = false;
        const repair = owner.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh' })
            .then(result => { finished = true; return result; });
        void repair.catch(() => {});
        try {
            // Let the repair reach its read owners while the older response is still held.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            releaseOld();
            await acquisition;
            await vi.waitFor(() => expect(reads).toBe(2));
            expect(finished).toBe(false);
            releaseFresh();
            await expect(repair).resolves.toEqual({ status: 'complete' });
        } finally {
            releaseOld(); releaseFresh();
            await Promise.allSettled([acquisition, repair]);
        }
    }, 60_000);

    it('starts a fresh Machine census for snapshot repair instead of borrowing an older read', async () => {
        const { sync } = await import('./sync');
        const owner = sync as unknown as {
            snapshotRefreshOnResume(opts: { mode: 'long-offline'; reason: string }): Promise<{ status: string }>;
        };
        let reads = 0;
        let releaseOld!: () => void;
        let releaseFresh!: () => void;
        const old = new Promise<void>(resolve => { releaseOld = resolve; });
        const fresh = new Promise<void>(resolve => { releaseFresh = resolve; });
        onMachineListRead = async () => {
            await (++reads === 1 ? old : fresh);
            return Response.json([]);
        };
        const acquisition = sync.refreshMachinesThrottled({ force: true });
        await vi.waitFor(() => expect(reads).toBe(1));
        let finished = false;
        const repair = owner.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh' })
            .then(result => { finished = true; return result; });
        void repair.catch(() => {});
        try {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            releaseOld();
            await acquisition;
            await vi.waitFor(() => expect(reads).toBe(2));
            expect(finished).toBe(false);
            releaseFresh();
            await expect(repair).resolves.toEqual({ status: 'complete' });
        } finally {
            releaseOld(); releaseFresh();
            await Promise.allSettled([acquisition, repair]);
        }
    }, 60_000);

    it('does not checkpoint an in-flight changes cursor after the server scope is reset', async () => {
        const { sync } = await import('./sync');
        const { loadChangesCursor } = await import('./domains/state/persistence');
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        nextCursor = 99;
        const resumed = sync.resumeSync('socket-reconnect');
        await changesStarted;

        await sync.disconnectServer();
        const other = await network.addHome('https://resume-b.example.test', 'account-other');
        await upsertAndActivateServer({ serverUrl: other.serverUrl });
        releaseChanges();
        await resumed;

        expect(loadChangesCursor({ serverScope: other.id, accountId: other.accountId })).toBeNull();
        expect(loadChangesCursor({ serverScope: home.id, accountId: home.accountId })).not.toBe('99');
    }, 60_000);
});
