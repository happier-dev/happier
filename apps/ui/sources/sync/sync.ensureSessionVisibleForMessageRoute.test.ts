import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

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

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
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
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());
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

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: runtimeFetchMock,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

import { storage } from './domains/state/storage';
import { renderHook } from '@/dev/testkit';
import { setActiveServerId, upsertServerProfile } from './domains/server/serverProfiles';
import { loadSessionMaterializedMaxSeqById } from './domains/state/persistence';
import type { AccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import type { Session } from './domains/state/storageTypes';
import type {
    ServerAccountSessionRequestAuthority,
} from './runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import {
    markSessionSurfaceHidden,
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from './domains/session/sessionSurfaceVisibility';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        encryptionMode: 'e2ee',
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    }
    throw lastError;
}

describe('sync.ensureSessionVisibleForMessageRoute', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        requestMock.mockReset();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
        resetSessionSurfaceVisibilityForTests();

        const { sync } = await import('./sync');
        sync.disconnectServer();
    });

    it('clears server-scoped session-list row/index caches on disconnect', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applySessions([createSession({ sessionId: 's_cached_1' })]);
        expect(storage.getState().sessionListRowStateByServerId?.[activeServerId]).toBeDefined();
        expect(storage.getState().sessionListIndexByServerId?.[activeServerId]).toBeDefined();

        const { sync } = await import('./sync');
        sync.disconnectServer();

        expect(storage.getState().sessionListRowStateByServerId?.[activeServerId]).toBeUndefined();
        expect(storage.getState().sessionListIndexByServerId?.[activeServerId]).toBeUndefined();
    });

    it('clears stale transcript array caches on disconnect', async () => {
        const { useSessionMessages } = await import('./domains/state/storage');
        const sessionId = 'cached_transcript_session';
        const messagesById = {
            'm-old': { id: 'm-old', kind: 'user-text', localId: null, createdAt: 1, text: 'cached' } as any,
        };
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    messageIdsOldestFirst: ['m-old'],
                    messagesById,
                    messagesMap: messagesById,
                    reducerState: {} as any,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));
        const hook = await renderHook(() => useSessionMessages(sessionId), {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const cached = hook.getCurrent().messages;
        expect(cached).toHaveLength(1);

        const { sync } = await import('./sync');
        await act(async () => {
            sync.disconnectServer();
            storage.getState().resetSessionMessages(sessionId);
        });

        const afterDisconnectReset = (await hook.rerender()).messages;
        expect(hook.getCurrent().isLoaded).toBe(false);
        expect(afterDisconnectReset).toEqual([]);

        await hook.unmount();
    });

    it('keeps the current transcript visible while pinned catch-up refreshes in the background', async () => {
        const sessionId = 'pinned_tail_reset_session';
        storage.getState().applySessions([{ ...createSession({ sessionId }), seq: 100 }]);
        storage.getState().resetSessionMessages(sessionId);

        const transcriptMessagesById = {
            'm-old': { id: 'm-old', kind: 'user-text', localId: null, createdAt: 1, text: 'cached' } as any,
        };
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    ...(state.sessionMessages[sessionId] as any),
                    messageIdsOldestFirst: ['m-old'],
                    messagesById: transcriptMessagesById,
                    messagesMap: transcriptMessagesById,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));

        const resetSessionMessagesSpy = vi.fn(storage.getState().resetSessionMessages);
        storage.setState((state) => ({
            ...state,
            resetSessionMessages: resetSessionMessagesSpy,
        }));

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).isForeground = true;
        (sync as any).pauseController = { isPaused: () => false };
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).sessionMaterializedMaxSeqById = { [sessionId]: 1 };
        (sync as any).syncTuning = {
            ...(sync as any).syncTuning,
            messageLargeGapSeq: 1,
            messageMaxIncrementalPagesOnResume: 1,
            messageForceSnapshotOfflineMs: 30 * 60 * 1000,
        };
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async (messages: Array<{ id: string; localId?: string | null; createdAt: number; seq?: number | null }>) =>
                    messages.map((message) => ({
                        id: message.id,
                        localId: message.localId ?? null,
                        createdAt: message.createdAt,
                        seq: message.seq ?? null,
                        content: {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    uuid: 'uuid_fresh_1',
                                    parentUuid: null,
                                    isSidechain: false,
                                    message: { role: 'user', content: 'fresh' },
                                },
                            },
                            meta: { source: 'cli' },
                        },
                    })),
            }),
        };

        let resolveRequest!: (response: Response) => void;
        const requestPromise = new Promise<Response>((resolve) => {
            resolveRequest = resolve;
        });
        requestMock.mockReturnValueOnce(requestPromise);

        markSessionSurfaceVisible(sessionId);
        const fetchPromise = (sync as any).fetchMessages(sessionId);

        expect(resetSessionMessagesSpy).not.toHaveBeenCalled();
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual(['m-old']);

        resolveRequest(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm-new',
                            seq: 125,
                            localId: null,
                            content: { t: 'encrypted', c: 'cipher' },
                            createdAt: 2,
                            updatedAt: 2,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        try {
            await fetchPromise;

            expect(resetSessionMessagesSpy).not.toHaveBeenCalled();
            expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toHaveLength(2);
            expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst?.[0]).toBe('m-old');
        } finally {
            markSessionSurfaceHidden(sessionId);
        }
    });

    it('persists session materialization progress in the active account/server scope', async () => {
        const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = scope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 7);
        syncInternals.flushSessionMaterializedMaxSeq();

        expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ 'session-a': 7 });
        expect(loadSessionMaterializedMaxSeqById()).toEqual({});
    });

    it('flushes pending session materialization progress before clearing the account/server scope', async () => {
        const scope: AccountSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = scope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 9);
        syncInternals.clearActiveAccountSettingsScope();

        expect(loadSessionMaterializedMaxSeqById(scope)).toEqual({ 'session-a': 9 });
        expect(loadSessionMaterializedMaxSeqById()).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqById).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqFlushTimer).toBeNull();
    });

    it('resets account settings sync status when clearing the account/server scope', async () => {
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        storage.getState().setAccountSettingsSyncStatus({
            state: 'failed',
            message: 'stale settings sync failure',
            retryable: true,
            kind: 'network',
            at: 123,
        });

        syncInternals.clearActiveAccountSettingsScope();

        expect(storage.getState().accountSettingsSyncStatus).toEqual({ state: 'idle', lastSyncedAt: null });
    });

    it('flushes old session materialization progress before activating a new account/server scope', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(serverId).toBeTruthy();

        const oldScope: AccountSettingsScope = { serverId, accountId: 'account-a' };
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        syncInternals.pendingSettingsScope = oldScope;
        syncInternals.sessionMaterializedMaxSeqById = {};
        syncInternals.sessionMaterializedMaxSeqDirty = false;

        syncInternals.markSessionMaterializedMaxSeq('session-a', 11);
        syncInternals.activateAccountSettingsScope('account-b');

        expect(loadSessionMaterializedMaxSeqById(oldScope)).toEqual({ 'session-a': 11 });
        expect(syncInternals.pendingSettingsScope).toEqual({ serverId, accountId: 'account-b' });
        expect(syncInternals.sessionMaterializedMaxSeqById).toEqual({});
        expect(syncInternals.sessionMaterializedMaxSeqFlushTimer).toBeNull();
    });

    it('resets stale account settings sync status when activating a new account/server scope', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://server-a.example.test', scope: 'tab' });
        const { sync } = await import('./sync');
        const syncInternals = sync as any;

        storage.getState().setAccountSettingsSyncStatus({
            state: 'retrying',
            message: 'previous scope retry',
            retryable: true,
            kind: 'server',
            at: 123,
            failuresCount: 2,
            nextRetryAt: 456,
        });

        syncInternals.activateAccountSettingsScope('account-b');

        expect(storage.getState().accountSettingsSyncStatus).toEqual({ state: 'idle', lastSyncedAt: null });
    });

    it('refuses a functional account-settings mutation when the account changes during preflush', async () => {
        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalSyncSettings = syncInternals.syncSettings;
        const originalCredentials = syncInternals.credentials;
        const originalEncryption = syncInternals.encryption;
        const originalScope = syncInternals.pendingSettingsScope;
        const originalGeneration = syncInternals.serverScopeGeneration;
        let releasePreflush!: () => void;
        const preflush = new Promise<void>((resolve) => { releasePreflush = resolve; });
        syncInternals.credentials = { token: 'account-a' };
        syncInternals.encryption = {};
        syncInternals.pendingSettingsScope = { serverId: 'server-a', accountId: 'account-a' };
        syncInternals.serverScopeGeneration = 10;
        syncInternals.syncSettings = vi.fn(async () => preflush);
        const mutate = vi.fn((raw: Record<string, unknown>) => raw);

        try {
            const operation = sync.mutateAccountSettings(mutate);
            syncInternals.pendingSettingsScope = { serverId: 'server-b', accountId: 'account-b' };
            syncInternals.serverScopeGeneration = 11;
            syncInternals.credentials = { token: 'account-b' };
            releasePreflush();

            await expect(operation).rejects.toThrow('Account settings scope changed while mutating settings');
            expect(mutate).not.toHaveBeenCalled();
        } finally {
            syncInternals.syncSettings = originalSyncSettings;
            syncInternals.credentials = originalCredentials;
            syncInternals.encryption = originalEncryption;
            syncInternals.pendingSettingsScope = originalScope;
            syncInternals.serverScopeGeneration = originalGeneration;
        }
    });

    it('hydrates e2ee session encryption on deep link before sessions snapshot fetch', async () => {
        const sessionId = 'deep_link_session';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;

        let ready = false;
        const decryptMetadata = vi.fn(async () => ({ readStateV1: null }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));

        (sync as any).encryption = {
            decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
            initializeSessions: async () => {
                ready = true;
            },
            getSessionEncryption: (_sessionId: string) =>
                ready ? ({ decryptMetadata, decryptAgentState } as any) : null,
        };

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataVersion: 1,
                        metadata: 'enc-meta',
                        agentStateVersion: 1,
                        agentState: 'enc-state',
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        const sessionByIdCalls = requestMock.mock.calls.filter(
            (call) => call?.[0] === `/v2/sessions/${sessionId}`,
        );
        expect(sessionByIdCalls).toHaveLength(1);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(true);
    });

    it('returns a retryable result when credentials are not yet available', async () => {
        const sessionId = 'deep_link_missing_creds';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = null;
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'unknown',
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('falls back to a session-list snapshot when socket new-session hydration cannot prove active-list visibility', async () => {
        const sessionId = 'socket_new_session_needs_snapshot_reconcile';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {});

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => {
                throw new Error('socket payload decrypt failed');
            }),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockImplementation(async () => (
            new Response('temporary session hydrate failure', { status: 503 })
        ));

        try {
            await syncInternals.handleUpdate({
                id: 'u_socket_new_session_reconcile',
                seq: 10,
                createdAt: 100,
                body: {
                    t: 'new-session',
                    id: sessionId,
                    seq: 1,
                    metadata: 'encrypted-metadata',
                    metadataVersion: 2,
                    agentState: 'encrypted-agent-state',
                    agentStateVersion: 3,
                    dataEncryptionKey: 'encrypted-data-key',
                    encryptionMode: 'e2ee',
                    active: true,
                    activeAt: 100,
                    createdAt: 90,
                    updatedAt: 100,
                },
            });

            await waitForAssertion(() => {
                expect(requestMock).toHaveBeenCalledWith(
                    `/v2/sessions/${sessionId}`,
                    expect.objectContaining({ method: 'GET' }),
                );
            });
            await waitForAssertion(() => {
                expect(fetchSessionsSpy).toHaveBeenCalledTimes(1);
            });
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
        }
    });

    it('refreshes the active session-list snapshot after socket new-session hydration even when the by-id row is locally indexed', async () => {
        const sessionId = 'socket_new_session_indexed_but_visible_list_stale';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
                serverId: activeServerId,
            } as Session & { serverId: string },
        ]);
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServerId]?.some((item) => (
                item.type === 'session' && item.sessionId === sessionId
            )),
        ).toBe(true);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {});

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({
                    id: sessionId,
                    seq: 2,
                    encryptionMode: 'plain',
                    metadata: { path: '/tmp/socket-indexed', host: 'local' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 1,
                    active: true,
                    activeAt: 120,
                    createdAt: 100,
                    updatedAt: 120,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('unexpected request', { status: 404 });
        });

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'socket-new-session-reconcile',
                activeServerId,
            );

            expect(requestMock).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(fetchSessionsSpy).toHaveBeenCalledTimes(1);
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
        }
    });

    it('keeps the exact socket-created active row visible when the reconcile list refresh omits it', async () => {
        const sessionId = 'socket_new_session_exact_row_retained_after_stale_refresh';
        const olderSessionId = 'socket_new_session_stale_refresh_older_row';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().applySessions([
            {
                ...createSession({ sessionId: olderSessionId }),
                encryptionMode: 'plain',
                serverId: activeServerId,
                metadata: { path: '/tmp/older-row', host: 'local' },
                metadataVersion: 1,
            } as Session & { serverId: string },
        ]);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {
            const olderRenderable = storage.getState().sessionListRenderables[olderSessionId];
            expect(olderRenderable).toBeDefined();
            storage.getState().replaceSessionListRenderables([olderRenderable]);
        });

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>([olderSessionId]);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({
                    session: {
                        id: sessionId,
                        seq: 2,
                        encryptionMode: 'plain',
                        metadata: JSON.stringify({ path: '/tmp/exact-socket-row', host: 'local' }),
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        active: true,
                        activeAt: 140,
                        archivedAt: null,
                        createdAt: 130,
                        updatedAt: 140,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('unexpected request', { status: 404 });
        });

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'socket-new-session-reconcile',
                activeServerId,
            );

            expect(fetchSessionsSpy).toHaveBeenCalledWith(expect.objectContaining({
                awaitSessionListHydration: true,
                prioritizeSessionIds: [sessionId],
                requiredHydrationSessionIds: [sessionId],
            }));
            expect(storage.getState().sessionListRenderables[sessionId]?.metadata?.path).toBe('/tmp/exact-socket-row');
            expect(
                storage.getState().sessionListIndexByServerId?.[activeServerId]?.some((item) => (
                    item.type === 'session' && item.sessionId === sessionId
                )),
            ).toBe(true);
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
        }
    });

    it('keeps visible cached socket update hydration targeted instead of refreshing the active session-list snapshot', async () => {
        const sessionId = 'socket_visible_cached_update_targeted_hydration';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        storage.getState().replaceSessionListRenderables([
            {
                id: sessionId,
                seq: 1,
                createdAt: 100,
                updatedAt: 100,
                active: true,
                activeAt: 100,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/visible-cached-update', host: 'local' },
                thinking: true,
                thinkingAt: 100,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);
        markSessionSurfaceVisible(sessionId, activeServerId);

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {});

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>(['older-session']);
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${sessionId}`) {
                return new Response(JSON.stringify({
                    id: sessionId,
                    seq: 2,
                    encryptionMode: 'plain',
                    metadata: { path: '/tmp/visible-cached-update', host: 'local' },
                    metadataVersion: 2,
                    agentState: null,
                    agentStateVersion: 1,
                    active: false,
                    activeAt: 120,
                    createdAt: 100,
                    updatedAt: 120,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('unexpected request', { status: 404 });
        });

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'socket-update-missing-session',
                activeServerId,
            );

            expect(requestMock).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(fetchSessionsSpy).not.toHaveBeenCalled();
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
            markSessionSurfaceHidden(sessionId);
        }
    });

    it('keeps shared-session visibility hydration targeted instead of refreshing the active session-list snapshot', async () => {
        const sessionId = 'share_visibility_targeted_hydration_only';
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'https://active.example.test', scope: 'tab' });
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).toBeTruthy();

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {});

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>();
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockResolvedValue(new Response(JSON.stringify({
            session: {
                id: sessionId,
                seq: 2,
                encryptionMode: 'plain',
                metadata: { path: '/tmp/share-targeted', host: 'local' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                active: true,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 120,
                share: { id: 'share-targeted', accessLevel: 'edit' },
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'share-visibility-change',
                activeServerId,
            );

            expect(requestMock).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(fetchSessionsSpy).not.toHaveBeenCalled();
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
        }
    });

    it('does not refresh the active session-list snapshot after hydrating a non-active source-server socket update', async () => {
        const sessionId = 'socket_foreign_server_targeted_hydration';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        const { sync } = await import('./sync');
        const syncInternals = sync as any;
        const originalFetchSessions = syncInternals.fetchSessions;
        const fetchSessionsSpy = vi.fn(async () => {});

        syncInternals.credentials = { token: 'active-token', secret: 'active-secret' };
        syncInternals.activeServerSessionIds = new Set<string>();
        syncInternals.hasFetchedSessionsSnapshotForActiveServer = true;
        syncInternals.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };
        syncInternals.fetchSessions = fetchSessionsSpy;

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        });
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({
            session: {
                id: sessionId,
                seq: 2,
                encryptionMode: 'plain',
                metadata: { path: '/tmp/foreign-targeted', host: 'owner' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                active: true,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 120,
                share: null,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        try {
            await syncInternals.hydrateSessionFromSocketUpdate(
                sessionId,
                'socket-new-session-reconcile',
                ownerServer.id,
            );

            expect(requestMock).not.toHaveBeenCalled();
            expect(runtimeFetchMock).toHaveBeenCalledWith(
                `https://scoped.example/v2/sessions/${sessionId}`,
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer scoped-token',
                    }),
                }),
            );
            expect(fetchSessionsSpy).not.toHaveBeenCalled();
        } finally {
            syncInternals.fetchSessions = originalFetchSessions;
        }
    });

    it('fast-paths a known encrypted session with metadata, encryption, and null agent state', async () => {
        const sessionId = 'known_session_null_agent_state';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { path: '/tmp/demo', host: 'local' },
                agentState: null,
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            getSessionEncryption: vi.fn(() => ({ decryptMetadata: vi.fn(), decryptAgentState: vi.fn() })),
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('does not fast-path a layout-v1 owner list row that is missing its owner view', async () => {
        const sessionId = 'layout1_owner_list_shell';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        }]);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            getSessionEncryption: vi.fn(() => null),
        };
        requestMock.mockResolvedValue(new Response('missing', { status: 404 }));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'missing',
            sessionId,
        });
        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('fast-paths a layout-v1 participant from strict shared metadata without owner data', async () => {
        const sessionId = 'layout1_shared_participant';
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
        }]);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            getSessionEncryption: vi.fn(() => null),
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('classifies session-by-id reachability failures as server unavailable retry results', async () => {
        const sessionId = 'deep_link_server_unavailable';
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };

        const connectivityError = new Error('active server request timed out');
        connectivityError.name = 'ServerFetchConnectivityTimeoutError';
        requestMock.mockRejectedValue(connectivityError);

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'retryable_failure',
            sessionId,
            cause: 'server_unavailable',
        });
    });

    it('returns a terminal missing result for not-found session ids so deep links can fail closed instead of spinning forever', async () => {
        const sessionId = 'deep_link_missing_session';

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };

        requestMock.mockResolvedValue(new Response('not found', { status: 404 }));

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'missing',
            sessionId,
            cause: 'not_found',
        });
    });

    it('initializes session encryption on the current encryption instance when it changes mid-hydration', async () => {
        const sessionId = 'deep_link_session_swap';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;

        let encryption2Initialized = false;
        const encryption2DecryptMetadata = vi.fn(async () => ({ readStateV1: null }));
        const encryption2DecryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
        const encryption2 = {
            decryptEncryptionKey: async () => new Uint8Array([4, 5, 6]),
            initializeSessions: async () => {
                encryption2Initialized = true;
            },
            getSessionEncryption: (_sessionId: string) =>
                encryption2Initialized ? ({ decryptMetadata: encryption2DecryptMetadata, decryptAgentState: encryption2DecryptAgentState } as any) : null,
        };

        let encryption1Initialized = false;
        const encryption1 = {
            decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
            initializeSessions: async () => {
                encryption1Initialized = true;
            },
            getSessionEncryption: (_sessionId: string) =>
                encryption1Initialized
                    ? ({
                          decryptMetadata: async () => {
                              (sync as any).encryption = encryption2 as any;
                              return { readStateV1: null };
                          },
                          decryptAgentState: async () => ({ controlledByUser: true }),
                      } as any)
                    : null,
        };

        (sync as any).encryption = encryption1 as any;

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataVersion: 1,
                        metadata: 'enc-meta',
                        agentStateVersion: 1,
                        agentState: 'enc-state',
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        expect((sync as any).encryption).toBe(encryption2);
        expect(encryption2.getSessionEncryption(sessionId)).not.toBeNull();
    });

    it('re-fetches a known session when forceRefresh is requested', async () => {
        const sessionId = 'known_session_force_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn((_sessionId: string) => ({ decryptMetadata: vi.fn(), decryptAgentState: vi.fn() })),
            decryptEncryptionKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
        };

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataVersion: 1,
                        metadata: 'enc-meta',
                        agentStateVersion: 1,
                        agentState: 'enc-state',
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        const sessionByIdCalls = requestMock.mock.calls.filter(
            (call) => call?.[0] === `/v2/sessions/${sessionId}`,
        );
        expect(sessionByIdCalls).toHaveLength(1);
    });

    it('re-fetches a known encrypted session when the stored record is still partially hydrated', async () => {
        const sessionId = 'known_session_partial_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        const initializeSessions = vi.fn(async () => {});
        const decryptMetadata = vi.fn(async () => ({ readStateV1: null }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
            initializeSessions,
            getSessionEncryption: vi.fn(() => ({ decryptMetadata, decryptAgentState })),
        };

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataVersion: 1,
                        metadata: 'enc-meta',
                        agentStateVersion: 1,
                        agentState: 'enc-state',
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer t',
                }),
            }),
        );
        expect(initializeSessions).toHaveBeenCalled();
    });

    it('keeps a fully hydrated known encrypted session on the fast path', async () => {
        const sessionId = 'known_session_fast_path';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => ({ decryptMetadata: vi.fn(), decryptAgentState: vi.fn() })),
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it('keeps a fully hydrated known plaintext session on the fast path without an encryption lookup', async () => {
        const sessionId = 'known_plain_session_fast_path';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        const getSessionEncryption = vi.fn(() => null);
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption,
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(requestMock).not.toHaveBeenCalled();
        expect(getSessionEncryption).not.toHaveBeenCalled();
    });

    it('hydrates through the preferred owner server when local cache maps the session to a non-active server', async () => {
        const sessionId = 'deep_link_scoped_owner';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);
        const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
        const renderable = buildSessionListRenderableFromSession(storage.getState().sessions[sessionId] as Session);
        storage.setState((state) => ({
            ...state,
            concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                [ownerServer.id]: {
                    serverName: String(ownerServer.name ?? ownerServer.id).trim() || ownerServer.id,
                    sessions: {
                        [sessionId]: renderable,
                    },
                },
            },
        }));

        const { sync } = await import('./sync');

        const initializeSessions = vi.fn(async () => {});
        (sync as any).credentials = { token: 'active-token', secret: 'active-secret' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions,
            getSessionEncryption: vi.fn(() => null),
        };

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        });
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
            serverId: ownerServer.id,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://scoped.example/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer scoped-token',
                }),
            }),
        );
        expect(storage.getState().sessions[sessionId]?.serverId).toBe(ownerServer.id);
        expect(storage.getState().sessionListRowStateByServerId?.[activeServer.id]?.[sessionId]).toBeUndefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(false);
        expect(storage.getState().sessionListRowStateByServerId?.[ownerServer.id]?.[sessionId]).toBeDefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[ownerServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(true);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(false);
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('hydrates through an explicit serverId override even when the active server differs', async () => {
        const sessionId = 'deep_link_explicit_server';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });

        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                encryptionMode: 'plain',
            },
        ]);
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        const initializeSessions = vi.fn(async () => {});

        (sync as any).credentials = { token: 'active-token', secret: 'active-secret' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => null,
            initializeSessions,
            getSessionEncryption: () => null,
        };

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        });
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, serverId: ownerServer.id })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
            serverId: ownerServer.id,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://scoped.example/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer scoped-token',
                }),
            }),
        );
        expect(storage.getState().sessions[sessionId]?.serverId).toBe(ownerServer.id);
        expect(storage.getState().sessionListRowStateByServerId?.[activeServer.id]?.[sessionId]).toBeUndefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[activeServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(false);
        expect(storage.getState().sessionListRowStateByServerId?.[ownerServer.id]?.[sessionId]).toBeDefined();
        expect(
            storage.getState().sessionListIndexByServerId?.[ownerServer.id]?.some(
                (item) => item.type === 'session' && item.sessionId === sessionId,
            ) ?? false,
        ).toBe(true);
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(false);
        expect(initializeSessions).not.toHaveBeenCalled();
    });

    it('does not recreate active message synchronization after captured-authority hydration completes following a reset', async () => {
        const sessionId = 'captured_authority_after_reset';
        const activeServer = upsertServerProfile({
            serverUrl: 'https://same-server.example',
            name: 'Same server',
        });
        setActiveServerId(activeServer.id, { scope: 'device' });
        const scope = {
            serverId: activeServer.id,
            accountId: 'account-a',
        };
        storage.setState({ profileScope: scope });

        let resolveHydration!: (response: Response) => void;
        const hydrationResponse = new Promise<Response>((resolve) => {
            resolveHydration = resolve;
        });
        const authorityRequest = vi.fn(async () => await hydrationResponse);
        const authority = {
            scope,
            context: {
                scope: 'scoped',
                timeoutMs: 30_000,
                targetServerId: activeServer.id,
                targetServerUrl: 'https://same-server.example',
                targetAccountId: scope.accountId,
                token: 'account-a-token',
                credentials: {
                    token: 'account-a-token',
                    secret: 'account-a-secret',
                },
                encryption: {
                    decryptEncryptionKey: async () => null,
                    initializeSessions: async () => undefined,
                    getSessionEncryption: () => null,
                },
            },
            request: authorityRequest,
        } as unknown as ServerAccountSessionRequestAuthority;

        const { sync } = await import('./sync');
        (sync as any).credentials = authority.context.credentials;
        (sync as any).encryption = authority.context.encryption;
        (sync as any).messagesSync = new Map();
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;

        const hydration = sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            authority,
        });
        await vi.waitFor(() => expect(authorityRequest).toHaveBeenCalledTimes(1));

        (sync as any).messagesSync.clear();
        storage.getState().resetSessionMessages(sessionId);
        resolveHydration(new Response(JSON.stringify({
            session: {
                id: sessionId,
                createdAt: 1,
                updatedAt: 2,
                seq: 3,
                active: false,
                activeAt: 2,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataVersion: 0,
                metadata: 'null',
                agentStateVersion: 0,
                agentState: null,
                share: null,
            },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(hydration).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect((sync as any).messagesSync.has(sessionId)).toBe(false);
        expect(requestMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();

        const ordinarySessionId = 'ordinary_hydration_after_reset';
        requestMock.mockImplementation(async (path: string) => {
            if (path === `/v2/sessions/${ordinarySessionId}`) {
                return new Response(JSON.stringify({
                    session: {
                        id: ordinarySessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: false,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({
                messages: [],
                hasMore: false,
                nextBeforeSeq: null,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await expect(sync.ensureSessionVisibleForMessageRoute(ordinarySessionId, {
            forceRefresh: true,
        })).resolves.toMatchObject({
            kind: 'available',
            sessionId: ordinarySessionId,
        });
        expect((sync as any).messagesSync.has(ordinarySessionId)).toBe(true);
    });

    it('initializes encrypted explicit-server route hydration with the owner server scope', async () => {
        const sessionId = 'deep_link_explicit_server_encrypted';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://scoped.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        const initializeSessions = vi.fn<(
            keys: Map<string, Uint8Array | null>,
            scope?: Readonly<{ serverId?: string | null }>,
        ) => Promise<void>>(async () => {});
        const scopedInitializeSessions = vi.fn(async () => {});

        (sync as any).credentials = { token: 'active-token', secret: 'active-secret' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
            initializeSessions,
            getSessionEncryption: () => null,
        };

        requestMock.mockRejectedValue(new Error('active request should not be used'));
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({
            decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
            initializeSessions: scopedInitializeSessions,
            getSessionEncryption: () => ({
                decryptMetadata: async () => ({ path: '/repo', host: 'owner' }),
                decryptAgentState: async () => ({ controlledByUser: true }),
            }),
        });
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'e2ee',
                        dataEncryptionKey: 'dek',
                        metadataVersion: 1,
                        metadata: 'enc-meta',
                        agentStateVersion: 1,
                        agentState: 'enc-state',
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, serverId: ownerServer.id })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
            serverId: ownerServer.id,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expect(scopedInitializeSessions).toHaveBeenCalled();
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        expect(initializeSessions.mock.calls[0]?.[0].get(sessionId)).toEqual(new Uint8Array([1, 2, 3]));
        expect(initializeSessions.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            serverId: ownerServer.id,
        }));
    });

    it('falls back to the active server when a route carries a stale unknown server id', async () => {
        const sessionId = 'deep_link_stale_route_server_id';
        const activeServer = upsertServerProfile({ serverUrl: 'http://localhost:52753', name: 'Active' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');

        (sync as any).credentials = { token: 'active-token', secret: 'active-secret' };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => {}),
            getSessionEncryption: vi.fn(() => null),
        };

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        createdAt: 1,
                        updatedAt: 2,
                        seq: 3,
                        active: true,
                        activeAt: 2,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 0,
                        metadata: 'null',
                        agentStateVersion: 0,
                        agentState: null,
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            serverId: '127.0.0.1-52753',
        })).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer active-token',
                }),
            }),
        );
        expect((sync as any).activeServerSessionIds.has(sessionId)).toBe(true);
    });

    it('ignores localStorage read errors while evaluating debug hydration logging', async () => {
        const sessionId = 'deep_link_local_storage_error';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadataVersion: 1,
                metadata: {
                    path: '/repo',
                    host: 'host',
                    machineId: 'machine-1',
                },
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    requests: {},
                    completedRequests: {},
                },
            } as Session,
        ]);

        const localStorageMock = {
            getItem: vi.fn(() => {
                throw new Error('storage blocked');
            }),
        };
        vi.stubGlobal('localStorage', localStorageMock as unknown as Storage);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).encryption = {
            decryptEncryptionKey: async () => new Uint8Array([1, 2, 3]),
            initializeSessions: async () => {},
            getSessionEncryption: vi.fn(() => ({ decryptMetadata: vi.fn(), decryptAgentState: vi.fn() })),
        };

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'available',
            sessionId,
        });
        expect(localStorageMock.getItem).toHaveBeenCalledWith('happier.debug.sessionHydrate');
    });

    it('records terminal auth and stops route hydration when session-by-id returns 401', async () => {
        const sessionId = 'deep_link_auth_failed';
        storage.getState().resetSessionMessages(sessionId);

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 't' };

        requestMock.mockResolvedValue(
            new Response(
                JSON.stringify({ error: 'auth failed' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(sync.ensureSessionVisibleForMessageRoute(sessionId)).resolves.toMatchObject({
            kind: 'missing',
            sessionId,
            cause: 'unauthorized',
        });

        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
    });
});
