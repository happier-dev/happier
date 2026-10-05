import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C6/D2a (stale-reopen targeted refetch): when a session becomes visible with stale-message
// markers (rows edited while hidden), onSessionVisible must refetch only the stale region and
// merge it in place — NOT wipe the whole transcript via resetSessionMessages. Previously the
// full reset discarded all paginated older history (and flipped isLoaded:false) to repair a
// single edited row.

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
        getAllKeys() {
            return [...kvStore.keys()];
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

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

vi.mock('@/track', () => ({
    initializeTracking: vi.fn(),
    tracking: null,
    trackPaywallPresented: vi.fn(),
    trackPaywallPurchased: vi.fn(),
    trackPaywallCancelled: vi.fn(),
    trackPaywallRestored: vi.fn(),
    trackPaywallError: vi.fn(),
}));

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        // The disconnected Sync fixture uses real scoped routing and the HTTP boundary.
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }) },
    });
});
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        invalidateRequests: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import { readStoredSessionMessages } from "@happier-dev/session-core/messages";
import type { Message } from "@happier-dev/session-core/messages";
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import {
    readStaleTranscriptMessageIds,
    type DeferredTranscriptMarker,
    type DeferredTranscriptState,
} from './domains/session/realtime/deferredTranscriptState';
import { markSessionSurfaceHidden, markSessionSurfaceVisible } from './domains/session/sessionSurfaceVisibility';

type SyncStaleReopenTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    deferredTranscriptState: DeferredTranscriptState;
    repairDeferredStaleTranscriptRegion: (sessionId: string, minSeq: number, messageIds: ReadonlySet<string>, messageSeqs?: Readonly<Record<string, number>>) => Promise<void>;
    repairSessionTranscriptRevision: (repair: { sessionId: string; minSeq: number; messageIds: string[]; messageSeqs?: Readonly<Record<string, number>> }) => Promise<void>;
    markSessionTranscriptStale: (sessionId: string, marker: DeferredTranscriptMarker) => void;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-stale-reopen';

type TranscriptTextMessage = Extract<Message, { text: string }>;

function readStoredTranscriptText(realID: string): string | undefined {
    return readStoredSessionMessages(storage.getState(), SESSION_ID)
        .find((message): message is TranscriptTextMessage => (
            message.realID === realID
            && (message.kind === 'user-text' || message.kind === 'agent-text')
        ))
        ?.text;
}

function createSession(sessionId: string, seq: number): Session {
    const now = Date.now();
    return {
        id: sessionId,
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

function emptyMessagesResponse(): Response {
    return new Response(
        JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function newerMessageResponse(): Response {
    return new Response(
        JSON.stringify({
            messages: [plainTranscriptApiMessage('mm21', 21, 'missed reply')],
            hasMore: false,
            nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function targetedStaleMessagesResponse(): Response {
    return new Response(
        JSON.stringify({
            messages: [
                {
                    id: 'mm10',
                    seq: 10,
                    localId: null,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'corrected hidden row 10' },
                        },
                    },
                    createdAt: 10,
                    updatedAt: 10_001,
                },
                {
                    // This row is in the fetched stale region, but was not named by a
                    // message-updated event. A region fetch alone must not authorize it.
                    id: 'mm13',
                    seq: 13,
                    localId: null,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'unrelated fetched replacement' },
                        },
                    },
                    createdAt: 13,
                    updatedAt: 13_001,
                },
                {
                    id: 'mm15',
                    seq: 15,
                    localId: null,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'corrected hidden row 15' },
                        },
                    },
                    createdAt: 15,
                    updatedAt: 15_001,
                },
            ],
            nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function plainTranscriptApiMessage(id: string, seq: number, text: string, updatedAt = seq) {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'plain' as const,
            v: {
                role: 'user' as const,
                content: { type: 'text' as const, text },
            },
        },
        createdAt: seq,
        updatedAt,
    };
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

async function seedLoadedHistorySession(historyLength = 20, withStreamSegment = false): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./syncEngine');
    const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
    sync.disconnectServer();

    const history = Array.from({ length: historyLength }, (_unused, index) => buildMessage(`mm${index + 1}`, index + 1));
    if (withStreamSegment) history[14] = {
        id: 'mm15', localId: 'segment15', seq: 15, createdAt: 15, role: 'agent',
        content: [{ type: 'text', text: 'mm15', uuid: 'mm15', parentUUID: null }],
        isSidechain: false,
        meta: { happierStreamSegmentV1: {
            v: 1, segmentKind: 'assistant', segmentLocalId: 'segment15', segmentState: 'streaming', updatedAtMs: 15,
        } },
    };
    storage.getState().applySessions([createSession(SESSION_ID, historyLength)]);
    storage.getState().applyMessages(SESSION_ID, history);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: historyLength };
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    return { sync };
}

describe('sync stale-reopen targeted refetch (C6/D2a)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            // Keep readiness probes real but independent from transcript response fixtures.
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return Promise.resolve(new Response(null, { status: 200 }));
            }
            return requestMock(url, init);
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('preserves loaded older history when reopening a session with a single stale row', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;

        const before = storage.getState().sessionMessages[SESSION_ID];
        const historyCountBefore = before?.messageIdsOldestFirst.length ?? 0;
        expect(historyCountBefore).toBe(20);

        // One row (seq 15) was edited while the session was hidden.
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });

        sync.onSessionVisible(SESSION_ID);
        await sync.refreshSessionMessages(SESSION_ID);
        await expect.poll(() => messagesRequestPaths().some((path) => path.includes('afterSeq=14'))).toBe(true);
        await expect.poll(() => storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);

        const after = storage.getState().sessionMessages[SESSION_ID];
        // The transcript is NOT destructively wiped: it stays loaded and keeps its full history.
        expect(after?.isLoaded).toBe(true);
        expect(after?.messageIdsOldestFirst.length).toBe(historyCountBefore);

        // The refetch is scoped to the stale region (newer-from just below the stale seq),
        // never a full-transcript snapshot reset.
        const paths = messagesRequestPaths();
        expect(paths.length).toBeGreaterThanOrEqual(1);
        expect(paths.some((path) => path.includes('afterSeq=14'))).toBe(true);
    });

    it('keeps stale markers retryable when the targeted refetch fails transiently', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        requestMock
            .mockRejectedValueOnce(new Error('temporary refetch failure'))
            .mockImplementation(() => Promise.resolve(emptyMessagesResponse()));

        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => messagesRequestPaths().filter((path) => path.includes('afterSeq=14')).length)
            .toBe(1);
        await expect.poll(() => storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => messagesRequestPaths().filter((path) => path.includes('afterSeq=14')).length)
            .toBe(2);

        const after = storage.getState().sessionMessages[SESSION_ID];
        expect(after?.isLoaded).toBe(true);
        expect(after?.messageIdsOldestFirst.length).toBe(20);
        consoleErrorSpy.mockRestore();
    });

    it('replaces only exact hidden updates through its targeted stale-region refetch', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;

        requestMock.mockImplementation((path: string) => Promise.resolve(
            String(path).includes('afterSeq=9')
                ? targetedStaleMessagesResponse()
                : emptyMessagesResponse(),
        ));
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 10,
            messageId: 'mm10',
        });
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });

        sync.onSessionVisible(SESSION_ID);

        await expect.poll(() => readStoredTranscriptText('mm10')).toBe('corrected hidden row 10');
        await expect.poll(() => readStoredTranscriptText('mm15')).toBe('corrected hidden row 15');
        expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toEqual(expect.arrayContaining([
            expect.objectContaining({ realID: 'mm13', text: 'mm13' }),
        ]));
    });

    it('batches nearby edits and jumps directly to sparse unloaded rows without moving the viewport or forward coverage', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false, offsetY: 420, shouldRestoreViewport: true, shouldPersistViewport: false,
            anchor: { kind: 'message', messageId: 'mm5', seq: 5, itemId: 'mm5', itemOffsetPx: 12, capturedAtMs: 1 },
        });
        const viewport = sync.getSessionViewport(SESSION_ID);
        const targetWindow = sync.getSessionTargetWindowState(SESSION_ID);
        const serverRows = [10, 11, 1_000, 15_000].map((seq) => plainTranscriptApiMessage(`mm${seq}`, seq, `corrected ${seq}`, seq + 10_000));
        requestMock.mockImplementation((path: string) => {
            const query = new URL(path, 'https://server.test').searchParams;
            const afterSeq = Number(query.get('afterSeq'));
            if (afterSeq === 20) return Promise.resolve(emptyMessagesResponse());
            const matching = serverRows.filter((row) => row.seq > afterSeq);
            const messages = matching.slice(0, Number(query.get('limit')));
            return Promise.resolve(new Response(JSON.stringify({
                messages, nextAfterSeq: matching.length > messages.length ? messages.at(-1)?.seq ?? null : null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });
        for (const seq of [10, 11, 15_000]) syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq, messageId: `mm${seq}`,
        });

        sync.onSessionVisible(SESSION_ID);

        await expect.poll(() => readStoredTranscriptText('mm10')).toBe('corrected 10');
        await expect.poll(() => readStoredTranscriptText('mm15000')).toBe('corrected 15000');
        await expect.poll(() => readStaleTranscriptMessageIds(
            syncForTest.deferredTranscriptState,
            SESSION_ID,
        )).toEqual([]);

        const queries = messagesRequestPaths().map((path) => new URL(path, 'https://server.test').searchParams)
            .filter((query) => query.get('afterSeq') !== '20');
        expect(queries.map((query) => ({ afterSeq: query.get('afterSeq'), limit: query.get('limit') })))
            .toEqual([{ afterSeq: '9', limit: '150' }, { afterSeq: '14999', limit: '150' }]);
        expect(readStoredTranscriptText('mm1000')).toBeUndefined();
        expect(syncForTest.sessionMaterializedMaxSeqById[SESSION_ID]).toBe(20);
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toBe(targetWindow);
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ offsetY: viewport?.offsetY, anchor: viewport?.anchor });
    });

    it('refreshes a materialized stream neighbor omitted by a coalesced hint without admitting unseen spill', async () => {
        const { sync } = await seedLoadedHistorySession(20, true);
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const viewport = sync.getSessionViewport(SESSION_ID);
        const targetWindow = sync.getSessionTargetWindowState(SESSION_ID);
        const rows = [
            plainTranscriptApiMessage('mm5', 5, 'corrected 5', 31),
            { id: 'mm15', seq: 15, localId: 'segment15', createdAt: 15, updatedAt: 30,
                content: { t: 'plain', v: {
                    role: 'agent', content: { type: 'output', data: {
                        type: 'assistant', uuid: 'mm15', message: { content: [{ type: 'text', text: 'coalesced edit' }] },
                    } },
                    meta: { happierStreamSegmentV1: {
                        v: 1, segmentKind: 'assistant', segmentLocalId: 'segment15', segmentState: 'complete', updatedAtMs: 30,
                    } },
                } } },
            plainTranscriptApiMessage('mm15000', 15_000, 'unseen spill'),
        ];
        requestMock.mockImplementation((path: string) => {
            const query = new URL(path, 'https://server.test').searchParams;
            const matching = rows.filter((row) => row.seq > Number(query.get('afterSeq')));
            const messages = matching.slice(0, Number(query.get('limit')));
            return Promise.resolve(new Response(JSON.stringify({
                messages, nextAfterSeq: matching.length > messages.length ? messages.at(-1)?.seq ?? null : null,
            })));
        });

        // The AccountChange producer replaces earlier session hints, not an identity-complete edit journal.
        await syncForTest.repairSessionTranscriptRevision({
            sessionId: SESSION_ID, minSeq: 5, messageIds: ['mm5'], messageSeqs: { mm5: 5 },
        });

        expect(readStoredTranscriptText('mm15')).toBe('coalesced edit');
        expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toHaveLength(20);
        expect(syncForTest.sessionReceivedMessages.get(SESSION_ID)?.has('mm15000')).toBe(false);
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(syncForTest.sessionMaterializedMaxSeqById[SESSION_ID]).toBe(20);
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toBe(targetWindow);
        expect(sync.getSessionViewport(SESSION_ID)).toBe(viewport);
    });

    it('acknowledges a newer already-applied revision without scanning following history', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        syncForTest.markSessionTranscriptStale(SESSION_ID, { updateType: 'message-updated', seq: 15, messageId: 'mm15' });
        syncForTest.sessionReceivedMessages.set(SESSION_ID, new Map([['mm15', 31]]));
        requestMock.mockImplementation((path: string) => Promise.resolve(
            String(path).includes('afterSeq=14')
                ? new Response(JSON.stringify({ messages: [plainTranscriptApiMessage('mm15', 15, 'older revision', 30)], nextAfterSeq: 15 }))
                : emptyMessagesResponse(),
        ));

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 15, new Set(['mm15']));

        expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toEqual([]);
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(readStoredTranscriptText('mm15')).toBe('mm15');
    });

    it('retains missing targets and excludes unseen rows and receipts across sequence gaps', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        for (const seq of [15, 17]) syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq, messageId: `mm${seq}`,
        });
        requestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
            messages: [15, 16, 15_000].map((seq) => plainTranscriptApiMessage(`mm${seq}`, seq, `corrected ${seq}`, seq + 30)),
            nextAfterSeq: null,
        }))));

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 15, new Set(['mm15', 'mm17']), { mm15: 15, mm17: 17 });

        expect(messagesRequestPaths()).toHaveLength(1);
        expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toEqual(['mm17']);
        expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toHaveLength(20);
        expect([...syncForTest.sessionReceivedMessages.get(SESSION_ID)?.keys() ?? []]).toEqual(['mm15', 'mm16']);
        requestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
            messages: [plainTranscriptApiMessage('mm17', 17, 'repaired 17', 47)], nextAfterSeq: null,
        }))));
        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 17, new Set(['mm17']), { mm17: 17 });
        expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toEqual([]);
        expect(readStoredTranscriptText('mm17')).toBe('repaired 17');
    });

    it('retains successful repairs when a later sparse target request fails and retries the missing target', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const seq of [15, 15_000]) syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq, messageId: `mm${seq}`,
        });
        requestMock.mockImplementation((path: string) => {
            const afterSeq = Number(new URL(path, 'https://server.test').searchParams.get('afterSeq'));
            if (afterSeq !== 14) return Promise.reject(new Error('Sparse repair unavailable'));
            return Promise.resolve(new Response(JSON.stringify({
                messages: [plainTranscriptApiMessage('mm15', 15, 'repaired 15', 45)], nextAfterSeq: 15,
            })));
        });
        try {
            await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 15, new Set(['mm15', 'mm15000']), {
                mm15: 15, mm15000: 15_000,
            });
            expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toEqual(['mm15000']);
            expect(readStoredTranscriptText('mm15')).toBe('repaired 15');
            requestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
                messages: [plainTranscriptApiMessage('mm15000', 15_000, 'repaired 15000')], nextAfterSeq: null,
            }))));
            await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 15_000, new Set(['mm15000']), { mm15000: 15_000 });
            expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toEqual([]);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not replay a historical task completion into current session activity during repair', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        storage.getState().applySessions([{ ...createSession(SESSION_ID, 20), thinking: true, thinkingAt: 10 }]);
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'completed-task',
        });
        requestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
            messages: [{
                id: 'completed-task', seq: 15, localId: null, createdAt: 30, updatedAt: 30,
                content: { t: 'plain', v: { role: 'agent', content: {
                    type: 'codex', data: { type: 'task_complete', id: 'historical-task' },
                } } },
            }], nextAfterSeq: null,
        }))));

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, 15, new Set(['completed-task']));

        expect(storage.getState().sessions[SESSION_ID].thinking).toBe(true);
        expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toHaveLength(20);
    });

    it('does not resurrect a deleted session when a stale targeted refetch finishes late', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        let releaseStaleRefetch!: (response: Response) => void;
        const staleRefetchResponse = new Promise<Response>((resolve) => {
            releaseStaleRefetch = resolve;
        });

        requestMock.mockImplementation((path: string) => (
            String(path).includes('afterSeq=14')
                ? staleRefetchResponse
                : Promise.resolve(emptyMessagesResponse())
        ));
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => messagesRequestPaths().some((path) => path.includes('afterSeq=14'))).toBe(true);

        // Keep active-server membership deliberately intact: the local delete must
        // still win over a response that was authorized before the delete arrived.
        storage.getState().deleteSession(SESSION_ID);
        releaseStaleRefetch(targetedStaleMessagesResponse());
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(storage.getState().sessions[SESSION_ID]).toBeUndefined();
        expect(storage.getState().sessionMessages[SESSION_ID]).toBeUndefined();
        expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toEqual([]);
    });

    it.each(['success', 'failure'] as const)('keeps catch-up active until a hidden-edit repair settles with %s after the tail probe', async (outcome) => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const oldRow = readStoredSessionMessages(storage.getState(), SESSION_ID)
            .find((message) => message.realID === 'mm1');
        expect(oldRow).toBeDefined();
        markSessionSurfaceVisible(SESSION_ID);
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'mm15',
        });

        let settleRepair: () => void = () => { throw new Error('Repair request was not issued'); };
        requestMock.mockImplementation((path: string) => {
            if (!String(path).includes('afterSeq=14')) return Promise.resolve(emptyMessagesResponse());
            return new Promise<Response>((resolve, reject) => {
                settleRepair = () => {
                    if (outcome === 'failure') {
                        reject(new Error('Hidden-edit repair unavailable'));
                        return;
                    }
                    resolve(new Response(JSON.stringify({
                        messages: [plainTranscriptApiMessage('mm15', 15, 'edited while hidden', 30)],
                        nextAfterSeq: null,
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                };
            });
        });

        try {
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);
            expect(messagesRequestPaths().filter((path) => path.includes('afterSeq=14'))).toHaveLength(1);
            expect(messagesRequestPaths().some((path) => path.includes('afterSeq=20'))).toBe(true);
            // The tail probe has settled while exact hidden-update repair remains pending.
            expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(true);
            expect(storage.getState().sessionMessages[SESSION_ID].isLoaded).toBe(true);
            expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toContain(oldRow);

            settleRepair();
            await expect.poll(() => storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);
            const rows = readStoredSessionMessages(storage.getState(), SESSION_ID);
            expect(rows).toHaveLength(20);
            expect(rows.find((message) => message.realID === 'mm1')).toBe(oldRow);
            expect(readStoredTranscriptText('mm15')).toBe(outcome === 'success' ? 'edited while hidden' : 'mm15');
        } finally {
            settleRepair();
            await new Promise((resolve) => setTimeout(resolve, 0));
            markSessionSurfaceHidden(SESSION_ID);
        }
    });

    it('probes the loaded transcript tail once when reopening with a stale equal sequence hint', async () => {
        const { sync } = await seedLoadedHistorySession();
        markSessionSurfaceVisible(SESSION_ID);
        requestMock.mockImplementation((path: string) => Promise.resolve(
            String(path).includes('afterSeq=20') ? newerMessageResponse() : emptyMessagesResponse(),
        ));

        try {
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);

            expect(messagesRequestPaths().filter((path) => path.includes('afterSeq=20'))).toHaveLength(1);
            expect(readStoredSessionMessages(storage.getState(), SESSION_ID))
                .toContainEqual(expect.objectContaining({ realID: 'mm21', seq: 21 }));
        } finally {
            markSessionSurfaceHidden(SESSION_ID);
        }
    });

    it('repairs a second hidden edit received while an older same-row repair is in flight', async () => {
        const { getActiveServerSnapshot } = await import('./domains/server/serverRuntime');
        const appliedServer = getActiveServerSnapshot();
        storage.getState().activateProfileScope({ serverId: appliedServer.serverId, accountId: 'account-a' });
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess & {
            appliedServerTarget: typeof appliedServer;
            serverID: string;
            handleUpdate: (update: import('./api/types/apiTypes').ApiUpdateContainer) => Promise<void>;
        };
        // Bind the real socket authority normally established by restore, as in
        // the neighboring real-Sync socket-gap fixture.
        syncForTest.appliedServerTarget = appliedServer;
        syncForTest.serverID = 'account-a';
        storage.getState().applySessions([{ ...createSession(SESSION_ID, 20), serverId: appliedServer.serverId }]);
        const deliverHiddenEdit = async (updatedAt: number, text: string) => {
            await syncForTest.handleUpdate({
                id: `edit-${updatedAt}`, seq: updatedAt, createdAt: updatedAt,
                body: { t: 'message-updated', sid: SESSION_ID, message: plainTranscriptApiMessage('mm15', 15, text, updatedAt) },
            });
        };
        let releaseOldRepair: (response: Response) => void = () => { throw new Error('Repair request was not issued'); };
        const oldRepair = new Promise<Response>((resolve) => { releaseOldRepair = resolve; });
        let repairRequests = 0;
        const responseForEdit = (text: string, updatedAt: number) => new Response(JSON.stringify({
            messages: [plainTranscriptApiMessage('mm15', 15, text, updatedAt)], nextAfterSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        requestMock.mockImplementation((path: string) => {
            if (!String(path).includes('afterSeq=14')) return Promise.resolve(emptyMessagesResponse());
            repairRequests += 1;
            return repairRequests === 1 ? oldRepair : Promise.resolve(responseForEdit('second hidden edit', 40));
        });

        try {
            markSessionSurfaceHidden(SESSION_ID, appliedServer.serverId);
            await deliverHiddenEdit(30, 'first hidden edit');
            expect(readStaleTranscriptMessageIds(syncForTest.deferredTranscriptState, SESSION_ID)).toContain('mm15');
            expect(readStoredTranscriptText('mm15')).toBe('mm15');

            markSessionSurfaceVisible(SESSION_ID, appliedServer.serverId);
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);
            await expect.poll(() => repairRequests).toBe(1);

            markSessionSurfaceHidden(SESSION_ID, appliedServer.serverId);
            await deliverHiddenEdit(40, 'second hidden edit');
            expect(readStoredTranscriptText('mm15')).toBe('mm15');
            releaseOldRepair(responseForEdit('first hidden edit', 30));
            await expect.poll(() => storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);

            markSessionSurfaceVisible(SESSION_ID, appliedServer.serverId);
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);
            await expect.poll(() => readStoredTranscriptText('mm15')).toBe('second hidden edit');
            expect(readStoredSessionMessages(storage.getState(), SESSION_ID)).toHaveLength(20);
        } finally {
            releaseOldRepair(responseForEdit('first hidden edit', 30));
            markSessionSurfaceHidden(SESSION_ID, appliedServer.serverId);
            sync.resetMessageTransport();
            sync.disconnectServer();
        }
    });
});
