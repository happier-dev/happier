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
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';
import type { DeferredTranscriptMarker } from './domains/session/realtime/deferredTranscriptState';
import { registerSessionVisibleSurface } from './domains/session/activeViewingSession';

type SyncStaleReopenTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
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

function targetedStaleRefetchPaths(): string[] {
    return messagesRequestPaths().filter((path) => path.includes('afterSeq=14'));
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function seedLoadedHistorySession(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncStaleReopenTestAccess;
    sync.disconnectServer();

    const history = Array.from({ length: 20 }, (_unused, index) => buildMessage(`mm${index + 1}`, index + 1));
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
});
