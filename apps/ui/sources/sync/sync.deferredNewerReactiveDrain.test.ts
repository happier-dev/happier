import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

// Deferred history pages and live-tail catch-up share sync ownership, but different demand:
// history-edge proximity fetches one adjacent page; live-tail intent uses the catch-up policy.

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
import type { ApiMessage } from './api/types/apiTypes';
import type { InvalidateSync } from '@/utils/sessions/sync';

type SyncDrainTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
    getOrCreateMessagesSync: (sessionId: string) => InvalidateSync;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-deferred-drain';

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

function messagePageResponse(seqs: readonly number[], cursors: Readonly<{
    nextAfterSeq?: number | null;
    nextBeforeSeq?: number | null;
}>): Response {
    const messages: ApiMessage[] = seqs.map((seq) => ({
        id: `m${seq}`,
        seq,
        localId: null,
        sidechainId: null,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `m${seq}` } } },
        createdAt: seq,
        updatedAt: seq,
    }));
    return new Response(JSON.stringify({
        messages,
        hasMore: cursors.nextAfterSeq != null || cursors.nextBeforeSeq != null,
        ...cursors,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function awaitMessagesQueue(sync: typeof import('./sync').sync): Promise<void> {
    const syncForTest = sync as unknown as SyncDrainTestAccess;
    expect(await syncForTest.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 }))
        .toEqual({ status: 'completed' });
}

function messagesRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'));
}

async function seedHistorySession(sessionSeq = 600): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncDrainTestAccess;
    sync.disconnectServer();

    storage.getState().applySessions([createSession(SESSION_ID, sessionSeq)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage('m10', 10)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);

    syncForTest.encryption = { getSessionEncryption: () => null };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 10 };
    markSessionVisible(SESSION_ID);

    // The default large gap defers forward loading while the reader is in history.
    sync.onSessionViewportChange(SESSION_ID, { isPinned: false, offsetY: 420, shouldRestoreViewport: true });
    requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
    requestMock.mockClear();
    await sync.refreshSessionMessages(SESSION_ID);

    return { sync };
}

describe('sync reactive deferred-newer drain (C6/D3)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        markSessionHidden(SESSION_ID);
    });

    afterEach(() => {
        markSessionHidden(SESSION_ID);
    });

    it('preserves a detached viewport and deferred history when the session is reopened', async () => {
        const { sync } = await seedHistorySession();
        const anchor = {
            kind: 'message' as const,
            messageId: 'm10',
            itemId: 'm10',
            seq: 10,
            itemOffsetPx: 24,
            capturedAtMs: Date.now(),
        };
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false,
            offsetY: 9_999,
            anchor,
            shouldRestoreViewport: true,
        });
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(messagesRequestPaths()).toHaveLength(0);

        sync.onSessionVisible(SESSION_ID);
        await awaitMessagesQueue(sync);

        expect(messagesRequestPaths()).toHaveLength(0);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: false, offsetY: 9_999, anchor });
    });

    it('uses the live-tail policy once when bottom demand follows explicit return from history', async () => {
        const { sync } = await seedHistorySession();
        requestMock.mockImplementation(() => Promise.resolve(messagePageResponse([600], { nextBeforeSeq: 600 })));

        sync.onSessionViewportChange(SESSION_ID, { isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: true, distanceFromBottomPx: 0 });
        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: true, distanceFromBottomPx: 0 });
        await awaitMessagesQueue(sync);

        await vi.waitFor(() => {
            expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);
        });
        const requests = messagesRequestPaths().map((path) => new URL(path, 'http://localhost'));
        expect(requests).toHaveLength(1);
        expect(requests[0]?.searchParams.has('afterSeq')).toBe(false);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: true, anchor: null });
        expect(Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {}).map((message) => message.seq))
            .toEqual(expect.arrayContaining([10, 600]));
    });

    it('replays live-tail intent delivered as an abandoned latest-page request publishes completion', async () => {
        const { sync } = await seedHistorySession();
        const firstResponse = createDeferred<Response>();
        requestMock
            .mockImplementationOnce(() => firstResponse.promise)
            .mockImplementation(() => Promise.resolve(messagePageResponse([600], { nextBeforeSeq: 600 })));
        sync.onSessionViewportChange(SESSION_ID, { isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        await vi.waitFor(() => expect(messagesRequestPaths()).toHaveLength(1));
        sync.onSessionViewportChange(SESSION_ID, { isPinned: false, offsetY: 9_999, shouldRestoreViewport: true });
        let returnedToTail = false;
        const unsubscribe = storage.subscribe((state, previousState) => {
            if (
                returnedToTail
                || (previousState.sessionCatchUpNewerInFlight[SESSION_ID] ?? 0) === 0
                || (state.sessionCatchUpNewerInFlight[SESSION_ID] ?? 0) !== 0
            ) return;
            // The mounted viewport can report its new intent during sync's completion
            // publication, before the invalidation cycle itself has released ownership.
            returnedToTail = true;
            sync.onSessionViewportChange(SESSION_ID, { isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        });
        try {
            firstResponse.resolve(messagePageResponse([600], { nextBeforeSeq: 600 }));
            await awaitMessagesQueue(sync);
        } finally {
            unsubscribe();
        }

        expect(returnedToTail).toBe(true);
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: true });
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        expect(messagesRequestPaths()).toHaveLength(2);
        expect(messagesRequestPaths().every((path) => !new URL(path, 'http://localhost').searchParams.has('afterSeq')))
            .toBe(true);
    });

    it('returns to the latest messages when a prior history probe found more than the stale session hint', async () => {
        const { sync } = await seedHistorySession(10);
        requestMock.mockImplementation(() => Promise.resolve(messagePageResponse([11], { nextAfterSeq: 11 })));
        sync.onSessionVisible(SESSION_ID);
        await awaitMessagesQueue(sync);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(storage.getState().sessions[SESSION_ID]?.seq).toBe(11);
        requestMock.mockImplementation(() => Promise.resolve(messagePageResponse([600], { nextBeforeSeq: 600 })));
        requestMock.mockClear();

        sync.onSessionViewportChange(SESSION_ID, { isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        await awaitMessagesQueue(sync);

        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        expect(Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {}).map((message) => message.seq))
            .toEqual(expect.arrayContaining([10, 11, 600]));
        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: true, anchor: null });
    });

    it('preserves the history anchor when the reader detaches during a latest-page request', async () => {
        const { sync } = await seedHistorySession();
        const response = createDeferred<Response>();
        requestMock.mockImplementation(() => response.promise);
        sync.onSessionViewportChange(SESSION_ID, { isPinned: true, offsetY: 0, shouldRestoreViewport: false });
        await vi.waitFor(() => expect(messagesRequestPaths()).toHaveLength(1));
        expect(new URL(messagesRequestPaths()[0]!, 'http://localhost').searchParams.has('afterSeq')).toBe(false);
        const anchor = {
            kind: 'message' as const,
            messageId: 'm10',
            itemId: 'm10',
            seq: 10,
            itemOffsetPx: 24,
            capturedAtMs: Date.now(),
        };
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: false,
            offsetY: 9_999,
            anchor,
            shouldRestoreViewport: true,
        });

        response.resolve(messagePageResponse([600], { nextBeforeSeq: 600 }));
        await awaitMessagesQueue(sync);

        expect(sync.getSessionViewport(SESSION_ID)).toMatchObject({ isPinned: false, offsetY: 9_999, anchor });
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBeNull();
        expect(Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {}).map((message) => message.seq))
            .toEqual([10]);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
    });

    it('loads one adjacent page while an unpinned reader approaches the loaded history edge', async () => {
        const { sync } = await seedHistorySession();
        const viewport = sync.getSessionViewport(SESSION_ID);
        requestMock.mockImplementation(() => Promise.resolve(messagePageResponse([11], { nextAfterSeq: 11 })));
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 10 });

        await vi.waitFor(() => {
            expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);
            expect(Object.values(storage.getState().sessionMessages[SESSION_ID]?.messagesById ?? {}).map((message) => message.seq))
                .toContain(11);
        });
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(new URL(messagesRequestPaths()[0]!, 'http://localhost').searchParams.get('afterSeq')).toBe('10');
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(sync.getSessionViewport(SESSION_ID)).toEqual(viewport);
    });

    it('keeps historical-window proximity on that window cursor instead of loading the global tail', async () => {
        const { sync } = await seedHistorySession();
        requestMock
            .mockResolvedValueOnce(messagePageResponse([5, 4], { nextBeforeSeq: 4 }))
            .mockResolvedValueOnce(messagePageResponse([6], { nextAfterSeq: 6 }));
        const target = { kind: 'seq' as const, seq: 5 };
        expect(await sync.loadTargetWindowMessages(SESSION_ID, target)).toMatchObject({
            status: 'loaded', targetPresent: true, newerCursor: 6,
        });
        const viewport = sync.getSessionViewport(SESSION_ID);
        requestMock.mockClear();

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 10 });
        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: true, distanceFromBottomPx: 0 });
        await awaitMessagesQueue(sync);
        await Promise.resolve();

        expect(messagesRequestPaths()).toHaveLength(0);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        expect(sync.getSessionViewport(SESSION_ID)).toEqual(viewport);

        requestMock.mockResolvedValueOnce(messagePageResponse([7], { nextAfterSeq: 7 }));
        expect(await sync.loadTargetWindowMessages(SESSION_ID, target, { direction: 'newer' }))
            .toMatchObject({ status: 'loaded', newerCursor: 7 });
        expect(messagesRequestPaths()).toHaveLength(1);
        expect(new URL(messagesRequestPaths()[0]!, 'http://localhost').searchParams.get('afterSeq')).toBe('6');
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toMatchObject({ isWindowMode: true, targetSeq: 5 });
    });

    it('does NOT drain (no viewport yank) for a scrolled-up session far from the bottom', async () => {
        const { sync } = await seedHistorySession();
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 9999 });

        // Geometry gate prevents the drain: no request, still deferred (let microtasks settle).
        await Promise.resolve();
        await Promise.resolve();
        expect(messagesRequestPaths()).toHaveLength(0);
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);
        markSessionHidden(SESSION_ID);
    });

    it('dedupes repeated near-bottom drain attempts while the newer page request is in flight', async () => {
        const { sync } = await seedHistorySession();
        const response = createDeferred<Response>();
        requestMock.mockImplementation(() => response.promise);

        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 10 });
        sync.maybeDrainDeferredNewerMessages(SESSION_ID, { isPinned: false, distanceFromBottomPx: 10 });

        await vi.waitFor(() => {
            expect(messagesRequestPaths()).toHaveLength(1);
        });
        expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(true);

        response.resolve(emptyMessagesResponse());

        await vi.waitFor(() => {
            expect(sync.hasDeferredNewerMessages(SESSION_ID)).toBe(false);
        });
        markSessionHidden(SESSION_ID);
    });
});
