import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// C6/D1 (catch-up visibility gate): a loaded session that is not visible and not a
// full-content consumer must not run catch-up on reconnect. Off-screen catch-up can
// reset hydrated transcript state while the user is working in another session.

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
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getPersistenceStorage } from './domains/state/persistenceStorage';
import { storage } from './domains/state/storage';

installDisconnectedServerSocketBoundary();
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
            if (requestUrl.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (requestUrl.pathname.includes('/messages') || requestUrl.pathname === '/v2/sessions/parent') {
                return await requestMock(path, init);
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        },
    });
}
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";

type SyncCatchUpTestAccess = {
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
            v: { role: 'user' as const, content: { type: 'text' as const, text: `claude unified ${seq}` } },
        },
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

async function seedLargeGapLoadedSession(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./syncEngine');
    const syncForTest = sync as unknown as SyncCatchUpTestAccess;

    storage.getState().applySessions([createSession(SESSION_ID, 600)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage('m10', 10)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 10 };
    syncForTest.lastSocketOfflineDurationMs = 60_000;
    syncForTest.lastSocketDisconnectedAtMs = null;
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    return { sync };
}

describe('sync catch-up visibility gate', () => {
    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        webLocks.restore();
        resetSessionSurfaceVisibilityForTests();
    });
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await loadSyncSingletonForTests();
        getPersistenceStorage().clearAll();
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        await restoreTestHome();
        resetSessionSurfaceVisibilityForTests();
    });

    it('does nothing and preserves the transcript for a loaded, non-visible, non-consumer session on reconnect', async () => {
        const { sync } = await seedLargeGapLoadedSession();

        await sync.refreshSessionMessages(SESSION_ID);

        expect(messagesRequestPaths()).toHaveLength(0);
        const record = storage.getState().sessionMessages[SESSION_ID];
        expect(record?.isLoaded).toBe(true);
        expect(record?.messageIdsOldestFirst.length).toBe(1);
    });

    it('runs catch-up once the session is actually visible', async () => {
        const { sync } = await seedLargeGapLoadedSession();

        markSessionSurfaceVisible(SESSION_ID);
        try {
            await sync.refreshSessionMessages(SESSION_ID);
            expect(messagesRequestPaths().length).toBeGreaterThanOrEqual(1);
        } finally {
            markSessionSurfaceHidden(SESSION_ID);
        }
    });

    it('catches up hidden Claude Unified persisted transcript updates when returning to the session', async () => {
        const { sync } = await import('./syncEngine');
        const syncForTest = sync as unknown as SyncCatchUpTestAccess & {
            markSessionTranscriptDeferred: (sessionId: string, marker: { updateType: 'new-message'; seq: number; messageId: string }) => void;
        };

        storage.getState().applySessions([createSession(CLAUDE_UNIFIED_SESSION_ID, 10)]);
        storage.getState().applyMessages(CLAUDE_UNIFIED_SESSION_ID, [buildMessage('m10', 10)]);
        storage.getState().applyMessagesLoaded(CLAUDE_UNIFIED_SESSION_ID);
        syncForTest.activeServerSessionIds = new Set<string>([CLAUDE_UNIFIED_SESSION_ID]);
        syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
        syncForTest.isForeground = true;
        syncForTest.sessionMaterializedMaxSeqById = { [CLAUDE_UNIFIED_SESSION_ID]: 10 };
        syncForTest.lastSocketOfflineDurationMs = null;
        syncForTest.lastSocketDisconnectedAtMs = null;
        syncForTest.markSessionTranscriptDeferred(CLAUDE_UNIFIED_SESSION_ID, {
            updateType: 'new-message',
            seq: 11,
            messageId: 'm11',
        });

        requestMock.mockImplementation(() => Promise.resolve(messagesResponse([
            buildApiPlainMessage('m11', 11),
        ])));
        requestMock.mockClear();

        markSessionSurfaceVisible(CLAUDE_UNIFIED_SESSION_ID);
        try {
            await sync.refreshSessionMessages(CLAUDE_UNIFIED_SESSION_ID);
        } finally {
            markSessionSurfaceHidden(CLAUDE_UNIFIED_SESSION_ID);
        }

        expectOnlyMainMessagesRequest({ sessionId: CLAUDE_UNIFIED_SESSION_ID, afterSeq: '10', limit: '150' });
        const record = storage.getState().sessionMessages[CLAUDE_UNIFIED_SESSION_ID];
        const appliedMessage = record?.messageIdsOldestFirst
            .map((id) => record.messagesById[id])
            .find((message) => message?.realID === 'm11');
        expect(appliedMessage).toMatchObject({
            realID: 'm11',
            seq: 11,
            text: 'claude unified 11',
        });
    });
});
