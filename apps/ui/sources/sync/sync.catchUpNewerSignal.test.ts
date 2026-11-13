import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// §13 catch-up-newer signal: a NORMAL on-open catch-up (a loaded session that advanced in the
// background) runs its newer fetches directly inside `fetchMessages` — NOT through
// `loadNewerMessages` — so that path must bracket the `beginSessionCatchUpNewer` /
// `endSessionCatchUpNewer` signal itself; otherwise the bottom-anchored "Catching up…" overlay
// never shows for the most common catch-up. The first-ever snapshot load is intentionally NOT
// bracketed (initial open shows the normal transcript, not a catch-up overlay).

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

const requestMock = vi.hoisted(() => vi.fn());
const externalTranscriptPageMock = vi.hoisted(() => vi.fn());
const externalTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getPersistenceStorage } from './domains/state/persistenceStorage';
import { profileDefaults } from './domains/profiles/profile';
import type { InvalidateSync } from '@/utils/sessions/sync';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';

installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event, payload: unknown) => {
        if (!payload || typeof payload !== 'object' || !('method' in payload) || !('params' in payload)) {
            return { ok: false, error: 'Machine method unavailable', errorCode: 'METHOD_NOT_AVAILABLE' };
        }
        if (payload.method === `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE}`) {
            return { ok: true, result: await externalTranscriptPageMock(payload.params) };
        }
        if (payload.method === `machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`) {
            return { ok: true, result: await externalTranscriptReadAfterMock(payload.params) };
        }
        return { ok: false, error: 'Machine method unavailable', errorCode: 'METHOD_NOT_AVAILABLE' };
    });
});
const { storage } = await import('./domains/state/storageStore');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

async function restoreTestHome(serverUrl = 'https://transcript-tests.example'): Promise<void> {
    await account?.dispose();
    account = await restoreServerAccountForTest({
        serverUrl,
        accountId: 'transcript-account',
        request: async (url, init) => {
            const requestUrl = new URL(String(url));
            const path = requestUrl.pathname + requestUrl.search;
            if (requestUrl.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (requestUrl.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (requestUrl.pathname === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            if (requestUrl.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (requestUrl.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'transcript-account' });
            if (requestUrl.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (requestUrl.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, machineId => machineId === 'machine-1'
                    ? createPlainMachineRowFixture({ id: machineId, accountId: 'transcript-account', machine: createOfflineMachine() })
                    : null);
            }
            if (requestUrl.pathname.includes('/messages') || requestUrl.pathname === '/v2/sessions/parent') {
                return await requestMock(path, init);
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
    // Offline transcript authority needs the Profile's admitted Account scope.
    // Drain its real bootstrap read before seeding Sessions and Machines.
    const { sync } = await import('./syncEngine');
    await (sync as unknown as { profileSync: Pick<InvalidateSync, 'awaitQueue'> }).profileSync.awaitQueue();
}
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Machine, Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";

type SyncCatchUpTestAccess = {
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-catchup-newer-signal';

function createSession(sessionId: string, seq: number): Session {
    if (!account) throw new Error('Session fixtures require a restored Home');
    const now = Date.now();
    return {
        id: sessionId,
        serverId: account.serverId,
        seq,
        encryptionMode: 'plain',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function buildMessage(id: string, seq: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: seq,
        role: 'user',
        content: { type: 'text', text: id },
        seq,
        isSidechain: false,
    };
}

function createExternalSession(
    currentStorageState: 'machine_only' | 'snapshot_complete',
): Session {
    return {
        ...createSession(SESSION_ID, 1),
        currentStorageState,
        ...(currentStorageState === 'snapshot_complete'
            ? {
                publishedThroughServerSeq: 1,
                materializedThroughSourceAt: 1,
                transcriptShareable: true,
            }
            : {}),
        metadata: {
            path: '/workspace',
            host: 'test-host',
            machineId: 'machine-1',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
                linkedAtMs: 1,
                qualifiedIdentity: {
                    v: 1,
                    agent: { pluginId: 'happier.codex', localId: 'codex' },
                    source: { kind: 'codexHome', contractVersion: 1 },
                },
            },
        },
    };
}

function createOfflineMachine(): Machine {
    return {
        id: 'machine-1',
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function emptyMessagesResponse(): Response {
    return new Response(
        JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met within 2000ms');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function deferredValue<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

/** Defer the next message-fetch request (snapshot or `afterSeq` newer) so the in-flight window is observable. */
function deferMessagesFetch(): { resolve: () => void; wasIssued: () => boolean } {
    let resolvePending: ((response: Response) => void) | null = null;
    requestMock.mockImplementation((path: string) => {
        if (String(path).includes('/messages?') && !String(path).includes('beforeSeq=')) {
            return new Promise<Response>((resolve) => {
                resolvePending = resolve;
            });
        }
        return Promise.resolve(emptyMessagesResponse());
    });
    return {
        resolve: () => {
            resolvePending?.(emptyMessagesResponse());
            resolvePending = null;
        },
        wasIssued: () => resolvePending !== null,
    };
}

function catchUpInFlight(): number {
    return storage.getState().sessionCatchUpNewerInFlight[SESSION_ID] ?? 0;
}

async function seedLoadedSession(
    materializedMaxSeq: number,
    sessionSeq: number,
    options: Readonly<{ withMaterializedMessage?: boolean }> = {},
): Promise<typeof import('./sync').sync> {
    const { sync } = await import('./syncEngine');
    const t = sync as unknown as SyncCatchUpTestAccess;
    storage.getState().applySessions([createSession(SESSION_ID, sessionSeq)]);
    if (options.withMaterializedMessage !== false && materializedMaxSeq > 0) {
        storage.getState().applyMessages(SESSION_ID, [buildMessage(`m${materializedMaxSeq}`, materializedMaxSeq)]);
    }
    storage.getState().applyMessagesLoaded(SESSION_ID);
    t.activeServerSessionIds = new Set<string>([SESSION_ID]);
    t.hasFetchedSessionsSnapshotForActiveServer = true;
    t.isForeground = true;
    t.sessionMaterializedMaxSeqById = { [SESSION_ID]: materializedMaxSeq };
    markSessionSurfaceVisible(SESSION_ID);
    return sync;
}

await loadSyncSingletonForTests();

describe('§13 catch-up-newer signal brackets the on-open catch-up', () => {
    it('reports a materialized complete history without an older network cursor', async () => {
        const { sync } = await import('./syncEngine');
        const sessionId = 'complete-local-history';
        storage.getState().applySessions([createSession(sessionId, 1)]);
        storage.getState().applyMessages(sessionId, [buildMessage('first', 1)]);
        storage.getState().applyMessagesLoaded(sessionId);
        expect(sync.getSessionOlderMessagesAvailability(sessionId)).toBeNull();
        storage.getState().markSessionMessagesHistoryStartLoaded(sessionId);
        expect(sync.getSessionOlderMessagesAvailability(sessionId)).toBe(false);
    });
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await loadSyncSingletonForTests();
        getPersistenceStorage().clearAll();
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        await restoreTestHome();
        externalTranscriptPageMock.mockReset();
        externalTranscriptReadAfterMock.mockReset();
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        webLocks.restore();
        markSessionSurfaceHidden(SESSION_ID);
        resetSessionSurfaceVisibilityForTests();
        vi.unstubAllGlobals();
    });

    it('retains authoritative older exhaustion from the initial snapshot even without a tail gap', async () => {
        const sync = await seedLoadedSession(0, 1, { withMaterializedMessage: false });
        requestMock.mockResolvedValue(emptyMessagesResponse());
        await sync.refreshSessionMessages(SESSION_ID);
        expect(sync.getSessionOlderMessagesAvailability(SESSION_ID)).toBe(false);
    });

    it('reports a failed newer page honestly, preserves rows, and allows the next read to recover', async () => {
        const sync = await seedLoadedSession(10, 20);
        const rowsBefore = storage.getState().sessionMessages[SESSION_ID];
        requestMock.mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 503 }));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(sync.loadNewerMessages(SESSION_ID)).resolves.toMatchObject({ loaded: 0, hasMore: true, status: 'retryable_error' });
            expect(storage.getState().sessionMessages[SESSION_ID]).toBe(rowsBefore);
            expect(catchUpInFlight()).toBe(0);
            requestMock.mockImplementation(async () => emptyMessagesResponse());
            await expect(sync.loadNewerMessages(SESSION_ID)).resolves.toMatchObject({ status: 'no_more' });
        } finally { errors.mockRestore(); }
    });

    it('flips sessionCatchUpNewerInFlight while a normal on-open incremental newer catch-up runs, and clears it after', async () => {
        // A loaded session that advanced in the background: materialized seq 10 < session seq 20.
        const sync = await seedLoadedSession(10, 20);
        const deferred = deferMessagesFetch();

        expect(catchUpInFlight()).toBe(0);
        const refresh = sync.refreshSessionMessages(SESSION_ID);

        // The newer fetch is in flight → the overlay signal is set.
        await waitFor(() => deferred.wasIssued());
        expect(catchUpInFlight()).toBeGreaterThan(0);
        expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(true);

        deferred.resolve();
        await refresh;

        // Settled → signal cleared (overlay hides).
        expect(catchUpInFlight()).toBe(0);
        expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);
    });

    it('does NOT flip the signal for a first-ever snapshot load (initial open is not "catching up")', async () => {
        const { sync } = await import('./syncEngine');
        const t = sync as unknown as SyncCatchUpTestAccess;
            // Never-loaded session → fetchMessages takes the snapshot branch, which is intentionally
        // NOT bracketed (initial load shows the normal transcript, not a "Catching up…" overlay).
        storage.getState().applySessions([createSession(SESSION_ID, 20)]);
        t.activeServerSessionIds = new Set<string>([SESSION_ID]);
        t.hasFetchedSessionsSnapshotForActiveServer = true;
        t.isForeground = true;
        markSessionSurfaceVisible(SESSION_ID);
        const deferred = deferMessagesFetch();

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => deferred.wasIssued());

        // The snapshot is in flight, but the catch-up signal must stay clear.
        expect(catchUpInFlight()).toBe(0);
        expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);

        deferred.resolve();
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });

    it('flips the signal when a previously loaded empty transcript catches up its first durable activity', async () => {
        const sync = await seedLoadedSession(0, 1, { withMaterializedMessage: false });
        const deferred = deferMessagesFetch();

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => deferred.wasIssued());

        expect(catchUpInFlight()).toBeGreaterThan(0);
        expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(true);

        deferred.resolve();
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });

    it('flips the signal while a loaded empty external transcript recovers from its live Agent', async () => {
        const { sync } = await import('./sync');
        const t = sync as unknown as SyncCatchUpTestAccess;
        storage.getState().applyMachines([createMachineFixture({
            id: 'machine-1', active: true, activeAt: Date.now(), storageMode: 'plain',
        })]);
        observeMachinePresenceForTest({ serverId: account!.serverId, accountId: 'transcript-account' }, ['machine-1']);
            storage.getState().applySessions([createExternalSession('machine_only')]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        t.activeServerSessionIds = new Set([SESSION_ID]);
        t.hasFetchedSessionsSnapshotForActiveServer = true;
        t.isForeground = true;
        t.sessionMaterializedMaxSeqById = { [SESSION_ID]: 0 };
        markSessionSurfaceVisible(SESSION_ID);
        const page = deferredValue<{
            ok: true;
            items: [];
            nextCursor: null;
            tailCursor: string;
            hasMore: false;
        }>();
        externalTranscriptPageMock.mockReturnValue(page.promise);
        externalTranscriptReadAfterMock.mockResolvedValue({
            ok: true,
            items: [],
            nextCursor: 'tail-1',
            truncated: false,
        });

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => externalTranscriptPageMock.mock.calls.length > 0);

        expect(catchUpInFlight()).toBeGreaterThan(0);

        page.resolve({
            ok: true,
            items: [],
            nextCursor: null,
            tailCursor: 'tail-1',
            hasMore: false,
        });
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });

    it('flips the signal while a loaded empty external transcript recovers from its server snapshot', async () => {
        const { sync } = await import('./sync');
        const t = sync as unknown as SyncCatchUpTestAccess;
            storage.getState().applyMachines([createOfflineMachine()]);
        observeMachinePresenceForTest({ serverId: account!.serverId, accountId: 'transcript-account' }, ['machine-1']);
        storage.getState().applySessions([createExternalSession('snapshot_complete')]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        t.activeServerSessionIds = new Set([SESSION_ID]);
        t.hasFetchedSessionsSnapshotForActiveServer = true;
        t.isForeground = true;
        t.sessionMaterializedMaxSeqById = { [SESSION_ID]: 0 };
        markSessionSurfaceVisible(SESSION_ID);
        const deferred = deferMessagesFetch();

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => deferred.wasIssued());

        expect(catchUpInFlight()).toBeGreaterThan(0);

        deferred.resolve();
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });
});
