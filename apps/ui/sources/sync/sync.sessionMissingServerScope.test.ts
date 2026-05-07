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
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const requestMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn());
const machineDirectSessionTranscriptPageMock = vi.hoisted(() => vi.fn());
const machineDirectSessionTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const sessionRpcWithPreferredSessionScopeMock = vi.hoisted(() => vi.fn());
const emitSessionMetadataUpdateWithServerScopeMock = vi.hoisted(() => vi.fn());
const notifyActivityReadyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineDirectSessions', () => ({
    machineDirectSessionTranscriptPage: machineDirectSessionTranscriptPageMock,
    machineDirectSessionTranscriptReadAfter: machineDirectSessionTranscriptReadAfterMock,
}));
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
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (params: unknown) => sessionRpcWithPreferredSessionScopeMock(params),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope', () => ({
    emitSessionMetadataUpdateWithServerScope: (params: unknown) => emitSessionMetadataUpdateWithServerScopeMock(params),
}));
vi.mock('@/activity/notifications/runtime/activityLocalNotificationBus', () => ({
    notifyActivityReady: (...args: unknown[]) => notifyActivityReadyMock(...args),
}));

import { storage } from './domains/state/storage';
import { setActiveServerId, upsertServerProfile } from './domains/server/serverProfiles';
import { saveAccountSettings, savePendingAccountSettings } from './domains/state/accountSettingsPersistence';
import { createAccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import { settingsDefaults } from './domains/settings/settings';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import type { Session } from './domains/state/storageTypes';

const initialStorageState = storage.getState();

type SyncMetadataPatchTestAccess = {
    credentials: { token: string; secret: string } | null;
    encryption: {
        decryptEncryptionKey: (encryptedKey: string | null | undefined) => Promise<null>;
        initializeSessions: () => Promise<void>;
        getSessionEncryption: (sessionId: string) => null;
    };
};

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function createDirectSession(sessionId: string): Session {
    const now = Date.now();
    return {
        ...createSession(sessionId),
        createdAt: now,
        updatedAt: now,
        metadata: {
            path: '',
            host: '',
            machineId: 'machine-1',
            directSessionV1: {
                v: 1,
                providerId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        },
    };
}

function expectHeaderValue(headers: HeadersInit | undefined, key: string, value: string) {
    expect(new Headers(headers).get(key)).toBe(value);
}

function findRuntimeFetchCall(url: string) {
    const call = runtimeFetchMock.mock.calls.find(([input]) => String(input) === url);
    expect(call, `expected runtimeFetch to be called with ${url}`).toBeTruthy();
    return call;
}

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('sync.fetchMessages server-scoped known-session checks', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        requestMock.mockReset();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
        machineDirectSessionTranscriptPageMock.mockReset();
        machineDirectSessionTranscriptReadAfterMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        sessionRpcWithPreferredSessionScopeMock.mockReset();
        emitSessionMetadataUpdateWithServerScopeMock.mockReset();
        notifyActivityReadyMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not delete local session when snapshot is loaded and session is absent on active server', async () => {
        const sessionId = 'stale_session_id';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();
        expect(storage.getState().sessions[sessionId]).not.toBeUndefined();
        // Ensure we don't get stuck in a perpetual loading state.
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
    });

    it('keeps retry semantics before first session snapshot for the active server', async () => {
        const sessionId = 'before_snapshot_session';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('keeps retry semantics for active-server sessions with missing encryption', async () => {
        const sessionId = 'known_active_session';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('fetches plaintext session messages without requiring session encryption', async () => {
        const sessionId = 'plain_active_session';
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        requestMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'plain-message-1',
                            seq: 1,
                            localId: null,
                            sidechainId: null,
                            content: {
                                t: 'plain',
                                v: { role: 'user', content: { type: 'text', text: 'hello plain sync' } },
                            },
                            createdAt: 1_001,
                            updatedAt: 1_001,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        const getSessionEncryption = vi.fn(() => null);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(getSessionEncryption).not.toHaveBeenCalled();
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello plain sync')).toBe(true);
    });

    it('treats sessions applied after the initial snapshot as known on the active server', async () => {
        const sessionId = 'new_after_snapshot';
        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        // Snapshot already fetched, but the set does not yet include this newly applied session.
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        (sync as any).applySessions([createSession(sessionId)]);

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            `Session encryption not ready for ${sessionId}`,
        );
    });

    it('loads direct session transcripts from provider-backed paging without requiring session encryption', async () => {
        const sessionId = 'direct_session_id';
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            hasMore: true,
        });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-1',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), { serverId: 'server-owned' });
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail',
        }), { serverId: 'server-owned' });
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello direct')).toBe(true);
    });

    it('fetches persisted session messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_messages';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([createSession(sessionId)]);

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    messages: [
                        {
                            id: 'm1',
                            seq: 1,
                            localId: null,
                            sidechainId: null,
                            content: { t: 'encrypted', c: 'ciphertext-1' },
                            createdAt: 1_001,
                            updatedAt: 1_001,
                        },
                    ],
                    hasMore: false,
                    nextBeforeSeq: null,
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async () => [
                    {
                        id: 'm1',
                        seq: 1,
                        localId: null,
                        createdAt: 1_001,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: 'hello scoped' },
                        },
                    },
                ],
            }),
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://owner.example/v1/sessions/${sessionId}/messages?scope=main`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        const ownerMessagesCall = findRuntimeFetchCall(`https://owner.example/v1/sessions/${sessionId}/messages?scope=main`);
        expectHeaderValue(ownerMessagesCall?.[1]?.headers, 'Authorization', 'Bearer owner-token');
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello scoped')).toBe(true);
    });

    it('pages older persisted session messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_older';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([createSession(sessionId)]);

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [
                            {
                                id: 'm2',
                                seq: 2,
                                localId: null,
                                sidechainId: null,
                                content: { t: 'encrypted', c: 'ciphertext-2' },
                                createdAt: 1_002,
                                updatedAt: 1_002,
                            },
                        ],
                        hasMore: true,
                        nextBeforeSeq: 2,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        messages: [
                            {
                                id: 'm1',
                                seq: 1,
                                localId: null,
                                sidechainId: null,
                                content: { t: 'encrypted', c: 'ciphertext-1' },
                                createdAt: 1_001,
                                updatedAt: 1_001,
                            },
                        ],
                        hasMore: false,
                        nextBeforeSeq: null,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => ({
                decryptMessages: async (messages: Array<{ id: string; seq: number; createdAt: number }>) =>
                    messages.map((message) => ({
                        id: message.id,
                        seq: message.seq,
                        localId: null,
                        createdAt: message.createdAt,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: message.id === 'm2' ? 'latest' : 'older' },
                        },
                    })),
            }),
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const result = await (sync as any).loadOlderMessages(sessionId);

        expect(result).toEqual({ loaded: 1, hasMore: false, status: 'no_more' });
        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenNthCalledWith(
            2,
            `https://owner.example/v1/sessions/${sessionId}/messages?beforeSeq=2&limit=150&scope=main`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        expectHeaderValue(runtimeFetchMock.mock.calls[1]?.[1]?.headers, 'Authorization', 'Bearer owner-token');
    });

    it('fetches pending messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_pending_fetch';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
        } as Session]);

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    pending: [
                        {
                            localId: 'pending-1',
                            content: {
                                t: 'plain',
                                v: {
                                    role: 'user',
                                    content: { type: 'text', text: 'queued remotely' },
                                },
                            },
                            status: 'queued',
                            position: 0,
                            createdAt: 100,
                            updatedAt: 100,
                            discardedAt: null,
                            discardedReason: null,
                            authorAccountId: null,
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const { sync } = await import('./sync');

        await expect((sync as any).fetchPendingMessages(sessionId)).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://owner.example/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        const ownerPendingCall = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending?includeDiscarded=1`);
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Authorization', 'Bearer owner-token');
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.text)).toEqual(['queued remotely']);
    });

    it('enqueues pending messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_pending_enqueue';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
        } as Session]);

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'owner-token', secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(null, { status: 200 }));

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        await expect((sync as any).enqueuePendingMessage(sessionId, 'hello pending')).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://owner.example/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({
                method: 'POST',
            }),
        );
        const ownerPendingCall = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending`);
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Authorization', 'Bearer owner-token');
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Content-Type', 'application/json');
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.text)).toEqual(['hello pending']);
    });

    it('routes abortSession through the preferred owner server scope', async () => {
        sessionRpcWithPreferredSessionScopeMock.mockResolvedValue(undefined);

        const { sync } = await import('./sync');

        await expect((sync as any).abortSession('session-1')).resolves.toBeUndefined();

        expect(sessionRpcWithPreferredSessionScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            method: 'abort',
            payload: {
                reason: expect.stringContaining("The user doesn't want to proceed"),
            },
        });
    });

    it('routes patchSessionMetadataWithRetry through the scoped metadata updater', async () => {
        const sessionId = 'plain_metadata_session';
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: {
                path: '/tmp/repo',
                host: 'test-host',
            },
        } as Session]);
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');

        await expect(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({
                ...metadata,
                summary: { text: 'Renamed session', updatedAt: 123 },
            })),
        ).resolves.toBeUndefined();

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });
        expect(storage.getState().sessions[sessionId]?.metadataVersion).toBe(3);
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.summary?.text).toBe('Renamed session');
    });

    it('supports overriding the server scope used by patchSessionMetadataWithRetry', async () => {
        const sessionId = 'plain_metadata_session_override';
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: {
                path: '/tmp/repo',
                host: 'test-host',
            },
        } as Session]);
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');

        await expect(
            sync.patchSessionMetadataWithRetry(
                sessionId,
                (metadata) => ({
                    ...metadata,
                    summary: { text: 'Renamed session', updatedAt: 123 },
                }),
                { serverId: 'server_override' },
            ),
        ).resolves.toBeUndefined();

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
            serverId: 'server_override',
        });
    });

    it('hydrates lightweight session rows before patching metadata', async () => {
        const sessionId = 'plain_metadata_lightweight_row';
        requestMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    session: {
                        id: sessionId,
                        seq: 1,
                        createdAt: 1_000,
                        updatedAt: 1_000,
                        active: true,
                        activeAt: 1_000,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 2,
                        metadata: JSON.stringify({
                            path: '/tmp/repo',
                            host: 'test-host',
                        }),
                        agentStateVersion: 1,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        share: null,
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            version: 3,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });

        const { sync } = await import('./sync');
        const syncForMetadataPatch = sync as unknown as SyncMetadataPatchTestAccess;
        syncForMetadataPatch.credentials = { token: 'active-token', secret: 'active-secret' };
        syncForMetadataPatch.encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };

        await expect(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) => ({
                ...metadata,
                summary: { text: 'Renamed session', updatedAt: 123 },
            })),
        ).resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({
                method: 'GET',
            }),
        );
        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            expectedVersion: 2,
            metadata: JSON.stringify({
                path: '/tmp/repo',
                host: 'test-host',
                summary: { text: 'Renamed session', updatedAt: 123 },
            }),
        });
        expect(storage.getState().sessions[sessionId]?.metadata?.summary?.text).toBe('Renamed session');
    });

    it('drops stale direct transcript fetch results after the server scope resets mid-request', async () => {
        const sessionId = 'direct_session_scope_reset';
        storage.getState().applySessions([createDirectSession(sessionId)]);

        let resolvePage: ((value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: 'user'; content: { type: 'text'; text: string } };
            }>;
            nextCursor: string | null;
            hasMore: boolean;
        }) => void) | null = null;

        machineDirectSessionTranscriptPageMock.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolvePage = resolve;
            }),
        );
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-stale',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        const fetchPromise = (sync as any).fetchMessages(sessionId);

        if (!resolvePage) {
            throw new Error('expected direct transcript page request to be pending');
        }
        (sync as any).resetServerScopedRuntimeState();

        const completePage = resolvePage as ((value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: 'user'; content: { type: 'text'; text: string } };
            }>;
            nextCursor: string | null;
            hasMore: boolean;
        }) => void) | null;
        if (!completePage) {
            throw new Error('expected direct transcript page request to remain pending');
        }
        completePage({
            ok: true,
            items: [
                {
                    id: 'direct-msg-stale',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'stale direct' } },
                },
            ],
            nextCursor: 'older-cursor-stale',
            hasMore: true,
        });

        await expect(fetchPromise).resolves.toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(machineDirectSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
    });

    it('pages older direct transcript messages using provider cursors', async () => {
        const sessionId = 'direct_session_paging';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'latest' } },
                    },
                ],
                nextCursor: 'older-cursor-2',
                hasMore: true,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'older' } },
                    },
                ],
                nextCursor: null,
                hasMore: false,
            });
        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-2',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const result = await (sync as any).loadOlderMessages(sessionId);

        expect(result).toEqual({ loaded: 1, hasMore: false, status: 'no_more' });
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            remoteSessionId: 'vendor-session-1',
            cursor: 'older-cursor-2',
            direction: 'older',
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['older', 'latest']);
    });

    it('refreshes loaded direct session transcripts through the shared messages invalidation path', async () => {
        const sessionId = 'direct_session_refresh';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'page-tail-cursor-1',
            hasMore: false,
        });
        machineDirectSessionTranscriptReadAfterMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                    },
                ],
                nextCursor: 'tail-cursor-2',
                truncated: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'page-tail-cursor-1',
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);
    });

    it('applies pushed direct-session transcript deltas and advances the tail cursor for fallback paging', async () => {
        const sessionId = 'direct_session_push_delta';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'page-tail-cursor-1',
            hasMore: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                },
            ],
            nextCursor: 'tail-cursor-2',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);

        machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });
        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail-cursor-2',
        }), expect.anything());
    });

    it('emits activity ready notifications for pushed direct-session transcript deltas when voice is suppressed', async () => {
        const sessionId = 'direct_session_push_ready_notification';
        storage.getState().applySessions([createDirectSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-ready-1',
                    createdAtMs: 2,
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'event',
                            id: 'direct-ready-event-1',
                            data: { type: 'ready' },
                        },
                    },
                },
            ],
            nextCursor: 'ready-tail-cursor-1',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(notifyActivityReadyMock).toHaveBeenCalledWith(sessionId, expect.any(Array));
    });

    it('emits activity notifications for pushed direct-session agent replies without requiring a ready event', async () => {
        const sessionId = 'direct_session_push_agent_reply_notification';
        storage.getState().applySessions([createDirectSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-agent-reply-1',
                    createdAtMs: 2,
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: {
                                type: 'message',
                                message: 'followed direct reply',
                            },
                        },
                    },
                },
            ],
            nextCursor: 'agent-reply-tail-cursor-1',
            truncated: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(notifyActivityReadyMock).toHaveBeenCalledWith(sessionId, [
            expect.objectContaining({
                kind: 'agent-text',
                text: 'followed direct reply',
            }),
        ]);
    });

    it('refetches direct-session transcript state when a pushed delta is truncated', async () => {
        const sessionId = 'direct_session_truncated_delta';
        storage.getState().applySessions([createDirectSession(sessionId)]);
        machineDirectSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                    },
                ],
                nextCursor: null,
                tailCursor: 'tail-cursor-1',
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                    },
                    {
                        id: 'direct-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'reloaded direct' } },
                    },
                ],
                nextCursor: null,
                tailCursor: 'tail-cursor-2',
                hasMore: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        (sync as any).handleEphemeralUpdate({
            type: 'direct-session-transcript-delta',
            sessionId,
            items: [
                {
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'partial direct' } },
                },
            ],
            nextCursor: 'tail-cursor-2',
            truncated: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(machineDirectSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineDirectSessionTranscriptPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), expect.anything());

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'reloaded direct']);
    });

    it('activates the account settings scope and reloads scoped pending settings for active credentials', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const { sync } = await import('./sync');
        const credentials = {
            token: buildTokenWithSub('account-settings-user'),
            secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        };

        (sync as any).activateAccountSettingsScopeForCredentials(credentials);

        expect(storage.getState().settingsScope).toEqual(scope);
        expect(storage.getState().settingsVersion).toBe(7);
        expect(storage.getState().settings.viewInline).toBe(true);
        expect((sync as any).pendingSettingsScope).toEqual(scope);
        expect((sync as any).pendingSettings).toEqual({ viewInline: false });
    });

    it('switches the active account pet library projection when credentials change account scope', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });

        const { sync } = await import('./sync');

        (sync as any).activateAccountSettingsScopeForCredentials({
            token: buildTokenWithSub('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
        });
        storage.getState().upsertAccountPet({
            accountPetId: 'pet-a',
            packageFormat: 'codex-compatible-atlas-v1',
            manifest: {
                id: 'blink-a',
                displayName: 'Blink A',
                description: 'Pet A',
                spritesheetPath: 'spritesheet.webp',
            },
            spritesheetAssetRef: {
                assetId: 'asset-a',
                mediaType: 'image/webp',
                digest: 'sha256:asset-a',
                sizeBytes: 5,
            },
            digest: 'sha256:pkg-a',
            sizeBytes: 128,
            createdAt: 1,
            updatedAt: 2,
            origin: { kind: 'manualImport' },
        });
        expect(Object.keys(storage.getState().accountPetsById)).toEqual(['pet-a']);

        (sync as any).activateAccountSettingsScopeForCredentials({
            token: buildTokenWithSub('account-b'),
            secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
        });

        expect(storage.getState().accountPetsById).toEqual({});
    });

    it('clears the account settings scope when credentials contain a malformed token', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const previousDebugFlag = process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;

        try {
            const { sync } = await import('./sync');
            (sync as any).activateAccountSettingsScopeForCredentials({
                token: buildTokenWithSub('account-settings-user'),
                secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });

            process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = '1';
            expect((sync as any).activateAccountSettingsScopeForCredentials({
                token: 'not-a-token',
                secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
            })).toBeNull();

            expect(storage.getState().settingsScope).toBeNull();
            expect(storage.getState().settingsVersion).toBeNull();
            expect(storage.getState().settings.viewInline).toBe(settingsDefaults.viewInline);
            expect(storage.getState().accountPetsById).toEqual({});
            expect((sync as any).pendingSettingsScope).toBeNull();
            expect((sync as any).pendingSettings).toEqual({});
            expect(warnSpy).toHaveBeenCalledWith(
                '[settings-sync] Sync.activateAccountSettingsScopeForCredentials: invalid token',
                expect.objectContaining({ error: expect.stringContaining('Invalid token') }),
            );
        } finally {
            if (previousDebugFlag === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = previousDebugFlag;
            }
            warnSpy.mockRestore();
        }
    });

    it('rejects create credentials with an empty token subject and clears the active settings scope', async () => {
        const server = upsertServerProfile({ serverUrl: 'https://settings-scope.example', name: 'Settings Scope' });
        setActiveServerId(server.id, { scope: 'device' });
        const scope = createAccountSettingsScope(server.id, 'account-settings-user');
        expect(scope).not.toBeNull();
        saveAccountSettings(scope!, { ...settingsDefaults, viewInline: true }, 7);
        savePendingAccountSettings(scope!, { viewInline: false });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const previousDebugFlag = process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;

        try {
            const { sync } = await import('./sync');
            (sync as any).activateAccountSettingsScopeForCredentials({
                token: buildTokenWithSub('account-settings-user'),
                secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });
            storage.getState().upsertAccountPet({
                accountPetId: 'pet-a',
                packageFormat: 'codex-compatible-atlas-v1',
                manifest: {
                    id: 'blink-a',
                    displayName: 'Blink A',
                    description: 'Pet A',
                    spritesheetPath: 'spritesheet.webp',
                },
                spritesheetAssetRef: {
                    assetId: 'asset-a',
                    mediaType: 'image/webp',
                    digest: 'sha256:asset-a',
                    sizeBytes: 5,
                },
                digest: 'sha256:pkg-a',
                sizeBytes: 128,
                createdAt: 1,
                updatedAt: 2,
                origin: { kind: 'manualImport' },
            });

            process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = '1';
            await expect(sync.create({
                token: buildTokenWithSub(''),
                secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
            }, {
                anonID: 'anon-empty-sub',
                initializeSessions: async () => undefined,
                getContentPrivateKey: () => new Uint8Array(32).fill(5),
            } as any)).rejects.toThrow('Invalid auth token');

            expect(storage.getState().settingsScope).toBeNull();
            expect(storage.getState().settingsVersion).toBeNull();
            expect(storage.getState().accountPetsById).toEqual({});
            expect((sync as any).pendingSettingsScope).toBeNull();
            expect((sync as any).pendingSettings).toEqual({});
            expect(warnSpy).toHaveBeenCalledWith(
                '[settings-sync] Sync.activateAccountSettingsScopeForCredentials: invalid token',
                expect.objectContaining({ error: expect.stringContaining('sub') }),
            );
        } finally {
            if (previousDebugFlag === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SETTINGS_SYNC = previousDebugFlag;
            }
            warnSpy.mockRestore();
        }
    });

});
