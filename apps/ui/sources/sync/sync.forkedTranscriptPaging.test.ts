import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { getForkedTranscriptSnapshotCached } from './domains/sessionFork/forkedTranscriptSnapshot';
import { insertForkDividersIntoTranscriptItems } from '@/components/sessions/transcript/forkContext/insertForkDividersIntoTranscriptItems';
import { setActiveServerId, upsertServerProfile } from './domains/server/serverProfiles';
import type { ServerAccountRequestAuthority } from './runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

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
    credentials: { token: string; secret: string } | null;
    encryption: {
        decryptEncryptionKey: (encryptedKey: string | null | undefined) => Promise<null>;
        initializeSessions: () => Promise<void>;
        getSessionEncryption: () => null;
    };
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
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();

        const { sync } = await import('./syncEngine');
        const syncForTest = sync as unknown as SyncForkPagingTestAccess;
        syncForTest.disconnectServer();
        syncForTest.credentials = { token: 'token', secret: 'secret' };
        syncForTest.encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };
        syncForTest.activeServerSessionIds = new Set<string>(['child']);
        syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    });

    afterEach(() => {
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
        const server = await upsertServerProfile({ serverUrl: 'https://fork-coverage.example', name: 'Fork coverage' });
        await setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'fork-account' });
        applyChildForkSession();
        const authority = {
            scope: { serverId: server.id, accountId: 'fork-account' },
            context: {
                scope: 'scoped', timeoutMs: 30_000, targetServerId: server.id,
                targetServerUrl: server.serverUrl, targetAccountId: 'fork-account', token: 'test-token', encryption: null,
            },
            request: async () => Response.json({
                messages: [{
                    id: 'account-start', seq: 2, localId: null, sidechainId: null,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'account start' } } },
                    createdAt: 2, updatedAt: 2,
                }], hasMore: false, nextBeforeSeq: null,
            }),
            release: async () => undefined,
        } satisfies ServerAccountRequestAuthority;
        const observedFirstSeqs: Array<number | undefined> = [];
        const unsubscribe = storage.subscribe((state) => {
            if (state.sessionMessagesHistoryStartLoaded.child !== true) return;
            const transcript = state.sessionMessages.child!;
            observedFirstSeqs.push(transcript.messagesById[transcript.messageIdsOldestFirst[0]!]!.seq);
        });
        try {
            const { sync } = await import('./sync');
            await sync.refreshSessionMessages('child', { authority });
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
