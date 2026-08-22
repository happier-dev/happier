import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionOwnerMetadataV1Schema,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

describe('sendSessionMessage', () => {
    beforeEach(() => {
        vi.doMock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
            enqueuePendingQueueV2MessageViaHttp: vi.fn(async () => ({
                didWrite: true,
                terminal: false,
                suppressed: false,
            })),
        }));
    });
    afterEach(() => {
        vi.doUnmock('@/api/session/pendingQueueV2Transport');
        vi.doUnmock('./requestInactiveSessionResume');
        vi.resetModules();
        vi.clearAllMocks();
    });

    type SendWaitRowsOptions = Readonly<{
        limit100RowsByCall?: readonly (readonly unknown[])[];
        sessionSnapshot?: Record<string, unknown>;
    }>;

    async function sendAndWaitForRowsAfterCurrentUser(
        rowsAfterUser: readonly unknown[],
        options: SendWaitRowsOptions = {},
    ) {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        let limit100CallCount = 0;
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 100) {
                const scriptedRows = options.limit100RowsByCall;
                const selectedRows = scriptedRows && scriptedRows.length > 0
                    ? scriptedRows[Math.min(limit100CallCount, scriptedRows.length - 1)]
                    : rowsAfterUser;
                limit100CallCount += 1;
                return [
                    userMessageRow,
                    ...(selectedRows ?? []).map((value, index) => ({
                        id: `msg-after-${index + 1}`,
                        localId: null,
                        seq: 8 + index,
                        createdAt: 101 + index,
                        updatedAt: 101 + index,
                        content: { t: 'plain' as const, v: value },
                    })),
                ];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        const defaultSessionSnapshot = {
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 99,
            lastRuntimeIssue: null,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        };
        const fetchSessionById = vi.fn(async () => ({
            ...defaultSessionSnapshot,
            ...(options.sessionSnapshot ?? {}),
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        const result = await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        });

        return {
            result,
            fetchEncryptedTranscriptPageAfterSeq,
            waitForIdleViaSocket,
        };
    }

    function rawLifecycle(type: string) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                data: { type, id: 'turn-1' },
            },
        };
    }

    function rawEventLifecycle(type: string) {
        return {
            role: 'event',
            content: {
                type: 'event',
                data: { type, id: 'turn-1' },
            },
        };
    }

    function rawAcpMessage(message: string) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'pi',
                data: { type: 'message', message },
            },
        };
    }

    function rawClaudeRuntimeIssueMessage(message: string) {
        return {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'claude',
                data: { type: 'message', message },
            },
            meta: {
                sentFrom: 'cli',
                source: 'runtime',
                runtimeIssueCode: 'claude_authentication_failed',
                runtimeIssueSource: 'auth_error',
                runtimeIssueProvider: 'claude',
            },
        };
    }

    function rawClaudeOutput(params: Readonly<{
        content: readonly unknown[];
        stopReason?: string;
    }>) {
        return {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: params.content,
                        ...(params.stopReason ? { stop_reason: params.stopReason } : {}),
                    },
                },
            },
        };
    }

    it('omits a pending restart intent from an ordinary active prompt', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async (_params: unknown) => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
            enqueuePendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    encryptionMode: 'plain',
                    metadata: JSON.stringify({
                        flavor: 'claude',
                        providerBindingV1: {
                            v: 1,
                            connectionId: 'pc_active',
                            contributionKey: null,
                            connectionRevision: 1,
                            model: { id: 'active-model', name: 'Active model' },
                            protocol: 'anthropic',
                            materialization: 'engineConfig',
                            compatibilityFingerprint: 'compatibility:v1:active',
                            bindingSecurityFingerprint: 'binding-security:v1:active',
                            displaySnapshot: {
                                providerName: 'Gateway',
                                connectionName: 'Active',
                                connectionRole: 'named',
                                connectionDisplayNameMode: 'custom',
                            },
                        },
                        modelSelectionIntentV1: {
                            v: 1,
                            updatedAt: 2,
                            selection: {
                                agentTargetKey: 'backend:claude',
                                providerConnectionId: 'pc_pending',
                                modelId: 'pending-restart-model',
                            },
                        },
                    }),
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        await expect(sendSessionMessage({
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            idOrPrefix: 'sess-1',
            message: 'ordinary active prompt',
            wait: false,
            timeoutMs: 1_000,
            localId: 'local-active-with-pending-intent',
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-active-with-pending-intent',
            waited: false,
        });
        const enqueue = enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0] as {
            body?: { content?: { t?: string; v?: { meta?: Record<string, unknown> } } };
        };
        const messageMeta = enqueue.body?.content?.v?.meta;
        expect(messageMeta).not.toHaveProperty('model');
        expect(messageMeta).not.toHaveProperty('modelSelectionV1');
    }, 60_000);

    it('emits structured Provider selections through prompt custody without providerless fallback', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async (_params: unknown) => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
            enqueuePendingQueueV2MessageViaHttp,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));
        vi.doMock('@/plugins/runtime/reload/runtimeLease', () => ({
            acquireAuthoritativePluginRuntimeRegistryLease: vi.fn(async () => ({
                registry: {
                    contributes: {
                        agentDefinitionsById: new Map([['claude', {
                            definition: {
                                ownedBackendIds: ['claude'],
                                providerRequirements: {
                                    acceptsProtocols: ['anthropic'],
                                    required: {},
                                    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
                                    authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
                                    materialization: 'engineConfig',
                                    applyPolicy: 'live',
                                    supportsFreeformModelIds: true,
                                },
                            },
                        }]]),
                    },
                },
                release: vi.fn(async () => undefined),
            })),
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    encryptionMode: 'plain',
                    metadata: JSON.stringify({
                        flavor: 'claude',
                        modelSelectionIntentV1: {
                            v: 1,
                            updatedAt: 1,
                            selection: {
                                agentTargetKey: 'backend:claude',
                                providerConnectionId: 'pc_work',
                                modelId: 'provider-old',
                            },
                        },
                    }),
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const firstResult = await sendSessionMessage({
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: false,
            timeoutMs: 1_000,
            localId: 'local-provider-default',
            modelSelectionInput: {
                providerConnectionId: 'pc_work',
                modelId: 'default',
            },
        });
        expect(firstResult).toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-provider-default',
            waited: false,
        });

        const firstEnqueue = enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0] as {
            body?: { content?: { t?: string; v?: { meta?: Record<string, unknown> } } };
        };
        const firstMessageMeta = firstEnqueue.body?.content?.v?.meta;
        expect(firstMessageMeta).toEqual(expect.objectContaining({
            modelSelectionV1: expect.objectContaining({
                v: 1,
                ref: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_work',
                    modelId: 'default',
                },
            }),
        }));
        expect(firstMessageMeta).not.toHaveProperty('model');

        await expect(sendSessionMessage({
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            idOrPrefix: 'sess-1',
            message: 'hello again',
            wait: false,
            timeoutMs: 1_000,
            localId: 'local-provider-switch',
            modelSelectionInput: {
                providerConnectionId: 'pc_other',
                modelId: 'other-model',
            },
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-provider-switch',
            waited: false,
        });
        const secondEnqueue = enqueuePendingQueueV2MessageViaHttp.mock.calls[1]?.[0] as {
            body?: { content?: { t?: string; v?: { meta?: Record<string, unknown> } } };
        };
        const secondMessageMeta = secondEnqueue.body?.content?.v?.meta;
        expect(secondMessageMeta).toEqual(expect.objectContaining({
            modelSelectionV1: expect.objectContaining({
                v: 1,
                ref: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_other',
                    modelId: 'other-model',
                },
            }),
        }));
        expect(secondMessageMeta).not.toHaveProperty('model');
        expect(callSessionRpc).not.toHaveBeenCalled();
    }, 60_000);

    it('returns wait_failed when the current prompt delivery is blocked before transcript materialization', async () => {
        const readBlockedPendingQueueV2DeliveryByLocalIdFromServer = vi.fn(async () => ({
            localId: 'blocked-local',
            reason: 'runtime_disposed_before_delivery' as const,
        }));
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => undefined);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async (_params: Readonly<{ maxWaitMs: number }>) => null);
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => []);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'in_progress',
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp: vi.fn(async () => ({
                didWrite: true,
                terminal: false,
                suppressed: false,
            })),
            materializeNextPendingQueueV2MessageViaHttp,
            readBlockedPendingQueueV2DeliveryByLocalIdFromServer,
        }));
        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'in_progress',
                    pendingCount: 1,
                    pendingBlockedCount: 1,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 10_000,
            localId: 'blocked-local',
        })).resolves.toEqual({
            ok: false,
            code: 'wait_failed',
            message: expect.stringContaining('runtime_disposed_before_delivery'),
        });

        expect(waitForTranscriptEncryptedMessageByLocalId).toHaveBeenCalledWith(expect.objectContaining({
            maxWaitMs: expect.any(Number),
        }));
        expect(waitForTranscriptEncryptedMessageByLocalId.mock.calls[0]?.[0]?.maxWaitMs).toBeLessThanOrEqual(250);
        expect(readBlockedPendingQueueV2DeliveryByLocalIdFromServer).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token',
            sessionId: 'sess-1',
            localId: 'blocked-local',
        }));
        expect(waitForIdleViaSocket).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
    });

    it('keeps wait-for-idle transcript bounded after materialized runtime RPC send', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const assistantMessageRow = {
            id: 'msg-agent',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'done' } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn()
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValueOnce([userMessageRow])
            .mockResolvedValue([userMessageRow, assistantMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: '{"requests":{"stale":{"createdAt":1}}}',
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'in_progress',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 1_000,
            localId: 'continuation-local-id',
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            sessionId: 'sess-1',
            localId: 'continuation-local-id',
            waited: true,
        }));

        expect(callSessionRpc).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).toHaveBeenCalledWith(expect.objectContaining({
            initialTurnActivity: {
                pendingUserTurns: 1,
                activeTaskInFlight: false,
                turnInFlight: true,
            },
            preferProjectionUpdates: false,
        }));
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageLatest).not.toHaveBeenCalled();
    });

    it('settles from the current-turn projection when native assistant text completes before the wait socket subscribes', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 4,
            createdAt: 100,
            updatedAt: 100,
            content: {
                t: 'plain' as const,
                v: { role: 'user', content: { type: 'text', text: 'respond quickly' } },
            },
        };
        const assistantMessageRow = {
            id: 'msg-agent',
            localId: null,
            seq: 5,
            createdAt: 101,
            updatedAt: 101,
            content: {
                t: 'plain' as const,
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'agent',
                        data: { type: 'text', text: 'CODEX_FAST_READY' },
                    },
                },
            },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [
            userMessageRow,
            assistantMessageRow,
        ]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        let sessionSnapshotReadCount = 0;
        const fetchSessionById = vi.fn(async () => {
            sessionSnapshotReadCount += 1;
            return {
                id: 'sess-1',
                active: true,
                agentState: JSON.stringify({ controlledByUser: false, requests: {} }),
                latestTurnStatus: sessionSnapshotReadCount === 1 ? 'in_progress' : 'completed',
                latestTurnStatusObservedAt: sessionSnapshotReadCount === 1 ? 100 : 101,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
            };
        });
        const waitForIdleViaSocket = vi.fn(async (request: Readonly<{
            recheckTurnActivity?: () => Promise<{
                pendingUserTurns: number;
                activeTaskInFlight: boolean;
                turnInFlight: boolean;
            }>;
        }>) => {
            const activity = await request.recheckTurnActivity?.();
            if (!activity || activity.turnInFlight) {
                throw new Error('timeout');
            }
            return { idle: true as const, observedAt: 102 };
        });

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: JSON.stringify({ controlledByUser: false, requests: {} }),
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 100,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'respond quickly',
            wait: true,
            timeoutMs: 1_000,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-user',
            waited: true,
        });
    });

    it('does not credit a terminal projection from the same millisecond without current-turn evidence', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [userMessageRow]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 100,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalled();
    });

    it('does not report waited success when socket idle only observed a bare ready event after the current user turn', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const bareReadyRow = {
            id: 'msg-ready',
            localId: null,
            seq: 8,
            createdAt: 101,
            updatedAt: 101,
            content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ limit?: number }>) => {
            if (request.limit === 100) {
                return [userMessageRow, bareReadyRow];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 7 }));
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
        });

        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('reports waited success when a bare ready event follows agent progress for the current user turn', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'codex',
                        data: {
                            type: 'tool-call',
                            callId: 'call-1',
                            name: 'Patch',
                            input: {},
                        },
                    },
                },
                {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: { type: 'ready' },
                    },
                },
            ]);

        expect(result).toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'local-user',
            waited: true,
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['task_started', rawLifecycle('task_started')],
        [
            'non-terminal assistant output',
            rawClaudeOutput({
                content: [
                    { type: 'text', text: 'I will inspect the file.' },
                    { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
                ],
                stopReason: 'tool_use',
            }),
        ],
    ] as const)('does not report waited success when only %s follows the current user turn', async (_label, row) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual({
            ok: false,
            code: 'timeout',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['turn_failed', rawLifecycle('turn_failed'), 'Current turn failed'],
        ['turn_cancelled', rawLifecycle('turn_cancelled'), 'Current turn cancelled'],
        ['turn_aborted', rawLifecycle('turn_aborted'), 'Current turn aborted'],
    ] as const)('returns wait_failed when structured lifecycle marker %s follows the current user turn', async (_label, row, message) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message,
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it.each([
        ['task_complete', rawLifecycle('task_complete')],
        [
            'terminal assistant output',
            rawClaudeOutput({
                content: [{ type: 'text', text: 'done' }],
                stopReason: 'end_turn',
            }),
        ],
    ] as const)('reports waited success when %s follows the current user turn', async (_label, row) => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([row]);

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            waited: true,
            sessionId: 'sess-1',
            localId: 'local-user',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('paginates --wait transcript scans until a later page contains the assistant completion proof', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fillerRows = Array.from({ length: 99 }, (_, index) => ({
            id: `msg-filler-${index + 1}`,
            localId: null,
            seq: 8 + index,
            createdAt: 101 + index,
            updatedAt: 101 + index,
            content: {
                t: 'plain' as const,
                v: rawLifecycle('task_started'),
            },
        }));
        const completionRow = {
            id: 'msg-complete',
            localId: null,
            seq: 107,
            createdAt: 200,
            updatedAt: 200,
            content: {
                t: 'plain' as const,
                v: rawLifecycle('task_complete'),
            },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ afterSeq?: number; limit?: number }>) => {
            if (request.limit === 100) {
                if ((request.afterSeq ?? 0) <= 6) {
                    return [userMessageRow, ...fillerRows];
                }
                return [completionRow];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual(expect.objectContaining({
            ok: true,
            waited: true,
            sessionId: 'sess-1',
            localId: 'local-user',
        }));

        const limit100Calls = fetchEncryptedTranscriptPageAfterSeq.mock.calls
            .map(([request]) => request)
            .filter((request) => request.limit === 100);
        expect(limit100Calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ afterSeq: 6, limit: 100 }),
            expect.objectContaining({ afterSeq: 106, limit: 100 }),
        ]));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
    });

    it('paginates --wait transcript scans until a later page exposes a terminal failure marker', async () => {
        const userMessageRow = {
            id: 'msg-user',
            localId: 'local-user',
            seq: 7,
            createdAt: 100,
            updatedAt: 100,
            content: { t: 'plain' as const, v: { role: 'user' } },
        };
        const fillerRows = Array.from({ length: 99 }, (_, index) => ({
            id: `msg-filler-${index + 1}`,
            localId: null,
            seq: 8 + index,
            createdAt: 101 + index,
            updatedAt: 101 + index,
            content: {
                t: 'plain' as const,
                v: rawLifecycle('task_started'),
            },
        }));
        const failureRow = {
            id: 'msg-failed',
            localId: null,
            seq: 107,
            createdAt: 200,
            updatedAt: 200,
            content: {
                t: 'plain' as const,
                v: rawLifecycle('turn_failed'),
            },
        };
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async (request: Readonly<{ afterSeq?: number; limit?: number }>) => {
            if (request.limit === 100) {
                if ((request.afterSeq ?? 0) <= 6) {
                    return [userMessageRow, ...fillerRows];
                }
                return [failureRow];
            }
            return [userMessageRow];
        });
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => userMessageRow);
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: true,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));
        const waitForIdleViaSocket = vi.fn(async () => ({ idle: true as const, observedAt: 456 }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'hello',
            wait: true,
            timeoutMs: 50,
            localId: 'local-user',
        })).resolves.toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed',
        });

        const limit100Calls = fetchEncryptedTranscriptPageAfterSeq.mock.calls
            .map(([request]) => request)
            .filter((request) => request.limit === 100);
        expect(limit100Calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ afterSeq: 6, limit: 100 }),
            expect.objectContaining({ afterSeq: 106, limit: 100 }),
        ]));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
    });

    it('returns wait_failed for a structured current-turn failure even when provider error prose is followed by task_complete', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser(
                [
                    rawAcpMessage('Error: PiRpcCommandResponseTimeoutError: Timed out waiting for Pi RPC response (get_state)'),
                    rawLifecycle('task_complete'),
                ],
                {
                    sessionSnapshot: {
                        latestTurnStatus: 'failed',
                        latestTurnStatusObservedAt: 101,
                        lastRuntimeIssue: {
                            v: 1,
                            scope: 'primary_session',
                            status: 'failed',
                            code: 'provider_turn_failed',
                            source: 'agent_session_error',
                            occurredAt: 101,
                            provider: 'pi',
                            sanitizedPreview: 'Provider session failed',
                        },
                    },
                },
            );

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed: Provider session failed',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed for runtime issue ACP messages even before a lifecycle marker materializes', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                rawClaudeRuntimeIssueMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
            ]);

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            code: 'wait_failed',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed for event-role turn_failed rows after Codex exec-client failure prose', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([
                rawAcpMessage('Error: Plugin exec client process exited'),
                rawEventLifecycle('turn_failed'),
            ]);

        expect(result).toEqual({
            ok: false,
            code: 'wait_failed',
            message: 'Current turn failed',
        });
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('returns wait_failed when runtime issue ACP messages appear during completion proof polling', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([], {
                limit100RowsByCall: [
                    [],
                    [
                        rawClaudeRuntimeIssueMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
                    ],
                ],
            });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            code: 'wait_failed',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('prefers a later runtime issue over earlier ACP message completion proof in one polling window', async () => {
        const { result, fetchEncryptedTranscriptPageAfterSeq, waitForIdleViaSocket } =
            await sendAndWaitForRowsAfterCurrentUser([], {
                limit100RowsByCall: [
                    [],
                    [
                        rawAcpMessage('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
                        rawClaudeRuntimeIssueMessage('claude turn failed: Failed to authenticate. API Error: 401 Invalid authentication credentials'),
                    ],
                ],
            });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            code: 'wait_failed',
        }));
        expect(waitForIdleViaSocket).toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('durably enqueues an inactive prompt before one user-authorized resume', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const requestInactiveSessionResume = vi.fn(async () => ({ ok: true as const }));

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async (_params: unknown) => ({ ok: true })),
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp,
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./requestInactiveSessionResume', () => ({ requestInactiveSessionResume }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    encryptionMode: 'plain',
                    path: '/repo',
                    machineId: 'machine-session',
                    seq: 41,
                    metadata: JSON.stringify({
                        machineId: 'machine-session',
                        path: '/repo',
                        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
                    }),
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({ ok: true, sessionId: 'sess-1', localId: 'connected-service-continuation:test', waited: false });

        expect(enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token',
            sessionId: 'sess-1',
            body: expect.objectContaining({ localId: 'connected-service-continuation:test' }),
        }));
        expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
        expect(enqueuePendingQueueV2MessageViaHttp.mock.invocationCallOrder[0]).toBeLessThan(
            requestInactiveSessionResume.mock.invocationCallOrder[0],
        );
        expect(requestInactiveSessionResume).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            rawSession: expect.objectContaining({ machineId: 'machine-session' }),
            metadata: expect.objectContaining({ machineId: 'machine-session' }),
        }));
        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue later',
            localId: 'connected-service-continuation:pending-only',
            resumeInactiveSession: false,
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({ ok: true, sessionId: 'sess-1', localId: 'connected-service-continuation:pending-only', waited: false });
        expect(requestInactiveSessionResume).toHaveBeenCalledTimes(1);
    });

    it('uses the layout-v1 owner envelope for inactive permission, model, and resume policy', async () => {
        const machineKey = new Uint8Array(32).fill(1);
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            workspace: {
                machineId: 'machine-layout1',
                path: '/layout1/repo',
                flavor: 'claude',
            },
            nativeSession: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'claude',
                    backendMode: 'native',
                    backendId: 'claude',
                    provenance: 'first_party',
                },
            },
            runtime: {
                permissionMode: 'safe-yolo',
                permissionModeUpdatedAt: 10,
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 11,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: null,
                        modelId: 'owner-model',
                    },
                },
            },
        });
        const ownerMetadataEnvelope = sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'dataKey', machineKey },
            ownerMetadata,
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        const requestInactiveSessionResume = vi.fn(async () => ({ ok: true as const }));

        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./requestInactiveSessionResume', () => ({ requestInactiveSessionResume }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-layout1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'e2ee' },
                rawSession: {
                    id: 'sess-layout1',
                    active: false,
                    encryptionMode: 'plain',
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({
                        v: 1,
                        summary: { text: 'Layout 1 session', updatedAt: 12 },
                        agentPresentation: { agentId: 'claude' },
                    }),
                    ownerMetadata: ownerMetadataEnvelope,
                    machineId: 'machine-layout1',
                    seq: 41,
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        await expect(sendSessionMessage({
            credentials: {
                token: 'token',
                encryption: { type: 'dataKey', publicKey: machineKey, machineKey },
            },
            idOrPrefix: 'sess-layout1',
            message: 'continue from owner envelope',
            localId: 'layout1-owner-send',
            wait: false,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-layout1',
            localId: 'layout1-owner-send',
            waited: false,
        });

        expect(enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.objectContaining({
                content: {
                    t: 'plain',
                    v: expect.objectContaining({
                        meta: expect.objectContaining({
                            permissionMode: 'safe-yolo',
                            model: 'owner-model',
                            modelSelectionV1: expect.objectContaining({
                                ref: {
                                    agentTargetKey: 'backend:claude',
                                    providerConnectionId: null,
                                    modelId: 'owner-model',
                                },
                            }),
                        }),
                    }),
                },
            }),
        }));
        expect(requestInactiveSessionResume).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-layout1',
            metadata: expect.objectContaining({
                machineId: 'machine-layout1',
                path: '/layout1/repo',
                permissionMode: 'safe-yolo',
                runtimeDescriptorV1: expect.objectContaining({
                    agentId: 'claude',
                }),
                modelSelectionIntentV1: expect.objectContaining({
                    selection: expect.objectContaining({ modelId: 'owner-model' }),
                }),
            }),
        }));
    });

    it('does not resume an inactive session when enqueue reports a terminal replay', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didWrite: false,
            terminal: true as const,
            suppressed: false,
        }));
        const requestInactiveSessionResume = vi.fn(async () => ({ ok: true as const }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({ enqueuePendingQueueV2MessageViaHttp }));
        vi.doMock('./requestInactiveSessionResume', () => ({ requestInactiveSessionResume }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    encryptionMode: 'plain',
                    machineId: 'machine-session',
                    path: '/repo',
                    metadata: JSON.stringify({ flavor: 'claude', machineId: 'machine-session', path: '/repo' }),
                },
            })),
        }));
        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);
        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'already-terminal',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'already-terminal',
            waited: false,
            terminal: true,
        });
        expect(requestInactiveSessionResume).not.toHaveBeenCalled();
    });

    it('enqueues an active prompt with explicit send-now intent and no direct runtime dispatch', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async (_input: Readonly<{
            body: Readonly<{
                ciphertext?: string;
                requestEqualityEvidenceV1?: unknown;
            }>;
        }>) => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));

        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'e2ee',
                ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'dataKey' },
                accountEncryptionCurrentness: { mode: 'e2ee' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            pendingAdmissionMode: 'continuation_if_no_queued_user_input',
            requestedAction: { v: 1, kind: 'send_now' },
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: 'connected-service-continuation:test',
            waited: false,
        });
        await sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            pendingAdmissionMode: 'continuation_if_no_queued_user_input',
            requestedAction: { v: 1, kind: 'send_now' },
            wait: false,
            timeoutMs: 1,
        });

        expect(enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token',
            sessionId: 'sess-1',
            body: expect.objectContaining({
                localId: 'connected-service-continuation:test',
                requestedAction: { v: 1, kind: 'send_now' },
                deliveryMode: 'continuation_if_no_queued_user_input',
            }),
        }));
        const firstBody = enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0]?.body;
        const retryBody = enqueuePendingQueueV2MessageViaHttp.mock.calls[1]?.[0]?.body;
        expect(firstBody?.ciphertext).not.toBe(retryBody?.ciphertext);
        expect(firstBody).not.toHaveProperty('requestEqualityEvidenceV1');
        expect(retryBody).not.toHaveProperty('requestEqualityEvidenceV1');
        expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it('fails closed for inactive --wait sends instead of reporting materialization as delivery', async () => {
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const waitForTranscriptEncryptedMessageByLocalId = vi.fn(async () => ({ seq: 4 }));
        const fetchEncryptedTranscriptPageAfterSeq = vi.fn(async () => [
            {
                id: 'msg-user',
                localId: 'connected-service-continuation:test',
                seq: 4,
                createdAt: 4,
                updatedAt: 4,
                content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'continue' } } },
            },
        ]);
        const fetchEncryptedTranscriptPageLatest = vi.fn(async () => []);
        const fetchSessionById = vi.fn(async () => ({
            id: 'sess-1',
            active: false,
            agentState: null,
            latestTurnStatus: 'completed',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        const waitForIdleViaSocket = vi.fn(async () => {
            throw new Error('timeout');
        });
        const callSessionRpc = vi.fn(async (_params: unknown) => ({ ok: true }));

        vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', () => ({
            fetchEncryptedTranscriptPageAfterSeq,
            fetchEncryptedTranscriptPageLatest,
        }));
        vi.doMock('@/session/transport/http/sessionsHttp', () => ({
            fetchSessionById,
        }));
        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc,
        }));
        vi.doMock('@/session/transport/socket/sessionSocketAgentState', () => ({
            waitForIdleViaSocket,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp: vi.fn(async () => ({
                didWrite: true,
                terminal: false,
                suppressed: false,
            })),
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('@/api/session/transcriptMessageLookup', () => ({
            waitForTranscriptEncryptedMessageByLocalId,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: false,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: 'connected-service-continuation:test',
            wait: true,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            ok: false,
            code: 'unsupported',
            message: 'Inactive session has no recorded machine target; pending custody was retained',
        });

        expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
        expect(waitForTranscriptEncryptedMessageByLocalId).not.toHaveBeenCalled();
        expect(callSessionRpc).not.toHaveBeenCalled();
        expect(fetchEncryptedTranscriptPageAfterSeq).not.toHaveBeenCalled();
        expect(waitForIdleViaSocket).not.toHaveBeenCalled();
    });

    it('rejects an explicit blank Pending localId before enqueue instead of substituting one', async () => {
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    encryptionMode: 'plain',
                    metadata: '{}',
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);
        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: ' \t ',
            wait: false,
            timeoutMs: 1,
        })).rejects.toThrow('Pending localId must not be blank');
        expect(enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });

    it('does not consult the removed runtime dispatch path for an active send', async () => {
        const materializeNextPendingQueueV2MessageViaHttp = vi.fn(async () => ({ didMaterialize: true }));
        const enqueuePendingQueueV2MessageViaHttp = vi.fn(async () => ({
            didWrite: true,
            terminal: false,
            suppressed: false,
        }));

        vi.doMock('@/session/transport/rpc/sessionRpc', () => ({
            callSessionRpc: vi.fn(async () => {
                throw new Error('Socket connect timeout');
            }),
        }));
        vi.doMock('@/api/session/pendingQueueV2Transport', () => ({
            enqueuePendingQueueV2MessageViaHttp,
            materializeNextPendingQueueV2MessageViaHttp,
        }));
        vi.doMock('./resolveSessionTransportContext', () => ({
            resolveSessionTransportContext: vi.fn(async () => ({
                ok: true,
                sessionId: 'sess-1',
                mode: 'plain',
                ctx: null,
                accountEncryptionCurrentness: { mode: 'plain' },
                rawSession: {
                    id: 'sess-1',
                    active: true,
                    metadata: '{}',
                    agentState: null,
                    latestTurnStatus: 'completed',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            })),
        }));

        const { sendSessionMessage } = await import('./sendSessionMessage');
        const machineKey = new Uint8Array(32).fill(1);

        await expect(sendSessionMessage({
            credentials: { token: 'token', encryption: { type: 'dataKey', publicKey: machineKey, machineKey } },
            idOrPrefix: 'sess-1',
            message: 'continue',
            localId: ' connected-service-continuation:test ',
            wait: false,
            timeoutMs: 1,
        })).resolves.toEqual({
            ok: true,
            sessionId: 'sess-1',
            localId: ' connected-service-continuation:test ',
            waited: false,
        });

        expect(enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith({
            token: 'token',
            sessionId: 'sess-1',
            body: expect.objectContaining({
                localId: ' connected-service-continuation:test ',
                messageRole: 'user',
                requestedAction: { v: 1, kind: 'steer_if_active' },
            }),
        });
        expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    });
});
