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
import type { NormalizedMessage } from './typesRaw/normalize';

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

        const { sync } = await import('./sync');
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

            if (path.startsWith('/v1/sessions/parent/messages?beforeSeq=4')) {
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
        expect(requestedPaths).toContainEqual(expect.stringContaining('/v1/sessions/parent/messages?beforeSeq=4'));
        expect(result.loaded).toBe(1);
        expect(storage.getState().sessions.parent).toBeTruthy();
        const parentMessages = storage.getState().sessionMessages.parent?.messagesById ?? {};
        expect(Object.values(parentMessages).some((message) => message.kind === 'user-text' && message.text === 'parent context')).toBe(true);
    });
});
