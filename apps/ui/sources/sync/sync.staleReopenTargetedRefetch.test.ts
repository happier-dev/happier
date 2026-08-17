import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { readStoredSessionMessages } from './domains/messages/readStoredSessionMessages';
import type { Message } from './domains/messages/messageTypes';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';
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
    deferredTranscriptState: DeferredTranscriptState;
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

function staleRegionPageResponse(params: {
    startSeq: number;
    endSeq: number;
    correctedTextById?: Readonly<Record<string, string>>;
    nextAfterSeq: number | null;
}): Response {
    const { startSeq, endSeq, correctedTextById = {}, nextAfterSeq } = params;
    return new Response(
        JSON.stringify({
            messages: Array.from({ length: endSeq - startSeq + 1 }, (_unused, index) => {
                const seq = startSeq + index;
                const id = `mm${seq}`;
                const correctedText = correctedTextById[id];
                return plainTranscriptApiMessage(id, seq, correctedText ?? id, correctedText ? seq + 10_000 : seq);
            }),
            nextAfterSeq,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

async function seedLoadedHistorySession(historyLength = 20): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
    sync.disconnectServer();

    const history = Array.from({ length: historyLength }, (_unused, index) => buildMessage(`mm${index + 1}`, index + 1));
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

    it('keeps stale markers retryable when the targeted refetch fails transiently', async () => {
        const { sync } = await seedLoadedHistorySession();
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        requestMock
            .mockRejectedValueOnce(new Error('temporary refetch failure'))
            .mockResolvedValue(emptyMessagesResponse());

        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 15,
            messageId: 'mm15',
        });

        sync.onSessionVisible(SESSION_ID);
        await expect.poll(() => messagesRequestPaths().filter((path) => path.includes('afterSeq=14')).length)
            .toBe(1);

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

    it('pages until every exact stale id is observed before clearing the targeted markers', async () => {
        const { sync } = await seedLoadedHistorySession(220);
        const syncForTest = sync as unknown as SyncStaleReopenTestAccess;

        requestMock.mockImplementation((path: string) => {
            if (String(path).includes('afterSeq=9')) {
                return Promise.resolve(staleRegionPageResponse({
                    startSeq: 10,
                    endSeq: 159,
                    correctedTextById: { mm10: 'corrected hidden row 10' },
                    nextAfterSeq: 159,
                }));
            }
            if (String(path).includes('afterSeq=159')) {
                return Promise.resolve(staleRegionPageResponse({
                    startSeq: 160,
                    endSeq: 220,
                    correctedTextById: { mm200: 'corrected hidden row 200' },
                    nextAfterSeq: null,
                }));
            }
            return Promise.resolve(emptyMessagesResponse());
        });
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 10,
            messageId: 'mm10',
        });
        syncForTest.markSessionTranscriptStale(SESSION_ID, {
            updateType: 'message-updated',
            seq: 200,
            messageId: 'mm200',
        });

        sync.onSessionVisible(SESSION_ID);

        await expect.poll(() => readStoredTranscriptText('mm10')).toBe('corrected hidden row 10');
        await expect.poll(() => readStoredTranscriptText('mm200')).toBe('corrected hidden row 200');
        await expect.poll(() => readStaleTranscriptMessageIds(
            syncForTest.deferredTranscriptState,
            SESSION_ID,
        )).toEqual([]);

        const paths = messagesRequestPaths();
        expect(paths.some((path) => path.includes('afterSeq=9'))).toBe(true);
        expect(paths.some((path) => path.includes('afterSeq=159'))).toBe(true);
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
});
