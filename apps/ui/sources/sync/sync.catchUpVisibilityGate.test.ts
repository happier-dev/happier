import { beforeEach, describe, expect, it, vi } from 'vitest';

// C6/D1 (catch-up visibility gate): a LOADED session that is NOT visible and NOT a
// full-content consumer must NOT run catch-up on reconnect. Today the catch-up call site
// hardcodes `isSessionVisible: true`, which defeats the policy gate and runs a destructive
// `tail_reset_latest_page` (wiping paginated history) for off-screen sessions on every
// reconnect sweep. The fix reads the REAL live-consumption signal at decision time.

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
import { markSessionVisible, markSessionHidden } from './domains/session/activeViewingSession';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';

type SyncCatchUpTestAccess = {
    encryption: {
        getSessionEncryption: (sessionId: string) => null;
    };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    lastSocketOfflineDurationMs: number | null;
    lastSocketDisconnectedAtMs: number | null;
};

const initialStorageState = storage.getState();

const SESSION_ID = 's-catchup-gate';
const CLAUDE_UNIFIED_SESSION_ID = 's-claude-unified-persisted';

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
        JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesResponse(messages: ReadonlyArray<ReturnType<typeof buildApiPlainMessage>>): Response {
    return new Response(
        JSON.stringify({ messages, hasMore: false, nextAfterSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

function expectOnlyMainMessagesRequest(params: {
    sessionId: string;
    afterSeq: string;
    limit: string;
}): void {
    const paths = messagesRequestPaths();
    expect(paths).toHaveLength(1);
    const path = paths[0];
    if (!path) {
        throw new Error(`Expected one message request for ${params.sessionId}`);
    }
    expect(path.startsWith(`/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?`)).toBe(true);

    const [, query = ''] = path.split('?');
    const searchParams = new URLSearchParams(query);
    expect(searchParams.get('scope')).toBe('main');
    expect(searchParams.get('afterSeq')).toBe(params.afterSeq);
    expect(searchParams.get('limit')).toBe(params.limit);
    expect(searchParams.has('beforeSeq')).toBe(false);
    expect(searchParams.has('sidechainId')).toBe(false);
}

function buildApiPlainMessage(id: string, seq: number) {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        createdAt: 10_000 + seq,
        updatedAt: 10_000 + seq,
        content: {
            t: 'plain' as const,
            v: { role: 'agent' as const, content: { type: 'text' as const, text: `claude unified ${seq}` } },
        },
    };
}

async function seedLargeGapLoadedSession(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncCatchUpTestAccess;
    sync.disconnectServer();

    // Materialized up to seq 10, session hint far ahead: a large catch-up gap, pinned by default.
    storage.getState().applySessions([createSession(SESSION_ID, 600)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage('m10', 10)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 10 };
    // Simulate a recent reconnect so offlineForMs > 0 (would force a snapshot path if visible).
    syncForTest.lastSocketOfflineDurationMs = 60_000;
    syncForTest.lastSocketDisconnectedAtMs = null;
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    return { sync };
}

describe('sync catch-up visibility gate (C6/D1)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        markSessionHidden(SESSION_ID);
        markSessionHidden(CLAUDE_UNIFIED_SESSION_ID);
    });

    it('does nothing and preserves the transcript for a loaded, non-visible, non-consumer session on reconnect', async () => {
        const { sync } = await seedLargeGapLoadedSession();

        // Not visible, no voice/SCM consumer -> not a live-content consumer.
        await sync.refreshSessionMessages(SESSION_ID);

        // No network catch-up, and the loaded transcript is untouched (no destructive reset:
        // the one materialized row survives and the record stays loaded).
        expect(messagesRequestPaths()).toHaveLength(0);
        const record = storage.getState().sessionMessages[SESSION_ID];
        expect(record?.isLoaded).toBe(true);
        expect(record?.messageIdsOldestFirst.length).toBe(1);
    });

    it('runs catch-up once the session is actually visible (gate flips on the real signal)', async () => {
        const { sync } = await seedLargeGapLoadedSession();

        markSessionVisible(SESSION_ID);
        try {
            await sync.refreshSessionMessages(SESSION_ID);
            expect(messagesRequestPaths().length).toBeGreaterThanOrEqual(1);
        } finally {
            markSessionHidden(SESSION_ID);
        }
    });

    it('catches up hidden Claude Unified persisted transcript updates when returning to the session', async () => {
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncCatchUpTestAccess & {
            markSessionTranscriptDeferred: (sessionId: string, marker: { updateType: 'new-message'; seq: number; messageId: string }) => void;
        };
        sync.disconnectServer();

        storage.getState().applySessions([createSession(CLAUDE_UNIFIED_SESSION_ID, 10)]);
        storage.getState().applyMessages(CLAUDE_UNIFIED_SESSION_ID, [buildMessage('m10', 10)]);
        storage.getState().applyMessagesLoaded(CLAUDE_UNIFIED_SESSION_ID);

        syncForTest.encryption = { getSessionEncryption: () => null };
        syncForTest.activeServerSessionIds = new Set<string>([CLAUDE_UNIFIED_SESSION_ID]);
        syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
        syncForTest.isForeground = true;
        syncForTest.sessionMaterializedMaxSeqById = { [CLAUDE_UNIFIED_SESSION_ID]: 10 };
        syncForTest.lastSocketOfflineDurationMs = null;
        syncForTest.lastSocketDisconnectedAtMs = null;

        // Mirrors the socket projection-only path used for hidden durable new-message updates:
        // the session row/list can advance while the transcript row is intentionally deferred.
        syncForTest.markSessionTranscriptDeferred(CLAUDE_UNIFIED_SESSION_ID, {
            updateType: 'new-message',
            seq: 11,
            messageId: 'm11',
        });

        requestMock.mockImplementation(() => Promise.resolve(messagesResponse([
            buildApiPlainMessage('m11', 11),
        ])));
        requestMock.mockClear();

        markSessionVisible(CLAUDE_UNIFIED_SESSION_ID);
        try {
            await sync.refreshSessionMessages(CLAUDE_UNIFIED_SESSION_ID);
        } finally {
            markSessionHidden(CLAUDE_UNIFIED_SESSION_ID);
        }

        expectOnlyMainMessagesRequest({ sessionId: CLAUDE_UNIFIED_SESSION_ID, afterSeq: '10', limit: '150' });
        // The deferred new row (seq 11) is materialized and merged on top of the existing
        // history (seq 10) — non-destructively (the record stays loaded; both rows present).
        const record = storage.getState().sessionMessages[CLAUDE_UNIFIED_SESSION_ID];
        expect(record?.isLoaded).toBe(true);
        expect(record?.messageIdsOldestFirst.length).toBe(2);
        const materializedSeqs = (record?.messageIdsOldestFirst ?? [])
            .map((id) => record?.messagesById[id]?.seq)
            .filter((seq): seq is number => typeof seq === 'number');
        expect(materializedSeqs).toContain(11);
    });
});
