import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// §13 catch-up-newer signal: a NORMAL on-open catch-up (a loaded session that advanced in the
// background) runs its newer fetches directly inside `fetchMessages` — NOT through
// `loadNewerMessages` — so that path must bracket the `beginSessionCatchUpNewer` /
// `endSessionCatchUpNewer` signal itself; otherwise the bottom-anchored "Catching up…" overlay
// never shows for the most common catch-up. The first-ever snapshot load is intentionally NOT
// bracketed (initial open shows the normal transcript, not a catch-up overlay).

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

const externalTranscriptPageMock = vi.hoisted(() => vi.fn());
const externalTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionTranscriptPage: externalTranscriptPageMock,
    machineExternalSessionTranscriptReadAfter: externalTranscriptReadAfterMock,
    machineExternalSessionTranscriptRefreshReadAfter: vi.fn(),
}));

import { storage } from './domains/state/storage';
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Machine, Session } from './domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";

type SyncCatchUpTestAccess = {
    encryption: { getSessionEncryption: (sessionId: string) => null };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
    sessionMaterializedMaxSeqById: Record<string, number>;
};

const initialStorageState = storage.getState();
const SESSION_ID = 's-catchup-newer-signal';

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
    sync.disconnectServer();
    storage.getState().applySessions([createSession(SESSION_ID, sessionSeq)]);
    if (options.withMaterializedMessage !== false && materializedMaxSeq > 0) {
        storage.getState().applyMessages(SESSION_ID, [buildMessage(`m${materializedMaxSeq}`, materializedMaxSeq)]);
    }
    storage.getState().applyMessagesLoaded(SESSION_ID);
    t.encryption = { getSessionEncryption: () => null };
    t.activeServerSessionIds = new Set<string>([SESSION_ID]);
    t.hasFetchedSessionsSnapshotForActiveServer = true;
    t.isForeground = true;
    t.sessionMaterializedMaxSeqById = { [SESSION_ID]: materializedMaxSeq };
    markSessionSurfaceVisible(SESSION_ID);
    return sync;
}

describe('§13 catch-up-newer signal brackets the on-open catch-up', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        externalTranscriptPageMock.mockReset();
        externalTranscriptReadAfterMock.mockReset();
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        markSessionSurfaceHidden(SESSION_ID);
        resetSessionSurfaceVisibilityForTests();
        vi.unstubAllGlobals();
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
        sync.disconnectServer();
        // Never-loaded session → fetchMessages takes the snapshot branch, which is intentionally
        // NOT bracketed (initial load shows the normal transcript, not a "Catching up…" overlay).
        storage.getState().applySessions([createSession(SESSION_ID, 20)]);
        t.encryption = { getSessionEncryption: () => null };
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
        sync.disconnectServer();
        storage.getState().applySessions([createExternalSession('machine_only')]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        t.encryption = { getSessionEncryption: () => null };
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
        sync.disconnectServer();
        storage.getState().applyMachines([createOfflineMachine()]);
        storage.getState().applySessions([createExternalSession('snapshot_complete')]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        t.encryption = { getSessionEncryption: () => null };
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
