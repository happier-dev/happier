import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tail-reset discontinuity (live defect 2026-07-12): a large catch-up gap resolves
// `tail_reset_latest_page`, which merges ONLY the newest page on top of the previously
// materialized history (C6/D2b fetch-then-merge). That leaves a hole between the old
// contiguous prefix and the new tail island. The older-page cursor is monotone-min
// (`Math.min(prev.beforeSeq, pageMin)`), so scroll-up pagination kept fetching from the
// PRE-GAP cursor — digging below yesterday while the whole morning stayed missing, forever.
//
// Contract under test: while a tail discontinuity is open, older-page loads must walk
// DOWN FROM THE TAIL ISLAND (hole-fill walk), the transcript tail floor must track the
// walk so only tail-contiguous content is displayed, and when the walk bridges the old
// prefix the walk closes and the preserved prefix cursor resumes (no skipped ranges, no
// redundant refetch of the prefix).

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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
        getAllKeys() {
            return [...kvStore.keys()];
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

import { storage } from './domains/state/storage';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Session } from './domains/state/storageTypes';

type SyncTailResetTestAccess = {
    encryption: {
        getSessionEncryption: (sessionId: string) => unknown;
    };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    isForeground: boolean;
};

const initialStorageState = storage.getState();

const SESSION_ID = 's-tail-reset-hole';

function createSession(sessionId: string, seq: number): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq,
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

type ApiPageMessage = {
    id: string;
    seq: number;
    localId: null;
    content: { t: 'encrypted'; c: string };
    createdAt: number;
    updatedAt: number;
};

function buildPageMessages(fromSeq: number, toSeq: number): ApiPageMessage[] {
    const messages: ApiPageMessage[] = [];
    // Server returns newest-first for beforeSeq/initial pages; order does not matter for
    // the pipeline, seqs do.
    for (let seq = toSeq; seq >= fromSeq; seq -= 1) {
        messages.push({
            id: `m${seq}`,
            seq,
            localId: null,
            content: { t: 'encrypted', c: 'cipher' },
            createdAt: seq,
            updatedAt: seq,
        });
    }
    return messages;
}

function pageResponse(page: {
    messages: ApiPageMessage[];
    hasMore: boolean;
    nextBeforeSeq: number | null;
}): Response {
    return new Response(
        JSON.stringify({
            messages: page.messages,
            hasMore: page.hasMore,
            nextBeforeSeq: page.nextBeforeSeq,
            nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function readBeforeSeq(path: string): number | null {
    const match = /[?&]beforeSeq=(\d+)/.exec(path);
    return match ? Number(match[1]) : null;
}

function olderRequestBeforeSeqs(): number[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages'))
        .map((path) => readBeforeSeq(path))
        .filter((value): value is number => value !== null);
}

async function seedSessionWithHole(): Promise<{ sync: typeof import('./sync').sync }> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncTailResetTestAccess;
    sync.disconnectServer();

    storage.getState().applySessions([createSession(SESSION_ID, 410)]);

    syncForTest.encryption = {
        getSessionEncryption: () => ({
            decryptMessages: async (messages: ApiPageMessage[]) =>
                messages.map((m) => ({
                    id: m.id,
                    localId: null,
                    createdAt: m.createdAt,
                    seq: m.seq,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            agentId: 'claude',
                            provider: 'claude',
                            data: { type: 'message', message: `msg-${m.seq}` },
                        },
                    },
                })),
        }),
    };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.isForeground = true;
    markSessionSurfaceVisible(SESSION_ID);

    // Yesterday's state: the initial load materializes seqs 401..410 with the older
    // cursor recorded at 401.
    requestMock.mockImplementation(() => Promise.resolve(pageResponse({
        messages: buildPageMessages(401, 410),
        hasMore: true,
        nextBeforeSeq: 401,
    })));
    await sync.refreshSessionMessages(SESSION_ID);
    expect(storage.getState().sessionMessages[SESSION_ID]?.isLoaded).toBe(true);

    // This morning: the session advanced to seq 2000 while nothing was consuming it.
    // A pinned live-tail viewport + large gap resolves tail_reset_latest_page: the
    // snapshot fetch returns ONLY the newest island 1951..2000.
    storage.getState().applySessions([createSession(SESSION_ID, 2000)]);
    sync.onSessionViewportChange(SESSION_ID, {
        isPinned: true,
        offsetY: 0,
        shouldRestoreViewport: false,
    });
    requestMock.mockImplementation(() => Promise.resolve(pageResponse({
        messages: buildPageMessages(1951, 2000),
        hasMore: true,
        nextBeforeSeq: 1951,
    })));
    await sync.refreshSessionMessages(SESSION_ID);

    requestMock.mockClear();
    return { sync };
}

describe('sync tail-reset pagination hole (discontinuity walk)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        resetSessionSurfaceVisibilityForTests();
    });

    it('opens a tail discontinuity on the snapshot and publishes the display floor', async () => {
        await seedSessionWithHole();

        // The store now holds [401..410] + HOLE + [1951..2000]. The transcript must not
        // glue yesterday onto the tail: the tail floor bounds display to the island.
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1951);
    });

    it('walks older pages down from the tail island instead of the stale pre-gap cursor', async () => {
        const { sync } = await seedSessionWithHole();

        // DEFECT: this fetched beforeSeq=401 (below yesterday), skipping 411..1950 forever.
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(1801, 1950),
            hasMore: true,
            nextBeforeSeq: 1801,
        })));
        const first = await sync.loadOlderMessages(SESSION_ID);
        expect(first.status).toBe('loaded');
        expect(first.hasMore).toBe(true);
        expect(olderRequestBeforeSeqs()).toEqual([1951]);

        // The walk advanced; the floor follows it so newly loaded content becomes visible.
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1801);
    });

    it('closes the walk when it bridges the old prefix and resumes the preserved prefix cursor', async () => {
        const { sync } = await seedSessionWithHole();

        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(1801, 1950),
            hasMore: true,
            nextBeforeSeq: 1801,
        })));
        await sync.loadOlderMessages(SESSION_ID);

        // The next page bridges down INTO the old prefix (minSeq 411 <= prefixMax+1 = 411):
        // the discontinuity is closed and the floor clears — the prefix is tail-contiguous.
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(411, 1800),
            hasMore: true,
            nextBeforeSeq: 411,
        })));
        const bridging = await sync.loadOlderMessages(SESSION_ID);
        expect(bridging.status).toBe('loaded');
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBeNull();

        // After the close, older paging resumes from the PRESERVED prefix cursor (401):
        // no refetch of 401..410, no skipped range.
        requestMock.mockClear();
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: [],
            hasMore: false,
            nextBeforeSeq: null,
        })));
        await sync.loadOlderMessages(SESSION_ID);
        expect(olderRequestBeforeSeqs()).toEqual([401]);
    });

    it('keeps reporting hasMore while the discontinuity is open even if a page under-fills', async () => {
        const { sync } = await seedSessionWithHole();

        // A short page (fewer than pageSize rows) normally infers hasMore=false. While the
        // hole is open there IS more older content by construction (the hole + the prefix),
        // so the walk must not let inference stall the scroll-up affordance.
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(1941, 1950),
            hasMore: true,
            nextBeforeSeq: 1941,
        })));
        const result = await sync.loadOlderMessages(SESSION_ID);
        expect(result.hasMore).toBe(true);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1941);
    });

    it('keeps walking an empty filtered page when the server explicitly reports more history', async () => {
        const { sync } = await seedSessionWithHole();

        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: [],
            hasMore: true,
            nextBeforeSeq: 1901,
        })));

        const result = await sync.loadOlderMessages(SESSION_ID);

        expect(result).toMatchObject({ loaded: 0, hasMore: true, status: 'loaded' });
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1901);
        expect(olderRequestBeforeSeqs()).toEqual([1951]);
    });

    it('retains the visible floor when the network walk exhausts before bridging the stale prefix', async () => {
        const { sync } = await seedSessionWithHole();

        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: [],
            hasMore: false,
            nextBeforeSeq: null,
        })));

        const result = await sync.loadOlderMessages(SESSION_ID);

        expect(result).toMatchObject({ loaded: 0, hasMore: false, status: 'no_more' });
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1951);

        requestMock.mockClear();
        const repeated = await sync.loadOlderMessages(SESSION_ID);
        expect(repeated).toMatchObject({ loaded: 0, hasMore: false, status: 'no_more' });
        expect(olderRequestBeforeSeqs()).toEqual([]);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1951);
    });

    it('keeps the deepest stale-prefix boundary across terminal exhaustion and a later tail reset', async () => {
        const { sync } = await seedSessionWithHole();

        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: [],
            hasMore: false,
            nextBeforeSeq: null,
        })));
        await sync.loadOlderMessages(SESSION_ID);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1951);

        storage.getState().applySessions([createSession(SESSION_ID, 4000)]);
        sync.onSessionViewportChange(SESSION_ID, {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        });
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(3951, 4000),
            hasMore: true,
            nextBeforeSeq: 3951,
        })));
        await sync.refreshSessionMessages(SESSION_ID);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(3951);

        requestMock.mockClear();
        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: buildPageMessages(2001, 3950),
            hasMore: true,
            nextBeforeSeq: 2001,
        })));
        const result = await sync.loadOlderMessages(SESSION_ID);

        expect(result).toMatchObject({ hasMore: true, status: 'loaded' });
        expect(olderRequestBeforeSeqs()).toEqual([3951]);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(2001);
    });

    it('clears a retained terminal-exhaustion floor when the server scope disconnects', async () => {
        const { sync } = await seedSessionWithHole();

        requestMock.mockImplementation(() => Promise.resolve(pageResponse({
            messages: [],
            hasMore: false,
            nextBeforeSeq: null,
        })));
        await sync.loadOlderMessages(SESSION_ID);
        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBe(1951);

        sync.disconnectServer();

        expect(storage.getState().getSessionTailContiguousFloorSeq(SESSION_ID)).toBeNull();
    });
});
