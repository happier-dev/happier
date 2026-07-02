import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';

type SyncGapFillDeferralTestAccess = {
    encryption: {
        getSessionEncryption: (sessionId: string) => null;
    };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    sessionMessagesBeforeSeqByKey: Map<string, number>;
    sessionMessagesHasMoreOlderByKey: Map<string, boolean>;
    getOrCreateMessagesSync: (sessionId: string) => { awaitQueue: (opts?: { timeoutMs?: number }) => Promise<void> };
};

const initialStorageState = storage.getState();

const SESSION_ID = 's1';

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
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

function emptyMessagesResponse(): Response {
    return new Response(
        JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

/** Requests issued by the background messages catch-up (`fetchMessages`), excluding older paging. */
function catchUpRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('/messages?') && !path.includes('beforeSeq='));
}

/** Requests issued by the user-triggered older-page load. */
function olderPageRequestPaths(): string[] {
    return requestMock.mock.calls
        .map((call) => String(call[0]))
        .filter((path) => path.includes('beforeSeq='));
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor: condition not met within 2000ms');
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function deferOlderPageRequests(): { resolveOlderPage: () => void } {
    let resolvePending: ((response: Response) => void) | null = null;
    requestMock.mockImplementation((path: string) => {
        if (String(path).includes('beforeSeq=')) {
            return new Promise<Response>((resolve) => {
                resolvePending = resolve;
            });
        }
        return Promise.resolve(emptyMessagesResponse());
    });
    return {
        resolveOlderPage: () => {
            if (!resolvePending) {
                throw new Error('expected an older-page request to be pending');
            }
            resolvePending(emptyMessagesResponse());
            resolvePending = null;
        },
    };
}

async function seedPagedSession(): Promise<SyncGapFillDeferralTestAccess> {
    const { sync } = await import('./sync');
    const syncForTest = sync as unknown as SyncGapFillDeferralTestAccess;
    sync.disconnectServer();

    storage.getState().applySessions([createSession(SESSION_ID)]);

    syncForTest.encryption = {
        getSessionEncryption: () => null,
    };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.sessionMessagesBeforeSeqByKey.set(`${SESSION_ID}:main`, 9);
    syncForTest.sessionMessagesHasMoreOlderByKey.set(`${SESSION_ID}:main`, true);
    return syncForTest;
}

describe('sync gap-fill deferral during user older pagination', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('defers background catch-up while an older load is in flight and replays exactly once after it settles', async () => {
        const syncForTest = await seedPagedSession();
        const { sync } = await import('./sync');
        const { resolveOlderPage } = deferOlderPageRequests();

        const olderLoad = sync.loadOlderMessages(SESSION_ID);
        await waitFor(() => olderPageRequestPaths().length === 1);

        // Background gap-fill catch-up arriving while the user older load is in flight must defer.
        await sync.refreshSessionMessages(SESSION_ID);
        expect(catchUpRequestPaths()).toHaveLength(0);

        resolveOlderPage();
        await olderLoad;

        // The deferred catch-up replays exactly once after the older load settles.
        await syncForTest.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 });
        await waitFor(() => catchUpRequestPaths().length >= 1);
        expect(catchUpRequestPaths()).toHaveLength(1);

        // A later older load with no pending deferral must not replay again.
        syncForTest.sessionMessagesBeforeSeqByKey.set(`${SESSION_ID}:main`, 9);
        syncForTest.sessionMessagesHasMoreOlderByKey.set(`${SESSION_ID}:main`, true);
        requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));
        await sync.loadOlderMessages(SESSION_ID);
        await syncForTest.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 });
        expect(catchUpRequestPaths()).toHaveLength(1);
    });

    it('fetches immediately when no older load is in flight', async () => {
        await seedPagedSession();
        const { sync } = await import('./sync');
        requestMock.mockImplementation(() => Promise.resolve(emptyMessagesResponse()));

        await sync.refreshSessionMessages(SESSION_ID);

        expect(catchUpRequestPaths()).toHaveLength(1);
    });

    it('clears deferrals on server-scope reset so a settling load cannot ghost-replay across scopes', async () => {
        const syncForTest = await seedPagedSession();
        const { sync } = await import('./sync');
        const { resolveOlderPage } = deferOlderPageRequests();

        const olderLoad = sync.loadOlderMessages(SESSION_ID);
        await waitFor(() => olderPageRequestPaths().length === 1);

        await sync.refreshSessionMessages(SESSION_ID);
        expect(catchUpRequestPaths()).toHaveLength(0);

        // Server scope resets while the older load is still in flight.
        sync.disconnectServer();

        resolveOlderPage();
        await olderLoad;

        // The stale deferral must not replay into the new scope.
        await syncForTest.getOrCreateMessagesSync(SESSION_ID).awaitQueue({ timeoutMs: 2_000 });
        expect(catchUpRequestPaths()).toHaveLength(0);
    });
});
