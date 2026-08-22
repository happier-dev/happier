import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';
import { createSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import type { ResumeSessionOptions } from '@/sync/ops/sessions';

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
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
const runtimeFetchWithServerReachabilityMock = vi.hoisted(() => vi.fn());
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

// System-boundary mock: scoped retry behavior is exercised through the real Sync scheduler and
// credential resolver; only the final HTTP transport is replaced so both target servers are deterministic.
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchWithServerReachabilityMock,
}));

const ensureSessionRuntimeForPendingInputMock = vi.hoisted(() => vi.fn(async (_options?: ResumeSessionOptions) => ({ type: 'success' as const })));
vi.mock('@/sync/ops', () => ({
    ensureSessionRuntimeForPendingInput: (...args: Parameters<typeof ensureSessionRuntimeForPendingInputMock>) => ensureSessionRuntimeForPendingInputMock(...args),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    buildWakeResumeExtras: () => ({}),
    getAgentCore: (agentId: string) => ({
        cli: {
            spawnAgent: agentId,
        },
        model: {
            defaultMode: 'default',
            supportsSelection: false,
        },
    }),
    isBundledAgentId: (value: unknown) => typeof value === 'string' && ['claude', 'codex'].includes(value),
    resolveAgentIdFromFlavor: (value: string | null | undefined) =>
        typeof value === 'string' && ['claude', 'codex'].includes(value) ? value : null,
    resolveAgentIdFromSessionMetadata: (metadata: Record<string, unknown> | null | undefined) => {
        const providerId = (metadata?.runtimeDescriptorV1 as { providerId?: unknown } | undefined)?.providerId;
        if (typeof providerId === 'string' && ['claude', 'codex'].includes(providerId)) {
            return providerId;
        }
        const flavor = typeof metadata?.flavor === 'string' ? metadata.flavor : null;
        return typeof flavor === 'string' && ['claude', 'codex'].includes(flavor) ? flavor : null;
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import type { SyncMessageTransport } from './sync';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { HappyError } from '@/utils/errors/errors';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import {
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
} from '@/sync/engine/pending/pendingQueueV2';
import { resolveSessionRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

function releasedServerV021PendingEnqueueResponse(body: BodyInit | null | undefined): Response {
    const parsed = JSON.parse(String(body)) as {
        localId: string;
        content?: unknown;
        ciphertext?: string;
    };
    return Response.json({
        didWrite: true,
        pending: {
            localId: parsed.localId,
            content: parsed.content ?? { t: 'encrypted', c: parsed.ciphertext },
            status: 'queued',
            position: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: 'sync-test-account',
        },
        pendingCount: 1,
        pendingVersion: 1,
    });
}

function createSession(params: { sessionId: string; metadata?: Session['metadata'] }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: params.metadata ?? null,
        metadataVersion: 0,
        agentState: null,
        // Mark as ready to avoid the 10s wait-for-ready timeout.
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function composerAttachmentRawRecord(params: Readonly<{
    text: string;
    instanceId: string;
}>) {
    return {
        role: 'user',
        content: { type: 'text', text: params.text },
        meta: {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: params.instanceId,
                    attachment: { pluginId: 'com.acme.context', localId: 'context' },
                    key: `context-${params.instanceId}`,
                    value: { itemId: '42' },
                    presentation: { label: 'Context #42', typeLabel: 'Plugin context' },
                }],
            },
        },
    } as const;
}

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

function pendingOutboxFixture(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    operation?: 'enqueue' | 'cancel';
}>) {
    const rawRecord = {
        role: 'user' as const,
        content: { type: 'text' as const, text: params.text },
        meta: {},
    };
    return {
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord,
        operation: params.operation,
        request: {
            v: 1 as const,
            body: JSON.stringify({
                localId: params.localId,
                content: { t: 'plain', v: rawRecord },
                messageRole: 'user',
            }),
        },
    };
}

async function flushPendingOutboxRetryMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
    }
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

function createFallbackSafeSessionRpcErrors(): Error[] {
    return [
        new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE),
        new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND),
        new Error('Socket connect timeout'),
        new Error('connect_error: legacy daemon reconnecting'),
    ];
}

function createAuthFailedEndpointSupervisor(): ManagedEndpointSupervisor {
    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: () => ({
            phase: 'auth_failed',
            reason: 'auth_invalid',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'expired token',
            lastProbe: {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            },
        }),
        subscribe: () => vi.fn(),
    };
}

function createAuthProbeEndpointSupervisor(): ManagedEndpointSupervisor {
    let phase: ReturnType<ManagedEndpointSupervisor['getState']>['phase'] = 'online';
    let lastProbe: ReturnType<ManagedEndpointSupervisor['getState']>['lastProbe'] = { status: 'ready' };
    const listeners = new Set<(state: ReturnType<ManagedEndpointSupervisor['getState']>) => void>();
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase,
        reason: phase === 'auth_failed' ? 'auth_invalid' : 'initial_connect',
        attempt: phase === 'auth_failed' ? 2 : 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: phase === 'auth_failed' ? Date.now() : null,
        lastErrorMessage: phase === 'auth_failed' ? 'expired token' : null,
        lastProbe,
    });
    const publish = (): void => {
        const state = readState();
        listeners.forEach((listener) => listener(state));
    };

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(() => {
            phase = 'connecting';
            publish();
            phase = 'auth_failed';
            lastProbe = {
                status: 'auth_failed',
                statusCode: 401,
                errorMessage: 'expired token',
            };
            publish();
        }),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listeners.add(listener);
            listener(readState());
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

function createReadyEndpointSupervisor(): ManagedEndpointSupervisor {
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    });

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listener(readState());
            return vi.fn();
        },
    };
}

function createTransientProbeFailureEndpointSupervisor(): ManagedEndpointSupervisor {
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    });

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(() => {
            throw new Error('Failed to fetch');
        }),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listener(readState());
            return vi.fn();
        },
    };
}

describe('sync.sendMessage optimistic thinking', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        const activeScope = {
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'sync-test-account',
        } as const;
        storage.getState().activateProfileScope(activeScope);
        appStateAddListener.mockClear();
        runtimeFetchWithServerReachabilityMock.mockReset();
        runtimeFetchWithServerReachabilityMock.mockResolvedValue(new Response(null, { status: 200 }));
        ensureSessionRuntimeForPendingInputMock.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('preserves optimistic thinking after a successful ACK/commit (until lifecycle clears)', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = sync.sendMessage(sessionId, 'hello');

        // sendMessage marks optimistic thinking before the first await.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        // ACK means the user message was committed; it does not mean the agent turn is complete.
        // Keep optimistic thinking so the UI can still show "processing" and expose abort controls
        // until we see a terminal lifecycle marker (task_complete / turn_aborted) or the timeout fires.
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_complete',
            id: 'task-1',
            createdAt: 12_345,
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().sessions[sessionId].lastTurnCompletedAt ?? null).toBe(12_345);
    });

    it('notifies local pending projection after the pending row exists', async () => {
        const sessionId = 's_local_pending_projection_callback';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: 'local-visible-id',
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const projectionEvents: Array<Readonly<{ localId: string; pendingIds: readonly string[] }>> = [];

        await sync.sendMessage(sessionId, 'hello', undefined, undefined, {
            localId: 'local-visible-id',
            onLocalPendingProjectionCreated: ({ localId }) => {
                projectionEvents.push({
                    localId,
                    pendingIds: (storage.getState().sessionPending[sessionId]?.messages ?? []).map((message) => message.id),
                });
            },
        });

        expect(projectionEvents).toEqual([{
            localId: 'local-visible-id',
            pendingIds: ['local-visible-id'],
        }]);
    });

    it('hydrates a missing active session before sending the user message', async () => {
        const sessionId = 's_missing_then_hydrated';

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        const ensureSessionVisibleForMessageRouteSpy = vi
            .spyOn(sync as any, 'ensureSessionVisibleForMessageRoute')
            .mockImplementation(async () => {
                storage.getState().applySessions([createSession({ sessionId })]);
                return true;
            });

        await sync.sendMessage(sessionId, 'hello after hydrate');

        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith(sessionId, { forceRefresh: true });
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
            }),
            expect.anything(),
        );
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
    });

    it('prefers session runtime RPC for active sessions so steering-capable agents receive the user message directly', async () => {
        const sessionId = 's_active_runtime_rpc';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await expect(sync.sendMessage(sessionId, 'steer this')).resolves.toEqual({
            localId: expect.any(String),
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                text: 'steer this',
                localId: expect.any(String),
                meta: expect.objectContaining({
                    sentFrom: expect.any(String),
                    permissionMode: 'default',
                }),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((message) => message.text)).toEqual(['steer this']);
        expect(pending.map((message) => message.deliveryStatus)).toEqual(['accepted']);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        sessionRpcSpy.mockRestore();
    });

    it('surfaces a plugin Composer attachment runtime refusal instead of accepting the pending message', async () => {
        const sessionId = 's_composer_attachment_runtime_refusal';
        storage.getState().applySessions([createSession({ sessionId })]);

        // Current ../remote-dev compatibility vector: cdb9408c04d7af35b3947e9fbff27ed0b92663c9
        // (protocol 9aed280c82776cb2a6245f68de817420ae74fa2d, resolver 073c13dc3b9e8fa1dd236227b32a31d18c39a715,
        // Codex turn input bc247a5ba760c83fdce896790fe46e62d81dc1db). Its passthrough input preserves this
        // r1.0 plugin-owned attachment-only field, while its resolver and turn adapter ignore it; an explicit
        // target refusal must therefore be terminal here rather than a false provider acceptance.
        const predecessorAttachmentOnlyInput = {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'plugin-context-1',
                    attachment: { pluginId: 'com.acme.context', localId: 'context' },
                    key: 'context-42',
                    value: { itemId: '42' },
                    presentation: { label: 'Context #42', typeLabel: 'Plugin context' },
                }],
            },
        };

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({
            ok: false,
            error: 'session_user_message_composer_attachments_unavailable',
            errorCode: 'session_user_message_composer_attachments_unavailable',
        } as any);
        const emitWithAck = vi.fn();

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'Use the attached plugin context',
            undefined,
            predecessorAttachmentOnlyInput,
        )).rejects.toMatchObject({
            name: 'HappyError',
            code: 'session_user_message_composer_attachments_unavailable',
        });

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                meta: expect.objectContaining(predecessorAttachmentOnlyInput),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not treat a typed Composer attachment refusal as a legacy transport fallback', async () => {
        const sessionId = 's_composer_attachment_runtime_refusal_no_fallback';
        storage.getState().applySessions([createSession({ sessionId })]);

        const attachmentMeta = {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'plugin-context-2',
                    attachment: { pluginId: 'com.acme.context', localId: 'context' },
                    key: 'context-43',
                    value: { itemId: '43' },
                    presentation: { label: 'Context #43', typeLabel: 'Plugin context' },
                }],
            },
        };

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({
            ok: false,
            error: 'connect_error: composer attachment resolution unavailable',
            errorCode: 'session_user_message_composer_attachments_unavailable',
        } as any);
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'Keep this attachment selected',
            undefined,
            attachmentMeta,
        )).rejects.toMatchObject({
            name: 'HappyError',
            code: 'session_user_message_composer_attachments_unavailable',
        });

        expect(sessionRpcSpy).toHaveBeenCalledOnce();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('fails closed instead of using the raw socket path when the Composer runtime RPC is unavailable', async () => {
        const sessionId = 's_composer_attachment_runtime_rpc_unavailable';
        storage.getState().applySessions([createSession({ sessionId })]);
        const attachmentMeta = {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'plugin-context-rpc-unavailable-1',
                    attachment: { pluginId: 'com.acme.context', localId: 'context' },
                    key: 'context-rpc-unavailable-1',
                    value: { itemId: '42' },
                    presentation: { label: 'Context #42', typeLabel: 'Plugin context' },
                }],
            },
        };
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC')
            .mockRejectedValue(createRpcMethodNotAvailableError());
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'Keep this attachment selected.',
            undefined,
            attachmentMeta,
        )).rejects.toMatchObject({
            name: 'HappyError',
            code: 'session_user_message_composer_attachments_runtime_required',
        });

        expect(sessionRpcSpy).toHaveBeenCalledOnce();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('keeps legacy image input usable when a predecessor-compatible runtime accepts it', async () => {
        const sessionId = 's_legacy_image_input_runtime_acceptance';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { version: '0.2.10' } as any,
        })]);

        const legacyImageInput = {
            happierStructuredInputV1: {
                v: 1,
                imageInputs: [{
                    id: 'legacy-image-1',
                    kind: 'image',
                    url: 'https://example.test/legacy-image.png',
                    mimeType: 'image/png',
                }],
            },
        };
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'Keep the legacy image available',
            undefined,
            legacyImageInput,
        )).resolves.toEqual({
            localId: expect.any(String),
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                meta: expect.objectContaining(legacyImageInput),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it('rejects an explicit blank Pending local id before transport instead of substituting one', async () => {
        const sessionId = 's_blank_execution_authorization_id';
        storage.getState().applySessions([createSession({ sessionId })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck: vi.fn(), send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'invalid explicit retry',
            undefined,
            undefined,
            { localId: ' \t ' },
        )).rejects.toThrow('Pending localId must not be blank');

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        sessionRpcSpy.mockRestore();
    });

    it('preserves whitespace-distinct opaque local ids at the production message writer', async () => {
        const sessionId = 's_opaque_execution_authorization_ids';
        storage.getState().applySessions([createSession({ sessionId })]);
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck: vi.fn(), send: vi.fn() });

        const opaqueLocalIds = [' request-1', 'request-1 '] as const;
        for (const localId of opaqueLocalIds) {
            await sync.sendMessage(sessionId, 'explicit retry', undefined, undefined, { localId });
        }

        const sentLocalIds = sessionRpcSpy.mock.calls.map(([, , request]) => (
            request && typeof request === 'object' && 'localId' in request ? request.localId : undefined
        ));
        expect(sentLocalIds).toEqual(opaqueLocalIds);
        expect(new Set(sentLocalIds)).toHaveLength(2);
        sessionRpcSpy.mockRestore();
    });

    it('keeps a runtime-accepted local pending message when server pending refresh is empty', async () => {
        const sessionId = 's_active_runtime_rpc_pending_refresh';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(
            new Response(JSON.stringify({ pending: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck: vi.fn(),
            send: vi.fn(),
        });

        await expect(sync.sendMessage(
            sessionId,
            'first prompt remains visible',
            undefined,
            undefined,
            { localId: 'first-turn-local' },
        )).resolves.toEqual({
            localId: 'first-turn-local',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            'first-turn-local',
        ]);

        await sync.fetchPendingMessages(sessionId);

        expect(requestSpy).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            { method: 'GET' },
        );
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'first-turn-local',
                localId: 'first-turn-local',
                deliveryStatus: 'accepted',
                text: 'first prompt remains visible',
            }),
        ]);

        sessionRpcSpy.mockRestore();
        requestSpy.mockRestore();
    });

    it('resolves UI projection ids to canonical localIds before reorder transport under collision', async () => {
        const sessionId = 's_reorder_projection_id_collision';
        const firstProjectionId = 'reorder-canonical-local-id';
        const firstLocalId = 'reorder-first-local-id';
        const secondProjectionId = 'reorder-second-synthetic-projection';
        const secondLocalId = firstProjectionId;
        const outboxScope = {
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'sync-test-account',
        } as const;
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: firstProjectionId,
            localId: firstLocalId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'first row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'first row' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: secondProjectionId,
            localId: secondLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'second row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'second row' }, meta: {} },
        });
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const requestSpy = vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
            if (path.endsWith('/reorder')) {
                expect(JSON.parse(String(init?.body))).toEqual({
                    orderedLocalIds: [firstLocalId, secondLocalId],
                });
                return Response.json({});
            }
            return Response.json({ pending: [] });
        });
        const { sync } = await import('./sync');
        sync.encryption = encryption;

        await sync.reorderPendingMessages(sessionId, [firstProjectionId, secondProjectionId]);

        expect(requestSpy).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending/reorder`,
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('replays identical scoped enqueue identities independently through the real Sync scheduler', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 'same-session';
            const localId = 'same-local';
            const serverAUrl = 'https://pending-a.example.test';
            const serverBUrl = 'https://pending-b.example.test';
            const profileA = upsertServerProfile({ serverUrl: serverAUrl, name: 'Pending A' });
            const profileB = upsertServerProfile({ serverUrl: serverBUrl, name: 'Pending B' });
            const scopeA = { serverId: profileA.id, accountId: 'account-a' } as const;
            const scopeB = { serverId: profileB.id, accountId: 'account-b' } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);
            savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'scope A' }), scopeA);
            savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'scope B' }), scopeB);

            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => ({
                token: tokenForSub(serverUrl === serverAUrl ? 'account-a' : 'account-b'),
                secret: Buffer.from(new Uint8Array(32).fill(serverUrl === serverAUrl ? 1 : 2)).toString('base64url'),
            }));
            runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ url, init }: { url: string; init?: RequestInit }) =>
                url.endsWith('/v1/features')
                    ? currentPendingInputFeaturesResponse()
                    : Response.json({
                        pending: { localId: JSON.parse(String(init?.body ?? '{}')).localId },
                        requestedAction: JSON.parse(String(init?.body ?? '{}')).requestedAction
                            ?? { v: 1, kind: 'enqueue' },
                    }));

            const { sync } = await import('./sync');
            await expect(resolveSessionRequestForServerAccountScope({ scope: scopeA, activeRequest: apiSocket.request }))
                .resolves.toEqual(expect.any(Function));
            await expect(resolveSessionRequestForServerAccountScope({ scope: scopeB, activeRequest: apiSocket.request }))
                .resolves.toEqual(expect.any(Function));
            // Replay A, then B, matching the order produced by a reload followed by a server switch.
            for (const replayLocalId of replayPersistedPendingOutboxForSession(sessionId, scopeA)) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeA });
            }
            for (const replayLocalId of replayPersistedPendingOutboxForSession(sessionId, scopeB)) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeB });
            }

            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();

            const posts = runtimeFetchWithServerReachabilityMock.mock.calls
                .map(([request]) => request as { serverUrl: string; init?: RequestInit })
                .filter((request) => request.init?.method === 'POST');
            expect(posts).toHaveLength(2);
            expect(posts.map((request) => request.serverUrl).sort()).toEqual([serverAUrl, serverBUrl].sort());
            expect(posts.map((request) => String(request.init?.body)).sort()).toEqual([
                pendingOutboxFixture({ sessionId, localId, text: 'scope A' }).request.body,
                pendingOutboxFixture({ sessionId, localId, text: 'scope B' }).request.body,
            ].sort());
            expect(loadPendingOutboxForSession(sessionId, scopeA)).toEqual([]);
            expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });


    it('replays identical scoped cancellations independently through the real Sync scheduler', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 'same-cancel-session';
            const localId = 'same-cancel-local';
            const serverAUrl = 'https://cancel-a.example.test';
            const serverBUrl = 'https://cancel-b.example.test';
            const profileA = upsertServerProfile({ serverUrl: serverAUrl, name: 'Cancel A' });
            const profileB = upsertServerProfile({ serverUrl: serverBUrl, name: 'Cancel B' });
            const scopeA = { serverId: profileA.id, accountId: 'cancel-account-a' } as const;
            const scopeB = { serverId: profileB.id, accountId: 'cancel-account-b' } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);
            savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'cancel A', operation: 'cancel' }), scopeA);
            savePendingOutboxMessage(pendingOutboxFixture({ sessionId, localId, text: 'cancel B', operation: 'cancel' }), scopeB);

            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl) => ({
                token: tokenForSub(serverUrl === serverAUrl ? 'cancel-account-a' : 'cancel-account-b'),
                secret: Buffer.from(new Uint8Array(32).fill(serverUrl === serverAUrl ? 3 : 4)).toString('base64url'),
            }));

            const { sync } = await import('./sync');
            await expect(resolveSessionRequestForServerAccountScope({ scope: scopeA, activeRequest: apiSocket.request }))
                .resolves.toEqual(expect.any(Function));
            await expect(resolveSessionRequestForServerAccountScope({ scope: scopeB, activeRequest: apiSocket.request }))
                .resolves.toEqual(expect.any(Function));
            // Replay A, then B, matching the order produced by a reload followed by a server switch.
            for (const replayLocalId of replayPersistedPendingOutboxForSession(sessionId, scopeA)) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeA });
            }
            for (const replayLocalId of replayPersistedPendingOutboxForSession(sessionId, scopeB)) {
                (sync as any).schedulePendingOutboxOperationRetry({ sessionId, localId: replayLocalId, outboxScope: scopeB });
            }

            await vi.advanceTimersByTimeAsync(1_000);
            await flushPendingOutboxRetryMicrotasks();

            const deletes = runtimeFetchWithServerReachabilityMock.mock.calls
                .map(([request]) => request as { serverUrl: string; url: string; init?: RequestInit })
                .filter((request) => request.init?.method === 'DELETE');
            expect(deletes).toHaveLength(2);
            expect(deletes.map((request) => request.serverUrl).sort()).toEqual([serverAUrl, serverBUrl].sort());
            expect(deletes.every((request) => request.url.endsWith(`/v2/sessions/${sessionId}/pending/${localId}`))).toBe(true);
            expect(loadPendingOutboxForSession(sessionId, scopeA)).toEqual([]);
            expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ['enqueue', 'stale_profile'],
        ['cancel', 'stale_profile'],
        ['enqueue', 'cleared_profile'],
        ['cancel', 'cleared_profile'],
    ] as const)(
        'does not let a held scope-A refresh replace the current scope-B durable %s projection during %s transition',
        async (operation, transition) => {
            const sessionId = `held-refresh-${operation}-session`;
            const localId = `held-refresh-${operation}-local`;
            const profileA = upsertServerProfile({ serverUrl: `https://held-${operation}-a.example.test`, name: 'Held A' });
            const profileB = upsertServerProfile({ serverUrl: `https://held-${operation}-b.example.test`, name: 'Held B' });
            const scopeA = { serverId: profileA.id, accountId: `held-${operation}-account-a` } as const;
            const scopeB = { serverId: profileB.id, accountId: `held-${operation}-account-b` } as const;
            storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

            setActiveServerId(profileA.id, { scope: 'tab' });
            storage.getState().activateProfileScope(scopeA);

            let markRefreshStarted!: () => void;
            const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
            let releaseRefresh!: () => void;
            const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
            const request = async () => {
                markRefreshStarted();
                await refreshGate;
                const rawRecord = {
                    role: 'user' as const,
                    content: { type: 'text' as const, text: 'scope A server row' },
                    meta: {},
                };
                return new Response(JSON.stringify({
                    pending: [{
                        localId,
                        content: { t: 'plain', v: rawRecord },
                        status: 'queued',
                        position: 0,
                        createdAt: 100,
                        updatedAt: 100,
                    }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };

            const encryption = await Encryption.create(new Uint8Array(32).fill(5));
            const heldScopeARefresh = fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption,
                request,
                outboxScope: scopeA,
            });
            await refreshStarted;

            setActiveServerId(profileB.id, { scope: 'tab' });
            if (transition === 'cleared_profile') {
                storage.getState().clearProfileScope();
            }
            savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: 'scope B durable row',
                operation,
            }), scopeB);
            expect(replayPersistedPendingOutboxForSession(sessionId, scopeB)).toEqual([localId]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    text: 'scope B durable row',
                    pendingOutboxScope: scopeB,
                    pendingOutboxOperation: operation,
                }),
            ]);

            releaseRefresh();
            await heldScopeARefresh;

            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    text: 'scope B durable row',
                    pendingOutboxScope: scopeB,
                    pendingOutboxOperation: operation,
                }),
            ]);
            expect(loadPendingOutboxForSession(sessionId, scopeB)).toEqual([
                expect.objectContaining({ localId, operation }),
            ]);
        },
    );

    it('resolves the exact owner before preflight when another scope has quarantined custody', async () => {
        const sessionId = 's_pending_action_other_scope_quarantine';
        const localId = 'action-other-scope-quarantine';
        const ownerScope = storage.getState().profileScope!;
        const otherScope = { ...ownerScope, accountId: 'other-quarantined-account' };
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        storage.getState().applySessions([createSession({ sessionId })]);
        savePendingOutboxMessage(pendingOutboxFixture({
            sessionId, localId, text: 'other scope quarantined', operation: 'enqueue',
        }), otherScope);
        const persistenceKey = scopedSessionLocalStateKey('session-pending-outbox-v1', otherScope);
        const persisted = JSON.parse(kvStore.get(persistenceKey)!) as Record<string, Array<Record<string, unknown>>>;
        persisted[sessionId]![0]!.operation = 'future-operation';
        kvStore.set(persistenceKey, JSON.stringify(persisted));
        replayPersistedPendingOutboxForSession(sessionId, otherScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: ownerScope,
            text: 'owner canonical', rawRecord,
        });
        const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(Response.json({ didUpdate: true }));
        const { sync } = await import('./sync');

        await expect((sync as any).updatePendingRequestedAction(
            sessionId,
            localId,
            { v: 1, kind: 'send_now' },
        )).resolves.toBeUndefined();

        expect(request).toHaveBeenCalledTimes(1);
        expect(loadPendingOutboxForSession(sessionId, otherScope)).toEqual([
            expect.objectContaining({ localId, operation: 'quarantined' }),
        ]);
    });

    it('does not overwrite a durable outbox projection through direct send with the same local id', async () => {
        const sessionId = 'durable-direct-send-collision';
        const localId = 'durable-direct-send-local';
        const outboxScope = storage.getState().profileScope!;
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { flavor: 'codex', version: '999.0.0' } as Session['metadata'],
        })]);
        savePendingOutboxMessage(pendingOutboxFixture({
            sessionId,
            localId,
            text: 'durable owner',
        }), outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(4));
        vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as never);

        await expect(sync.sendMessage(
            sessionId,
            'must not overwrite',
            undefined,
            undefined,
            { localId },
        )).rejects.toThrow();

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                text: 'durable owner',
                pendingOutboxScope: outboxScope,
                pendingOutboxOperation: 'enqueue',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toHaveLength(1);
    });

    it('keeps the local pending row when active-session runtime RPC fails from transient connectivity', async () => {
        const sessionId = 's_active_runtime_rpc_transient_connectivity';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(new Error('Failed to fetch'));
        sync.setActiveEndpointSupervisor(createTransientProbeFailureEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        try {
            await expect(sync.sendMessage(
                sessionId,
                'runtime rpc transient offline',
                undefined,
                undefined,
                { localId: 'runtime-rpc-transient-local-id' },
            )).resolves.toEqual({
                localId: 'runtime-rpc-transient-local-id',
                persistence: 'pending',
            });

            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    id: 'runtime-rpc-transient-local-id',
                    localId: 'runtime-rpc-transient-local-id',
                    text: 'runtime rpc transient offline',
                }),
            ]);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:runtime-rpc-transient-local-id`)).toBe(true);
            expect(storage.getState().syncError).toBeNull();
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('keeps active-session runtime RPC timeout as ambiguous pending delivery instead of surfacing a failed send', async () => {
        const sessionId = 's_active_runtime_rpc_ack_timeout';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC')
            .mockRejectedValue(createSocketIoAckTimeoutError());
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-fallback',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;
        const send = vi.fn();
        sync.setMessageTransport({ emitWithAck, send });

        await expect(sync.sendMessage(
            sessionId,
            'runtime rpc provider custody timeout',
            undefined,
            undefined,
            { localId: 'runtime-rpc-timeout-local-id' },
        )).resolves.toEqual({
            localId: 'runtime-rpc-timeout-local-id',
            persistence: 'pending',
        });

        expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'runtime-rpc-timeout-local-id',
                localId: 'runtime-rpc-timeout-local-id',
                deliveryStatus: 'queued',
                sendState: 'unconfirmed',
                text: 'runtime rpc provider custody timeout',
            }),
        ]);
        expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:runtime-rpc-timeout-local-id`)).toBe(false);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        sessionRpcSpy.mockRestore();
    });

    it('records auth syncError when active-session runtime RPC rejects with terminal auth', async () => {
        const sessionId = 's_active_runtime_rpc_auth';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(
            new HappyError('Authentication required', false, {
                kind: 'auth',
                code: 'not_authenticated',
                status: 401,
            }),
        );
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await expect(sync.sendMessage(sessionId, 'auth please')).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });

        sessionRpcSpy.mockRestore();
    });

    it.each(createFallbackSafeSessionRpcErrors())(
        'falls back to the socket commit path when active-session runtime RPC fails with %s',
        async (sessionRpcError) => {
            const sessionId = 's_active_runtime_rpc_fallback';
            storage.getState().applySessions([createSession({
                sessionId,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    flavor: 'codex',
                } as any,
            })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(sessionRpcError);
            const emitWithAck = vi.fn(async () => ({
                ok: true,
                id: 'm-fallback',
                seq: 7,
                localId: null,
                didWrite: true,
            })) as any;

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck,
                send: vi.fn(),
            });

            await sync.sendMessage(sessionId, 'fallback please');

            expect(sessionRpcSpy).toHaveBeenCalledTimes(1);
            expect(emitWithAck).toHaveBeenCalledWith(
                'message',
                expect.objectContaining({
                    sid: sessionId,
                    localId: expect.any(String),
                    messageRole: 'user',
                }),
                expect.anything(),
            );
            expect(ensureSessionRuntimeForPendingInputMock).toHaveBeenCalledWith(expect.objectContaining({
                sessionId,
                initialTranscriptAfterSeq: 6,
            }));

            sessionRpcSpy.mockRestore();
        },
    );

    it.each(createFallbackSafeSessionRpcErrors())(
        'persists selected-direct runtime RPC fallback durably with the same local id when %s',
        async (sessionRpcError) => {
            const sessionId = 's_active_selected_direct_fallback';
            storage.getState().applySessions([createSession({ sessionId })]);
            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(sessionRpcError);
            const emitWithAck = vi.fn(async () => ({ ok: true, id: 'must-not-commit', seq: 7 })) as any;
            const requestSpy = vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) =>
                releasedServerV021PendingEnqueueResponse(init?.body));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck, send: vi.fn() });

            await expect(sync.sendMessage(
                sessionId,
                'durable selected direct',
                undefined,
                undefined,
                { localId: 'selected-direct-local', bypassPendingQueueReason: 'selected_direct' },
            )).resolves.toEqual({ localId: 'selected-direct-local', persistence: 'pending' });
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(requestSpy).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}/pending`,
                expect.objectContaining({ method: 'POST', body: expect.stringContaining('selected-direct-local') }),
            );
        },
    );

    it('removes the optimistic pending message and rethrows auth failures from the socket commit path', async () => {
        const sessionId = 's_socket_auth_failure';
        storage.getState().applySessions([{
            ...createSession({
                sessionId,
                metadata: { version: '0.0.9' } as Session['metadata'],
            }),
            encryptionMode: 'plain',
        } as Session]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const authError = new HappyError('Authentication required', false, {
            kind: 'auth',
            code: 'not_authenticated',
        });
        const emitWithAck: SyncMessageTransport['emitWithAck'] = vi.fn(async () => {
            throw authError;
        });
        const send = vi.fn();

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC');
        sync.setActiveEndpointSupervisor(createReadyEndpointSupervisor());
        sync.setMessageTransport({
            emitWithAck,
            send,
        });

        await expect(sync.sendMessage(sessionId, 'auth please')).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
        });

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
        const retryTimers = (sync as unknown as {
            pendingMessageCommitRetryTimers: Map<string, unknown>;
        }).pendingMessageCommitRetryTimers;
        expect(
            Array.from(retryTimers.keys()).some((key) => key.startsWith(`${sessionId}:`)),
        ).toBe(false);
        expect(storage.getState().syncError).toMatchObject({
            kind: 'auth',
            retryable: false,
            message: 'Authentication required',
        });
        sync.setActiveEndpointSupervisor(null);
    });

    it('removes the local pending row when socket fallback sees an auth-failed endpoint', async () => {
        const sessionId = 's_stale_auth_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setActiveEndpointSupervisor(createAuthFailedEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        try {
            await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('keeps the local pending row and schedules retry when socket fallback auth probe fails transiently', async () => {
        const sessionId = 's_socket_transient_probe_failure';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setActiveEndpointSupervisor(createTransientProbeFailureEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        try {
            await expect(sync.sendMessage(
                sessionId,
                'survive transient offline',
                undefined,
                undefined,
                { localId: 'offline-local-id' },
            )).resolves.toEqual({
                localId: 'offline-local-id',
                persistence: 'pending',
            });

            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    id: 'offline-local-id',
                    localId: 'offline-local-id',
                    text: 'survive transient offline',
                }),
            ]);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:offline-local-id`)).toBe(true);
            expect(storage.getState().syncError).toBeNull();
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('forces endpoint auth convergence before fire-and-forget no-ack fallback', async () => {
        const sessionId = 's_stale_auth_probe_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

        const supervisor = createAuthProbeEndpointSupervisor();
        sync.setActiveEndpointSupervisor(supervisor);

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        try {
            await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('uses the pooled active endpoint supervisor for stale-auth send guards', async () => {
        const sessionId = 's_stale_auth_pooled_endpoint';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { upsertAndActivateServer, getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { acquireEndpointSupervisorForServer, resetEndpointSupervisorPoolForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const previousSnapshot = getActiveServerSnapshot();
        upsertAndActivateServer({ serverUrl: 'https://pooled-auth.test', scope: 'tab' });
        const snapshot = getActiveServerSnapshot();

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ error: 'auth' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const lease = await acquireEndpointSupervisorForServer({
            serverId: snapshot.serverId,
            serverUrl: snapshot.serverUrl,
            tokenOverride: 'stale-token',
        });

        try {
            expect(lease.supervisor.getState().phase).toBe('auth_failed');

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

            const send = vi.fn();
            sync.setMessageTransport({
                emitWithAck: vi.fn(async () => {
                    throw new Error('operation has timed out');
                }),
                send,
            });

            await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            await lease.release({ immediate: true });
            await resetEndpointSupervisorPoolForTests();
            if (previousSnapshot.serverId) {
                setActiveServer({ serverId: previousSnapshot.serverId, scope: 'tab' });
            }
        }
    });

    it('acquires and probes the active endpoint before no-ack fallback when no supervisor exists', async () => {
        const sessionId = 's_stale_auth_acquired_endpoint';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { upsertAndActivateServer, getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { resetEndpointSupervisorPoolForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const previousSnapshot = getActiveServerSnapshot();
        upsertAndActivateServer({ serverUrl: 'https://acquired-auth.test', scope: 'device' });
        await TokenStorage.setCredentials({ token: 'stale-token', secret: 'secret' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ error: 'auth' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        try {
            const { sync } = await import('./sync');
            sync.encryption = encryption;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

            const send = vi.fn();
            sync.setMessageTransport({
                emitWithAck: vi.fn(async () => {
                    throw new Error('operation has timed out');
                }),
                send,
            });

            await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(fetchMock).toHaveBeenCalledWith(
                'https://acquired-auth.test/v1/auth/ping',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer stale-token',
                    }),
                }),
            );
            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            await resetEndpointSupervisorPoolForTests();
            if (previousSnapshot.serverId) {
                setActiveServer({ serverId: previousSnapshot.serverId, scope: 'device' });
            }
        }
    });

    it('uses server reachability auth state before user no-ack fallback restores the draft', async () => {
        const sessionId = 's_stale_auth_reachability_no_ack';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { upsertAndActivateServer, getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { resetEndpointSupervisorPoolForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
        const {
            peekServerReachabilityState,
            reportServerAuthFailed,
            resetServerReachabilitySupervisors,
            startServerReachabilitySupervisor,
        } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');

        const previousSnapshot = getActiveServerSnapshot();
        upsertAndActivateServer({ serverUrl: 'https://reachability-auth.test', scope: 'device' });
        await TokenStorage.setCredentials({ token: 'stale-token', secret: 'secret' });

        const runtimeFetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected reachability probe URL: ${url}`);
        });
        setRuntimeFetch(runtimeFetchMock);

        try {
            await startServerReachabilitySupervisor({
                serverUrl: 'https://reachability-auth.test',
                token: 'stale-token',
            });
            reportServerAuthFailed('https://reachability-auth.test', 401);
            for (let i = 0; i < 10 && peekServerReachabilityState('https://reachability-auth.test')?.phase !== 'auth_failed'; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            expect(peekServerReachabilityState('https://reachability-auth.test')?.phase).toBe('auth_failed');

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());

            const send = vi.fn();
            sync.setMessageTransport({
                emitWithAck: vi.fn(async () => {
                    throw new Error('operation has timed out');
                }),
                send,
            });

            await expect(sync.sendMessage(sessionId, 'stale auth send')).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(runtimeFetchMock.mock.calls.map(([input]) => String(input))).toEqual([
                'https://reachability-auth.test/v1/auth/ping',
            ]);
            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            resetRuntimeFetch();
            await resetServerReachabilitySupervisors();
            await resetEndpointSupervisorPoolForTests();
            if (previousSnapshot.serverId) {
                setActiveServer({ serverId: previousSnapshot.serverId, scope: 'device' });
            }
        }
    });

    it('skips session runtime RPC for older attached CLI versions and uses the legacy socket commit path directly', async () => {
        const sessionId = 's_active_legacy_cli';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.0.9',
            } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-legacy',
            seq: 7,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'legacy please');

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                localId: expect.any(String),
            }),
            expect.anything(),
        );
    });

    it('fails closed for selected Composer attachments when an older attached CLI cannot expose the runtime RPC', async () => {
        const sessionId = 's_active_legacy_cli_composer_attachment';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: {
                version: '0.0.9',
            } as any,
        })]);
        const attachmentMeta = {
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'plugin-context-legacy-cli-1',
                    attachment: { pluginId: 'com.acme.context', localId: 'context' },
                    key: 'context-legacy-cli-1',
                    value: { itemId: '42' },
                    presentation: { label: 'Context #42', typeLabel: 'Plugin context' },
                }],
            },
        };

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendMessage(
            sessionId,
            'Keep this attachment selected.',
            undefined,
            attachmentMeta,
        )).rejects.toMatchObject({
            name: 'HappyError',
            code: 'session_user_message_composer_attachments_runtime_required',
        });

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });


    it('sendPendingMessageNow preserves the pending localId in the outbound payload and does not remove the queued row', async () => {
        const sessionId = 's_pending_send_now';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as any;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        const pendingBefore = (storage.getState().sessionPending[sessionId]?.messages ?? []).map((m) => m.id);
        expect(pendingBefore).toContain('p1');

        const result = await sync.sendPendingMessageNow(sessionId, {
            localId: 'p1',
            createdAt: 111,
            rawRecord,
            text: 'hello',
        });

        expect(result).toEqual({ type: 'committed', persistence: 'transcript_committed' });

        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                localId: 'p1',
                messageRole: 'user',
            }),
            expect.anything(),
        );

        // No duplicate pending row should be created (localId is preserved).
        const pendingAfter = (storage.getState().sessionPending[sessionId]?.messages ?? []).map((m) => m.id);
        expect(pendingAfter.every((id) => id === 'p1')).toBe(true);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_complete',
            id: 'task-1',
            createdAt: Date.now(),
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('replays a selected Composer attachment pending row through the canonical runtime RPC', async () => {
        const sessionId = 's_pending_composer_attachment_runtime_rpc';
        const localId = 'pending-composer-runtime-rpc';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const rawRecord = composerAttachmentRawRecord({
            text: 'Use the selected Composer attachment.',
            instanceId: 'pending-composer-runtime-rpc-1',
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            text: rawRecord.content.text,
            rawRecord,
        });

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: 111,
            rawRecord,
            text: rawRecord.content.text,
        })).resolves.toEqual({
            type: 'committed',
            persistence: 'provider_direct',
            providerAcceptancePending: true,
        });

        expect(sessionRpcSpy).toHaveBeenCalledWith(
            sessionId,
            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
            expect.objectContaining({
                localId,
                meta: expect.objectContaining(rawRecord.meta),
            }),
            { timeoutMs: 7_500 },
        );
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                createdAt: 111,
                rawRecord,
                deliveryStatus: 'accepted',
            }),
        ]);
    });

    it('keeps a selected Composer attachment pending when its runtime RPC is unavailable', async () => {
        const sessionId = 's_pending_composer_attachment_runtime_unavailable';
        const localId = 'pending-composer-runtime-unavailable';
        storage.getState().applySessions([createSession({
            sessionId,
            metadata: { version: '0.0.9' } as any,
        })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));
        const rawRecord = composerAttachmentRawRecord({
            text: 'Keep this selected Composer attachment.',
            instanceId: 'pending-composer-runtime-unavailable-1',
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 111,
            updatedAt: 111,
            text: rawRecord.content.text,
            rawRecord,
        });

        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC');
        const emitWithAck = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({ emitWithAck, send: vi.fn() });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: 111,
            rawRecord,
            text: rawRecord.content.text,
        })).rejects.toMatchObject({
            name: 'HappyError',
            code: 'session_user_message_composer_attachments_runtime_required',
        });

        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, createdAt: 111, rawRecord }),
        ]);
    });

    it('sendPendingMessageNow removes the pending row when the server rejects the message', async () => {
        const sessionId = 's_pending_rejected';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-reject',
            localId: 'p-reject',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: false,
            error: 'rejected',
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId: 'p-reject',
            createdAt: 111,
            rawRecord,
            text: 'hello',
        })).rejects.toThrow('rejected');

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sendPendingMessageNow removes the pending row when the active endpoint is auth-failed', async () => {
        const sessionId = 's_pending_send_now_auth_failed';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-auth-failed',
            localId: 'p-auth-failed',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setActiveEndpointSupervisor(createAuthFailedEndpointSupervisor());

        const send = vi.fn();
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send,
        });

        try {
            await expect(sync.sendPendingMessageNow(sessionId, {
                localId: 'p-auth-failed',
                createdAt: 111,
                rawRecord,
                text: 'hello',
            })).rejects.toMatchObject({
                name: 'HappyError',
                canTryAgain: false,
                kind: 'auth',
                code: 'not_authenticated',
            });

            expect(send).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('keeps and retries a server-pending enqueue when the pending POST fails from transient connectivity', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_server_pending_enqueue_transient_retry';
            storage.getState().applySettingsLocal({ sessionMessageSendMode: 'server_pending' as any });
            storage.getState().applySessions([{
                ...createSession({
                    sessionId,
                    metadata: {
                        flavor: 'codex',
                        version: '999.0.0',
                    } as any,
                }),
                pendingVersion: 2,
            }]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const requestSpy = vi.spyOn(apiSocket, 'request')
                .mockRejectedValueOnce(new TypeError('Failed to fetch'))
                .mockResolvedValueOnce(new Response(null, { status: 200 }));
            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
                token: tokenForSub('sync-test-account'),
                secret: Buffer.from(new Uint8Array(32).fill(6)).toString('base64url'),
            });
            runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ url, init }: { url: string; init: RequestInit }) => {
                if (url.endsWith('/v1/features')) return currentPendingInputFeaturesResponse();
                return releasedServerV021PendingEnqueueResponse(init.body);
            });

            const { sync } = await import('./sync');
            sync.encryption = encryption;

            await expect(sync.submitMessage(sessionId, 'queue through server pending')).resolves.toBeUndefined();

            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(requestSpy).toHaveBeenCalledWith(
                `/v2/sessions/${sessionId}/pending`,
                expect.objectContaining({ method: 'POST' }),
            );

            const pendingBeforeRetry = storage.getState().sessionPending[sessionId]?.messages ?? [];
            expect(pendingBeforeRetry).toEqual([
                expect.objectContaining({
                    source: 'local_outbound',
                    deliveryStatus: 'queued',
                    text: 'queue through server pending',
                }),
            ]);
            const localId = pendingBeforeRetry[0]?.localId ?? pendingBeforeRetry[0]?.id;
            expect(typeof localId).toBe('string');
            expect((sync as any).pendingOutboxOperationRetryTimers.size).toBe(1);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(requestSpy).toHaveBeenCalledTimes(1);
            expect(runtimeFetchWithServerReachabilityMock).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
                init: expect.objectContaining({ method: 'POST' }),
            }));
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    source: 'local_outbound',
                    deliveryStatus: 'accepted',
                    text: 'queue through server pending',
                }),
            ]);
            expect((sync as any).pendingOutboxOperationRetryTimers.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('removes only the retried local pending row when retry discovers terminal auth', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_retry_auth';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const retryRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            } as const;
            const persistedRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'keep me' },
                meta: {},
            } as const;

            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-retry-auth',
                localId: 'p-retry-auth',
                createdAt: 111,
                updatedAt: 111,
                text: 'retry me',
                rawRecord: retryRawRecord,
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-persisted',
                localId: 'p-persisted',
                createdAt: 222,
                updatedAt: 222,
                text: 'keep me',
                rawRecord: persistedRawRecord,
            });

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new HappyError('Authentication required', false, {
                    kind: 'auth',
                    code: 'not_authenticated',
                    status: 401,
                }));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendPendingMessageNow(sessionId, {
                localId: 'p-retry-auth',
                createdAt: 111,
                rawRecord: retryRawRecord,
                text: 'retry me',
            });
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(emitWithAck.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
                localId: 'p-retry-auth',
                messageRole: 'user',
            }));
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry-auth`)).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual(['p-persisted']);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('forces endpoint auth convergence before retrying a pending local row again', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_retry_auth_probe';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            const retryRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'retry me' },
                meta: {},
            } as const;
            const persistedRawRecord = {
                role: 'user',
                content: { type: 'text', text: 'keep me' },
                meta: {},
            } as const;

            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-retry-auth-probe',
                localId: 'p-retry-auth-probe',
                createdAt: 111,
                updatedAt: 111,
                text: 'retry me',
                rawRecord: retryRawRecord,
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: 'p-persisted',
                localId: 'p-persisted',
                createdAt: 222,
                updatedAt: 222,
                text: 'keep me',
                rawRecord: persistedRawRecord,
            });

            const initialSupervisor = createReadyEndpointSupervisor();
            const supervisor = createAuthProbeEndpointSupervisor();
            const endpointSupervisorPool = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
            vi.spyOn(endpointSupervisorPool, 'getEndpointSupervisorForServer')
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValueOnce(initialSupervisor)
                .mockReturnValue(supervisor);

            const emitWithAck = vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('operation has timed out'));

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({
                emitWithAck: emitWithAck as any,
                send: vi.fn(),
            });

            await sync.sendPendingMessageNow(sessionId, {
                localId: 'p-retry-auth-probe',
                createdAt: 111,
                rawRecord: retryRawRecord,
                text: 'retry me',
            });
            storage.getState().markSessionOptimisticThinking(sessionId);

            await vi.advanceTimersByTimeAsync(1_000);
            await Promise.resolve();

            expect(emitWithAck).toHaveBeenCalledTimes(2);
            expect(supervisor.invalidate).toHaveBeenCalledTimes(1);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry-auth-probe`)).toBe(false);
            expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual(['p-persisted']);
            expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
            expect(storage.getState().syncError).toMatchObject({
                kind: 'auth',
                retryable: false,
                message: 'Authentication required',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('sendPendingMessageNow schedules a retry when the transport produces no ack', async () => {
        const sessionId = 's_pending_retry';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-retry',
            localId: 'p-retry',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => null) as any,
            send: vi.fn(),
        });

        const result = await sync.sendPendingMessageNow(sessionId, {
            localId: 'p-retry',
            createdAt: 111,
            rawRecord,
            text: 'hello',
        });

        expect(result).toEqual({ type: 'retry_scheduled' });
        expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry`)).toBe(true);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sendPendingMessageNow keeps the row and schedules retry when fallback auth probe fails transiently', async () => {
        const sessionId = 's_pending_retry_transient_probe_failure';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'retry after transient offline' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-transient',
            localId: 'p-transient',
            createdAt: 111,
            updatedAt: 111,
            text: 'retry after transient offline',
            rawRecord,
        });

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setActiveEndpointSupervisor(createTransientProbeFailureEndpointSupervisor());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => {
                throw new Error('operation has timed out');
            }),
            send: vi.fn(),
        });

        try {
            await expect(sync.sendPendingMessageNow(sessionId, {
                localId: 'p-transient',
                createdAt: 111,
                rawRecord,
                text: 'retry after transient offline',
            })).resolves.toEqual({ type: 'retry_scheduled' });

            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    id: 'p-transient',
                    localId: 'p-transient',
                    text: 'retry after transient offline',
                }),
            ]);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-transient`)).toBe(true);
            expect(storage.getState().syncError).toBeNull();
        } finally {
            sync.setActiveEndpointSupervisor(null);
        }
    });

    it('sendPendingMessageNow wakes inactive sessions from the committed pending row cursor', async () => {
        const sessionId = 's_pending_send_now_inactive_wake';
        storage.getState().applySessions([{
            ...createSession({
                sessionId,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    flavor: 'codex',
                } as any,
            }),
            active: false,
            presence: 'online',
        }]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'wake from pending' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-wake',
            localId: 'p-wake',
            createdAt: 111,
            updatedAt: 111,
            text: 'wake from pending',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-wake',
            seq: 42,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendPendingMessageNow(sessionId, {
            localId: 'p-wake',
            createdAt: 111,
            rawRecord,
            text: 'wake from pending',
        });

        expect(ensureSessionRuntimeForPendingInputMock).toHaveBeenCalledTimes(1);
        expect(ensureSessionRuntimeForPendingInputMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId,
            machineId: 'm1',
            directory: '/repo',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            initialTranscriptAfterSeq: 41,
        }));
    });

    it.each([
        {
            caseName: 'Steer-now with no reachable resume target',
            deliveryIntent: 'steer_now' as const,
            metadata: {
                host: 'test-host',
                path: '/repo',
                flavor: 'claude',
                claudeSessionId: '',
                forkV1: {
                    v: 1,
                    parentSessionId: 'parent-session',
                    parentCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    strategy: 'replay',
                    agentHint: { agentId: 'claude' },
                },
                replaySeedV1: {
                    v: 1,
                    seedText: '',
                    sourceSessionId: 'parent-session',
                    sourceCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    appliedToLocalId: 'local-1',
                    appliedAtMs: 2000,
                },
            } satisfies NonNullable<Session['metadata']>,
        },
        {
            caseName: 'Send-now with a denied reachable resume target',
            deliveryIntent: 'interrupt_and_send' as const,
            metadata: {
                machineId: 'm1',
                host: 'test-host',
                path: '/repo',
                flavor: 'codex',
            } satisfies NonNullable<Session['metadata']>,
        },
    ])('preserves an inactive selected row and FIFO when $caseName', async ({ deliveryIntent, metadata }) => {
        const sessionId = `s_inactive_selected_${deliveryIntent}`;
        storage.getState().applySessions([{
            ...createSession({ sessionId, metadata }),
            active: false,
            presence: 'online',
            encryptionMode: 'plain',
        }]);

        const queuedRows = [
            { id: 'head', text: 'first command', createdAt: 100 },
            { id: 'target', text: 'selected command', createdAt: 200 },
            { id: 'tail', text: 'last command', createdAt: 300 },
        ].map((row) => ({
            ...row,
            localId: row.id,
            updatedAt: row.createdAt,
            rawRecord: {
                role: 'user' as const,
                content: { type: 'text' as const, text: row.text },
                meta: {},
            },
        }));
        for (const row of queuedRows) {
            storage.getState().upsertPendingMessage(sessionId, row);
        }

        const emitWithAck = vi.fn();
        const transportSend = vi.fn();
        const { sync } = await import('./sync');
        sync.encryption = {
            getMachineEncryption: () => null,
        } as unknown as Encryption;
        sync.setMessageTransport({ emitWithAck, send: transportSend });

        const removePendingMessageSpy = vi.spyOn(storage.getState(), 'removePendingMessage');
        const deletePendingMessageSpy = vi.spyOn(sync, 'deletePendingMessage');
        const discardPendingMessageSpy = vi.spyOn(sync, 'discardPendingMessage');
        const reorderPendingMessagesSpy = vi.spyOn(sync, 'reorderPendingMessages');
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response(null, { status: 200 }));
        const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC');

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId: 'target',
            createdAt: 200,
            rawRecord: queuedRows[1]!.rawRecord,
            text: 'selected command',
            deliveryIntent,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'config',
            code: 'SESSION_NOT_RESUMABLE',
        });

        expect((storage.getState().sessionPending[sessionId]?.messages ?? []).map((row) => ({
            id: row.id,
            localId: row.localId,
            text: row.text,
            rawRecord: row.rawRecord,
        }))).toEqual(queuedRows.map((row) => ({
            id: row.id,
            localId: row.localId,
            text: row.text,
            rawRecord: row.rawRecord,
        })));
        expect(removePendingMessageSpy).not.toHaveBeenCalled();
        expect(deletePendingMessageSpy).not.toHaveBeenCalled();
        expect(discardPendingMessageSpy).not.toHaveBeenCalled();
        expect(reorderPendingMessagesSpy).not.toHaveBeenCalled();
        expect(requestSpy).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending/target/action`,
            expect.objectContaining({ method: 'PATCH' }),
        );
        expect(sessionRpcSpy).not.toHaveBeenCalled();
        expect(ensureSessionRuntimeForPendingInputMock).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(transportSend).not.toHaveBeenCalled();
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('refreshes the exact pending session and surfaces an actionable error when an action loses its mutation race', async () => {
        const sessionId = 's_pending_action_conflict';
        const localId = 'pending-action-conflict-local';
        const outboxScope = storage.getState().profileScope!;
        const pending = pendingOutboxFixture({ sessionId, localId, text: 'steer me now' });
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        savePendingOutboxMessage(pending, outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const requests: Array<{ path: string; method: string }> = [];
        vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
            requests.push({ path, method: init?.method ?? 'GET' });
            if (init?.method === 'PATCH') {
                return Response.json({ error: 'action-conflict' }, { status: 409 });
            }
            return Response.json({ pending: [], discarded: [] });
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: pending.createdAt,
            rawRecord: pending.rawRecord,
            text: pending.text,
            deliveryIntent: 'steer_now',
        })).rejects.toMatchObject({
            code: 'action-conflict',
            message: expect.stringContaining('changed'),
        });

        expect(requests).toEqual([
            { path: `/v2/sessions/${sessionId}/pending/${localId}/action`, method: 'PATCH' },
            { path: `/v2/sessions/${sessionId}/pending?includeDiscarded=1`, method: 'GET' },
        ]);
    });

    it('normalizes an omitted pending delivery intent onto the canonical durable action path', async () => {
        const sessionId = 's_pending_default_action';
        const localId = 'pending-default-action-local';
        const outboxScope = storage.getState().profileScope!;
        const pending = pendingOutboxFixture({ sessionId, localId, text: 'send this now' });
        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            encryptionMode: 'plain',
        }]);
        savePendingOutboxMessage(pending, outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);

        const { sync } = await import('./sync');
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const requests: Array<{ path: string; method: string }> = [];
        vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
            requests.push({ path, method: init?.method ?? 'GET' });
            return Response.json({ didUpdate: true });
        });

        await expect(sync.sendPendingMessageNow(sessionId, {
            localId,
            createdAt: pending.createdAt,
            rawRecord: pending.rawRecord,
            text: pending.text,
        })).resolves.toMatchObject({ type: 'retry_scheduled' });

        expect(requests).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/${localId}/action`,
            method: 'PATCH',
        });
    });

    it('commits pending retry messages for plaintext sessions without requiring session encryption', async () => {
        vi.useFakeTimers();
        const sessionId = 's_plain_pending_retry';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const encryption = {
            getSessionEncryption: () => null,
        } as unknown as Encryption;

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-retry',
            localId: 'p-retry',
            createdAt: 111,
            updatedAt: 111,
            text: 'hello',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption as any;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        (sync as any).schedulePendingMessageCommitRetry({ sessionId, localId: 'p-retry' });
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.runAllTimersAsync();

        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                localId: 'p-retry',
                sentFrom: 'retry',
                messageRole: 'user',
            }),
            expect.anything(),
        );
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        vi.useRealTimers();
    });

    it('replays a selected Composer attachment retry through the canonical runtime RPC', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_composer_attachment_retry_runtime_rpc';
            const localId = 'pending-composer-retry-runtime-rpc';
            storage.getState().applySessions([createSession({ sessionId })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));
            const rawRecord = composerAttachmentRawRecord({
                text: 'Retry with this selected Composer attachment.',
                instanceId: 'pending-composer-retry-runtime-rpc-1',
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId,
                createdAt: 111,
                updatedAt: 111,
                text: rawRecord.content.text,
                rawRecord,
            });

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockResolvedValue({ ok: true } as any);
            const emitWithAck = vi.fn();
            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck, send: vi.fn() });

            (sync as any).schedulePendingMessageCommitRetry({ sessionId, localId });
            await vi.advanceTimersByTimeAsync(1_000);

            expect(sessionRpcSpy).toHaveBeenCalledWith(
                sessionId,
                SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
                expect.objectContaining({
                    localId,
                    meta: expect.objectContaining(rawRecord.meta),
                }),
                { timeoutMs: 7_500 },
            );
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    createdAt: 111,
                    rawRecord,
                    deliveryStatus: 'accepted',
                }),
            ]);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:${localId}`)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a selected Composer attachment retry pending when the runtime RPC is unavailable', async () => {
        vi.useFakeTimers();
        try {
            const sessionId = 's_pending_composer_attachment_retry_runtime_unavailable';
            const localId = 'pending-composer-retry-runtime-unavailable';
            storage.getState().applySessions([createSession({
                sessionId,
                metadata: { version: '0.0.9' } as any,
            })]);

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));
            const rawRecord = composerAttachmentRawRecord({
                text: 'Keep this retry selected Composer attachment.',
                instanceId: 'pending-composer-retry-runtime-unavailable-1',
            });
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId,
                createdAt: 111,
                updatedAt: 111,
                text: rawRecord.content.text,
                rawRecord,
            });

            const sessionRpcSpy = vi.spyOn(apiSocket, 'sessionRPC');
            const emitWithAck = vi.fn();
            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck, send: vi.fn() });

            (sync as any).schedulePendingMessageCommitRetry({ sessionId, localId });
            await vi.advanceTimersByTimeAsync(1_000);

            expect(sessionRpcSpy).not.toHaveBeenCalled();
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({ localId, createdAt: 111, rawRecord }),
            ]);
            expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:${localId}`)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops pending retry for inactive replay forks that cannot resume before socket emit', async () => {
        vi.useFakeTimers();
        const sessionId = 's_plain_pending_retry_consumed_replay';
        storage.getState().applySessions([{
            ...createSession({
                sessionId,
                metadata: {
                    flavor: 'claude',
                    claudeSessionId: '',
                    forkV1: {
                        v: 1,
                        parentSessionId: 'parent-session',
                        parentCutoffSeqInclusive: 7,
                        createdAtMs: 1000,
                        strategy: 'replay',
                        providerHint: { providerId: 'claude' },
                    },
                    replaySeedV1: {
                        v: 1,
                        seedText: '',
                        sourceSessionId: 'parent-session',
                        sourceCutoffSeqInclusive: 7,
                        createdAtMs: 1000,
                        appliedToLocalId: 'local-1',
                        appliedAtMs: 2000,
                    },
                } as any,
            }),
            active: false,
            presence: 'online',
            encryptionMode: 'plain',
        } as any]);

        const rawRecord = {
            role: 'user',
            content: { type: 'text', text: 'do not retry' },
            meta: {},
        } as const;

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p-retry-blocked',
            localId: 'p-retry-blocked',
            createdAt: 111,
            updatedAt: 111,
            text: 'do not retry',
            rawRecord,
        });

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm-blocked',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = { getSessionEncryption: () => null } as unknown as Encryption;
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        (sync as any).schedulePendingMessageCommitRetry({ sessionId, localId: 'p-retry-blocked' });
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.runAllTimersAsync();

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect((sync as any).pendingMessageCommitRetryTimers.has(`${sessionId}:p-retry-blocked`)).toBe(false);
        vi.useRealTimers();
    });

    it('sends plaintext message envelopes when session encryptionMode is plain', async () => {
        const sessionId = 's_plain_send';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const encryptRawRecord = vi.fn(async () => {
            throw new Error('encryptRawRecord should not be called')
        })
        const encryption = {
            getSessionEncryption: () => ({ encryptRawRecord }),
        } as unknown as Encryption;

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = encryption as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(encryptRawRecord).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: sessionId,
                message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
            expect.anything(),
        );
    });

    it('includes metaOverrides (e.g. meta.happier) in the outbound rawRecord meta', async () => {
        const sessionId = 's_meta_overrides';
        storage.getState().applySessions([createSession({ sessionId })]);

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello', 'Review comments (0)', {
            happier: { kind: 'review_comments.v1', payload: { sessionId, comments: [] } },
        } as any);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(0);
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const transcriptIds = sessionMessages?.messageIdsOldestFirst ?? [];
        const transcript = sessionMessages
            ? transcriptIds.map((id) => sessionMessages.messagesById[id]).filter(Boolean)
            : [];
        const user = transcript.find((m) => m.kind === 'user-text') as any;
        expect(user?.meta?.happier?.kind).toBe('review_comments.v1');
        expect(user?.seq).toBe(1);
    });

    it('does not materialize appendSystemPrompt in first-turn message metadata', async () => {
        const sessionId = 's_profile_override';
        storage.getState().applySessions([{ ...createSession({ sessionId }), encryptionMode: 'plain' }]);

        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 1,
            localId: null,
            didWrite: true,
        })) as any;

        const { sync } = await import('./sync');
        sync.encryption = {
            getSessionEncryption: () => null,
        } as any;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck,
            send: vi.fn(),
        });

        await sync.sendMessage(
            sessionId,
            'hello',
            undefined,
            undefined,
            { profileId: 'profile-test' },
        );

        const payload = emitWithAck.mock.calls[0]?.[1];
        expect(payload?.message?.t).toBe('plain');
        expect(Object.prototype.hasOwnProperty.call(payload?.message?.v?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('clears optimistic thinking when a turn is aborted even if session.thinking is already false', async () => {
        const sessionId = 's_turn_aborted';
        storage.getState().applySessions([createSession({ sessionId })]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'task-abort-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('keeps running approved tools active when a turn is aborted without tool error proof', async () => {
        const sessionId = 's_turn_aborted_tools';
        const now = Date.now();

        storage.getState().applySessions([{
            ...createSession({ sessionId }),
            agentState: {
                completedRequests: {
                    'tool-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 5' },
                        createdAt: now - 5_000,
                        completedAt: now - 4_000,
                        status: 'approved',
                    },
                },
            },
        } as any]);

        storage.getState().applyMessagesLoaded(sessionId);
        storage.getState().applyMessages(sessionId, [{
            id: 'm-tool-call',
            localId: null,
            createdAt: now - 3_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'sleep 5' },
                description: null,
                uuid: 'tool-uuid-1',
                parentUUID: null,
            }],
        } as any]);

        const beforeAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const beforeAbortIds = beforeAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const beforeAbortMessages = beforeAbortIds.map((id) => beforeAbortSessionMessages.messagesById[id]).filter(Boolean);
        const beforeAbort = beforeAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!beforeAbort || beforeAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message before abort');
        }
        expect(beforeAbort.tool.state).toBe('running');

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'turn_aborted',
            id: 'tool-1',
            createdAt: Date.now(),
        });

        const afterAbortSessionMessages = storage.getState().sessionMessages[sessionId];
        const afterAbortIds = afterAbortSessionMessages?.messageIdsOldestFirst ?? [];
        const afterAbortMessages = afterAbortIds.map((id) => afterAbortSessionMessages.messagesById[id]).filter(Boolean);
        const afterAbort = afterAbortMessages.find(
            (message) => message.kind === 'tool-call' && message.tool.permission?.id === 'tool-1'
        );
        if (!afterAbort || afterAbort.kind !== 'tool-call') {
            throw new Error('Expected tool-call message after abort');
        }
        expect(afterAbort.tool.state).toBe('running');
        expect(afterAbort.tool.permission?.status).toBe('approved');
        expect(afterAbort.tool.result).toBeUndefined();
        expect(afterAbort.tool.completedAt).toBeNull();
    });

    it('does not force running state from fetched task_started lifecycle events', async () => {
        const sessionId = 's_task_started_fetch';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                latestTurnStatus: 'completed',
            },
        ]);

        const { sync } = await import('./sync');
        await (sync as any).applySessionThinkingFromTaskLifecycle(sessionId, {
            type: 'task_started',
            id: 'task-start-1',
            createdAt: Date.now(),
        });

        expect(storage.getState().sessions[sessionId].thinking).toBe(false);
        expect(storage.getState().sessions[sessionId].latestTurnStatus).toBe('completed');
    });

    it('publishes session metadata after send when apply timing is next_prompt and local permission selection is newer', async () => {
        const sessionId = 's_perm_next_prompt';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { permissionMode: 'default', permissionModeUpdatedAt: 1 } as any,
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });
        storage.getState().updateSessionPermissionMode(sessionId, 'yolo' as any);

        const localUpdatedAt = storage.getState().sessions[sessionId].permissionModeUpdatedAt;
        expect(typeof localUpdatedAt).toBe('number');

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.fn(async () => {});
        (sync as any).publishSessionPermissionModeToMetadata = publish;

        await sync.sendMessage(sessionId, 'hello');

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith({
            sessionId,
            permissionMode: 'yolo',
            permissionModeUpdatedAt: localUpdatedAt,
        });
    });

    it.each([
        ['real local id', 'steer_now'],
        ['synthetic display id', undefined],
    ] as const)(
        'sendPendingMessageNow rejects quarantined custody addressed by %s before any submit transport',
        async (identifierKind, deliveryIntent) => {
            const sessionId = `s_pending_quarantine_${identifierKind.replaceAll(' ', '_')}`;
            const localId = 'quarantined-send-now';
            const outboxScope = storage.getState().profileScope!;
            const rawRecord = {
                role: 'user' as const,
                content: { type: 'text' as const, text: 'quarantined' },
                meta: {},
            };
            storage.getState().applySessions([createSession({ sessionId })]);
            savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: 'quarantined',
            }), outboxScope);
            const persistenceKey = scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope);
            const persisted = JSON.parse(kvStore.get(persistenceKey)!) as Record<string, Array<Record<string, unknown>>>;
            persisted[sessionId]![0]!.operation = 'future-operation';
            kvStore.set(persistenceKey, JSON.stringify(persisted));
            expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
            const projection = storage.getState().sessionPending[sessionId]?.messages[0]!;
            const addressedId = identifierKind === 'real local id' ? localId : projection.id;

            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));
            const emitWithAck = vi.fn();
            const send = vi.fn();
            const sessionRpc = vi.spyOn(apiSocket, 'sessionRPC');
            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck, send });

            await expect(sync.sendPendingMessageNow(sessionId, {
                localId: addressedId,
                createdAt: 111,
                rawRecord,
                text: 'quarantined',
                ...(deliveryIntent ? { deliveryIntent } : {}),
            })).rejects.toThrow('Persisted pending outbox row is quarantined');

            expect(sessionRpc).not.toHaveBeenCalled();
            expect(emitWithAck).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
            expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
                expect.objectContaining({ localId, operation: 'quarantined' }),
            ]);
        },
    );

    it('updatePendingRequestedAction rejects quarantined custody addressed by canonical localId before PATCH', async () => {
            const sessionId = 's_pending_action_quarantine_canonical_local_id';
            const localId = 'quarantined-action';
            const outboxScope = storage.getState().profileScope!;
            storage.getState().applySessions([createSession({ sessionId })]);
            savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: 'quarantined action',
            }), outboxScope);
            const persistenceKey = scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope);
            const persisted = JSON.parse(kvStore.get(persistenceKey)!) as Record<string, Array<Record<string, unknown>>>;
            persisted[sessionId]![0]!.operation = 'future-operation';
            kvStore.set(persistenceKey, JSON.stringify(persisted));
            replayPersistedPendingOutboxForSession(sessionId, outboxScope);
            const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response(null, { status: 204 }));
            const { sync } = await import('./sync');

            await expect((sync as any).updatePendingRequestedAction(
                sessionId,
                localId,
                { v: 1, kind: 'send_now' },
            )).rejects.toThrow('Persisted pending outbox row is quarantined');

            expect(request).not.toHaveBeenCalled();
            expect(runtimeFetchWithServerReachabilityMock).not.toHaveBeenCalled();
    });

    it.each([
        { didUpdate: true, operation: 'enqueue', shouldRetain: false },
        { didUpdate: true, operation: 'cancel', shouldRetain: true },
        { didUpdate: false, operation: 'enqueue', shouldRetain: false },
    ] as const)(
        'an action PATCH with didUpdate=$didUpdate handles same-scope $operation custody without touching another scope',
        async ({ didUpdate, operation, shouldRetain }) => {
            const sessionId = `s_pending_action_custody_${operation}_${didUpdate}`;
            const localId = `action-custody-${operation}-${didUpdate}`;
            const outboxScope = storage.getState().profileScope!;
            const otherScope = { ...outboxScope, accountId: 'other-account' };
            storage.getState().applySessions([createSession({ sessionId })]);
            savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: `${operation} custody`,
                operation,
            }), outboxScope);
            savePendingOutboxMessage(pendingOutboxFixture({
                sessionId,
                localId,
                text: 'other scope custody',
                operation: 'enqueue',
            }), otherScope);
            const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(Response.json({ didUpdate }));
            const { sync } = await import('./sync');

            await expect((sync as any).updatePendingRequestedAction(
                sessionId,
                localId,
                { v: 1, kind: 'send_now' },
            )).resolves.toBeUndefined();

            expect(request).toHaveBeenCalledTimes(1);
            expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual(
                shouldRetain
                    ? [expect.objectContaining({ localId, operation })]
                    : [],
            );
            expect(loadPendingOutboxForSession(sessionId, otherScope)).toEqual([
                expect.objectContaining({ localId, operation: 'enqueue' }),
            ]);
        },
    );

    it('does not publish session metadata after send when apply timing is next_prompt but metadata is already up to date', async () => {
        const sessionId = 's_perm_next_prompt_noop';
        storage.getState().applySessions([
            {
                ...createSession({ sessionId }),
                metadata: { permissionMode: 'safe-yolo', permissionModeUpdatedAt: Date.now() } as any,
            },
        ]);

        storage.getState().applySettingsLocal({ sessionPermissionModeApplyTiming: 'next_prompt' as any });

        const encryption = await Encryption.create(new Uint8Array(32).fill(9));
        await encryption.initializeSessions(new Map([[sessionId, null]]));

        const { sync } = await import('./sync');
        sync.encryption = encryption;
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        const publish = vi.fn(async () => {});
        (sync as any).publishSessionPermissionModeToMetadata = publish;

        await sync.sendMessage(sessionId, 'hello');

        expect(publish).not.toHaveBeenCalled();
    });
});
