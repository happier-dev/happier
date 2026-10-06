import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
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
import type { Session } from './domains/state/storageTypes';

type SyncGapFillDeferralTestAccess = {
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    sessionMessagesBeforeSeqByKey: Map<string, number>;
    sessionMessagesHasMoreOlderByKey: Map<string, boolean>;
    deferredMessagesFetchSessionIds: Set<string>;
    retireLocalSession(sessionId: string): void;
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
    const { sync } = await import('./syncEngine');
    const syncForTest = sync as unknown as SyncGapFillDeferralTestAccess;

    storage.getState().applySessions([createSession(SESSION_ID)]);

    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.sessionMessagesBeforeSeqByKey.set(`${SESSION_ID}:main`, 9);
    syncForTest.sessionMessagesHasMoreOlderByKey.set(`${SESSION_ID}:main`, true);
    return syncForTest;
}

describe('sync gap-fill deferral during user older pagination', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await loadSyncSingletonForTests();
        getPersistenceStorage().clearAll();
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        await restoreTestHome();
    });

    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        webLocks.restore();
        vi.unstubAllGlobals();
    });

    it('defers background catch-up while an older load is in flight and replays exactly once after it settles', async () => {
        const syncForTest = await seedPagedSession();
        const { sync } = await import('./syncEngine');
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

    it('keeps pagination and deferred state empty when local retirement wins a held older page', async () => {
        const syncForTest = await seedPagedSession();
        const { sync } = await import('./sync');
        const { resolveOlderPage } = deferOlderPageRequests();

        const olderLoad = sync.loadOlderMessages(SESSION_ID);
        await waitFor(() => olderPageRequestPaths().length === 1);

        // This creates the exact replay deferral that must disappear with the
        // deleted transcript, rather than being replayed after the held page.
        await sync.refreshSessionMessages(SESSION_ID);
        expect(syncForTest.deferredMessagesFetchSessionIds.has(SESSION_ID)).toBe(true);

        syncForTest.retireLocalSession(SESSION_ID);
        expect(syncForTest.deferredMessagesFetchSessionIds.has(SESSION_ID)).toBe(false);

        resolveOlderPage();
        await expect(olderLoad).resolves.toEqual({ loaded: 0, hasMore: true, status: 'not_ready' });

        expect(storage.getState().sessions[SESSION_ID]).toBeUndefined();
        expect(storage.getState().sessionMessages[SESSION_ID]).toBeUndefined();
        expect(syncForTest.sessionMessagesBeforeSeqByKey.has(`${SESSION_ID}:main`)).toBe(false);
        expect(syncForTest.sessionMessagesHasMoreOlderByKey.has(`${SESSION_ID}:main`)).toBe(false);
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
