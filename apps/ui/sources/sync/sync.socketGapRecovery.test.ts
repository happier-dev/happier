import { type SessionMessageV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture } from '@/dev/testkit';

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

vi.mock('@/log', () => ({ log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onReady: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));
vi.mock('@/track', () => ({ initializeTracking: vi.fn(), tracking: null }));

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        // Scoped HTTP reads use the real routing owner with a persisted-credential boundary fixture.
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }) },
    });
});
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        invalidateRequests: vi.fn(),
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import { markSessionSurfaceVisible, markSessionSurfaceHidden } from './domains/session/sessionSurfaceVisibility';
import type { ApiUpdateContainer } from './api/types/apiTypes';
import type { InvalidateSync } from '@/utils/sessions/sync';

type SyncGapTestAccess = {
    appliedServerTarget: ReturnType<typeof getActiveServerSnapshot>;
    serverID: string;
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    sessionMessagesTailDiscontinuityBySessionId: Map<string, { prefixMaxSeq: number; walkCursor: number }>;
    handleUpdate: (update: ApiUpdateContainer) => Promise<void>;
    getOrCreateMessagesSync: (sessionId: string) => InvalidateSync;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-socket-gap';

function message(seq: number) {
    return {
        id: `m${seq}`,
        seq,
        localId: null,
        sidechainId: null,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `m${seq}` } } },
        createdAt: seq,
        updatedAt: seq,
    } satisfies SessionMessageV1;
}

function update(seq: number): ApiUpdateContainer {
    return {
        id: `u${seq}`,
        seq: 100 + seq,
        createdAt: seq,
        body: { t: 'new-message', sid: SESSION_ID, message: message(seq) },
    };
}

function page(seqs: readonly number[], nextAfterSeq: number | null = null): Response {
    return new Response(JSON.stringify({
        messages: seqs.map(message),
        hasMore: nextAfterSeq !== null,
        nextAfterSeq,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function loadedSeqs(): number[] {
    return Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {})
        .map((row) => row.seq ?? 0)
        .sort((left, right) => left - right);
}

async function seedSession(initialSeq = 1): Promise<SyncGapTestAccess> {
    const { sync } = await import('./syncEngine');
    sync.disconnectServer();
    const appliedServer = getActiveServerSnapshot();
    const accountId = 'account-a';
    storage.getState().activateProfileScope({ serverId: appliedServer.serverId, accountId });
    storage.getState().applySessions([createSessionFixture({
        id: SESSION_ID,
        serverId: appliedServer.serverId,
        seq: initialSeq,
        encryptionMode: 'plain',
        metadata: null,
    })]);
    if (initialSeq > 0) storage.getState().applyMessages(SESSION_ID, [{
        id: 'm1', localId: null, createdAt: 1, seq: 1,
        role: 'user', content: { type: 'text', text: 'm1' }, isSidechain: false,
    }]);
    storage.getState().applyMessagesLoaded(SESSION_ID);
    const syncForTest = sync as unknown as SyncGapTestAccess;
    // Direct Sync tests bind the real applied transport/Account normally established by restore.
    syncForTest.appliedServerTarget = appliedServer;
    syncForTest.serverID = accountId;
    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: initialSeq };
    markSessionSurfaceVisible(SESSION_ID, appliedServer.serverId);
    return syncForTest;
}

async function awaitQueue(sync: SyncGapTestAccess): Promise<void> {
    expect(await sync.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 }))
        .toEqual({ status: 'completed' });
}

describe('sync socket gap recovery', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
            if (url.pathname === '/v1/auth/ping') {
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            return requestMock(`${url.pathname}${url.search}`, init);
        });
        markSessionSurfaceHidden(SESSION_ID, getActiveServerSnapshot().serverId);
    });

    afterEach(async () => {
        const { sync } = await import('./syncEngine');
        sync.resetMessageTransport();
        sync.disconnectServer();
        markSessionSurfaceHidden(SESSION_ID, getActiveServerSnapshot().serverId);
        vi.unstubAllGlobals();
    });

    it.each([0, 1])('fetches missing rows from the covered prefix %s when a live row jumps ahead', async (initialSeq) => {
        const sync = await seedSession(initialSeq);
        requestMock.mockImplementation(async (path: string) => {
            const afterSeq = Number(new URL(path, 'http://localhost').searchParams.get('afterSeq'));
            return page([1, 2, 3, 4, 5].filter((seq) => seq > afterSeq));
        });

        await sync.handleUpdate(update(5));
        await awaitQueue(sync);

        expect(loadedSeqs()).toEqual([1, 2, 3, 4, 5]);
        expect(requestMock.mock.calls.some(([path]) => new URL(String(path), 'http://localhost').searchParams.get('afterSeq') === String(initialSeq)))
            .toBe(true);
    });

    it('recovers a second socket gap received while the previous HTTP catch-up is in flight', async () => {
        const sync = await seedSession();
        const firstPage = createDeferred<Response>();
        let requested = false;
        requestMock.mockImplementation(async (path: string) => {
            if (!requested) {
                requested = true;
                return firstPage.promise;
            }
            const afterSeq = Number(new URL(path, 'http://localhost').searchParams.get('afterSeq'));
            return page([2, 3, 4, 5, 6, 7, 8].filter((seq) => seq > afterSeq));
        });

        await sync.handleUpdate(update(5));
        await vi.waitFor(() => expect(requested).toBe(true));
        await sync.handleUpdate(update(8));
        firstPage.resolve(page([2, 3, 4, 5]));
        await awaitQueue(sync);

        expect(loadedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('retains a live sidechain row and accepts terminal main coverage below its session-wide seq', async () => {
        const sync = await seedSession();
        requestMock.mockImplementation(async () => page([2, 3, 4]));
        const sidechainUpdate = update(5);
        if (sidechainUpdate.body.t !== 'new-message') throw new Error('Expected new-message fixture');
        sidechainUpdate.body.message.content = {
            t: 'plain',
            v: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: 'sidechain reply', sidechainId: 'tool-task', isSidechain: true },
                },
            },
        };

        await sync.handleUpdate(sidechainUpdate);
        await awaitQueue(sync);

        expect(loadedSeqs()).toEqual([1, 2, 3, 4]);
        await vi.waitFor(() => {
            expect(storage.getState().sessionMessages[SESSION_ID]?.reducerState.sidechains.get('tool-task'))
                .toEqual([expect.objectContaining({ realID: 'm5', seq: 5, text: 'sidechain reply' })]);
        });
        requestMock.mockClear();
        await sync.getOrCreateMessagesSync(SESSION_ID).invalidateAndAwait();
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('transfers a large live gap to the existing tail-discontinuity owner from the covered prefix', async () => {
        const sync = await seedSession();
        requestMock.mockImplementation(async () => page([599, 600]));

        await sync.handleUpdate(update(600));
        await awaitQueue(sync);

        expect(loadedSeqs()).toEqual([1, 599, 600]);
        expect(sync.sessionMessagesTailDiscontinuityBySessionId.get(SESSION_ID))
            .toEqual({ kind: 'seq', prefixMaxSeq: 1, walkCursor: 599 });
        requestMock.mockClear();
        await sync.getOrCreateMessagesSync(SESSION_ID).invalidateAndAwait();
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('retains the recovery floor when a newer page makes no progress without proving exhaustion', async () => {
        const sync = await seedSession();
        requestMock.mockResolvedValueOnce(page([], 1));

        await sync.handleUpdate(update(5));
        await awaitQueue(sync);

        requestMock.mockClear();
        requestMock.mockImplementation(async () => page([2, 3, 4, 5]));
        await sync.getOrCreateMessagesSync(SESSION_ID).invalidateAndAwait();

        expect(loadedSeqs()).toEqual([1, 2, 3, 4, 5]);
        expect(new URL(String(requestMock.mock.calls[0]?.[0]), 'http://localhost').searchParams.get('afterSeq'))
            .toBe('1');
    });

    it.each([0, 1])('recovers the interval before an outbound acknowledgement through the shared commit owner (prefix: %s)', async (initialSeq) => {
        const syncForTest = await seedSession(initialSeq);
        const { sync } = await import('./sync');
        requestMock.mockImplementation(async (path: string) => {
            const afterSeq = Number(new URL(path, 'http://localhost').searchParams.get('afterSeq'));
            return page([1, 2, 3, 4, 5].filter((seq) => seq > afterSeq));
        });

        sync.commitAckedOutboundUserMessage({
            sessionId: SESSION_ID,
            localId: 'sent-local',
            createdAt: 5,
            rawRecord: { role: 'user', content: { type: 'text', text: 'sent across a gap' } },
            ack: { id: 'm5', seq: 5 },
        });
        await awaitQueue(syncForTest);

        expect(loadedSeqs()).toEqual([1, 2, 3, 4, 5]);
    });

    it('loads an adjacent page from a retained zero gap floor while the reader stays detached', async () => {
        const syncForTest = await seedSession(0);
        const { sync } = await import('./sync');
        sync.onSessionViewportChange(SESSION_ID, { isPinned: false, offsetY: 420, shouldRestoreViewport: true });
        requestMock.mockImplementation(async () => page([599, 600]));
        await syncForTest.handleUpdate(update(600));
        await awaitQueue(syncForTest);
        expect(requestMock).not.toHaveBeenCalled();
        requestMock.mockClear();
        requestMock.mockImplementation(async () => page([1, 2], 2));

        await expect(sync.loadNewerMessages(SESSION_ID)).resolves.toMatchObject({ loaded: 2, hasMore: true, status: 'loaded' });

        expect(new URL(String(requestMock.mock.calls[0]?.[0]), 'http://localhost').searchParams.get('afterSeq')).toBe('0');
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: false, offsetY: 420 });
    });
});
