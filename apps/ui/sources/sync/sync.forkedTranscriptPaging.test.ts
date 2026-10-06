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
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { getForkedTranscriptSnapshotCached } from './domains/sessionFork/forkedTranscriptSnapshot';
import { insertForkDividersIntoTranscriptItems } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { apiSocket } from './api/session/apiSocket';
import { runWithServerRequestAuthorityForServerAccountScope } from './runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

function isMainMessagesPageRequest(path: string, params: {
    sessionId: string;
    beforeSeq: string;
    limit: string;
}): boolean {
    const prefix = `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?`;
    if (!path.startsWith(prefix)) return false;

    const [, query = ''] = path.split('?');
    const searchParams = new URLSearchParams(query);
    return searchParams.get('scope') === 'main'
        && searchParams.get('beforeSeq') === params.beforeSeq
        && searchParams.get('limit') === params.limit
        && !searchParams.has('afterSeq')
        && !searchParams.has('sidechainId');
}

type SyncForkPagingTestAccess = {
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    sessionMessagesBeforeSeqByKey: Map<string, number>;
    sessionMessagesHasMoreOlderByKey: Map<string, boolean>;
    disconnectServer: () => void;
    fetchMessages: (sessionId: string) => Promise<void>;
    replaceWithServerTranscript: (session: Session, authority: { kind: 'hosted' }) => Promise<boolean>;
    prefetchForkedTranscriptContext: (sessionId: string) => Promise<void>;
    loadOlderMessagesForkAware: (sessionId: string) => Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    }>;
};

const initialStorageState = storage.getState();

function createSession(sessionId: string, metadata: Session['metadata'] = null): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        encryptionMode: 'plain',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function forkMetadata(parentSessionId: string, parentCutoffSeqInclusive: number): Session['metadata'] {
    return {
        forkV1: {
            v: 1,
            parentSessionId,
            parentCutoffSeqInclusive,
            createdAtMs: 1,
            strategy: 'provider_native',
        },
    } as Session['metadata'];
}

function applyChildForkSession(): void {
    storage.getState().applySessions([
        createSession('child', forkMetadata('parent', 3)),
    ]);
    const childMessage: NormalizedMessage = {
        role: 'agent',
        content: [{ type: 'text', text: 'child latest page', uuid: 'child-text', parentUUID: null }],
        id: 'child-message',
        seq: 10,
        localId: null,
        createdAt: 10,
        isSidechain: false,
    };
    storage.getState().applyMessages('child', [childMessage]);
    storage.getState().applyMessagesLoaded('child');
}

describe('sync forked transcript paging', () => {
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        await loadSyncSingletonForTests();
        getPersistenceStorage().clearAll();
        storage.setState(initialStorageState, true);
        requestMock.mockReset();
        await restoreTestHome();

        const { sync } = await import('./syncEngine');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.activeServerSessionIds = new Set<string>(['child']);
        syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    });

    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        webLocks.restore();
        vi.unstubAllGlobals();
    });

    it('publishes initial-page coverage only once that page has materialized', async () => {
        applyChildForkSession();
        storage.setState((state) => ({
            sessionMessages: {
                ...state.sessionMessages,
                child: { ...state.sessionMessages.child!, isLoaded: false },
            },
        }));
        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [{
                id: 'child-start', seq: 2, localId: null, sidechainId: null, messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first visible row' } } },
                createdAt: 2, updatedAt: 2,
            }],
            hasMore: false, nextBeforeSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const observedFirstSeqs: Array<number | undefined> = [];
        const unsubscribe = storage.subscribe((state) => {
            if (state.sessionMessagesHistoryStartLoaded?.child !== true) return;
            const fork = getForkedTranscriptSnapshotCached(state, 'child')!;
            observedFirstSeqs.push(fork.combinedMessagesById[fork.combinedMessageIdsOldestFirst[0]!]?.seq);
        });
        try {
            const { sync } = await import('./syncEngine');
            await (sync as unknown as SyncForkPagingTestAccess).fetchMessages('child');
            expect(observedFirstSeqs.length).toBeGreaterThan(0);
            expect(observedFirstSeqs.every((seq) => seq === 2)).toBe(true);
        } finally {
            unsubscribe();
        }
    });

    it('publishes account-authority refresh coverage only after its first page materializes', async () => {
        await restoreTestHome('https://fork-coverage.example');
        if (!account) throw new Error('Expected the restored Account');
        const scope = { serverId: account.home.id, accountId: 'transcript-account' };
        applyChildForkSession();
        requestMock.mockResolvedValue(Response.json({
            messages: [{
                id: 'account-start', seq: 2, localId: null, sidechainId: null,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'account start' } } },
                createdAt: 2, updatedAt: 2,
            }], hasMore: false, nextBeforeSeq: null,
        }));
        const observedFirstSeqs: Array<number | undefined> = [];
        const unsubscribe = storage.subscribe((state) => {
            if (state.sessionMessagesHistoryStartLoaded.child !== true) return;
            const transcript = state.sessionMessages.child!;
            observedFirstSeqs.push(transcript.messagesById[transcript.messageIdsOldestFirst[0]!]!.seq);
        });
        try {
            const { sync } = await import('./sync');
            await runWithServerRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init, options) => apiSocket.request(path, init, options),
            }, async (authority) => await sync.refreshSessionMessages('child', { authority }));
            expect(observedFirstSeqs.length).toBeGreaterThan(0);
            expect(observedFirstSeqs.every((seq) => seq === 2)).toBe(true);
        } finally {
            unsubscribe();
        }
    });

    it.each([true, false])('publishes server-authority replacement coverage after materialization (hasMore=%s)', async (hasMore) => {
        applyChildForkSession();
        const previousCoverage = hasMore;
        if (previousCoverage) storage.getState().markSessionMessagesHistoryStartLoaded('child');
        const before = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
        requestMock.mockResolvedValue(Response.json({
            messages: [{
                id: 'replacement', seq: 2, localId: null, sidechainId: null, messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'replacement' } } },
                createdAt: 2, updatedAt: 2,
            }],
            hasMore, nextBeforeSeq: hasMore ? 2 : null,
        }));
        const firstSeqAtCoverage: Array<number | undefined> = [];
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessionMessagesHistoryStartLoaded.child !== true
                || previous.sessionMessagesHistoryStartLoaded.child === true) return;
            const transcript = state.sessionMessages.child!;
            firstSeqAtCoverage.push(transcript.messagesById[transcript.messageIdsOldestFirst[0]!]!.seq);
        });
        try {
            const { sync } = await import('./sync');
            await (sync as unknown as SyncForkPagingTestAccess).replaceWithServerTranscript(storage.getState().sessions.child!, { kind: 'hosted' });
            expect(storage.getState().sessionMessagesHistoryStartLoaded.child === true).toBe(!hasMore);
            expect(firstSeqAtCoverage).toEqual(hasMore ? [] : [2]);
            expect(Object.values(storage.getState().sessionMessages.child!.messagesById).map((message) => message.seq)).toEqual([2]);
            const replaced = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
            expect(replaced).not.toBe(before);
            expect(Object.values(replaced.combinedMessagesById).map((message) => message.seq)).toEqual([2]);
            if (hasMore) {
                storage.getState().replaceSessionMessages('child', [{
                    role: 'user', id: 'next-authority', seq: 3, localId: null, createdAt: 3,
                    isSidechain: false, content: { type: 'text', text: 'next authority' },
                }]);
                const nextAuthority = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
                expect(Object.values(nextAuthority.combinedMessagesById).map((message) => message.seq)).toEqual([3]);
            }
        } finally {
            unsubscribe();
        }
    });

    it('retains reached history start when a later snapshot merges a partial tail into the cache', async () => {
        applyChildForkSession();
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.sessionMessagesHasMoreOlderByKey.set('child:main', true);
        syncForTest.sessionMessagesBeforeSeqByKey.set('child:main', 9);
        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [], hasMore: false, nextBeforeSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await syncForTest.loadOlderMessagesForkAware('child');
        expect(storage.getState().sessionMessagesHistoryStartLoaded?.child).toBe(true);

        storage.setState((state) => ({
            sessionMessages: {
                ...state.sessionMessages,
                child: { ...state.sessionMessages.child!, isLoaded: false },
            },
        }));
        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [{
                id: 'new-tail', seq: 100, localId: null, sidechainId: null, messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'new tail' } } },
                createdAt: 100, updatedAt: 100,
            }],
            hasMore: true, nextBeforeSeq: 100,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await syncForTest.fetchMessages('child');

        const cachedSeqs = Object.values(storage.getState().sessionMessages.child!.messagesById).map((message) => message.seq);
        expect(cachedSeqs).toContain(10);
        expect(cachedSeqs).toContain(100);
        expect(storage.getState().sessionMessagesHistoryStartLoaded?.child).toBe(true);
    });

    it.each(['reset', 'evict', 'delete', 'disconnect'] as const)('publishes empty-final-page coverage and clears it on %s', async (cleanup) => {
        applyChildForkSession();
        storage.getState().applySessions([createSession('child', forkMetadata('parent', 0))]);
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.sessionMessagesHasMoreOlderByKey.set('child:main', true);
        syncForTest.sessionMessagesBeforeSeqByKey.set('child:main', 9);
        const before = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;

        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [], hasMore: false, nextBeforeSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await syncForTest.loadOlderMessagesForkAware('child');

        const reached = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
        expect(reached.segments.at(-1)).toMatchObject({ isHistoryStartLoaded: true });
        expect(reached).not.toBe(before);
        const items = reached.combinedMessageIdsOldestFirst.map((messageId) => ({
            kind: 'message' as const, id: messageId, messageId, createdAt: 10, seq: 10,
        }));
        expect(insertForkDividersIntoTranscriptItems({ items, fork: reached }).map((item) => item.kind))
            .toEqual(['fork-divider', 'message']);

        if (cleanup === 'reset') storage.getState().resetSessionMessages('child');
        if (cleanup === 'evict') storage.getState().evictSessionMessages('child');
        if (cleanup === 'delete') storage.getState().deleteSession('child');
        if (cleanup === 'disconnect') syncForTest.disconnectServer();
        expect(storage.getState().sessionMessagesHistoryStartLoaded.child).toBeUndefined();
    });

    it('does not prefetch ancestor context while the child still has older pages', async () => {
        applyChildForkSession();
        storage.getState().applySessions([createSession('parent')]);

        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.activeServerSessionIds.add('parent');
        syncForTest.sessionMessagesHasMoreOlderByKey.set('child:main', true);
        syncForTest.sessionMessagesBeforeSeqByKey.set('child:main', 9);

        requestMock.mockResolvedValue(new Response(JSON.stringify({
            messages: [],
            hasMore: false,
            nextBeforeSeq: null,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        await syncForTest.prefetchForkedTranscriptContext('child');

        expect(requestMock).not.toHaveBeenCalled();
    });

    it('pages from an empty child through a partial parent and known empty intermediate segment', async () => {
        storage.getState().applySessions([
            createSession('child', forkMetadata('parent', 3)),
            { ...createSession('parent', forkMetadata('empty', 0)), seq: 3 },
            createSession('empty', forkMetadata('root', 2)),
            { ...createSession('root', { path: '/tmp', host: 'h' }), seq: 2 },
        ]);
        storage.getState().applyMessages('root', [{
            role: 'user', content: { type: 'text', text: 'cached root' }, id: 'root-row',
            seq: 2, localId: null, createdAt: 2, isSidechain: false,
        }]);
        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        for (const id of ['parent', 'empty', 'root']) syncForTest.activeServerSessionIds.add(id);
        requestMock.mockImplementation(async (path: string) => {
            const url = new URL(path, 'https://test.invalid');
            if (url.pathname === '/v1/sessions/child/messages') {
                return new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 });
            }
            if (url.pathname === '/v1/sessions/parent/messages') {
                const seq = url.searchParams.get('beforeSeq') === '4' ? 3 : 1;
                return new Response(JSON.stringify({
                    messages: [{
                        id: `parent-${seq}`, seq, localId: null, sidechainId: null, messageRole: 'user',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `parent ${seq}` } } },
                        createdAt: seq, updatedAt: seq,
                    }],
                    hasMore: seq > 1, nextBeforeSeq: seq,
                }), { status: 200 });
            }
            throw new Error(`Unexpected request ${path}`);
        });

        await syncForTest.fetchMessages('child');
        expect(storage.getState().sessionMessages.child!.isLoaded).toBe(true);
        expect(storage.getState().sessionMessagesHistoryStartLoaded?.child).toBe(true);
        await syncForTest.prefetchForkedTranscriptContext('child');
        const partial = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
        expect(Object.values(partial.combinedMessagesById).map((message) => message.seq)).toEqual([3]);

        await syncForTest.loadOlderMessagesForkAware('child');
        const reached = getForkedTranscriptSnapshotCached(storage.getState(), 'child')!;
        expect(reached.segments.map((segment) => segment.sessionId)).toEqual(['root', 'empty', 'parent', 'child']);
        expect(reached.combinedMessageIdsOldestFirst.map((id) => reached.combinedMessagesById[id]!.seq))
            .toEqual([2, 1, 3]);
        expect(storage.getState().sessionMessages.root!.messageIdsOldestFirst).toHaveLength(1);
    });

    it('hydrates an unknown parent before loading ancestor context after child pages are exhausted', async () => {
        applyChildForkSession();

        const { sync } = await import('./sync');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.sessionMessagesHasMoreOlderByKey.set('child:main', false);
        syncForTest.sessionMessagesHasMoreOlderByKey.set('parent:main', false);

        requestMock.mockImplementation(async (path: string) => {
            if (path === '/v2/sessions/parent') {
                return new Response(JSON.stringify({
                    session: {
                        id: 'parent',
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        metadataVersion: 1,
                        metadata: JSON.stringify({ readStateV1: null }),
                        agentStateVersion: 1,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        accessLevel: 'admin',
                        canApprovePermissions: true,
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (path === '/v1/sessions/parent/turns') {
                return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
            }

            if (path === '/v1/sessions/parent/messages?scope=main') {
                return new Response(JSON.stringify({
                    messages: [],
                    hasMore: false,
                    nextBeforeSeq: null,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (isMainMessagesPageRequest(path, { sessionId: 'parent', beforeSeq: '4', limit: '150' })) {
                return new Response(JSON.stringify({
                    messages: [
                        {
                            id: 'parent-message',
                            seq: 3,
                            localId: null,
                            sidechainId: null,
                            messageRole: 'user',
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'parent context' } },
                            },
                            createdAt: 3,
                            updatedAt: 3,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: 1,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 500 });
        });

        const result = await syncForTest.loadOlderMessagesForkAware('child');

        const requestedPaths = requestMock.mock.calls.map((call) => call[0]);
        expect(requestedPaths[0]).toBe('/v2/sessions/parent');
        expect(requestedPaths.some((path) => isMainMessagesPageRequest(String(path), {
            sessionId: 'parent',
            beforeSeq: '4',
            limit: '150',
        }))).toBe(true);
        expect(result.loaded).toBe(1);
        expect(storage.getState().sessions.parent).toBeTruthy();
        const parentMessages = storage.getState().sessionMessages.parent?.messagesById ?? {};
        expect(Object.values(parentMessages).some((message) => message.kind === 'user-text' && message.text === 'parent context')).toBe(true);
    });
});
