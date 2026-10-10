import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/track/tracking', () => ({ tracking: null }));

const requestMock = vi.hoisted(() => vi.fn());
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

import { storage } from './domains/state/storage';
import { getPersistenceStorage } from './domains/state/persistenceStorage';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';
import type { Session } from './domains/state/storageTypes';

const initialStorageState = storage.getState();

const SESSION_ID = 's-tail-reset-hole';

function createSession(sessionId: string, seq: number): Session {
    const now = Date.now();
    return {
        id: sessionId,
        encryptionMode: 'plain',
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
    content: { t: 'plain'; v: { role: 'agent'; content: { type: 'acp'; agentId: 'claude'; data: { type: 'message'; message: string } } } };
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
            content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'claude', data: { type: 'message', message: `msg-${seq}` } } } },
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
    const { sync } = await import('./syncEngine');
    storage.getState().applySessions([createSession(SESSION_ID, 410)]);
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
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        getPersistenceStorage().clearAll();
        requestMock.mockReset();
        resetSessionSurfaceVisibilityForTests();
        installDisconnectedServerSocketBoundary();
        accountConnection = await restoreServerAccountForTest({
            serverUrl: 'https://tail-paging.example.test',
            request: async (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname.endsWith('/messages')) return requestMock(url.pathname + url.search, init);
                return Response.json({}, { status: 404 });
            },
        });
    });

    afterEach(async () => {
        await accountConnection?.dispose();
        accountConnection = undefined;
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
