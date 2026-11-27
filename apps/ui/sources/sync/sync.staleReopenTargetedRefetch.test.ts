import { beforeEach, describe, expect, it, vi } from 'vitest';

// C6/D2a (stale-reopen targeted refetch): when a session becomes visible with stale-message
// markers (rows edited while hidden), onSessionVisible must refetch only the stale region and
// merge it in place — NOT wipe the whole transcript via resetSessionMessages. Today the full
// reset discards all paginated older history (and flips isLoaded:false) to repair a single
// edited row.

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
}));

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
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
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';
import type { DeferredTranscriptMarker, DeferredTranscriptState } from './domains/session/realtime/deferredTranscriptState';
import { registerSessionVisibleSurface } from './domains/session/activeViewingSession';

type SyncStaleReopenTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    deferredTranscriptState: DeferredTranscriptState;
    repairDeferredStaleTranscriptRegion: (sessionId: string, snapshot: { minSeq: number; messageIds: string[]; messageSeqs?: Readonly<Record<string, number>> }) => Promise<void>;
    repairSessionTranscriptRevision: (repair: { sessionId: string; minSeq: number; messageIds: string[]; messageSeqs?: Readonly<Record<string, number>> }) => Promise<void>;
    markSessionTranscriptStale: (sessionId: string, marker: DeferredTranscriptMarker) => void;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-stale-reopen';

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
            messages: [{
                id: 'mm21',
                seq: 21,
                localId: null,
                sidechainId: null,
                content: {
                    t: 'plain',
                    v: { role: 'user', content: { type: 'text', text: 'missed reply' } },
                },
                createdAt: 21,
                updatedAt: 21,
            }],
            hasMore: false,
            nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

function messagePageResponse(rows: Array<{ id: string; seq: number; updatedAt?: number }>, hasMore = false): Response {
    return new Response(JSON.stringify({
        messages: rows.map((row) => ({
            ...row,
            localId: null,
            createdAt: row.seq,
            updatedAt: row.updatedAt ?? row.seq,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: row.id } } },
        })),
        hasMore,
        nextAfterSeq: hasMore ? rows.at(-1)?.seq ?? null : null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function targetedStaleRefetchPaths(): string[] {
    return messagesRequestPaths().filter((path) => path.includes('afterSeq=14'));
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function seedLoadedHistorySession(options: { withStreamSegment?: boolean } = {}): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
    sync.disconnectServer();

    const history = Array.from({ length: 20 }, (_unused, index) => buildMessage(`mm${index + 1}`, index + 1));
    if (options.withStreamSegment) {
        history[14] = {
            id: 'mm15', localId: 'segment15', seq: 15, createdAt: 15, role: 'agent',
            content: [{ type: 'text', text: 'mm15', uuid: 'mm15', parentUUID: null }],
            isSidechain: false,
            meta: { happierStreamSegmentV1: {
                v: 1, segmentKind: 'assistant', segmentLocalId: 'segment15',
                segmentState: 'streaming', updatedAtMs: 15,
            } },
        };
    }
    storage.getState().applySessions([createSession(SESSION_ID, 20)]);
    storage.getState().applyMessages(SESSION_ID, history);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 20 };
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    return { sync };
}

describe('sync stale-reopen targeted refetch (C6/D2a)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
    });

    it('refreshes a materialized neighbor omitted by a coalesced revision hint without admitting unseen spill', async () => {
        const { sync } = await seedLoadedHistorySession({ withStreamSegment: true });
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const viewport = sync.getSessionViewport(SESSION_ID);
        const targetWindow = sync.getSessionTargetWindowState(SESSION_ID);
        const rows = [
            { id: 'mm5', seq: 5, localId: null, createdAt: 5, updatedAt: 31,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'mm5' } } } },
            { id: 'mm15', seq: 15, localId: 'segment15', createdAt: 15, updatedAt: 30,
                content: { t: 'plain', v: {
                    role: 'agent', content: { type: 'output', data: {
                        type: 'assistant', uuid: 'mm15', message: { content: [{ type: 'text', text: 'coalesced edit' }] },
                    } },
                    meta: { happierStreamSegmentV1: {
                        v: 1, segmentKind: 'assistant', segmentLocalId: 'segment15',
                        segmentState: 'complete', updatedAtMs: 30,
                    } },
                } } },
            { id: 'mm15000', seq: 15_000, localId: null, createdAt: 15_000, updatedAt: 15_000,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unseen spill' } } } },
        ];
        requestMock.mockImplementation((path: string) => {
            const query = new URL(path, 'https://server.test').searchParams;
            const matching = rows.filter((row) => row.seq > Number(query.get('afterSeq')));
            const page = matching.slice(0, Number(query.get('limit')));
            return Promise.resolve(new Response(JSON.stringify({
                messages: page, hasMore: matching.length > page.length,
                nextAfterSeq: matching.length > page.length ? page.at(-1)?.seq : null,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });

        // AccountChange replaces a session's previous hint; the later mm5 edit hides mm15's identity.
        await syncForTest.repairSessionTranscriptRevision({
            sessionId: SESSION_ID, minSeq: 5, messageIds: ['mm5'], messageSeqs: { mm5: 5 },
        });

        const storedRows = Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById);
        expect(storedRows.find((row) => row.realID === 'mm15')).toMatchObject({ text: 'coalesced edit' });
        expect(storedRows).toHaveLength(20);
        expect(syncForTest.sessionReceivedMessages.get(SESSION_ID)?.has('mm15000')).toBe(false);
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(syncForTest.sessionMaterializedMaxSeqById[SESSION_ID]).toBe(20);
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toBe(targetWindow);
        expect(sync.getSessionViewport(SESSION_ID)).toBe(viewport);
    });

    it('batches adjacent stale rows and jumps directly to sparse unloaded edits without changing the viewport or forward coverage', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false, offsetY: 420, shouldRestoreViewport: true, shouldPersistViewport: false,
            anchor: { kind: 'message', messageId: 'mm5', seq: 5, itemId: 'mm5', itemOffsetPx: 12, capturedAtMs: 1 },
        });
        const viewport = sync.getSessionViewport(SESSION_ID);
        const targetWindow = sync.getSessionTargetWindowState(SESSION_ID);
        for (const seq of [15, 16, 15_000]) {
            syncForTest.markSessionTranscriptStale(SESSION_ID, {
                updateType: 'message-updated', seq, messageId: `mm${seq}`,
            });
        }
        const serverRows = [15, 16, 17, 1_000, 15_000].map((seq) => ({ id: `mm${seq}`, seq }));
        requestMock.mockImplementation((path: string) => {
            const query = new URL(path, 'https://server.test').searchParams;
            const afterSeq = Number(query.get('afterSeq'));
            if (afterSeq === 20) return Promise.resolve(emptyMessagesResponse());
            const matching = serverRows.filter((row) => row.seq > afterSeq);
            const page = matching.slice(0, Number(query.get('limit')));
            return Promise.resolve(messagePageResponse(page, matching.length > page.length));
        });

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toBeUndefined();

        const repairQueries = messagesRequestPaths()
            .map((path) => new URL(path, 'https://server.test').searchParams)
            .filter((query) => query.get('afterSeq') !== '20');
        expect(repairQueries.map((query) => ({ afterSeq: query.get('afterSeq'), limit: query.get('limit') })))
            .toEqual([{ afterSeq: '14', limit: '150' }, { afterSeq: '14999', limit: '150' }]);
        expect(Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById).map((row) => row.realID))
            .not.toContain('mm1000');
        expect(syncForTest.sessionMaterializedMaxSeqById[SESSION_ID]).toBe(20);
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toBe(targetWindow);
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ offsetY: viewport?.offsetY, anchor: viewport?.anchor });
    });

    it('acknowledges an already-current revision without scanning the following history', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'mm15',
        });
        syncForTest.sessionReceivedMessages.set(SESSION_ID, new Map([['mm15', 30]]));
        requestMock.mockImplementation((path: string) => Promise.resolve(
            String(path).includes('afterSeq=14')
                ? messagePageResponse([{ id: 'mm15', seq: 15, updatedAt: 30 }], true)
                : emptyMessagesResponse(),
        ));

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, { minSeq: 15, messageIds: ['mm15'] });

        expect(syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toBeUndefined();
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(storage.getState().sessionMessages[SESSION_ID].messageIdsOldestFirst).toHaveLength(20);
    });

    it('keeps missing target markers retryable and ignores unseen rows returned across sequence gaps', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        for (const seq of [15, 17]) {
            syncForTest.markSessionTranscriptStale(SESSION_ID, {
                updateType: 'message-updated', seq, messageId: `mm${seq}`,
            });
        }
        requestMock.mockResolvedValue(messagePageResponse([
            { id: 'mm15', seq: 15 }, { id: 'mm16', seq: 16 }, { id: 'mm15000', seq: 15_000 },
        ], true));
        const snapshot = { minSeq: 15, messageIds: ['mm15', 'mm17'], messageSeqs: { mm15: 15, mm17: 17 } };

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, snapshot);

        expect(messagesRequestPaths()).toHaveLength(1);
        expect(syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toEqual(['mm15', 'mm17']);
        expect(storage.getState().sessionMessages[SESSION_ID].messageIdsOldestFirst).toHaveLength(20);
        expect([...syncForTest.sessionReceivedMessages.get(SESSION_ID)?.keys() ?? []]).toEqual(['mm15', 'mm16']);

        requestMock.mockResolvedValue(messagePageResponse([{ id: 'mm15', seq: 15 }, { id: 'mm17', seq: 17 }]));
        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, snapshot);
        expect(syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toBeUndefined();
    });

    it('does not replay historical task completion into current activity during repair', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        storage.getState().applySessions([{ ...createSession(SESSION_ID, 20), thinking: true, thinkingAt: 10 }]);
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'completed-task',
        });
        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [{
                id: 'completed-task', seq: 15, localId: null, createdAt: 30, updatedAt: 30,
                content: { t: 'plain', v: { role: 'agent', content: {
                    type: 'codex', data: { type: 'task_complete', id: 'historical-task' },
                } } },
            }],
            hasMore: false, nextAfterSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        await syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, { minSeq: 15, messageIds: ['completed-task'] });

        expect(storage.getState().sessions[SESSION_ID].thinking).toBe(true);
        expect(storage.getState().sessionMessages[SESSION_ID].messageIdsOldestFirst).toHaveLength(20);
        expect(syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toBeUndefined();
    });

    it('retains a newer revision of the same message that arrives while repair is in flight', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'mm15',
        });
        let resolveRequest: (response: Response) => void = () => {
            throw new Error('Repair request was not issued');
        };
        requestMock.mockImplementation(() => new Promise<Response>((resolve) => {
            resolveRequest = resolve;
        }));
        const snapshot = {
            minSeq: 15,
            messageIds: ['mm15'],
            messageSeqs: { mm15: 15 },
        };

        const repair = syncForTest.repairDeferredStaleTranscriptRegion(SESSION_ID, snapshot);
        await expect.poll(() => messagesRequestPaths().length).toBe(1);
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated', seq: 15, messageId: 'mm15',
        });
        resolveRequest(messagePageResponse([{ id: 'mm15', seq: 15 }]));
        await repair;

        expect(syncForTest.deferredTranscriptState.staleMessageIdsBySessionId[SESSION_ID]).toEqual(['mm15']);
        expect(syncForTest.deferredTranscriptState.staleMessageSeqsBySessionId[SESSION_ID]).toEqual({ mm15: 15 });
    });

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

    it('keeps stale row markers until targeted refetch succeeds so visibility can retry', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });
        requestMock
            .mockRejectedValueOnce(new Error('transient stale refetch failure'))
            .mockImplementation(() => Promise.resolve(emptyMessagesResponse()));

        sync.onSessionVisible(SESSION_ID);
        await flushAsyncWork();

        expect(targetedStaleRefetchPaths()).toHaveLength(1);

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => targetedStaleRefetchPaths().length, { timeout: 250 }).toBe(2);

        expect(storage.getState().sessionMessages[SESSION_ID]?.isLoaded).toBe(true);
        expect(storage.getState().sessionMessages[SESSION_ID]?.messageIdsOldestFirst).toHaveLength(20);
        consoleErrorSpy.mockRestore();
    });

    it('probes the loaded transcript tail once when reopening with a stale equal sequence hint', async () => {
        const { sync } = await seedLoadedHistorySession();
        const releaseVisibleSurface = registerSessionVisibleSurface(SESSION_ID);
        requestMock.mockImplementation((path: string) => Promise.resolve(
            String(path).includes('afterSeq=20') ? newerMessageResponse() : emptyMessagesResponse(),
        ));

        try {
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);

            expect(messagesRequestPaths().filter((path) => path.includes('afterSeq=20'))).toHaveLength(1);
            expect(Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {}))
                .toContainEqual(expect.objectContaining({ realID: 'mm21', seq: 21 }));
        } finally {
            releaseVisibleSurface();
        }
    });

    it.each(['success', 'failure'] as const)('keeps catch-up active until a hidden-edit repair settles with %s after the tail probe', async (outcome) => {
        const { sync } = await seedLoadedHistorySession({ withStreamSegment: true });
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const releaseVisibleSurface = registerSessionVisibleSurface(SESSION_ID);
        const oldRow = Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById)
            .find((message) => message.realID === 'mm1');
        expect(oldRow).toBeDefined();
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
                        messages: [{
                            id: 'mm15', seq: 15, localId: 'segment15', createdAt: 15, updatedAt: 30,
                            content: { t: 'plain', v: {
                                role: 'agent',
                                content: { type: 'output', data: {
                                    type: 'assistant', uuid: 'mm15',
                                    message: { content: [{ type: 'text', text: 'edited while hidden' }] },
                                } },
                                meta: { happierStreamSegmentV1: {
                                    v: 1, segmentKind: 'assistant', segmentLocalId: 'segment15',
                                    segmentState: 'complete', updatedAtMs: 30,
                                } },
                            } },
                        }],
                        hasMore: false, nextAfterSeq: null,
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                };
            });
        });

        try {
            sync.onSessionVisible(SESSION_ID);
            await sync.refreshSessionMessages(SESSION_ID);
            expect(targetedStaleRefetchPaths()).toHaveLength(1);
            // The tail probe has settled, but the independent hidden-edit repair is still
            // pending. Its lifecycle must continue to own the visible catch-up signal.
            expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(true);
            expect(storage.getState().sessionMessages[SESSION_ID].isLoaded).toBe(true);
            expect(Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById)).toContain(oldRow);

            settleRepair();
            await expect.poll(() => storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);
            const rows = Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById);
            expect(rows).toHaveLength(20);
            expect(rows.find((message) => message.realID === 'mm1')).toBe(oldRow);
            expect(rows.find((message) => message.realID === 'mm15')).toMatchObject({
                text: outcome === 'success' ? 'edited while hidden' : 'mm15',
            });
        } finally {
            settleRepair();
            await flushAsyncWork();
            releaseVisibleSurface();
        }
    });
});
