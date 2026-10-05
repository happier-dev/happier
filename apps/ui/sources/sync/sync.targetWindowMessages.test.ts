import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getAllKeys() {
            return [...kvStore.keys()];
        }
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
// Scoped credential persistence and HTTP remain the only request boundaries.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }),
        },
    });
});
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: requestMock,
        emitWithAck: vi.fn(),
        send: vi.fn(),
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnected: vi.fn(),
        disconnect: vi.fn(),
        invalidateRequests: vi.fn(),
        initialize: vi.fn(),
    },
}));

import { createInactiveSessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';

type SyncTargetWindowTestAccess = {
    encryption: {
        getSessionEncryption: (sessionId: string) => null;
    };
    activeServerSessionIds: Set<string>;
    hasFetchedSessionsSnapshotForActiveServer: boolean;
    sessionMessagesBeforeSeqByKey: Map<string, number>;
    sessionMessagesHasMoreOlderByKey: Map<string, boolean>;
    sessionMessagesPaginationSupportedByKey: Map<string, boolean>;
    sessionMaterializedMaxSeqById: Record<string, number>;
};

const initialStorageState = storage.getState();

const SESSION_ID = 'target-window-session';

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        serverId: getActiveServerSnapshot().serverId,
        seq: 452,
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

function plainMessage(id: string, seq: number) {
    return {
        id,
        seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'plain',
            v: {
                role: 'user',
                content: { type: 'text', text: id },
            },
        },
        createdAt: 1_000 + seq,
        updatedAt: 2_000 + seq,
    };
}

async function seedSession(): Promise<SyncTargetWindowTestAccess> {
    const { sync } = await import('./syncEngine');
    const syncForTest = sync as unknown as SyncTargetWindowTestAccess;
    sync.disconnectServer();

    storage.getState().applySessions([createSession(SESSION_ID)]);

    syncForTest.encryption = {
        getSessionEncryption: () => null,
    };
    syncForTest.activeServerSessionIds = new Set<string>([SESSION_ID]);
    syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
    syncForTest.sessionMessagesBeforeSeqByKey.set(`${SESSION_ID}:main`, 303);
    syncForTest.sessionMessagesHasMoreOlderByKey.set(`${SESSION_ID}:main`, true);
    syncForTest.sessionMessagesPaginationSupportedByKey.set(`${SESSION_ID}:main`, true);
    syncForTest.sessionMaterializedMaxSeqById = { [SESSION_ID]: 452 };
    return syncForTest;
}

function readRequestUrl(): URL {
    const path = requestMock.mock.calls[0]?.[0];
    expect(path).toEqual(expect.any(String));
    return new URL(String(path), 'https://sync.test');
}

describe('sync target-window message adapter', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) {
                return Response.json({ ok: true });
            }
            return requestMock(input, init);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('loads a main transcript target window without mutating live-tail pagination', async () => {
        const syncForTest = await seedSession();
        requestMock.mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [
                    plainMessage('m331', 331),
                    plainMessage('m330', 330),
                    plainMessage('m329', 329),
                ],
                hasMore: true,
                nextBeforeSeq: 329,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )).mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [
                    plainMessage('m332', 332),
                    plainMessage('m333', 333),
                ],
                hasMore: true,
                nextAfterSeq: 333,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const { sync } = await import('./syncEngine');
        const result = await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 }, { limit: 3 });

        const url = readRequestUrl();
        expect(url.pathname).toBe(`/v1/sessions/${SESSION_ID}/messages`);
        expect(url.searchParams.get('scope')).toBe('main');
        expect(url.searchParams.get('beforeSeq')).toBe('332');
        expect(url.searchParams.get('limit')).toBe('3');
        expect(url.searchParams.has('afterSeq')).toBe(false);

        expect(result).toMatchObject({
            status: 'loaded',
            targetSeq: 331,
            targetPresent: true,
            rawSeqs: [331, 330, 329, 332, 333],
            appliedSeqs: [329, 330, 331, 332, 333],
            olderCursor: 329,
            newerCursor: 333,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });
        expect(result.windowId).toBe(`${SESSION_ID}:main:seq:331`);
        expect(syncForTest.sessionMessagesBeforeSeqByKey.get(`${SESSION_ID}:main`)).toBe(303);
        expect(syncForTest.sessionMessagesHasMoreOlderByKey.get(`${SESSION_ID}:main`)).toBe(true);
        expect(syncForTest.sessionMessagesPaginationSupportedByKey.get(`${SESSION_ID}:main`)).toBe(true);
        expect(syncForTest.sessionMaterializedMaxSeqById[SESSION_ID]).toBe(452);
        const loadedMessages = (storage.getState().sessionMessages[SESSION_ID]?.messageIdsOldestFirst ?? [])
            .map((id) => storage.getState().sessionMessages[SESSION_ID]?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => message != null);
        expect(loadedMessages.map((message) => message.seq)).toEqual([329, 330, 331, 332, 333]);
        expect(loadedMessages.map((message) => (message as { realID?: string }).realID)).toEqual(['m329', 'm330', 'm331', 'm332', 'm333']);
    });

    it('refreshes retained metadata through the real Sync page callback without replaying equal-revision content', async () => {
        await seedSession();
        let refreshed = false;
        requestMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = new URL(String(input instanceof Request ? input.url : input), 'https://sync.test');
            const row = plainMessage('metadata-target', 331);
            return Response.json({
                messages: url.searchParams.has('afterSeq') ? [] : [{
                    ...row,
                    content: refreshed
                        ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'must not replay' } } }
                        : row.content,
                    accountActor: refreshed
                        ? { v: 1, accountId: 'alice', profile: { firstName: 'Alice', lastName: null, username: null, avatarUrl: null } }
                        : null,
                    messageActionReference: { v: 1, sessionId: SESSION_ID, messageId: row.id, observedRevision: refreshed ? 'rev-2' : 'rev-1' },
                }],
                hasMore: false,
            });
        });
        const { sync } = await import('./sync');
        expect(await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 })).toMatchObject({ status: 'loaded' });
        const initial = Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById)[0];
        expect(initial).toMatchObject({ text: 'metadata-target', accountActor: null });

        refreshed = true;
        expect(await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 })).toMatchObject({ status: 'loaded' });
        expect(Object.values(storage.getState().sessionMessages[SESSION_ID].messagesById)).toEqual([
            expect.objectContaining({
                id: initial.id,
                text: 'metadata-target',
                accountActor: expect.objectContaining({ accountId: 'alice', profile: expect.objectContaining({ firstName: 'Alice' }) }),
                messageActionReference: expect.objectContaining({ observedRevision: 'rev-2' }),
            }),
        ]);
    });

    it('distinguishes web and native transient request failures from persistent not-ready failure', async () => {
        await seedSession();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        requestMock
            .mockRejectedValueOnce(new TypeError('Network request failed'))
            .mockRejectedValueOnce(new Error('Failed to fetch'))
            .mockRejectedValueOnce(new Error('persistent target-window pipeline failure'));

        const { sync } = await import('./sync');
        const nativeTransientResult = await sync.loadTargetWindowMessages(
            SESSION_ID,
            { kind: 'seq', seq: 331 },
            { limit: 1 },
        );
        const webTransientResult = await sync.loadTargetWindowMessages(
            SESSION_ID,
            { kind: 'seq', seq: 331 },
            { limit: 1 },
        );
        const persistentResult = await sync.loadTargetWindowMessages(
            SESSION_ID,
            { kind: 'seq', seq: 331 },
            { limit: 1 },
        );

        expect(nativeTransientResult.status).toBe('retryable_error');
        expect(webTransientResult.status).toBe('retryable_error');
        expect(persistentResult.status).toBe('not_ready');
        expect(consoleError).toHaveBeenCalledTimes(3);
    });

    it('exposes the canonical per-session target-window state', async () => {
        await seedSession();
        requestMock.mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [plainMessage('m331', 331)],
                hasMore: false,
                nextBeforeSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )).mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [],
                hasMore: false,
                nextAfterSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const { sync } = await import('./sync');
        const inactiveState = sync.getSessionTargetWindowState(SESSION_ID);
        expect(inactiveState).toEqual(createInactiveSessionMessagesWindowState());
        expect(sync.getSessionTargetWindowState(SESSION_ID)).toBe(inactiveState);

        await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 }, { limit: 1 });

        expect(sync.getSessionTargetWindowState(SESSION_ID)).toMatchObject({
            isWindowMode: true,
            windowId: `${SESSION_ID}:main:seq:331`,
            targetSeq: 331,
            windowMinSeq: 331,
            windowMaxSeq: 331,
            olderCursor: null,
            newerCursor: 331,
            hasMoreOlder: false,
            hasMoreNewer: false,
        });
    });

    it('notifies target-window subscribers on activation and live-tail exit', async () => {
        await seedSession();
        requestMock.mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [plainMessage('m331', 331)],
                hasMore: false,
                nextBeforeSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )).mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [],
                hasMore: false,
                nextAfterSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const { sync } = await import('./sync');
        const listener = vi.fn();
        const unsubscribe = sync.subscribeSessionTargetWindowState(SESSION_ID, listener);

        await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 }, { limit: 1 });
        expect(listener).toHaveBeenCalledTimes(1);

        sync.markSessionLiveTailIntent(SESSION_ID);
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        sync.markSessionLiveTailIntent(SESSION_ID);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('loads a storage-present same-server target window after the active-session snapshot omits it', async () => {
        const syncForTest = await seedSession();
        syncForTest.activeServerSessionIds.clear();
        syncForTest.hasFetchedSessionsSnapshotForActiveServer = true;
        requestMock.mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [plainMessage('m331', 331)],
                hasMore: false,
                nextBeforeSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )).mockResolvedValueOnce(new Response(
            JSON.stringify({
                messages: [],
                hasMore: false,
                nextAfterSeq: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const { sync } = await import('./sync');
        const result = await sync.loadTargetWindowMessages(SESSION_ID, { kind: 'seq', seq: 331 }, { limit: 1 });

        expect(result.status).toBe('loaded');
        expect(requestMock).toHaveBeenCalled();
    });
});
