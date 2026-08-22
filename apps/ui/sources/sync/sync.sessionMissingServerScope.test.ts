import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

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
const machineExternalSessionTranscriptPageMock = vi.hoisted(() => vi.fn());
const machineExternalSessionTranscriptReadAfterMock = vi.hoisted(() => vi.fn());
const machineExternalSessionTranscriptRefreshReadAfterMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const sessionRpcWithPreferredSessionScopeMock = vi.hoisted(() => vi.fn());
const emitSessionMetadataUpdateWithServerScopeMock = vi.hoisted(() => vi.fn());
const notifyActivityReadyMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionTranscriptPage: machineExternalSessionTranscriptPageMock,
    machineExternalSessionTranscriptReadAfter: machineExternalSessionTranscriptReadAfterMock,
    machineExternalSessionTranscriptRefreshReadAfter: machineExternalSessionTranscriptRefreshReadAfterMock,
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
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/auth/storage/tokenStorage')
    >();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: getCredentialsForServerUrlMock,
        },
    };
});
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
vi.mock('@/activity/notifications/runtime/activityLocalNotificationBus', async () => {
    const actual = await vi.importActual<typeof import('@/activity/notifications/runtime/activityLocalNotificationBus')>('@/activity/notifications/runtime/activityLocalNotificationBus');
    return {
        ...actual,
        notifyActivityReady: (...args: unknown[]) => notifyActivityReadyMock(...args),
    };
});

import { storage } from './domains/state/storage';
import type { ApiUpdateContainer } from './api/types/apiTypes';
import {
    clearTabActiveServerId,
    getActiveServerSnapshot,
    setActiveServerId,
    upsertServerProfile,
} from './domains/server/serverProfiles';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { saveAccountSettings, savePendingAccountSettings } from './domains/state/accountSettingsPersistence';
import { loadPendingOutboxForSession } from './domains/state/pendingOutboxPersistence';
import { createAccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import { settingsDefaults } from './domains/settings/settings';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import type { Machine, Session } from './domains/state/storageTypes';
import type { SessionListRenderableSession } from './domains/session/listing/sessionListRenderable';
import type { NormalizedMessage, RawRecord } from './typesRaw';
import { enterDemoMode, resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema,
    sealSessionOwnerMetadataEnvelopeV1,
    type AccountEncryptionCurrentnessResponse,
    type ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';
import { createVoiceHistoryConsumer } from '@/voice/history/voiceHistoryConsumer';
import type { ServerAccountSessionRequestAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import {
    applyTranscriptStreamSegmentDelta,
    isTranscriptStreamSegmentAssemblyReady,
    noteTranscriptStreamSegmentSnapshot,
    resetTranscriptStreamSegmentAssemblyForTests,
} from './engine/sessions/transcriptStreamSegmentAssembly';
import { handleUpdateContainer } from './engine/socket/socket';

const initialStorageState = storage.getState();

function currentPendingInputFeaturesResponse(): Response {
    return Response.json({
        features: {},
        capabilities: {
            session: {
                runtimeActivity: { protocolVersion: 2 },
                pendingInput: { protocolVersion: 1 },
            },
        },
    });
}

const plainAccountEncryptionCurrentness = {
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

function currentPlainAccountEncryptionCurrentnessResponse(): Response {
    return Response.json(plainAccountEncryptionCurrentness);
}

function currentE2eeAccountEncryptionCurrentnessResponse(
    contentPublicKey: Uint8Array,
): Response {
    const currentness = {
        mode: 'e2ee',
        version: 1,
        signingKeyFingerprint: 'signing-1',
        contentKeyFingerprint:
            computeAccountEncryptionMigrateKeyFingerprintV1(
                contentPublicKey,
            ),
        updatedAt: 1,
    } satisfies AccountEncryptionCurrentnessResponse;
    return Response.json(currentness);
}

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

function createStreamSegmentRecord(text: string): RawRecord {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            data: { type: 'message', message: text },
        },
    } as unknown as RawRecord;
}

function createPlainNewMessageUpdate(params: Readonly<{
    sessionId: string;
    messageId: string;
    seq: number;
}>): ApiUpdateContainer {
    return {
        id: `socket-new-message-${params.messageId}`,
        seq: params.seq,
        createdAt: params.seq,
        body: {
            t: 'new-message',
            sid: params.sessionId,
            message: {
                id: params.messageId,
                seq: params.seq,
                localId: null,
                createdAt: params.seq,
                updatedAt: params.seq,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'queued before local retirement' },
                    },
                },
            },
        },
    } as ApiUpdateContainer;
}

type SyncRetirementEncryptionTestAccess = {
    encryption: {
        getSessionEncryption: (sessionId: string) => null;
        removeSessionEncryption: (sessionId: string) => void;
    };
};

type SyncRetirementTestAccess = {
    retireLocalSession: (sessionId: string) => void;
    sessionReceivedMessages: Map<string, Map<string, number>>;
    sessionMaterializedMaxSeqById: Record<string, number>;
    sessionMessagesBeforeSeqByKey: Map<string, number>;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
};

// Sync's encryption service is an external boundary. Retirement invokes both
// methods, so this minimal fixture mirrors the real surface it crosses.
function installPlainRetirementEncryption(sync: unknown): void {
    const syncWithEncryption = sync as SyncRetirementEncryptionTestAccess;
    syncWithEncryption.encryption = {
        getSessionEncryption: () => null,
        removeSessionEncryption: () => {},
    };
}

function createMachine(machineId: string): Machine {
    const now = Date.now();
    return {
        id: machineId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        revokedAt: null,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createExternalSession(sessionId: string): Session {
    const now = Date.now();
    return {
        ...createSession(sessionId),
        currentStorageState: 'machine_only',
        createdAt: now,
        updatedAt: now,
        metadata: {
            path: '',
            host: '',
            machineId: 'machine-1',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'codexHome', home: 'user' },
                linkedAtMs: 1,
                qualifiedIdentity: {
                    v: 1,
                    agent: { pluginId: 'happier.codex', localId: 'codex' },
                    source: { kind: 'codexHome', contractVersion: 1 },
                },
            },
        },
    };
}

function createTranscriptInvalidation(sessionId: string, _cursor: string) {
    return {
        v: 1 as const,
        type: 'external-session-transcript-invalidated' as const,
        binding: {
            v: 1 as const,
            machineId: 'machine-1',
            sessionId,
            link: { generation: '1', remoteSessionId: 'vendor-session-1' },
            source: {
                qualifiedIdentity: {
                    v: 1 as const,
                    agent: { pluginId: 'happier.codex', localId: 'codex' },
                    source: { kind: 'codexHome', contractVersion: 1 as const },
                },
                generation: 'source-1',
            },
            contributionGeneration: 'contribution-1',
            cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
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

function expectRuntimeFetchMessagePageCall(
    call: unknown[] | undefined,
    params: { baseUrl: string; sessionId: string; beforeSeq: string; limit: string },
): void {
    expect(call).toBeDefined();
    if (!call) {
        throw new Error(`Expected runtimeFetch message page call for ${params.sessionId}`);
    }
    const [url, init] = call;
    const requestUrl = new URL(String(url));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
        `${params.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/messages`,
    );
    expect(requestUrl.searchParams.get('scope')).toBe('main');
    expect(requestUrl.searchParams.get('beforeSeq')).toBe(params.beforeSeq);
    expect(requestUrl.searchParams.get('limit')).toBe(params.limit);
    expect(requestUrl.searchParams.has('afterSeq')).toBe(false);
    expect(requestUrl.searchParams.has('sidechainId')).toBe(false);
    expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
}

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

describe('sync.fetchMessages server-scoped known-session checks', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        clearTabActiveServerId();
        requestMock.mockReset();
        runtimeFetchMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockReset();
        machineExternalSessionTranscriptPageMock.mockReset();
        machineExternalSessionTranscriptReadAfterMock.mockReset();
        machineExternalSessionTranscriptRefreshReadAfterMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        sessionRpcWithPreferredSessionScopeMock.mockReset();
        emitSessionMetadataUpdateWithServerScopeMock.mockReset();
        notifyActivityReadyMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(undefined);
        resetSessionSurfaceVisibilityForTests();
        resetTranscriptStreamSegmentAssemblyForTests();
    });

    afterEach(() => {
        resetDemoModeDepthForTests();
        resetSessionSurfaceVisibilityForTests();
        resetTranscriptStreamSegmentAssemblyForTests();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('resets malformed or oversized cached external-session cursors and preserves a valid carrier', async () => {
        const { sync } = await import('./sync');
        const malformedSessionId = 'malformed-cached-external-cursor';
        const oversizedSessionId = 'oversized-cached-external-cursor';
        const validSessionId = 'valid-cached-external-cursor';
        const validCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';

        (sync as any).externalSessionTailCursorBySessionId.set(
            malformedSessionId,
            'source-native-cursor',
        );
        (sync as any).externalSessionTailCursorBySessionId.set(
            oversizedSessionId,
            `happier_external_cursor_v1:${'a'.repeat(4_096)}`,
        );
        (sync as any).externalSessionTailCursorBySessionId.set(validSessionId, validCursor);

        expect(sync.getAcceptedExternalSessionTailCursor(malformedSessionId)).toBeNull();
        expect(sync.getAcceptedExternalSessionTailCursor(oversizedSessionId)).toBeNull();
        expect(sync.getAcceptedExternalSessionTailCursor(validSessionId)).toBe(validCursor);
        expect((sync as any).externalSessionTailCursorBySessionId.get(malformedSessionId)).toBeNull();
        expect((sync as any).externalSessionTailCursorBySessionId.get(oversizedSessionId)).toBeNull();
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

    it('does not recreate a transcript entry for a deleted session missing from the snapshot', async () => {
        const sessionId = 'deleted_session_id';
        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
    });

    it('immediately retires a Voice History carrier through Sync before any socket echo', async () => {
        const sessionId = 'voice-history-local-retirement';
        storage.getState().applySessions([createSession(sessionId)]);
        storage.getState().applyMessagesLoaded(sessionId);

        const { sync } = await import('./sync');
        installPlainRetirementEncryption(sync);
        const syncWithTranscriptRetirement = sync as unknown as SyncRetirementTestAccess;
        syncWithTranscriptRetirement.sessionReceivedMessages.set(
            sessionId,
            new Map([['voice-history-carrier', 2_000]]),
        );

        const consumer = createVoiceHistoryConsumer({
            readScopeKey: () => 'server-a/account-a',
            captureScope: async () => ({ key: 'server-a/account-a' }),
            discoverHistorySession: async () => sessionId,
            refreshSessionMessages: async () => undefined,
            loadOlderMessages: async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const }),
            readMessages: () => [],
            resolveProviderLabel: () => 'Voice provider',
            deleteSession: async () => ({ success: true }),
            canDeleteSession: () => true,
            retireLocalSession: (targetSessionId) => syncWithTranscriptRetirement.retireLocalSession(targetSessionId),
            runCarrierOperation: async (operation) => await operation(),
            now: () => new Date('2026-08-10T00:00:00.000Z'),
        });

        await consumer.open();
        await expect(consumer.clear()).resolves.toEqual({ cleared: true });

        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(syncWithTranscriptRetirement.sessionReceivedMessages.get(sessionId)).toBeUndefined();
    });

    it('releases a retired Voice History carrier\'s assembled stream text', async () => {
        const sessionId = 'voice-history-assembled-stream-retirement';
        storage.getState().applySessions([createSession(sessionId)]);
        noteTranscriptStreamSegmentSnapshot({
            sessionId,
            localId: 'stream-segment',
            record: createStreamSegmentRecord('private partial transcript'),
            tick: 1,
        });
        expect(isTranscriptStreamSegmentAssemblyReady(sessionId, 'stream-segment')).toBe(true);

        const { sync } = await import('./sync');
        installPlainRetirementEncryption(sync);
        (sync as unknown as SyncRetirementTestAccess).retireLocalSession(sessionId);

        expect(isTranscriptStreamSegmentAssemblyReady(sessionId, 'stream-segment')).toBe(false);
        expect(applyTranscriptStreamSegmentDelta({
            sessionId,
            localId: 'stream-segment',
            deltaText: ' late',
            tick: 2,
            baseLength: 'private partial transcript'.length,
        })).toBeNull();
    });

    it('does not materialize a late outbound ACK after local retirement', async () => {
        const sessionId = 'voice-history-late-outbound-ack';
        storage.getState().applySessions([createSession(sessionId)]);

        const { sync } = await import('./sync');
        installPlainRetirementEncryption(sync);
        const syncWithRetirement = sync as unknown as SyncRetirementTestAccess;
        syncWithRetirement.retireLocalSession(sessionId);

        sync.commitAckedOutboundUserMessage({
            sessionId,
            localId: 'late-ack-local-id',
            createdAt: 1,
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'late ACK must not recreate history' },
            } as unknown as RawRecord,
            ack: { id: 'late-ack-message', seq: 2 },
        });

        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(syncWithRetirement.sessionMaterializedMaxSeqById[sessionId] ?? 0).toBe(0);
    });

    it('drops socket work already admitted before local retirement can flush it', async () => {
        vi.useFakeTimers();
        const sessionId = 'voice-history-admitted-socket-work-retirement';
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
        }]);
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                transcriptStreamingCoalesceEnabled: true,
                transcriptStreamingCoalesceWindowMs: 50,
                transcriptStreamingCoalesceMaxBatchSize: 1_000,
            },
        }));

        const { sync } = await import('./sync');
        installPlainRetirementEncryption(sync);
        const syncWithSocketState = sync as unknown as SyncRetirementTestAccess;
        syncWithSocketState.sessionReceivedMessages.set(sessionId, new Map([['pre-delete-row', 1]]));

        const applyMessages = vi.fn((targetSessionId: string, messages: NormalizedMessage[]) => {
            storage.getState().applyMessages(targetSessionId, messages);
        });
        const applySessions = vi.fn((sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });

        await handleUpdateContainer({
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: async () => null,
                initializeMachines: async () => {},
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            artifactDataKeys: new Map(),
            applySessions,
            fetchSessions: vi.fn(),
            applyMessages,
            sessionReceivedMessages: syncWithSocketState.sessionReceivedMessages,
            onSessionVisible: vi.fn(),
            isSessionMessagesLoaded: (targetSessionId) => storage.getState().sessionMessages[targetSessionId]?.isLoaded === true,
            getSessionMaterializedMaxSeq: (targetSessionId) => syncWithSocketState.sessionMaterializedMaxSeqById[targetSessionId] ?? 0,
            markSessionMaterializedMaxSeq: (targetSessionId, seq) => syncWithSocketState.markSessionMaterializedMaxSeq(targetSessionId, seq),
            onMessageGapDetected: vi.fn(),
            assumeUsers: vi.fn(async () => {}),
            applyTodoSocketUpdates: vi.fn(async () => {}),
            invalidateMachines: vi.fn(),
            invalidateSessions: vi.fn(),
            invalidateArtifacts: vi.fn(),
            invalidateFriends: vi.fn(),
            invalidateFriendRequests: vi.fn(),
            invalidateFeed: vi.fn(),
            invalidateAutomations: vi.fn(),
            invalidateTodos: vi.fn(),
            log: { log: vi.fn() },
            updateData: createPlainNewMessageUpdate({ sessionId, messageId: 'queued-after-delete', seq: 2 }),
        });
        expect(applyMessages).not.toHaveBeenCalled();

        syncWithSocketState.retireLocalSession(sessionId);
        await vi.advanceTimersByTimeAsync(100);

        expect(applyMessages).not.toHaveBeenCalled();
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(syncWithSocketState.sessionReceivedMessages.get(sessionId)).toBeUndefined();
        expect(syncWithSocketState.sessionMaterializedMaxSeqById[sessionId] ?? 0).toBe(0);
    });

    it('does not revive a locally retired Voice History carrier from a held account-authority refresh', async () => {
        const sessionId = 'voice-history-held-account-refresh';
        const accountId = 'voice-history-account';
        const server = upsertServerProfile({
            serverUrl: 'https://voice-history-currentness.example',
            name: 'Voice History currentness',
        });
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().activateProfileScope({ serverId: server.id, accountId });
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
        } as Session]);

        let releasePage!: (response: Response) => void;
        const heldPage = new Promise<Response>((resolve) => {
            releasePage = resolve;
        });
        let markRequestStarted!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
            markRequestStarted = resolve;
        });
        const authority = {
            scope: { serverId: server.id, accountId },
            context: {
                scope: 'scoped' as const,
                timeoutMs: 30_000,
                targetServerId: server.id,
                targetServerUrl: server.serverUrl,
                targetAccountId: accountId,
                token: buildTokenWithSub(accountId),
                encryption: null,
            },
            request: async () => {
                markRequestStarted();
                return await heldPage;
            },
        } satisfies ServerAccountSessionRequestAuthority;

        const { sync } = await import('./sync');
        installPlainRetirementEncryption(sync);
        const syncWithState = sync as unknown as SyncRetirementTestAccess;
        const refresh = sync.refreshSessionMessages(sessionId, { authority });
        await requestStarted;

        syncWithState.retireLocalSession(sessionId);
        releasePage(Response.json({
            messages: [{
                id: 'voice-history-late-row',
                seq: 1,
                localId: null,
                sidechainId: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'late Voice History page' },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_000,
            }],
            hasMore: false,
            nextBeforeSeq: null,
        }));
        await refresh;

        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect(syncWithState.sessionMessagesBeforeSeqByKey.get(`${sessionId}:main`)).toBeUndefined();
        expect(syncWithState.sessionReceivedMessages.get(sessionId)).toBeUndefined();
    });

    it('clears only the active server session-list cache entry when runtime state resets', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const sideServer = upsertServerProfile({ serverUrl: 'https://side.example', name: 'Side' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        const now = Date.now();
        const activeSession = {
            id: 'active-session',
            seq: 0,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies SessionListRenderableSession;
        const sideSession = {
            ...activeSession,
            id: 'side-session',
        } satisfies SessionListRenderableSession;

        storage.setState((state) => ({
            ...state,
            concurrentSessionListCacheByServerId: {
                [activeServer.id]: {
                    serverName: 'Active',
                    sessions: { [activeSession.id]: activeSession },
                },
                [sideServer.id]: {
                    serverName: 'Side',
                    sessions: { [sideSession.id]: sideSession },
                },
            },
            sessionListRowStateByServerId: {
                [activeServer.id]: { [activeSession.id]: activeSession },
                [sideServer.id]: { [sideSession.id]: sideSession },
            },
            sessionListIndexByServerId: {
                [activeServer.id]: [{ type: 'session', sessionId: activeSession.id, serverId: activeServer.id }],
                [sideServer.id]: [{ type: 'session', sessionId: sideSession.id, serverId: sideServer.id }],
            },
        }));

        const { sync } = await import('./sync');
        (sync as any).externalSessionOlderCursorBySessionId.set(activeSession.id, 'stale-older');
        (sync as any).externalSessionHasMoreOlderBySessionId.set(activeSession.id, true);
        (sync as any).externalSessionTailCursorBySessionId.set(activeSession.id, 'stale-tail');
        (sync as any).transcriptAuthorityKeyBySessionId.set(activeSession.id, 'live_agent:stale-source');
        storage.getState().setSessionTranscriptLoadIssue(activeSession.id, {
            kind: 'source_discontinuity',
        });

        (sync as any).resetServerScopedRuntimeState();

        expect(storage.getState().concurrentSessionListCacheByServerId).toEqual({
            [sideServer.id]: {
                serverName: 'Side',
                sessions: { [sideSession.id]: sideSession },
            },
        });
        expect(storage.getState().sessionListRowStateByServerId).toEqual({
            [sideServer.id]: { [sideSession.id]: sideSession },
        });
        expect(storage.getState().sessionListIndexByServerId).toEqual({
            [sideServer.id]: [{ type: 'session', sessionId: sideSession.id, serverId: sideServer.id }],
        });
        expect((sync as any).externalSessionOlderCursorBySessionId.size).toBe(0);
        expect((sync as any).externalSessionHasMoreOlderBySessionId.size).toBe(0);
        expect((sync as any).externalSessionTailCursorBySessionId.size).toBe(0);
        expect((sync as any).transcriptAuthorityKeyBySessionId.size).toBe(0);
        expect(storage.getState().sessionTranscriptLoadIssues).toEqual({});
    });

    it('clears only the active server machine-list cache entry when runtime state resets', async () => {
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const sideServer = upsertServerProfile({ serverUrl: 'https://side.example', name: 'Side' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        const sideMachine = createMachine('side-machine');

        storage.setState((state) => ({
            ...state,
            machineListByServerId: {
                [activeServer.id]: [createMachine('active-machine')],
                [sideServer.id]: [sideMachine],
            },
            machineListStatusByServerId: {
                [activeServer.id]: 'loading',
                [sideServer.id]: 'idle',
            },
        }));

        const { sync } = await import('./sync');

        (sync as any).resetServerScopedRuntimeState();

        expect(storage.getState().machineListByServerId).toEqual({
            [sideServer.id]: [sideMachine],
        });
        expect(storage.getState().machineListStatusByServerId).toEqual({
            [sideServer.id]: 'idle',
        });
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
        storage.getState().applySessions([createExternalSession(sessionId)]);
        emitSessionMetadataUpdateWithServerScopeMock.mockImplementation(async ({ expectedVersion, metadata }: any) => ({
            result: 'success',
            version: Number(expectedVersion ?? 0) + 1,
            metadata,
        }));
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
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
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
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

        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), { serverId: 'server-owned' });
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail',
        }), { serverId: 'server-owned' });
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '1:direct-msg-1',
            observedAtMs: 1,
        });
        expect(emitSessionMetadataUpdateWithServerScopeMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello direct')).toBe(true);
    });

    it('loads direct session transcripts even when the active server snapshot does not yet know the linked session', async () => {
        const sessionId = 'direct_session_id_without_active_snapshot';
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(undefined);
        storage.getState().applySessions([createExternalSession(sessionId)]);
        emitSessionMetadataUpdateWithServerScopeMock.mockImplementation(async ({ expectedVersion, metadata }: any) => ({
            result: 'success',
            version: Number(expectedVersion ?? 0) + 1,
            metadata,
        }));
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct snapshotless' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            hasMore: true,
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-1',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>();
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            direction: 'older',
        }), { serverId: undefined });
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'vendor-session-1',
            cursor: 'tail',
        }), { serverId: undefined });
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some((message) => message.kind === 'user-text' && message.text === 'hello direct snapshotless')).toBe(true);
    });

    it('hydrates only the pushed operation-accepted server prefix for an offline initial partial import', async () => {
        const sessionId = 'external_session_initial_partial_hydration';
        const acceptedLocalId = 'direct-import:v1:codex:aaaaaaaaaaaaaaaaaaaaaaaa';
        const stagedLocalId = 'direct-import:v1:codex:bbbbbbbbbbbbbbbbbbbbbbbb';
        const session = createExternalSession(sessionId);
        session.encryptionMode = 'plain';
        session.currentStorageState = 'server_partial';
        session.acceptedThroughServerSeq = 4;
        session.metadata = {
            ...session.metadata!,
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'operation-initial-partial',
                revision: 4,
                kind: 'materialize',
                status: 'awaiting_user_resume',
                phase: 'importing',
            },
            externalSessionOperationV1: {
                v: 1,
                progress: {
                    v: 1,
                    operationId: 'operation-initial-partial',
                    revision: 4,
                    request: {
                        plan: 'materialize',
                        targetStorageMode: 'external-linked',
                        targetRuntimeMode: null,
                    },
                    status: 'awaiting_user_resume',
                    phase: 'importing',
                    timeline: ['validating', 'staging', 'importing', 'publishing'],
                    updatedAtMs: 1_700_000_000_000,
                    priorStableStorage: { state: 'machine_only' },
                    currentStorageState: 'server_partial',
                    checkpoint: {
                        sourcePagesRead: 1,
                        stagedItemCount: 5,
                        importedItemCount: 4,
                        requiredItemFailures: {
                            total: 0,
                            record: 0,
                            media: 0,
                            conversion: 0,
                            diagnosticsTruncated: false,
                        },
                        acceptedThroughServerSeq: 4,
                    },
                    fence: {
                        kind: 'initial_server_partial',
                        acceptedThroughServerSeq: 4,
                    },
                    retryTargetPhase: 'importing',
                },
            },
        };
        const sharedOperationPresentation =
            session.metadata.externalSessionOperationPresentationV1;
        session.metadataLayoutVersion = 1;
        session.ownerMetadataView = session.metadata;
        session.metadata = projectSessionSharedMetadataV1({
            metadata: {
                externalSessionOperationPresentationV1:
                    sharedOperationPresentation,
            },
        }) as unknown as Session['metadata'];
        const offlineMachine = createMachine('machine-1');
        offlineMachine.revokedAt = 1;
        storage.getState().applyMachines([offlineMachine], false);
        storage.getState().applySessions([session]);
        requestMock.mockResolvedValueOnce(Response.json({
            messages: [
                {
                    id: 'server-row-5',
                    seq: 5,
                    localId: stagedLocalId,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'staged beyond accepted prefix' },
                        },
                    },
                    createdAt: 1_005,
                    updatedAt: 1_005,
                },
                {
                    id: 'server-row-4',
                    seq: 4,
                    localId: acceptedLocalId,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted partial row' },
                        },
                    },
                    createdAt: 1_004,
                    updatedAt: 1_004,
                },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        }));

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        expect(requestMock).toHaveBeenCalledWith(
            `/v1/sessions/${sessionId}/messages?scope=main`,
            expect.objectContaining({ method: 'GET' }),
        );
        const messages = storage.getState().sessionMessages[sessionId];
        expect(messages?.messageIdsOldestFirst).toHaveLength(1);
        const acceptedMessageId = messages?.messageIdsOldestFirst[0];
        expect(acceptedMessageId).toBeDefined();
        expect(messages?.messagesById[acceptedMessageId!]).toMatchObject({
            realID: acceptedLocalId,
            localId: acceptedLocalId,
            seq: 4,
            kind: 'user-text',
            text: 'accepted partial row',
        });
        expect(Object.values(messages?.messagesById ?? {}).some(
            (message) => message.realID === stagedLocalId
                || ('localId' in message && message.localId === stagedLocalId),
        )).toBe(false);

        const mismatchedPresentationSession = {
            ...session,
            metadata: {
                ...session.metadata!,
                externalSessionOperationPresentationV1: {
                    ...session.metadata!.externalSessionOperationPresentationV1!,
                    revision: 5,
                },
            },
        };
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: mismatchedPresentationSession,
            },
        }));

        await (sync as any).fetchMessages(sessionId);

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual(
            messages?.messageIdsOldestFirst,
        );
        expect((sync as any).transcriptAuthorityKeyBySessionId.get(sessionId)).toBe(
            'unavailable:initial_partial_not_permitted',
        );
    });

    it('chooses authority before apply and replaces peer rows across live to accepted-prefix to live switches', async () => {
        const sessionId = 'external_session_authority_switch_replacement';
        const acceptedLocalId = 'direct-import:v1:codex:cccccccccccccccccccccccc';
        const stagedLocalId = 'direct-import:v1:codex:dddddddddddddddddddddddd';
        const initial = createExternalSession(sessionId);
        initial.encryptionMode = 'plain';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([initial]);
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'live-before-switch',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'live before switch' } },
                }],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'live-after-switch',
                    createdAtMs: 3,
                    raw: { role: 'user', content: { type: 'text', text: 'live after switch' } },
                }],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValue({
            ok: true,
            items: [],
            nextCursor: null,
            truncated: false,
        });

        const partial = createExternalSession(sessionId);
        partial.encryptionMode = 'plain';
        partial.currentStorageState = 'server_partial';
        partial.acceptedThroughServerSeq = 4;
        partial.metadata = {
            ...partial.metadata!,
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'operation-authority-switch',
                revision: 4,
                kind: 'materialize',
                status: 'awaiting_user_resume',
                phase: 'importing',
            },
            externalSessionOperationV1: {
                v: 1,
                progress: {
                    v: 1,
                    operationId: 'operation-authority-switch',
                    revision: 4,
                    request: {
                        plan: 'materialize',
                        targetStorageMode: 'external-linked',
                        targetRuntimeMode: null,
                    },
                    status: 'awaiting_user_resume',
                    phase: 'importing',
                    timeline: ['validating', 'staging', 'importing', 'publishing'],
                    updatedAtMs: 1_700_000_000_000,
                    priorStableStorage: { state: 'machine_only' },
                    currentStorageState: 'server_partial',
                    checkpoint: {
                        sourcePagesRead: 1,
                        stagedItemCount: 5,
                        importedItemCount: 4,
                        requiredItemFailures: {
                            total: 0,
                            record: 0,
                            media: 0,
                            conversion: 0,
                            diagnosticsTruncated: false,
                        },
                        acceptedThroughServerSeq: 4,
                    },
                    fence: {
                        kind: 'initial_server_partial',
                        acceptedThroughServerSeq: 4,
                    },
                    retryTargetPhase: 'importing',
                },
            },
        };
        const serverPage = () => Response.json({
            messages: [
                {
                    id: 'server-row-5',
                    seq: 5,
                    localId: stagedLocalId,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'staged beyond accepted prefix' },
                        },
                    },
                    createdAt: 1_005,
                    updatedAt: 1_005,
                },
                {
                    id: 'server-row-4',
                    seq: 4,
                    localId: acceptedLocalId,
                    sidechainId: null,
                    content: {
                        t: 'plain',
                        v: {
                            role: 'user',
                            content: { type: 'text', text: 'accepted server prefix' },
                        },
                    },
                    createdAt: 1_004,
                    updatedAt: 1_004,
                },
            ],
            hasMore: false,
            nextBeforeSeq: null,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: partial },
            machines: {
                ...state.machines,
                'machine-1': { ...createMachine('machine-1'), revokedAt: 1 },
            },
        }));
        let releaseStaleServerPage!: (response: Response) => void;
        const staleServerPage = new Promise<Response>((resolve) => {
            releaseStaleServerPage = resolve;
        });
        let markStaleServerReadStarted!: () => void;
        const staleServerReadStarted = new Promise<void>((resolve) => {
            markStaleServerReadStarted = resolve;
        });
        requestMock.mockImplementationOnce(async () => {
            markStaleServerReadStarted();
            return await staleServerPage;
        });

        const staleServerFetch = (sync as any).fetchMessages(sessionId);
        await staleServerReadStarted;
        storage.setState((state) => ({
            ...state,
            machines: {
                ...state.machines,
                'machine-1': createMachine('machine-1'),
            },
        }));
        releaseStaleServerPage(serverPage());
        await staleServerFetch;

        const readTexts = () => Object.values(
            storage.getState().sessionMessages[sessionId]?.messagesById ?? {},
        )
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(readTexts()).toEqual(['live before switch']);

        storage.setState((state) => ({
            ...state,
            machines: {
                ...state.machines,
                'machine-1': { ...createMachine('machine-1'), revokedAt: 1 },
            },
        }));
        requestMock.mockResolvedValueOnce(serverPage());
        const serverReplacementSnapshots: Array<{ texts: string[]; isLoaded: boolean }> = [];
        const unsubscribeServerReplacement = storage.subscribe((state, previousState) => {
            if (state.sessionMessages[sessionId] === previousState.sessionMessages[sessionId]) return;
            const transcript = state.sessionMessages[sessionId];
            serverReplacementSnapshots.push({
                texts: Object.values(transcript?.messagesById ?? {})
                    .filter((message): message is NonNullable<typeof message> => Boolean(message))
                    .filter((message) => message.kind === 'user-text')
                    .map((message) => message.text),
                isLoaded: transcript?.isLoaded === true,
            });
        });
        await (sync as any).fetchMessages(sessionId);
        unsubscribeServerReplacement();

        expect(readTexts()).toEqual(['accepted server prefix']);
        expect(serverReplacementSnapshots).toEqual([{
            texts: ['accepted server prefix'],
            isLoaded: true,
        }]);
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}).some(
            (message) => message.realID === stagedLocalId
                || ('localId' in message && message.localId === stagedLocalId),
        )).toBe(false);

        storage.setState((state) => ({
            ...state,
            machines: {
                ...state.machines,
                'machine-1': createMachine('machine-1'),
            },
        }));
        const liveReplacementSnapshots: Array<{ texts: string[]; isLoaded: boolean }> = [];
        const unsubscribeLiveReplacement = storage.subscribe((state, previousState) => {
            if (state.sessionMessages[sessionId] === previousState.sessionMessages[sessionId]) return;
            const transcript = state.sessionMessages[sessionId];
            liveReplacementSnapshots.push({
                texts: Object.values(transcript?.messagesById ?? {})
                    .filter((message): message is NonNullable<typeof message> => Boolean(message))
                    .filter((message) => message.kind === 'user-text')
                    .map((message) => message.text),
                isLoaded: transcript?.isLoaded === true,
            });
        });
        await (sync as any).fetchMessages(sessionId);
        unsubscribeLiveReplacement();

        expect(readTexts()).toEqual(['live after switch']);
        expect(liveReplacementSnapshots).toEqual([{
            texts: ['live after switch'],
            isLoaded: true,
        }]);
        expect(Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {}).some(
            (message) => message.realID === acceptedLocalId
                || ('localId' in message && message.localId === acceptedLocalId),
        )).toBe(false);
        expect(requestMock).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
    });

    it('distinguishes unavailable and failed external transcript reads from an authoritative empty transcript', async () => {
        const sessionId = 'external_session_typed_transcript_load_outcome';
        const offlineMachine = createMachine('machine-1');
        offlineMachine.revokedAt = 1;
        storage.getState().applyMachines([offlineMachine], false);
        storage.getState().applySessions([createExternalSession(sessionId)]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).not.toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'authority_unavailable',
            reason: 'machine_offline',
        });

        storage.getState().applyMachines([createMachine('machine-1')], false);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'Agent unavailable',
        });

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow('Agent unavailable');

        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).not.toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });

        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: false,
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: null,
            truncated: false,
        });

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toBeNull();

        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'machine_offline',
            error: 'Machine offline',
        });

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow('Machine offline');

        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'machine_offline',
        });

        (sync as any).transcriptAuthorityKeyBySessionId.set(sessionId, 'live_agent:stale-before-reset');
        (sync as any).resetSessionTranscriptState(sessionId);
        expect((sync as any).transcriptAuthorityKeyBySessionId.has(sessionId)).toBe(false);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
            truncated: true,
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: null,
            truncated: false,
        });

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).not.toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'source_discontinuity',
        });
    });

    it('does not apply an initial page when its fallback tail read fails', async () => {
        const sessionId = 'external_session_initial_page_tail_failure';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'initial-page-row',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'must not publish' } },
            }],
            nextCursor: 'older-1',
            tailCursor: null,
            hasMore: true,
            truncated: false,
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'tail read failed',
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow('tail read failed');

        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBeNull();
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });
    });

    it('does not apply a nonempty truncated initial result', async () => {
        const sessionId = 'external_session_initial_truncated_result';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'truncated-page-row',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'must not publish' } },
            }],
            nextCursor: 'older-1',
            tailCursor: 'happier_external_cursor_v1:dHJ1bmNhdGVk',
            hasMore: false,
            truncated: true,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await expect((sync as any).fetchMessages(sessionId)).resolves.toBeUndefined();

        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBeNull();
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'source_discontinuity',
        });
        expect(machineExternalSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
    });

    it('preserves the last-known catch-up rows and cursor when truncated replacement fails', async () => {
        const sessionId = 'external_session_catch_up_truncated_replacement_failure';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'last-known-a',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'last-known A' } },
                }],
                nextCursor: null,
                tailCursor: 'happier_external_cursor_v1:YzE',
                hasMore: false,
                truncated: false,
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'agent_unavailable',
                error: 'replacement failed',
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'catch-up-b',
                createdAtMs: 2,
                raw: { role: 'user', content: { type: 'text', text: 'must not publish B' } },
            }],
            nextCursor: 'happier_external_cursor_v1:YzI',
            truncated: true,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow('replacement failed');

        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['last-known A']);
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:YzE',
        );
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });
    });

    it('retains hosted authority when an older linked transcript read resolves after link retirement', async () => {
        const sessionId = 'external_session_late_linked_read_after_hosted_cutover';
        const linked = createExternalSession(sessionId);
        linked.encryptionMode = 'plain';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([linked]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'linked-before-hosted',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'linked before hosted' } },
            }],
            nextCursor: null,
            tailCursor: null,
            hasMore: false,
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'happier_external_cursor_v1:aW5pdGlhbC1saW5rZWQ',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        let releaseLateLinkedRead!: (result: {
            ok: true;
            items: ExternalSessionTranscriptRawMessageV1[];
            nextCursor: string;
            truncated: false;
        }) => void;
        const lateLinkedRead = new Promise<{
            ok: true;
            items: ExternalSessionTranscriptRawMessageV1[];
            nextCursor: string;
            truncated: false;
        }>((resolve) => {
            releaseLateLinkedRead = resolve;
        });
        let markLateLinkedReadStarted!: () => void;
        const lateLinkedReadStarted = new Promise<void>((resolve) => {
            markLateLinkedReadStarted = resolve;
        });
        machineExternalSessionTranscriptReadAfterMock.mockImplementationOnce(async () => {
            markLateLinkedReadStarted();
            return await lateLinkedRead;
        });

        const staleLinkedFetch = (sync as any).fetchMessages(sessionId);
        await lateLinkedReadStarted;

        const hosted = createSession(sessionId);
        hosted.seq = 1;
        hosted.encryptionMode = 'plain';
        hosted.currentStorageState = 'hosted';
        hosted.metadata = {
            path: '',
            host: '',
            machineId: 'machine-1',
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: hosted },
        }));
        requestMock.mockResolvedValueOnce(Response.json({
            messages: [{
                id: 'hosted-row-1',
                seq: 1,
                localId: 'hosted-local-1',
                sidechainId: null,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'hosted authority row' },
                    },
                },
                createdAt: 2,
                updatedAt: 2,
            }],
            hasMore: false,
            nextBeforeSeq: null,
        }));

        await (sync as any).fetchMessages(sessionId);
        releaseLateLinkedRead({
            ok: true,
            items: [{
                id: 'late-linked-after-hosted',
                createdAtMs: 3,
                raw: { role: 'assistant', content: { type: 'text', text: 'late linked row' } },
            }],
            nextCursor: 'happier_external_cursor_v1:bGF0ZS1saW5rZWQ',
            truncated: false,
        });
        await staleLinkedFetch;

        const appliedMessages = Object.values(
            storage.getState().sessionMessages[sessionId]?.messagesById ?? {},
        ).filter((message): message is NonNullable<typeof message> => Boolean(message));
        const texts = appliedMessages
            .filter((message) => message.kind === 'user-text' || message.kind === 'agent-text')
            .map((message) => message.text);
        expect(appliedMessages).toHaveLength(1);
        expect(texts).toEqual(['hosted authority row']);
        expect((sync as any).transcriptAuthorityKeyBySessionId.get(sessionId)).toBe('hosted');
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(2);
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('preserves a typed issue when a stale server replacement is discarded without commit', async () => {
        const sessionId = 'external_session_stale_server_replacement_issue';
        const linked = createExternalSession(sessionId);
        linked.encryptionMode = 'plain';
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([linked]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'last-known-linked-row',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'last-known A' } },
            }],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:YzE',
            hasMore: false,
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        await (sync as any).fetchMessages(sessionId);

        const hosted = createSession(sessionId);
        hosted.encryptionMode = 'plain';
        hosted.currentStorageState = 'hosted';
        hosted.metadata = { path: '', host: '', machineId: 'machine-1' };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: hosted },
        }));
        storage.getState().setSessionTranscriptLoadIssue(sessionId, {
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });

        let releaseServerReplacement!: (response: Response) => void;
        let markServerReplacementStarted!: () => void;
        const serverReplacement = new Promise<Response>((resolve) => {
            releaseServerReplacement = resolve;
        });
        const serverReplacementStarted = new Promise<void>((resolve) => {
            markServerReplacementStarted = resolve;
        });
        requestMock.mockImplementationOnce(async () => {
            markServerReplacementStarted();
            return await serverReplacement;
        });

        const staleReplacement = (sync as any).fetchMessages(sessionId);
        await serverReplacementStarted;

        const changedAuthority = {
            ...hosted,
            currentStorageState: 'snapshot_complete' as const,
            publishedThroughServerSeq: 2,
            acceptedThroughServerSeq: 2,
            materializedThroughSourceAt: 2,
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: changedAuthority },
        }));
        releaseServerReplacement(Response.json({
            messages: [{
                id: 'stale-server-row',
                seq: 2,
                localId: 'stale-server-local',
                sidechainId: null,
                content: {
                    t: 'plain',
                    v: { role: 'user', content: { type: 'text', text: 'must not commit' } },
                },
                createdAt: 2,
                updatedAt: 2,
            }],
            hasMore: false,
            nextBeforeSeq: null,
        }));
        await staleReplacement;

        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['last-known A']);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });
        expect(texts).not.toContain('must not commit');
    });

    it('atomically replaces an accepted partial bound with a finalized snapshot and rejects the late old-bound response', async () => {
        const sessionId = 'external_session_partial_to_finalized_snapshot';
        const partialAcceptedLocalId = 'direct-import:v1:codex:111111111111111111111111';
        const partialStagedLocalId = 'direct-import:v1:codex:222222222222222222222222';
        const latePartialLocalId = 'direct-import:v1:codex:333333333333333333333333';
        const finalizedAcceptedLocalId = 'direct-import:v1:codex:444444444444444444444444';
        const finalizedTailLocalId = 'direct-import:v1:codex:555555555555555555555555';
        const finalizedStagedLocalId = 'direct-import:v1:codex:666666666666666666666666';
        const materializedThroughSourceAt = 1_700_000_000_100;
        const serverRow = (params: {
            id: string;
            seq: number;
            localId: string;
            text: string;
        }) => ({
            id: params.id,
            seq: params.seq,
            localId: params.localId,
            sidechainId: null,
            content: {
                t: 'plain' as const,
                v: {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: params.text },
                },
            },
            createdAt: 1_000 + params.seq,
            updatedAt: 1_000 + params.seq,
        });
        const serverPage = (messages: ReturnType<typeof serverRow>[]) => Response.json({
            messages,
            hasMore: false,
            nextBeforeSeq: null,
        });

        const partial = createExternalSession(sessionId);
        partial.encryptionMode = 'plain';
        partial.currentStorageState = 'server_partial';
        partial.acceptedThroughServerSeq = 4;
        partial.metadata = {
            ...partial.metadata!,
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'operation-partial-to-finalized',
                revision: 4,
                kind: 'materialize',
                status: 'awaiting_user_resume',
                phase: 'importing',
            },
            externalSessionOperationV1: {
                v: 1,
                progress: {
                    v: 1,
                    operationId: 'operation-partial-to-finalized',
                    revision: 4,
                    request: {
                        plan: 'materialize',
                        targetStorageMode: 'external-linked',
                        targetRuntimeMode: null,
                    },
                    status: 'awaiting_user_resume',
                    phase: 'importing',
                    timeline: ['validating', 'staging', 'importing', 'publishing'],
                    updatedAtMs: 1_700_000_000_000,
                    priorStableStorage: { state: 'machine_only' },
                    currentStorageState: 'server_partial',
                    checkpoint: {
                        sourcePagesRead: 1,
                        stagedItemCount: 5,
                        importedItemCount: 4,
                        requiredItemFailures: {
                            total: 0,
                            record: 0,
                            media: 0,
                            conversion: 0,
                            diagnosticsTruncated: false,
                        },
                        acceptedThroughServerSeq: 4,
                    },
                    fence: {
                        kind: 'initial_server_partial',
                        acceptedThroughServerSeq: 4,
                    },
                    retryTargetPhase: 'importing',
                },
            },
        };
        const offlineMachine = createMachine('machine-1');
        offlineMachine.revokedAt = 1;
        storage.getState().applyMachines([offlineMachine], false);
        storage.getState().applySessions([partial]);

        requestMock.mockResolvedValueOnce(serverPage([
            serverRow({
                id: 'partial-staged-row-5',
                seq: 5,
                localId: partialStagedLocalId,
                text: 'partial staged beyond old bound',
            }),
            serverRow({
                id: 'partial-accepted-row-4',
                seq: 4,
                localId: partialAcceptedLocalId,
                text: 'partial accepted through old bound',
            }),
        ]));

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        const readTexts = () => Object.values(
            storage.getState().sessionMessages[sessionId]?.messagesById ?? {},
        )
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(readTexts()).toEqual(['partial accepted through old bound']);
        expect((sync as any).transcriptAuthorityKeyBySessionId.get(sessionId)).toBe(
            'server_partial:4:[1,"operation-partial-to-finalized",4,"materialize","awaiting_user_resume","importing"]',
        );

        let releaseLatePartialPage!: (response: Response) => void;
        const latePartialPage = new Promise<Response>((resolve) => {
            releaseLatePartialPage = resolve;
        });
        let markLatePartialReadStarted!: () => void;
        const latePartialReadStarted = new Promise<void>((resolve) => {
            markLatePartialReadStarted = resolve;
        });
        requestMock.mockImplementationOnce(async () => {
            markLatePartialReadStarted();
            return await latePartialPage;
        });
        // Model a source-composed reload of the still-current accepted prefix so
        // the old authority owns a real in-flight server read at finalization.
        (sync as any).transcriptAuthorityKeyBySessionId.delete(sessionId);
        const latePartialFetch = (sync as any).fetchMessages(sessionId);
        await latePartialReadStarted;

        const finalizedPage = serverPage([
            serverRow({
                id: 'finalized-staged-row-9',
                seq: 9,
                localId: finalizedStagedLocalId,
                text: 'staged beyond finalized bound',
            }),
            serverRow({
                id: 'finalized-tail-row-8',
                seq: 8,
                localId: finalizedTailLocalId,
                text: 'finalized tail at new bound',
            }),
            serverRow({
                id: 'finalized-accepted-row-4',
                seq: 4,
                localId: finalizedAcceptedLocalId,
                text: 'finalized snapshot prefix',
            }),
        ]);
        let releaseFinalizedPage!: (response: Response) => void;
        const pendingFinalizedPage = new Promise<Response>((resolve) => {
            releaseFinalizedPage = resolve;
        });
        let markFinalizedReadStarted!: () => void;
        const finalizedReadStarted = new Promise<void>((resolve) => {
            markFinalizedReadStarted = resolve;
        });
        requestMock.mockImplementationOnce(async () => {
            markFinalizedReadStarted();
            return await pendingFinalizedPage;
        });
        const finalized = {
            ...partial,
            currentStorageState: 'snapshot_complete' as const,
            acceptedThroughServerSeq: 8,
            publishedThroughServerSeq: 8,
            materializedThroughSourceAt,
            metadata: {
                ...partial.metadata!,
                externalSessionOperationV1: {
                    v: 1 as const,
                    progress: {
                        v: 1 as const,
                        operationId: 'operation-partial-to-finalized',
                        revision: 5,
                        request: {
                            plan: 'materialize' as const,
                            targetStorageMode: 'external-linked' as const,
                            targetRuntimeMode: null,
                        },
                        status: 'completed' as const,
                        phase: 'publishing' as const,
                        timeline: ['validating', 'staging', 'importing', 'publishing'] as const,
                        updatedAtMs: materializedThroughSourceAt,
                        priorStableStorage: { state: 'machine_only' as const },
                        currentStorageState: 'snapshot_complete' as const,
                        checkpoint: {
                            sourcePagesRead: 2,
                            stagedItemCount: 8,
                            importedItemCount: 8,
                            requiredItemFailures: {
                                total: 0,
                                record: 0,
                                media: 0,
                                conversion: 0,
                                diagnosticsTruncated: false,
                            },
                            acceptedThroughServerSeq: 8,
                        },
                        fence: { kind: 'none' as const },
                        publication: {
                            materializationPublicationId: 'publication-finalized',
                            materializedThroughSourceAt,
                            publishedThroughServerSeq: 8,
                        },
                    },
                },
            },
        };
        storage.getState().applySessions([finalized]);
        const finalizedFetch = (sync as any).fetchMessages(sessionId);
        await finalizedReadStarted;

        expect(readTexts()).toEqual(['partial accepted through old bound']);

        releaseFinalizedPage(finalizedPage);
        await finalizedFetch;

        expect(readTexts()).toEqual([
            'finalized snapshot prefix',
            'finalized tail at new bound',
        ]);
        expect((sync as any).transcriptAuthorityKeyBySessionId.get(sessionId)).toBe(
            `server_snapshot:8:${materializedThroughSourceAt}`,
        );

        releaseLatePartialPage(serverPage([
            serverRow({
                id: 'late-partial-row-4',
                seq: 4,
                localId: latePartialLocalId,
                text: 'late old-bound response',
            }),
        ]));
        await latePartialFetch;

        expect(readTexts()).toEqual([
            'finalized snapshot prefix',
            'finalized tail at new bound',
        ]);
        expect(readTexts()).not.toContain('late old-bound response');
        expect((sync as any).transcriptAuthorityKeyBySessionId.get(sessionId)).toBe(
            `server_snapshot:8:${materializedThroughSourceAt}`,
        );
        expect(requestMock).toHaveBeenCalledTimes(3);
    });

    it('fetches persisted session messages through the preferred owner server when the owner is not active', async () => {
        const sessionId = 'persisted_session_remote_messages';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);

        storage.getState().applySessions([createSession(sessionId)]);

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
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
        expectHeaderValue(ownerMessagesCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
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

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
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
        expectRuntimeFetchMessagePageCall(runtimeFetchMock.mock.calls[1], {
            baseUrl: 'https://owner.example',
            sessionId,
            beforeSeq: '2',
            limit: '150',
        });
        expectHeaderValue(runtimeFetchMock.mock.calls[1]?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
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

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async (input) => {
            if (String(input).endsWith('/v1/features')) {
                return currentPendingInputFeaturesResponse();
            }
            return Response.json({
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
            });
        });

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
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.text)).toEqual(['queued remotely']);
    });

    it('does not fetch pending messages or require a server-account scope in demo mode', async () => {
        const sessionId = 'demo_external_session';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        enterDemoMode();

        const { sync } = await import('./sync');

        await expect((sync as any).fetchPendingMessages(sessionId)).resolves.toBeUndefined();
        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
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

        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockImplementation(async (input) =>
            String(input).endsWith('/v1/features')
                ? currentPendingInputFeaturesResponse()
                : Response.json({
                    pending: { localId: 'owner-local-id' },
                    requestedAction: { v: 1, kind: 'send_now' },
                }));

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };

        const enqueueResult = await (sync as any).enqueuePendingMessage(
            sessionId,
            'hello pending',
            undefined,
            undefined,
            {
                localId: 'owner-local-id',
                requestedAction: { v: 1, kind: 'send_now' },
            },
        );
        expect(enqueueResult).toEqual({
            localId: 'owner-local-id',
            accepted: true,
        });

        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith(
            `https://owner.example/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({
                method: 'POST',
            }),
        );
        const ownerPendingCall = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending`);
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expectHeaderValue(ownerPendingCall?.[1]?.headers, 'Content-Type', 'application/json');
        expect(JSON.parse(String(ownerPendingCall?.[1]?.body))).toMatchObject({
            requestedAction: { v: 1, kind: 'send_now' },
        });
        const pendingMessages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pendingMessages.map((message) => message.text)).toEqual(['hello pending']);
        expect(pendingMessages[0]?.localId).toBe(enqueueResult.localId);
    });

    it.each(['before transport', 'after response'] as const)(
        'fences the captured active server-account scope %s for dynamic apiSocket requests',
        async (crossing) => {
            const sessionId = `active_pending_scope_fence_${crossing.replace(' ', '_')}`;
            const server = upsertServerProfile({ serverUrl: 'https://active-scope.example', name: 'Active scope' });
            setActiveServerId(server.id, { scope: 'device' });
            const { sync } = await import('./sync');
            const activate = (accountId: string) => (sync as any).activateAccountSettingsScopeForCredentials({
                token: buildTokenWithSub(accountId),
                secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            });
            activate('captured-account');
            const owner = await (sync as any).resolvePendingQueueOwnerContext(sessionId) as Readonly<{
                request: (path: string, init?: RequestInit) => Promise<Response>;
            }>;
            if (crossing === 'before transport') {
                activate('switched-account');
                requestMock.mockResolvedValue(new Response(null, { status: 204 }));
            } else {
                requestMock.mockImplementation(async () => {
                    activate('switched-account');
                    return new Response(null, { status: 204 });
                });
            }

            await expect(owner.request('/v2/sessions/s/pending', { method: 'POST' }))
                .rejects.toThrow('Pending owner server-account scope changed');
            expect(requestMock).toHaveBeenCalledTimes(crossing === 'before transport' ? 0 : 1);
        },
    );

    it('retains exact enqueue custody when the active-owner postflight fence rejects after a possible commit', async () => {
        const sessionId = 'active_pending_postflight_custody';
        const localId = 'postflight-local';
        const server = upsertServerProfile({ serverUrl: 'https://active-postflight.example', name: 'Active postflight' });
        setActiveServerId(server.id, { scope: 'device' });
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().activateProfileScope({ serverId: server.id, accountId: 'captured-account' });
        const { sync } = await import('./sync');
        requestMock.mockImplementation(async () => {
            storage.getState().activateProfileScope({ serverId: server.id, accountId: 'switched-account' });
            return Response.json({});
        });

        await expect((sync as any).enqueuePendingMessage(
            sessionId,
            'retain exact custody',
            undefined,
            undefined,
            { localId },
        )).resolves.toEqual({ localId, accepted: false });

        expect(loadPendingOutboxForSession(sessionId, {
            serverId: server.id,
            accountId: 'captured-account',
        })).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, sendState: 'unconfirmed' }),
        ]);
    });

    it('routes a pending update through the preferred owner server when it is not active', async () => {
        const sessionId = 'persisted_session_remote_pending_update';
        const pendingId = 'remote-pending-update';
        const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
        const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
        setActiveServerId(activeServer.id, { scope: 'device' });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'before update',
            rawRecord: { role: 'user', content: { type: 'text', text: 'before update' }, meta: {} },
        });
        const ownerToken = buildTokenWithSub('owner-account');
        getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
        runtimeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        const { sync } = await import('./sync');
        const pendingUpdater = sync as unknown as Readonly<{
            updatePendingMessage: (targetSessionId: string, targetPendingId: string, text: string) => Promise<void>;
        }>;
        await expect(pendingUpdater.updatePendingMessage(sessionId, pendingId, 'after update')).resolves.toBeUndefined();

        expect(requestMock).not.toHaveBeenCalled();
        const call = findRuntimeFetchCall(`https://owner.example/v2/sessions/${sessionId}/pending/${pendingId}`);
        expect(call?.[1]).toEqual(expect.objectContaining({ method: 'PATCH' }));
        expectHeaderValue(call?.[1]?.headers, 'Authorization', `Bearer ${ownerToken}`);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: pendingId, text: 'after update' }),
        ]);
    });

    it.each([false, true])(
        'applies remote mutation refresh only while the full owner account scope remains current (crossed=%s)',
        async (crossed) => {
            const sessionId = `persisted_session_remote_refresh_${crossed}`;
            const pendingId = 'remote-refresh-row';
            const activeServer = upsertServerProfile({ serverUrl: 'https://active.example', name: 'Active' });
            const ownerServer = upsertServerProfile({ serverUrl: 'https://owner.example', name: 'Owner' });
            setActiveServerId(activeServer.id, { scope: 'device' });
            resolvePreferredServerIdForSessionIdMock.mockReturnValue(ownerServer.id);
            storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
            storage.getState().upsertPendingMessage(sessionId, {
                id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
                source: 'server_pending', deliveryStatus: 'accepted', text: 'before refresh',
                rawRecord: { role: 'user', content: { type: 'text', text: 'before refresh' }, meta: {} },
            });
            const ownerToken = buildTokenWithSub('owner-account');
            const crossedToken = buildTokenWithSub('crossed-account');
            const replacementLocalId = 'server-owned-replacement';
            getCredentialsForServerUrlMock.mockResolvedValue({ token: ownerToken, secret: 'owner-secret' });
            createEncryptionFromAuthCredentialsMock.mockResolvedValue({});
            runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.endsWith(`/pending/${pendingId}/delivery/send-as-new`)) {
                    if (crossed) {
                        getCredentialsForServerUrlMock.mockResolvedValue({ token: crossedToken, secret: 'crossed-secret' });
                    }
                    return Response.json({ newLocalId: replacementLocalId });
                }
                if (url.includes('/pending?includeDiscarded=1')) {
                    return Response.json({ pending: [{
                        localId: pendingId,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'after refresh' }, meta: {} } },
                        status: 'queued', position: 0, createdAt: 1, updatedAt: 2,
                        discardedAt: null, discardedReason: null,
                    }] });
                }
                return new Response(null, { status: 204 });
            });

            const { sync } = await import('./sync');
            const pendingMutator = sync as unknown as Readonly<{
                sendPendingDeliveryAsNew: (targetSessionId: string, targetPendingId: string) => Promise<string>;
            }>;
            await expect(
                pendingMutator.sendPendingDeliveryAsNew(sessionId, pendingId),
            ).resolves.toBe(replacementLocalId);

            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({ localId: pendingId, text: crossed ? 'before refresh' : 'after refresh' }),
            ]);
        },
    );

    it.each(['.', '..'])('rejects requested-action dot segment %j before owner resolution or request', async (localId) => {
        const { sync } = await import('./sync');
        const actionMutator = sync as unknown as Readonly<{
            updatePendingRequestedAction: (
                targetSessionId: string,
                targetLocalId: string,
                requestedAction: { v: 1; kind: 'send_now' },
            ) => Promise<void>;
        }>;

        await expect(actionMutator.updatePendingRequestedAction('session', localId, { v: 1, kind: 'send_now' }))
            .rejects.toThrow('Pending message ID is invalid');
        expect(requestMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
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


    it('migrates a cached linked layout-0 owner through the scoped tuple writer', async () => {
        const sessionId = 'plain_metadata_session';
        const sourceMetadata = {
            path: '/tmp/repo',
            host: 'test-host',
            externalSessionV1: {
                v: 1 as const,
                agentId: 'codex',
                machineId: 'machine-layout0-owner',
                remoteSessionId: 'native-layout0-owner',
                source: {
                    kind: 'codexHome' as const,
                    home: 'user' as const,
                },
            },
        };
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: sourceMetadata,
        } as Session]);
        requestMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return currentPlainAccountEncryptionCurrentnessResponse();
            }
            if (path !== `/v2/sessions/${sessionId}`) {
                throw new Error(`Unexpected metadata request path: ${path}`);
            }
            return Response.json({ session: {
                id: sessionId,
                seq: 1,
                createdAt: 1_000,
                updatedAt: 1_000,
                active: true,
                activeAt: 1_000,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadataVersion: 2,
                metadata: JSON.stringify(sourceMetadata),
                agentStateVersion: 0,
                agentState: null,
                share: null,
            } });
        });
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 3,
            agentStateVersion: 1,
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            encryption: {
                publicKey: encodeBase64(
                    new Uint8Array(32).fill(24),
                    'base64',
                ),
                machineKey: encodeBase64(
                    new Uint8Array(32).fill(23),
                    'base64',
                ),
            },
        };
        (sync as any).encryption = {
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

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            patch: expect.objectContaining({
                mode: 'owner_migration',
                expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
                source: expect.objectContaining({
                    metadataLayoutVersion: 0,
                    metadata: {
                        version: 2,
                        ciphertext: JSON.stringify(sourceMetadata),
                    },
                }),
                target: expect.objectContaining({
                    metadataLayoutVersion: 1,
                    ownerMetadata: expect.objectContaining({ t: 'plain' }),
                    sharedMetadata: expect.objectContaining({
                        ciphertext: expect.stringContaining('Renamed session'),
                    }),
                }),
            }),
        });
        expect(storage.getState().sessions[sessionId]?.metadataLayoutVersion).toBe(1);
        expect(storage.getState().sessions[sessionId]?.metadataVersion).toBe(3);
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.summary?.text).toBe('Renamed session');
    });

    it('routes layout-1 title updates as strict shared-editor tuple patches', async () => {
        const sessionId = 'plain_shared_metadata_session';
        const initialSharedMetadata = {
            v: 1,
            summary: { text: 'Before', updatedAt: 100 },
        };
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataLayoutVersion: 1,
            metadataVersion: 2,
            metadata: initialSharedMetadata,
        } as unknown as Session]);
        requestMock.mockResolvedValueOnce(new Response(JSON.stringify({
            session: {
                id: sessionId,
                seq: 1,
                createdAt: 1_000,
                updatedAt: 1_000,
                active: true,
                activeAt: 1_000,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 1,
                metadataVersion: 2,
                metadata: JSON.stringify(initialSharedMetadata),
                agentStateVersion: 0,
                agentState: null,
                share: {
                    accessLevel: 'edit',
                    canApprovePermissions: false,
                },
            },
        }), { status: 200 }));
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 3,
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            encryption: {
                publicKey: encodeBase64(
                    new Uint8Array(32).fill(24),
                    'base64',
                ),
                machineKey: encodeBase64(
                    new Uint8Array(32).fill(23),
                    'base64',
                ),
            },
        };
        (sync as any).encryption = {
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

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            patch: {
                mode: 'shared_editor',
                metadataLayoutVersion: 1,
                sharedMetadata: {
                    ciphertext: JSON.stringify({
                        v: 1,
                        summary: { text: 'Renamed session', updatedAt: 123 },
                    }),
                    expectedVersion: 2,
                },
            },
        });
        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            metadataLayoutVersion: 1,
            metadataVersion: 3,
            metadata: {
                v: 1,
                summary: { text: 'Renamed session', updatedAt: 123 },
            },
        }));
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it('hydrates and mutates a cold layout-1 owner with one authoritative by-id read', async () => {
        const sessionId = 'plain_cold_owner_metadata_session';
        const machineKey = new Uint8Array(32).fill(23);
        const accountPublicKey = new Uint8Array(
            tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        );
        const credentials = {
            token: 'active-token',
            encryption: {
                publicKey: encodeBase64(
                    accountPublicKey,
                    'base64',
                ),
                machineKey: encodeBase64(machineKey, 'base64'),
            },
        } as const;
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: {
                path: '/private/repo',
                host: 'owner-host',
            },
        });
        const ownerMetadataEnvelope = sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'dataKey', machineKey },
            ownerMetadata,
            randomBytes: (length) =>
                new Uint8Array(length).fill(7),
        });
        const sharedMetadata = projectSessionSharedMetadataV1({
            metadata: {
                path: '/private/repo',
                host: 'owner-host',
                summary: { text: 'Before', updatedAt: 100 },
            },
            agentState: { requests: {} },
        });
        requestMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return currentE2eeAccountEncryptionCurrentnessResponse(
                    accountPublicKey,
                );
            }
            if (path !== `/v2/sessions/${sessionId}`) {
                throw new Error(`Unexpected metadata request path: ${path}`);
            }
            return Response.json({ session: {
                id: sessionId,
                seq: 1,
                createdAt: 1_000,
                updatedAt: 1_000,
                active: true,
                activeAt: 1_000,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 1,
                metadataVersion: 2,
                metadata: JSON.stringify(sharedMetadata),
                ownerMetadata: ownerMetadataEnvelope,
                agentStateVersion: 4,
                agentState: JSON.stringify({ requests: {} }),
                share: null,
            } });
        });
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 3,
            agentStateVersion: 5,
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = credentials;
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };

        await expect(
            sync.patchSessionMetadataWithRetry(
                sessionId,
                (metadata) => ({
                    ...metadata,
                    summary: {
                        text: 'Renamed owner session',
                        updatedAt: 123,
                    },
                }),
            ),
        ).resolves.toBeUndefined();

        expect(requestMock).toHaveBeenCalledTimes(2);
        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(requestMock).toHaveBeenCalledWith(
            '/v1/account/encryption/currentness',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(
            emitSessionMetadataUpdateWithServerScopeMock,
        ).toHaveBeenCalledWith({
            sessionId,
            patch: {
                mode: 'owner',
                metadataLayoutVersion: 1,
                expectedOwnerMetadata: ownerMetadataEnvelope,
                sharedMetadata: {
                    ciphertext: JSON.stringify({
                        ...sharedMetadata,
                        summary: {
                            text: 'Renamed owner session',
                            updatedAt: 123,
                        },
                    }),
                    expectedVersion: 2,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: JSON.stringify({ requests: {} }),
                    expectedVersion: 4,
                },
            },
        });
        expect(
            storage.getState().sessions[sessionId],
        ).toEqual(expect.objectContaining({
            metadataLayoutVersion: 1,
            metadataVersion: 3,
            agentStateVersion: 5,
            ownerMetadataView: expect.objectContaining({
                path: '/private/repo',
                host: 'owner-host',
                summary: {
                    text: 'Renamed owner session',
                    updatedAt: 123,
                },
            }),
        }));
        expect(
            storage.getState().sessions[sessionId],
        ).not.toHaveProperty('ownerMetadata');
    });

    it('supports overriding the server scope used by patchSessionMetadataWithRetry', async () => {
        const sessionId = 'plain_metadata_session_override';
        const activeServer = upsertServerProfile({
            serverUrl: 'https://active-metadata.example',
            name: 'Active metadata',
        });
        setActiveServerId(activeServer.id, { scope: 'device' });
        const sourceMetadata = {
            path: '/tmp/repo',
            host: 'test-host',
            externalSessionV1: {
                v: 1 as const,
                agentId: 'codex',
                machineId: 'machine-layout0-override',
                remoteSessionId: 'native-layout0-override',
                source: {
                    kind: 'codexHome' as const,
                    home: 'user' as const,
                },
            },
        };
        storage.getState().applySessions([{
            ...createSession(sessionId),
            encryptionMode: 'plain',
            metadataVersion: 2,
            metadata: sourceMetadata,
        } as Session]);
        requestMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return currentPlainAccountEncryptionCurrentnessResponse();
            }
            if (path !== `/v2/sessions/${sessionId}`) {
                throw new Error(`Unexpected metadata request path: ${path}`);
            }
            return Response.json({ session: {
                id: sessionId,
                seq: 1,
                createdAt: 1_000,
                updatedAt: 1_000,
                active: true,
                activeAt: 1_000,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadataVersion: 2,
                metadata: JSON.stringify(sourceMetadata),
                agentStateVersion: 0,
                agentState: null,
                share: null,
            } });
        });
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 3,
            agentStateVersion: 1,
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            encryption: {
                publicKey: encodeBase64(
                    new Uint8Array(32).fill(24),
                    'base64',
                ),
                machineKey: encodeBase64(
                    new Uint8Array(32).fill(23),
                    'base64',
                ),
            },
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };

        await expect(
            sync.patchSessionMetadataWithRetry(
                sessionId,
                (metadata) => ({
                    ...metadata,
                    summary: { text: 'Renamed session', updatedAt: 123 },
                }),
                { serverId: activeServer.id },
            ),
        ).resolves.toBeUndefined();

        expect(emitSessionMetadataUpdateWithServerScopeMock).toHaveBeenCalledWith({
            sessionId,
            serverId: activeServer.id,
            patch: expect.objectContaining({
                mode: 'owner_migration',
                expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
                source: expect.objectContaining({
                    metadataLayoutVersion: 0,
                    metadata: {
                        version: 2,
                        ciphertext: JSON.stringify(sourceMetadata),
                    },
                }),
                target: expect.objectContaining({
                    metadataLayoutVersion: 1,
                    ownerMetadata: expect.objectContaining({ t: 'plain' }),
                }),
            }),
        });
    });

    it('hydrates lightweight session rows before patching metadata', async () => {
        const sessionId = 'plain_metadata_lightweight_row';
        const sourceMetadata = {
            path: '/tmp/repo',
            host: 'test-host',
            externalSessionV1: {
                v: 1 as const,
                agentId: 'codex',
                machineId: 'machine-layout0-lightweight',
                remoteSessionId: 'native-layout0-lightweight',
                source: {
                    kind: 'codexHome' as const,
                    home: 'user' as const,
                },
            },
        };
        requestMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return currentPlainAccountEncryptionCurrentnessResponse();
            }
            if (path !== `/v2/sessions/${sessionId}`) {
                throw new Error(`Unexpected metadata request path: ${path}`);
            }
            return Response.json({ session: {
                        id: sessionId,
                        seq: 1,
                        createdAt: 1_000,
                        updatedAt: 1_000,
                        active: true,
                        activeAt: 1_000,
                        encryptionMode: 'plain',
                        dataEncryptionKey: null,
                        metadataVersion: 2,
                        metadata: JSON.stringify(sourceMetadata),
                        agentStateVersion: 1,
                        agentState: JSON.stringify({ controlledByUser: true }),
                        share: null,
            } });
        });
        emitSessionMetadataUpdateWithServerScopeMock.mockResolvedValue({
            result: 'success',
            metadataLayoutVersion: 1,
            version: 3,
            agentStateVersion: 2,
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
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
            patch: expect.objectContaining({
                mode: 'owner_migration',
                expectedAccountEncryptionMode: 'plain',
                expectedAccountContentPublicKeyFingerprint: null,
                source: expect.objectContaining({
                    metadataLayoutVersion: 0,
                    metadata: {
                        version: 2,
                        ciphertext: JSON.stringify(sourceMetadata),
                    },
                    agentState: {
                        version: 1,
                        ciphertext: JSON.stringify({ controlledByUser: true }),
                    },
                }),
                target: expect.objectContaining({
                    metadataLayoutVersion: 1,
                    ownerMetadata: expect.objectContaining({ t: 'plain' }),
                }),
            }),
        });
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.summary?.text).toBe('Renamed session');
    });

    it('drops stale direct transcript fetch results after the server scope resets mid-request', async () => {
        const sessionId = 'direct_session_scope_reset';
        storage.getState().applySessions([createExternalSession(sessionId)]);

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

        machineExternalSessionTranscriptPageMock.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolvePage = resolve;
            }),
        );
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
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
        expect(machineExternalSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
    });

    it('pages older direct transcript messages using provider cursors', async () => {
        const sessionId = 'direct_session_paging';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock
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
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
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
        const result = await (sync as any).loadOlderMessages(sessionId, { limit: 37 });

        expect(result).toEqual({ loaded: 1, hasMore: false, status: 'no_more' });
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            remoteSessionId: 'vendor-session-1',
            cursor: 'older-cursor-2',
            direction: 'older',
            maxItems: 37,
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['older', 'latest']);
    });

    it('refuses a truncated older page instead of splicing replacement rows into the accepted transcript', async () => {
        const sessionId = 'direct_session_older_truncated';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        const readTexts = () => {
            const sessionMessages = storage.getState().sessionMessages[sessionId];
            return (sessionMessages?.messageIdsOldestFirst ?? [])
                .map((id) => sessionMessages?.messagesById[id])
                .filter((message): message is NonNullable<typeof message> => Boolean(message))
                .filter((message) => message.kind === 'user-text')
                .map((message) => message.text);
        };
        let textsObservedAtHydration: string[] | null = null;
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'accepted-msg-2',
                        createdAtMs: 2,
                        raw: { role: 'user', content: { type: 'text', text: 'accepted' } },
                    },
                ],
                nextCursor: 'older-cursor-accepted',
                hasMore: true,
            })
            // A physical source replacement: the older page is nonempty but discontinuous.
            .mockResolvedValueOnce({
                ok: true,
                items: [
                    {
                        id: 'replacement-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'spliced replacement' } },
                    },
                ],
                nextCursor: 'older-cursor-replacement',
                hasMore: true,
                truncated: true,
            })
            // The existing replacement hydration re-reads the source from its head.
            .mockImplementationOnce(async () => {
                textsObservedAtHydration = readTexts();
                return {
                    ok: true,
                    items: [
                        {
                            id: 'rehydrated-msg-1',
                            createdAtMs: 3,
                            raw: { role: 'user', content: { type: 'text', text: 'rehydrated' } },
                        },
                    ],
                    nextCursor: null,
                    hasMore: false,
                };
            });
        machineExternalSessionTranscriptReadAfterMock
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: 'tail-cursor-accepted',
                truncated: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: 'tail-cursor-rehydrated',
                truncated: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        expect(readTexts()).toEqual(['accepted']);

        const result = await (sync as any).loadOlderMessages(sessionId);

        // Zero rows applied from the truncated page.
        expect(result.loaded).toBe(0);
        expect(textsObservedAtHydration).toEqual(['accepted']);
        // The truncated page's cursor is never committed as the accepted cursor.
        expect((sync as any).externalSessionOlderCursorBySessionId.get(sessionId))
            .not.toBe('older-cursor-replacement');
        // The existing source-replacement hydration ran: a fresh head read, no cursor.
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(3);
        expect(machineExternalSessionTranscriptPageMock.mock.calls[2]?.[0]).toEqual(
            expect.objectContaining({ direction: 'older' }),
        );
        expect(machineExternalSessionTranscriptPageMock.mock.calls[2]?.[0]?.cursor).toBeUndefined();
        expect(readTexts()).toEqual(['rehydrated']);
    });

    it('replaces the live transcript without reusing the losing link generation cursor after relink', async () => {
        const sessionId = 'direct_session_relink_authority';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'old-link-message',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'old link' } },
                }],
                nextCursor: null,
                tailCursor: 'happier_external_cursor_v1:b2xk',
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'new-link-message',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'new link' } },
                }],
                nextCursor: null,
                tailCursor: 'happier_external_cursor_v1:bmV3',
                hasMore: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        const relinked = createExternalSession(sessionId);
        const relinkedMetadata = relinked.metadata as NonNullable<Session['metadata']>;
        relinked.metadata = {
            ...relinkedMetadata,
            externalSessionV1: {
                ...relinkedMetadata.externalSessionV1!,
                remoteSessionId: 'vendor-session-2',
                linkedAtMs: 2,
            },
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: relinked },
        }));

        await (sync as any).fetchMessages(sessionId);

        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                remoteSessionId: 'vendor-session-2',
                direction: 'older',
            }),
            expect.anything(),
        );
        expect(machineExternalSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['new link']);
    });

    it('redrives only an existing transcript owner after relink and machine reachability changes', async () => {
        const openSessionId = 'direct_session_open_relink_redrive';
        const unopenedSessionId = 'direct_session_unopened_relink_redrive';
        const initial = createExternalSession(openSessionId);
        storage.getState().applyMachines([createMachine('machine-1')], false);
        storage.getState().applySessions([initial, createSession(unopenedSessionId)]);

        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'relinked-b',
                createdAtMs: 2,
                raw: { role: 'user', content: { type: 'text', text: 'relinked B' } },
            }],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:cmVsaW5rZWQtQg',
            hasMore: false,
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).messagesSync.clear();
        let redrive!: Promise<void>;
        const invalidateOpen = vi.fn(() => {
            redrive = (sync as any).fetchMessages(openSessionId);
        });
        (sync as any).messagesSync.set(openSessionId, { invalidateCoalesced: invalidateOpen });

        const relinked = createExternalSession(openSessionId);
        const relinkedMetadata = relinked.metadata as NonNullable<Session['metadata']>;
        relinked.metadata = {
            ...relinkedMetadata,
            externalSessionV1: {
                ...relinkedMetadata.externalSessionV1!,
                remoteSessionId: 'vendor-session-2',
                linkedAtMs: 2,
            },
        };
        (sync as any).applySessions([relinked]);
        await redrive;

        expect(invalidateOpen).toHaveBeenCalledTimes(1);
        expect((sync as any).messagesSync.has(unopenedSessionId)).toBe(false);
        const relinkedTexts = Object.values(storage.getState().sessionMessages[openSessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(relinkedTexts).toEqual(['relinked B']);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(1);

        invalidateOpen.mockImplementation(() => undefined);
        (sync as any).flushMachineActivityUpdates(new Map([
            ['machine-1', { id: 'machine-1', active: false, activeAt: Date.now() - 120_000 }],
        ]));
        expect(invalidateOpen).toHaveBeenCalledTimes(2);
        expect((sync as any).messagesSync.has(unopenedSessionId)).toBe(false);
    });

    it('preserves the last accepted row when a canonical live source relink cannot load', async () => {
        const sessionId = 'direct_session_relink_failure';
        const initial = createExternalSession(sessionId);
        const initialMetadata = initial.metadata as NonNullable<Session['metadata']>;
        initial.metadata = {
            ...initialMetadata,
            externalSessionV1: {
                ...initialMetadata.externalSessionV1!,
                linkData: { workspaceRoot: '/workspace/a' },
            },
        };
        storage.getState().applySessions([initial]);
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'same-native-message-id',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'losing source row' } },
                }],
                nextCursor: null,
                tailCursor: 'happier_external_cursor_v1:b2xkLXNvdXJjZQ',
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'agent_unavailable',
                error: 'replacement source unavailable',
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);

        const relinked = createExternalSession(sessionId);
        const relinkedMetadata = relinked.metadata as NonNullable<Session['metadata']>;
        relinked.metadata = {
            ...relinkedMetadata,
            externalSessionV1: {
                ...relinkedMetadata.externalSessionV1!,
                // The native id and linkedAtMs intentionally remain identical. The
                // canonical link-data carrier is what selects a new live authority.
                linkData: { workspaceRoot: '/workspace/b' },
            },
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: relinked },
        }));

        await expect((sync as any).fetchMessages(sessionId)).rejects.toThrow(
            'replacement source unavailable',
        );

        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true);
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'read_failed',
            errorCode: 'agent_unavailable',
        });
        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['losing source row']);
    });

    it('atomically commits all staged replacement pages before a relink during progress publication', async () => {
        const sessionId = 'direct_session_relink_between_staged_pages';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'accepted-old-message',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'accepted old authority' } },
                }],
                nextCursor: null,
                tailCursor: 'happier_external_cursor_v1:b2xk',
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'replacement-page-1',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'replacement page one' } },
                }],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'replacement-page-2',
                createdAtMs: 3,
                raw: { role: 'user', content: { type: 'text', text: 'replacement page two' } },
            }],
            nextCursor: 'happier_external_cursor_v1:cmVwbGFjZW1lbnQ',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const acceptedAuthorityKey = (sync as any).transcriptAuthorityKeyBySessionId.get(sessionId);

        const replacement = createExternalSession(sessionId);
        const replacementMetadata = replacement.metadata as NonNullable<Session['metadata']>;
        replacement.metadata = {
            ...replacementMetadata,
            externalSessionV1: {
                ...replacementMetadata.externalSessionV1!,
                remoteSessionId: 'vendor-session-2',
                linkedAtMs: 2,
            },
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: replacement },
        }));

        const observedProgressOwner = sync as unknown as {
            publishExternalSessionObservedProgress: (
                publishedSessionId: string,
                items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
            ) => Promise<void>;
        };
        const originalPublishObservedProgress =
            observedProgressOwner.publishExternalSessionObservedProgress.bind(observedProgressOwner);
        let releaseFirstPageProgress!: () => void;
        const firstPageProgressReleased = new Promise<void>((resolve) => {
            releaseFirstPageProgress = resolve;
        });
        let markFirstPageProgressStarted!: () => void;
        const firstPageProgressStarted = new Promise<void>((resolve) => {
            markFirstPageProgressStarted = resolve;
        });
        vi.spyOn(observedProgressOwner, 'publishExternalSessionObservedProgress')
            .mockImplementationOnce(async (publishedSessionId, items) => {
                await originalPublishObservedProgress(publishedSessionId, items);
                markFirstPageProgressStarted();
                await firstPageProgressReleased;
            });

        const replacementFetch = (sync as any).fetchMessages(sessionId);
        await firstPageProgressStarted;
        const acceptedReplacementPageIds = [
            ...(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? []),
        ];

        const relinkedAgain = createExternalSession(sessionId);
        const relinkedAgainMetadata = relinkedAgain.metadata as NonNullable<Session['metadata']>;
        relinkedAgain.metadata = {
            ...relinkedAgainMetadata,
            externalSessionV1: {
                ...relinkedAgainMetadata.externalSessionV1!,
                remoteSessionId: 'vendor-session-3',
                linkedAtMs: 3,
            },
        };
        storage.setState((state) => ({
            ...state,
            sessions: { ...state.sessions, [sessionId]: relinkedAgain },
        }));
        releaseFirstPageProgress();
        await replacementFetch;

        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['replacement page one', 'replacement page two']);
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual(
            acceptedReplacementPageIds,
        );
        const replacementAuthorityKey = (sync as any).transcriptAuthorityKeyBySessionId.get(sessionId);
        expect(replacementAuthorityKey).not.toBe(acceptedAuthorityKey);
        expect(replacementAuthorityKey).toContain('vendor-session-2');
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:cmVwbGFjZW1lbnQ',
        );
    });

    it('catches up a missed direct transcript invalidation from the accepted UI tail on socket reconnect', async () => {
        const sessionId = 'direct_session_missed_invalidation_reconnect';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-1',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'accepted before disconnect' } },
            }],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });

        let resolveCatchUp!: (value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: string; content: { type: string; text: string } };
            }>;
            nextCursor: string;
            truncated: false;
        }) => void;
        const catchUpResponse = new Promise<Parameters<typeof resolveCatchUp>[0]>((resolve) => {
            resolveCatchUp = resolve;
        });
        let markCatchUpStarted!: () => void;
        const catchUpStarted = new Promise<void>((resolve) => {
            markCatchUpStarted = resolve;
        });
        machineExternalSessionTranscriptReadAfterMock
            .mockImplementationOnce(async () => {
                markCatchUpStarted();
                return await catchUpResponse;
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [],
                nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                truncated: false,
            });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const acceptedMessageIds = [
            ...(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? []),
        ];

        storage.setState((state) => ({
            ...state,
            profile: { ...(state.profile ?? {}), id: 'reconnect-account' } as any,
        }), true);
        (sync as any).credentials = {
            token: buildTokenWithSub('reconnect-account'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };
        (sync as any).isForeground = true;
        (sync as any).resumeInFlight = null;
        const resumeViaChangesSpy = vi.spyOn(sync as any, 'resumeViaChanges').mockResolvedValue({
            status: 'ok',
            refreshedByCatchUp: { sessions: false, machines: false },
        });
        const resumeUnits = [
            (sync as any).sessionsSync,
            (sync as any).machinesSync,
            (sync as any).purchasesSync,
            (sync as any).pushTokenSync,
            (sync as any).nativeUpdateSync,
        ];
        for (const unit of resumeUnits) {
            vi.spyOn(unit, 'invalidateCoalesced').mockImplementation(() => undefined);
            vi.spyOn(unit, 'awaitQueue').mockResolvedValue(undefined);
        }

        const firstResume = (sync as any).resumeSync('socket-reconnect');
        await catchUpStarted;

        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                machineId: 'machine-1',
                remoteSessionId: 'vendor-session-1',
                cursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            }),
            expect.anything(),
        );
        expect(storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst).toEqual(acceptedMessageIds);

        resolveCatchUp({
            ok: true,
            items: [{
                id: 'direct-msg-2',
                createdAtMs: 2,
                raw: { role: 'user', content: { type: 'text', text: 'missed while disconnected' } },
            }],
            nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
            truncated: false,
        });
        await firstResume;
        await (sync as any).resumeSync('socket-reconnect');

        expect(resumeViaChangesSpy).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                cursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
            }),
            expect.anything(),
        );
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionTranscriptRefreshReadAfterMock).not.toHaveBeenCalled();
        expect(requestMock.mock.calls.some(([path]) => String(path).includes('/messages'))).toBe(false);

        const orderedTexts = (storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? [])
            .map((id) => storage.getState().sessionMessages[sessionId]?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual([
            'accepted before disconnect',
            'missed while disconnected',
        ]);
    });

    it('refreshes loaded direct session transcripts through the shared messages invalidation path', async () => {
        const sessionId = 'direct_session_refresh';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        emitSessionMetadataUpdateWithServerScopeMock.mockImplementation(async ({ expectedVersion, metadata }: any) => ({
            result: 'success',
            version: Number(expectedVersion ?? 0) + 1,
            metadata,
        }));
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });
        const firstInvalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: firstInvalidation.binding,
            result: {
                outcome: 'advanced',
                items: [{
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                }],
                nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                boundary: '2:direct-msg-2',
            },
        });
        machineExternalSessionTranscriptReadAfterMock
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

        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
        }), expect.anything());
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '2:direct-msg-2',
            observedAtMs: 2,
        });
        expect(emitSessionMetadataUpdateWithServerScopeMock).not.toHaveBeenCalled();
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);
    });

    it('hydrates the source-scoped linked session before applying a pre-hydration transcript invalidation', async () => {
        const sessionId = 'direct_session_push_delta_before_session_hydration';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-source.example',
            name: 'External invalidation source',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        const hydratedSession = createExternalSession(sessionId);
        const initialCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
        const invalidation = createTranscriptInvalidation(sessionId, initialCursor);

        requestMock.mockResolvedValueOnce(Response.json({
            session: {
                ...hydratedSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadata: JSON.stringify(hydratedSession.metadata),
                agentState: null,
                share: null,
            },
        }));
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: invalidation.binding,
            result: { outcome: 'already_current' },
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(sessionId, initialCursor);

        (sync as any).handleEphemeralUpdate(invalidation);
        await vi.waitFor(() => {
            expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
        });

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            id: sessionId,
            serverId: sourceServer.id,
        }));
        expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledWith({
            v: 1,
            binding: invalidation.binding,
            cursor: initialCursor,
        }, { serverId: sourceServer.id });
    });

    it('hydrates an existing stale linked-session row before accepting the newer invalidation binding', async () => {
        const sessionId = 'direct_session_push_delta_after_link_generation_race';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-link-race.example',
            name: 'External invalidation link race',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        const currentSession = createExternalSession(sessionId);
        const currentMetadata = currentSession.metadata!;
        storage.getState().applySessions([{
            ...currentSession,
            serverId: sourceServer.id,
            metadata: {
                ...currentMetadata,
                externalSessionV1: {
                    ...currentMetadata.externalSessionV1!,
                    remoteSessionId: 'stale-vendor-session',
                    linkedAtMs: 0,
                },
            },
        }]);
        const hydratedSession = createExternalSession(sessionId);
        const initialCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
        const invalidation = createTranscriptInvalidation(sessionId, initialCursor);
        requestMock.mockResolvedValueOnce(Response.json({
            session: {
                ...hydratedSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadataVersion: 1,
                metadata: JSON.stringify(hydratedSession.metadata),
                agentState: null,
                share: null,
            },
        }));
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: invalidation.binding,
            result: { outcome: 'already_current' },
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(sessionId, initialCursor);

        await (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            { sourceServerId: sourceServer.id, shouldContinue: () => true },
        );

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(
            (storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionV1,
        ).toEqual(expect.objectContaining({
            remoteSessionId: 'vendor-session-1',
            linkedAtMs: 1,
        }));
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(initialCursor);
        expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
    });

    it('does not secure-refresh when exact hydration still cannot prove the invalidation binding', async () => {
        const sessionId = 'direct_session_push_delta_stale_event';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-stale-event.example',
            name: 'External invalidation stale event',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        const currentSession = createExternalSession(sessionId);
        const currentMetadata = currentSession.metadata!;
        const stillMismatchedSession = {
            ...currentSession,
            metadata: {
                ...currentMetadata,
                externalSessionV1: {
                    ...currentMetadata.externalSessionV1!,
                    remoteSessionId: 'replacement-vendor-session',
                    linkedAtMs: 2,
                },
            },
        };
        storage.getState().applySessions([{
            ...stillMismatchedSession,
            serverId: sourceServer.id,
        }]);
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        requestMock.mockResolvedValueOnce(Response.json({
            session: {
                ...stillMismatchedSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadataVersion: 1,
                metadata: JSON.stringify(stillMismatchedSession.metadata),
                agentState: null,
                share: null,
            },
        }));

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );

        await (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            { sourceServerId: sourceServer.id, shouldContinue: () => true },
        );

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(machineExternalSessionTranscriptRefreshReadAfterMock).not.toHaveBeenCalled();
    });

    it.each([
        ['unscoped', undefined],
        ['wrong-server', 'different-server'],
    ])('does not trust a %s local link as proof of the invalidation source server', async (
        _caseName,
        localServerId,
    ) => {
        const sessionId = `direct_session_push_delta_${_caseName}_local_link`;
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-unscoped.example',
            name: 'External invalidation unscoped source',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: localServerId,
        }]);
        requestMock.mockResolvedValueOnce(Response.json(
            { error: 'session_not_found' },
            { status: 404 },
        ));
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: invalidation.binding,
            result: { outcome: 'already_current' },
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );

        await (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            { sourceServerId: sourceServer.id, shouldContinue: () => true },
        );

        expect(requestMock).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}`,
            expect.objectContaining({ method: 'GET' }),
        );
        expect(machineExternalSessionTranscriptRefreshReadAfterMock).not.toHaveBeenCalled();
    });

    it('cancels a pre-hydration invalidation when its captured server scope changes', async () => {
        const sessionId = 'direct_session_push_delta_scope_changes_during_hydration';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-cancelled.example',
            name: 'External invalidation cancelled source',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        const hydratedSession = createExternalSession(sessionId);
        let resolveHydration!: (response: Response) => void;
        requestMock.mockImplementationOnce(
            () => new Promise<Response>((resolve) => {
                resolveHydration = resolve;
            }),
        );
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        let scopeIsCurrent = true;

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );

        const refresh = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            {
                sourceServerId: sourceServer.id,
                shouldContinue: () => scopeIsCurrent,
            },
        );
        await vi.waitFor(() => {
            expect(requestMock).toHaveBeenCalledTimes(1);
        });
        scopeIsCurrent = false;
        resolveHydration(Response.json({
            session: {
                ...hydratedSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadata: JSON.stringify(hydratedSession.metadata),
                agentState: null,
                share: null,
            },
        }));
        await refresh;

        expect(machineExternalSessionTranscriptRefreshReadAfterMock).not.toHaveBeenCalled();
    });

    it('drops a secure-refresh response when the accepted tail cursor changes in flight', async () => {
        const sessionId = 'direct_session_push_delta_cursor_changes_inflight';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-cursor-race.example',
            name: 'External invalidation cursor race',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: sourceServer.id,
        }]);
        const initialCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
        const newerCursor = 'happier_external_cursor_v1:Y3Vyc29yLTI';
        const invalidation = createTranscriptInvalidation(sessionId, initialCursor);
        let releaseRefresh!: () => void;
        machineExternalSessionTranscriptRefreshReadAfterMock.mockImplementationOnce(
            async () => {
                await new Promise<void>((resolve) => {
                    releaseRefresh = resolve;
                });
                return {
                    v: 1,
                    binding: invalidation.binding,
                    result: {
                        outcome: 'advanced',
                        items: [{
                            id: 'direct-msg-stale-cursor',
                            createdAtMs: 2,
                            raw: {
                                role: 'user',
                                content: { type: 'text', text: 'stale cursor row' },
                            },
                        }],
                        nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTM',
                        boundary: '2:direct-msg-stale-cursor',
                    },
                };
            },
        );

        const { sync } = await import('./sync');
        (sync as any).externalSessionTailCursorBySessionId.set(sessionId, initialCursor);
        const refresh = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            { sourceServerId: sourceServer.id, shouldContinue: () => true },
        );
        await vi.waitFor(() => {
            expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
        });
        (sync as any).setExternalSessionTailCursor(sessionId, newerCursor);
        releaseRefresh();
        await refresh;

        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(newerCursor);
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
    });

    it('drops a secure-refresh response whose full binding differs from the invalidation', async () => {
        const sessionId = 'direct_session_push_delta_response_binding_mismatch';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-response-mismatch.example',
            name: 'External invalidation response mismatch',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: sourceServer.id,
        }]);
        const initialCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
        const invalidation = createTranscriptInvalidation(sessionId, initialCursor);
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: {
                ...invalidation.binding,
                contributionGeneration: 'different-contribution',
            },
            result: {
                outcome: 'advanced',
                items: [{
                    id: 'direct-msg-wrong-binding',
                    createdAtMs: 2,
                    raw: {
                        role: 'user',
                        content: { type: 'text', text: 'wrong binding row' },
                    },
                }],
                nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                boundary: '2:direct-msg-wrong-binding',
            },
        });

        const { sync } = await import('./sync');
        (sync as any).externalSessionTailCursorBySessionId.set(sessionId, initialCursor);
        await (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
            invalidation,
            { sourceServerId: sourceServer.id, shouldContinue: () => true },
        );

        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(initialCursor);
        expect(storage.getState().sessionMessages[sessionId]).toBeUndefined();
    });

    it('coalesces duplicate pre-hydration reads and applies their shared cursor transition once', async () => {
        const sessionId = 'direct_session_push_delta_duplicate_before_hydration';
        const sourceServer = upsertServerProfile({
            serverUrl: 'https://external-invalidation-duplicate.example',
            name: 'External invalidation duplicate source',
        });
        setActiveServerId(sourceServer.id, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe(sourceServer.id);
        resolvePreferredServerIdForSessionIdMock.mockImplementation(
            (candidateSessionId) => candidateSessionId === sessionId
                ? sourceServer.id
                : undefined,
        );
        const hydratedSession = createExternalSession(sessionId);
        const initialCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
        const invalidation = createTranscriptInvalidation(sessionId, initialCursor);
        let resolveHydration!: (response: Response) => void;
        requestMock.mockImplementationOnce(
            () => new Promise<Response>((resolve) => {
                resolveHydration = resolve;
            }),
        );
        let releaseRefreshes!: () => void;
        const refreshGate = new Promise<void>((resolve) => {
            releaseRefreshes = resolve;
        });
        machineExternalSessionTranscriptRefreshReadAfterMock.mockImplementation(
            async () => {
                await refreshGate;
                return {
                    v: 1,
                    binding: invalidation.binding,
                    result: {
                        outcome: 'advanced',
                        items: [{
                            id: 'direct-msg-from-duplicate-invalidation',
                            createdAtMs: 2,
                            raw: {
                                role: 'user',
                                content: { type: 'text', text: 'one visible row' },
                            },
                        }],
                        nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                        boundary: '2:direct-msg-from-duplicate-invalidation',
                    },
                };
            },
        );

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).externalSessionTailCursorBySessionId.set(sessionId, initialCursor);
        const applyItemsSpy = vi.spyOn(
            sync as any,
            'applyExternalSessionTranscriptItems',
        );

        const refreshes = [
            (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
                invalidation,
                { sourceServerId: sourceServer.id, shouldContinue: () => true },
            ),
            (sync as any).handleExternalSessionTranscriptEphemeralUpdate(
                invalidation,
                { sourceServerId: sourceServer.id, shouldContinue: () => true },
            ),
        ];
        await vi.waitFor(() => {
            expect(requestMock).toHaveBeenCalledTimes(1);
        });
        resolveHydration(Response.json({
            session: {
                ...hydratedSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadata: JSON.stringify(hydratedSession.metadata),
                agentState: null,
                share: null,
            },
        }));
        await vi.waitFor(() => {
            expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(2);
        });
        releaseRefreshes();
        await Promise.all(refreshes);

        expect(requestMock).toHaveBeenCalledTimes(1);
        expect(applyItemsSpy).toHaveBeenCalledTimes(1);
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:Y3Vyc29yLTI',
        );
    });

    it('applies authoritative secure-refresh items and advances the tail cursor for fallback paging', async () => {
        const sessionId = 'direct_session_push_delta';
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: getActiveServerSnapshot().serverId,
        }]);
        emitSessionMetadataUpdateWithServerScopeMock.mockImplementation(async ({ expectedVersion, metadata }: any) => ({
            result: 'success',
            version: Number(expectedVersion ?? 0) + 1,
            metadata,
        }));
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [
                {
                    id: 'direct-msg-1',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                },
            ],
            nextCursor: 'older-cursor-1',
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });
        const firstInvalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: firstInvalidation.binding,
            result: {
                outcome: 'advanced',
                items: [{
                    id: 'direct-msg-2',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'followed direct' } },
                }],
                nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                boundary: '2:direct-msg-2',
            },
        });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'tail-cursor-3',
            truncated: false,
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '1:direct-msg-1',
            observedAtMs: 1,
        });
        const initialIndexItems = Object.values(storage.getState().sessionListIndexByServerId ?? {})
            .flatMap(items => (Array.isArray(items) ? items : []));
        expect(initialIndexItems.some(
            item => item.type === 'session' && item.sessionId === sessionId && (item.storageKind ?? 'persisted') === 'direct',
        )).toBe(true);

        await (sync as any).handleEphemeralUpdate(firstInvalidation);

        expect((storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '2:direct-msg-2',
            observedAtMs: 2,
        });
        const nextIndexItems = Object.values(storage.getState().sessionListIndexByServerId ?? {})
            .flatMap(items => (Array.isArray(items) ? items : []));
        expect(nextIndexItems.some(
            item => item.type === 'session' && item.sessionId === sessionId && (item.storageKind ?? 'persisted') === 'direct',
        )).toBe(true);
        expect(emitSessionMetadataUpdateWithServerScopeMock).not.toHaveBeenCalled();

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['hello direct', 'followed direct']);

        await (sync as any).refreshSessionMessages(sessionId);

        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            cursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
        }), expect.anything());
    });

    it('meets a deterministic 120ms secure-refresh baseline with one bounded read and a stable accepted anchor', async () => {
        const sessionId = 'direct_session_secure_refresh_latency_baseline';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-1',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'accepted anchor' } },
            }],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;
        await (sync as any).fetchMessages(sessionId);
        const readOrderedUserTexts = () => (
            storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? []
        )
            .map((id) => storage.getState().sessionMessages[sessionId]?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);

        vi.useFakeTimers();
        try {
            machineExternalSessionTranscriptRefreshReadAfterMock.mockImplementationOnce(
                async () => await new Promise((resolve) => {
                    setTimeout(() => resolve({
                        v: 1,
                        binding: invalidation.binding,
                        result: {
                            outcome: 'advanced',
                            items: [{
                                id: 'direct-msg-2',
                                createdAtMs: 2,
                                raw: { role: 'user', content: { type: 'text', text: 'eligible live item' } },
                            }],
                            nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                            boundary: '2:direct-msg-2',
                        },
                    }), 120);
                }),
            );

            const startedAtMs = Date.now();
            const refresh = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(invalidation);
            await vi.advanceTimersByTimeAsync(119);
            expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
            expect(readOrderedUserTexts()).toEqual(['accepted anchor']);

            await vi.advanceTimersByTimeAsync(1);
            await refresh;

            expect(Date.now() - startedAtMs).toBe(120);
            expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
            expect(readOrderedUserTexts()).toEqual(['accepted anchor', 'eligible live item']);
            expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
                'happier_external_cursor_v1:Y3Vyc29yLTI',
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('fences a replaced source before rehydrating and atomically replaces only after the new source succeeds', async () => {
        const sessionId = 'direct_session_refresh_replaced_source';
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: getActiveServerSnapshot().serverId,
        }]);
        const replacementSession = createExternalSession(sessionId);
        const replacementMetadata = replacementSession.metadata as NonNullable<Session['metadata']>;
        replacementSession.metadata = {
            ...replacementMetadata,
            externalSessionV1: {
                ...replacementMetadata.externalSessionV1!,
                remoteSessionId: 'vendor-session-2',
                linkedAtMs: 2,
            },
        };
        machineExternalSessionTranscriptPageMock
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'direct-msg-old',
                    createdAtMs: 1,
                    raw: { role: 'user', content: { type: 'text', text: 'accepted old source' } },
                }],
                nextCursor: 'older-cursor-old',
                tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
                hasMore: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                items: [{
                    id: 'direct-msg-new',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'accepted replacement source' } },
                }],
                nextCursor: 'older-cursor-new',
                tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTM',
                hasMore: false,
            });
        machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-old-leak',
                createdAtMs: 2,
                raw: { role: 'user', content: { type: 'text', text: 'must not read old source' } },
            }],
            nextCursor: 'old-tail-cursor-2',
            truncated: false,
        });
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: invalidation.binding,
            result: { outcome: 'source_replaced' },
        });
        let resolveHydration!: (response: Response) => void;
        requestMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
            resolveHydration = resolve;
        }));

        const { sync } = await import('./sync');
        (sync as any).credentials = {
            token: 'active-token',
            secret: encodeBase64(new Uint8Array(32).fill(9), 'base64'),
        };
        (sync as any).encryption = {
            decryptEncryptionKey: vi.fn(async () => null),
            initializeSessions: vi.fn(async () => undefined),
            getSessionEncryption: vi.fn(() => null),
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const sourceReplacement = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(invalidation);
        await vi.waitFor(() => {
            expect(requestMock).toHaveBeenCalledTimes(1);
        });

        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBeNull();
        await (sync as any).fetchMessages(sessionId);
        expect(machineExternalSessionTranscriptReadAfterMock).not.toHaveBeenCalled();
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual({
            kind: 'source_discontinuity',
        });

        resolveHydration(Response.json({
            session: {
                ...replacementSession,
                encryptionMode: 'plain',
                dataEncryptionKey: null,
                metadataLayoutVersion: 0,
                metadata: JSON.stringify(replacementSession.metadata),
                agentState: null,
                share: null,
            },
        }));
        await sourceReplacement;

        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-2',
        }), expect.anything());
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const orderedTexts = (sessionMessages?.messageIdsOldestFirst ?? [])
            .map((id) => sessionMessages?.messagesById[id])
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(orderedTexts).toEqual(['accepted replacement source']);
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:Y3Vyc29yLTM',
        );
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toBeNull();
    });

    it.each([
        ['source_unavailable', { kind: 'read_failed', errorCode: 'agent_unavailable' }],
        ['read_failed', { kind: 'read_failed', errorCode: 'internal_error' }],
    ] as const)('retains the accepted transcript and cursor for a $0 secure-refresh outcome', async (
        outcome,
        expectedIssue,
    ) => {
        const sessionId = `direct_session_refresh_${outcome}`;
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: getActiveServerSnapshot().serverId,
        }]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-1',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'accepted before refresh failure' } },
            }],
            nextCursor: 'older-cursor-1',
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: invalidation.binding,
            result: { outcome },
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = { getSessionEncryption: () => null };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await (sync as any).handleExternalSessionTranscriptEphemeralUpdate(invalidation);

        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        expect(storage.getState().getSessionTranscriptLoadIssue(sessionId)).toEqual(expectedIssue);
        const messages = storage.getState().sessionMessages[sessionId];
        expect(messages?.messageIdsOldestFirst).toHaveLength(1);
        expect(messages?.messagesById[messages.messageIdsOldestFirst[0]!]).toMatchObject({
            text: 'accepted before refresh failure',
        });
    });

    it('applies zero secure-refresh items when a layout-v1 owner link changes in flight', async () => {
        const sessionId = 'direct_session_refresh_relinked_inflight';
        const initial = createExternalSession(sessionId);
        const initialMetadata = initial.metadata as NonNullable<Session['metadata']>;
        initial.metadataLayoutVersion = 1;
        initial.metadata = {
            v: 1,
            summary: {
                text: 'Shared external session',
                updatedAt: 1,
            },
            // Deliberately retain the old private-looking link in the shared
            // payload so this test distinguishes the owner view from a shared
            // metadata continuation guard.
            externalSessionV1: {
                ...initialMetadata.externalSessionV1!,
                linkData: { workspaceRoot: '/workspace/a' },
            },
        } as unknown as Session['metadata'];
        initial.ownerMetadataView = {
            ...initialMetadata,
            externalSessionV1: {
                ...initialMetadata.externalSessionV1!,
                linkData: { workspaceRoot: '/workspace/a' },
            },
        };
        storage.getState().applySessions([initial]);
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [{
                id: 'direct-msg-1',
                createdAtMs: 1,
                raw: { role: 'user', content: { type: 'text', text: 'accepted current row' } },
            }],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
            hasMore: false,
        });
        const invalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        let resolveRefresh!: (value: {
            v: 1;
            binding: ReturnType<typeof createTranscriptInvalidation>['binding'];
            result: {
                outcome: 'advanced';
                items: Array<{
                    id: string;
                    createdAtMs: number;
                    raw: { role: string; content: { type: string; text: string } };
                }>;
                nextCursor: string;
                boundary: string;
            };
        }) => void;
        const refreshResponse = new Promise<Parameters<typeof resolveRefresh>[0]>((resolve) => {
            resolveRefresh = resolve;
        });
        let markRefreshStarted!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
            markRefreshStarted = resolve;
        });
        machineExternalSessionTranscriptRefreshReadAfterMock.mockImplementationOnce(async () => {
            markRefreshStarted();
            return await refreshResponse;
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const refresh = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(invalidation);
        await refreshStarted;

        const current = storage.getState().sessions[sessionId]!;
        const currentOwnerMetadata = current.ownerMetadataView as NonNullable<Session['ownerMetadataView']>;
        storage.setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...current,
                    ownerMetadataView: {
                        ...currentOwnerMetadata,
                        externalSessionV1: {
                            ...currentOwnerMetadata.externalSessionV1!,
                            linkData: { workspaceRoot: '/workspace/b' },
                        },
                    },
                },
            },
        }));
        resolveRefresh({
            v: 1,
            binding: invalidation.binding,
            result: {
                outcome: 'advanced',
                items: [{
                    id: 'direct-msg-stale',
                    createdAtMs: 2,
                    raw: { role: 'user', content: { type: 'text', text: 'stale old source row' } },
                }],
                nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
                boundary: '2:direct-msg-stale',
            },
        });
        await refresh;

        const texts = Object.values(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(texts).toEqual(['accepted current row']);
        expect((sync as any).getExternalSessionTailCursor(sessionId)).toBe(
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
    });

    it('does not synthesize ready notifications from markerless authoritative secure-refresh Agent text', async () => {
        const sessionId = 'direct_session_notify_delta';
        storage.getState().applySessions([{
            ...createExternalSession(sessionId),
            serverId: getActiveServerSnapshot().serverId,
        }]);
        emitSessionMetadataUpdateWithServerScopeMock.mockImplementation(async ({ expectedVersion, metadata }: any) => ({
            result: 'success',
            version: Number(expectedVersion ?? 0) + 1,
            metadata,
        }));
        machineExternalSessionTranscriptPageMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: null,
            tailCursor: 'happier_external_cursor_v1:bm90aWZ5LTE',
            hasMore: false,
        });
        const notificationInvalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:bm90aWZ5LTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: notificationInvalidation.binding,
            result: {
                outcome: 'advanced',
                items: [{
                    id: 'direct-agent-msg-1',
                    createdAtMs: 2,
                    raw: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: { type: 'message', message: 'followed direct reply' },
                        },
                    },
                }],
                nextCursor: 'happier_external_cursor_v1:bm90aWZ5LTI',
                boundary: '2:direct-agent-msg-1',
            },
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        await (sync as any).handleEphemeralUpdate(notificationInvalidation);

        const messagesById = storage.getState().sessionMessages[sessionId]?.messagesById ?? {};
        expect(Object.values(messagesById).some(
            (message) => message.kind === 'agent-text' && message.text === 'followed direct reply',
        )).toBe(true);
        expect((storage.getState().sessions[sessionId]?.metadata as any)?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '2:direct-agent-msg-1',
            observedAtMs: 2,
        });
        expect(notifyActivityReadyMock).not.toHaveBeenCalled();
    });

    it('preserves accepted items while a gap result performs one bounded authoritative refetch', async () => {
        const sessionId = 'direct_session_truncated_delta';
        storage.getState().applySessions([createExternalSession(sessionId)]);
        let resolveRefetchPage!: (value: {
            ok: true;
            items: Array<{
                id: string;
                createdAtMs: number;
                raw: { role: string; content: { type: string; text: string } };
            }>;
            nextCursor: null;
            tailCursor: string;
            hasMore: false;
        }) => void;
        const refetchPage = new Promise<Parameters<typeof resolveRefetchPage>[0]>((resolve) => {
            resolveRefetchPage = resolve;
        });
        machineExternalSessionTranscriptPageMock
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
                tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTE',
                hasMore: false,
            })
            .mockImplementationOnce(async () => await refetchPage);
        const gapInvalidation = createTranscriptInvalidation(
            sessionId,
            'happier_external_cursor_v1:Y3Vyc29yLTE',
        );
        machineExternalSessionTranscriptRefreshReadAfterMock.mockResolvedValueOnce({
            v: 1,
            binding: gapInvalidation.binding,
            result: { outcome: 'gap_or_cursor_expired' },
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
        };
        (sync as any).activeServerSessionIds = new Set<string>([sessionId]);
        (sync as any).hasFetchedSessionsSnapshotForActiveServer = true;

        await (sync as any).fetchMessages(sessionId);
        const refresh = (sync as any).handleExternalSessionTranscriptEphemeralUpdate(gapInvalidation);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const textsWhileRefetching = Object.values(
            storage.getState().sessionMessages[sessionId]?.messagesById ?? {},
        )
            .filter((message): message is NonNullable<typeof message> => Boolean(message))
            .filter((message) => message.kind === 'user-text')
            .map((message) => message.text);
        expect(textsWhileRefetching).toEqual(['hello direct']);

        resolveRefetchPage({
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
            tailCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
            hasMore: false,
        });
        await refresh;

        expect(machineExternalSessionTranscriptRefreshReadAfterMock).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionTranscriptPageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
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

    it('applies transcript-stream-segment ephemerals without crashing when session encryption is available through sync.handleEphemeralUpdate', async () => {
        const sessionId = 'direct_session_ephemeral_segment';
        storage.setState((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: false,
            },
        }));
        storage.getState().applySessions([{ ...createSession(sessionId), encryptionMode: 'plain' } as Session]);
        markSessionSurfaceVisible(sessionId);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            sessionEncryptions: new Map([
                [sessionId, { decryptMessage: vi.fn(async () => null) }],
            ]),
            getSessionEncryption(sessionId: string) {
                return this.sessionEncryptions.get(sessionId) ?? null;
            },
        };

        expect(() => (sync as any).handleEphemeralUpdate({
            type: 'transcript-stream-segment',
            sessionId,
            message: {
                localId: 'segment-1',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'text',
                            text: 'Hello there',
                        },
                        meta: {
                            happierStreamSegmentV1: {
                                v: 1,
                                segmentKind: 'assistant',
                                segmentLocalId: 'segment-1',
                                segmentState: 'streaming',
                                startedAtMs: 1_000,
                                updatedAtMs: 1_025,
                            },
                        },
                    },
                },
                createdAt: 1_000,
                updatedAt: 1_025,
            },
        })).not.toThrow();

        await new Promise((resolve) => setTimeout(resolve, 0));

        const sessionMessages = storage.getState().sessionMessages[sessionId];
        expect(sessionMessages?.messageIdsOldestFirst).toHaveLength(1);
        const appliedMessageId = sessionMessages?.messageIdsOldestFirst[0];
        expect(appliedMessageId).toBeTruthy();
        expect(sessionMessages?.messagesById[appliedMessageId as string]).toMatchObject({
            localId: 'segment-1',
        });
    });
});
