import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
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

const directTailReadMock = vi.hoisted(() => vi.fn());
const directTranscriptPageMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/machineDirectSessions', () => ({
    machineDirectSessionTranscriptReadAfter: directTailReadMock,
    machineDirectSessionTranscriptPage: directTranscriptPageMock,
}));

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from './typesRaw';
import { markSessionVisible } from '@/sync/domains/session/activeViewingSession';

type SyncCatchUpTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-catchup';

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

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met within 2000ms');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/** Defer the next message-fetch request so the in-flight window is observable. */
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

async function seedLoadedSession(materializedMaxSeq: number, sessionSeq: number): Promise<void> {
    const { sync } = await import('./sync');
    const t = sync as unknown as SyncCatchUpTestAccess;
    sync.disconnectServer();
    storage.getState().applySessions([createSession(SESSION_ID, sessionSeq)]);
    storage.getState().applyMessages(SESSION_ID, [buildMessage(`m${materializedMaxSeq}`, materializedMaxSeq)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);
    t.encryption = { getSessionEncryption: () => null };
    t.activeServerSessionIds = new Set<string>([SESSION_ID]);
    t.hasFetchedSessionsSnapshotForActiveServer = true;
    t.isForeground = true;
    t.sessionMaterializedMaxSeqById[SESSION_ID] = materializedMaxSeq;
    markSessionVisible(SESSION_ID);
}

describe('§13 catch-up-newer signal brackets the on-open catch-up', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('flips sessionCatchUpNewerInFlight while a normal on-open incremental newer catch-up runs, and clears it after', async () => {
        // A loaded session that advanced in the background: materialized seq 10 < session seq 20.
        await seedLoadedSession(10, 20);
        const { sync } = await import('./sync');
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
        const { sync } = await import('./sync');
        const t = sync as unknown as SyncCatchUpTestAccess;
        sync.disconnectServer();
        // Never-loaded session → fetchMessages takes the snapshot branch, which is intentionally
        // NOT bracketed (initial load shows the normal transcript, not a "Catching up…" overlay).
        storage.getState().applySessions([createSession(SESSION_ID, 20)]);
        t.encryption = { getSessionEncryption: () => null };
        t.activeServerSessionIds = new Set<string>([SESSION_ID]);
        t.hasFetchedSessionsSnapshotForActiveServer = true;
        t.isForeground = true;
        markSessionVisible(SESSION_ID);
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
});

/**
 * The direct-session tail probe is the steady-state poll, not a catch-up.
 *
 * `useDirectSessionRuntime` re-invalidates this exact path on a self-rescheduling timer — 250ms
 * while the agent is running, 2s otherwise — so anything bracketed around the probe itself is
 * raised and lowered several times a second for the life of an open direct session. The overlay
 * component's own contract (`CatchUpProgressOverlay.tsx`) states the signal is bracketed "ONLY
 * around genuine newer-catch-up work ... and never around normal streaming".
 *
 * The sibling incremental path already gates the same signal on `isCatchUpWork`
 * (`decision.kind !== 'do_nothing'`); these two cases pin the direct-session equivalent, so the
 * fix cannot be "stop bracketing" — a truncated tail must still surface, because it drops the
 * transcript and refetches it.
 */
describe('§13 catch-up-newer signal and the direct-session tail poll', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        directTailReadMock.mockReset();
        directTranscriptPageMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function seedLoadedDirectSession(): Promise<void> {
        const { sync } = await import('./sync');
        const t = sync as unknown as SyncCatchUpTestAccess;
        sync.disconnectServer();
        storage.getState().applySessions([{
            ...createSession(SESSION_ID, 20),
            metadata: {
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'm-1',
                    remoteSessionId: 'r-1',
                    source: { kind: 'claudeConfig' },
                },
            } as unknown as Session['metadata'],
        }]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        t.encryption = { getSessionEncryption: () => null };
        t.activeServerSessionIds = new Set<string>([SESSION_ID]);
        t.hasFetchedSessionsSnapshotForActiveServer = true;
        t.isForeground = true;
        t.sessionMaterializedMaxSeqById[SESSION_ID] = 20;
        markSessionVisible(SESSION_ID);
    }

    /** A promise whose settlement this test controls, so the in-flight window is observable. */
    function deferredResponse<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((settle) => { resolve = settle; });
        return { promise, resolve };
    }

    it('does NOT raise the signal while an idle tail probe is in flight', async () => {
        await seedLoadedDirectSession();
        const { sync } = await import('./sync');

        const tail = deferredResponse<unknown>();
        directTailReadMock.mockReturnValue(tail.promise);

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => directTailReadMock.mock.calls.length > 0);

        // The probe is in flight and has not yet reported whether anything is new. Nothing is
        // being caught up, so the reader must not be told that anything is.
        expect(catchUpInFlight()).toBe(0);
        expect(storage.getState().isSessionCatchingUpNewer(SESSION_ID)).toBe(false);

        tail.resolve({ ok: true, items: [], nextCursor: 'c-1', truncated: false });
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });

    it('DOES raise the signal while a truncated tail drops and refetches the transcript', async () => {
        await seedLoadedDirectSession();
        const { sync } = await import('./sync');

        directTailReadMock.mockResolvedValue({ ok: true, items: [], nextCursor: null, truncated: true });
        const page = deferredResponse<unknown>();
        directTranscriptPageMock.mockReturnValue(page.promise);

        const refresh = sync.refreshSessionMessages(SESSION_ID);
        await waitFor(() => directTranscriptPageMock.mock.calls.length > 0);

        // A truncated tail is genuine catch-up: the transcript was reset and is being refetched,
        // which is exactly the window the overlay exists to cover.
        expect(catchUpInFlight()).toBeGreaterThan(0);

        page.resolve({ ok: true, items: [], nextCursor: null, hasMore: false });
        await refresh;
        expect(catchUpInFlight()).toBe(0);
    });
});
