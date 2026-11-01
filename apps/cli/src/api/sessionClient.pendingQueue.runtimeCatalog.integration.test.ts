import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from '@/agent/runtime/session/follow/sessionFollowSourceMaterialResolver';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionInputRequestV1Schema, SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionPendingAdmissionSettlementRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { waitForProcessExit } from '@/testkit/process/spawn';

import { ApiSessionClient } from './session/sessionClient';
import type { SessionMessageContent } from './types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import {
    createMockSession,
    createSessionRecordFixture,
    type SessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { HttpStatusError } from './client/httpStatusError';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import type {
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    type SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import {
    bindApiSessionSocketPairMock as bindApiSessionSocketPairHarness,
    createApiSessionSocketStub,
    resolveApiSessionSocketDefaultAck,
    flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));
const currentFeatures = {
    features: {},
    capabilities: {
        session: {
            runtimeActivity: { protocolVersion: 2 },
            pendingInput: { protocolVersion: 1 },
            publisherAuthority: { protocolVersion: 1 },
        },
    },
} as const;

const bindApiSessionSocketPairMock = (
    ioMock: typeof mockIo,
    params: Parameters<typeof bindApiSessionSocketPairHarness>[1],
): void => {
    // Exercise the real connection event; an already-connected stub bypasses
    // the supervisor's socket-affine compatibility handshake.
    params.sessionSocket.connected = false;
    const emitWithAck = params.sessionSocket.emitWithAck.getMockImplementation();
    params.sessionSocket.emitWithAck.mockImplementation(async (event: string, payload: unknown) =>
        emitWithAck ? await emitWithAck(event, payload) : { ok: true });
    bindApiSessionSocketPairHarness(ioMock, {
        ...params,
        // The connection supervisor may create a replacement transport while the test is
        // reconciling the compatibility result. Keep that genuine socket boundary deterministic.
        fallbackSocket: params.sessionSocket,
    });
};

const TEST_SESSION_ID = 'test-session-id';
const sessionSnapshotUrlSuffix = `/v2/sessions/${TEST_SESSION_ID}`;

type SessionSnapshotHttpResponse = Readonly<{ status: number; data: unknown }>;

/**
 * The Session snapshot read is a real HTTP boundary (`GET /v2/sessions/:id`).
 * Serving it here keeps the whole snapshot decode/apply path — pending queue
 * state, latest turn status, metadata layout — as real internal logic.
 */
const SESSION_SNAPSHOT_NOT_FOUND: SessionSnapshotHttpResponse = {
    status: 404,
    data: { error: 'Session not found' },
};

const createSessionSnapshotHttpResponse = (
    overrides: Partial<SessionRecordFixture> = {},
): SessionSnapshotHttpResponse => ({
    status: 200,
    data: {
        session: createSessionRecordFixture({ id: TEST_SESSION_ID, metadata: '', ...overrides }),
    },
});

let sessionSnapshotHttpResponse: SessionSnapshotHttpResponse = SESSION_SNAPSHOT_NOT_FOUND;

const expectSessionSnapshotRead = (purpose: string): void => {
    expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining(sessionSnapshotUrlSuffix),
        expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: 'Bearer fake-token',
                'X-Happier-Request-Purpose': purpose,
            }),
        }),
    );
};

const readSessionSnapshotRequestPurposes = (): string[] => (
    (axios.get as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([url]) => typeof url === 'string' && url.endsWith(sessionSnapshotUrlSuffix))
        .map(([, config]) => (config as { headers?: Record<string, string> } | undefined)
            ?.headers?.['X-Happier-Request-Purpose'] ?? '')
);

const installAxiosGetBoundaryMock = (
    fallback: (url: string) => Promise<unknown> = async () => ({ status: 200, data: {} }),
) => vi.spyOn(axios, 'get').mockImplementation((async (url: string) => {
    if (url.includes('/v1/access-keys/')) {
        return { status: 200, data: { accessKey: 'test-session-access-key' } };
    }
    if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: {
            mode: 'e2ee',
            version: 1,
            signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: 'content-fingerprint',
            updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'available' },
        } };
    }
    if (url.endsWith(sessionSnapshotUrlSuffix)) {
        return sessionSnapshotHttpResponse;
    }
    return await fallback(url);
}) as typeof axios.get);

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
    createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));

describe('ApiSessionClient pending queue materialization', () => {
    let mockSession: any;
    let previousEnableV2Changes: string | undefined;
    const clients = new Set<ApiSessionClient>();

    const createClient = (session: ConstructorParameters<typeof ApiSessionClient>[1]): ApiSessionClient => {
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', session, {
            localMachineId: 'test-machine', durableMutationDeliveryInitiallyActive: false,
        });
        clients.add(client);
        return client;
    };

    const waitForPendingInputContract = async (client: ApiSessionClient, protocolVersion = 1): Promise<void> => {
        const readContract = () => Reflect.get(client, 'sessionSyncPendingInputServerContractResult');
        if (!readContract()) await new Promise<void>((resolve) => client.once('session-sync-server-contract', resolve));
        expect(readContract()).toMatchObject({
            mode: 'session_sync_v3_publisher_authority_check_v1',
            pendingInputProtocolVersion: protocolVersion,
            socket: Reflect.get(client, 'socket'),
        });
    };

    beforeEach(() => {
        previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(currentFeatures), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
        sessionSnapshotHttpResponse = SESSION_SNAPSHOT_NOT_FOUND;
        installAxiosGetBoundaryMock();
        mockSession = createMockSession();
        mockIo.mockReset();
    });

    afterEach(async () => {
        await Promise.allSettled([...clients].map((client) => client.close()));
        clients.clear();
        if (typeof previousEnableV2Changes === 'string') {
            process.env.HAPPY_ENABLE_V2_CHANGES = previousEnableV2Changes;
        } else {
            delete process.env.HAPPY_ENABLE_V2_CHANGES;
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('replays exact queued Run targets from the initial attach Session when the Run manager subscribes', async () => {
        bindApiSessionSocketPairMock(mockIo, {
            sessionSocket: createApiSessionSocketStub({ connected: true }),
            userSocket: createApiSessionSocketStub(),
        });
        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 8,
            pendingExecutionRunIds: ['run-offline', 'run-offline'],
        }));
        const reconcileTarget = vi.fn(async () => {});

        client.subscribeExecutionRunPendingTarget(reconcileTarget);

        await vi.waitFor(() => {
            expect(reconcileTarget).toHaveBeenCalledTimes(1);
            expect(reconcileTarget).toHaveBeenCalledWith('run-offline');
        });
    });

    it('reconciles recipient-specific Pending wakes even when their Session-global versions arrive out of order', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        const client = createClient(createMockSession({ pendingCount: 0, pendingVersion: 0 }));
        const reconciled: string[] = [];
        client.subscribeExecutionRunPendingTarget(async (runId) => {
            reconciled.push(runId);
        });

        const handleUpdate = (client as unknown as {
            updateRuntime: { handleUpdate: (update: unknown, opts: { source: 'user-scoped' }) => void };
        }).updateRuntime.handleUpdate;
        handleUpdate({
            id: 'wake-b', seq: 1, createdAt: 1,
            body: {
                t: 'pending-changed', sid: client.sessionId, pendingCount: 1,
                pendingBlockedCount: 0, pendingVersion: 2,
                recipient: { kind: 'execution_run', runId: 'run-b' },
            },
        }, { source: 'user-scoped' });
        handleUpdate({
            id: 'wake-b-duplicate', seq: 2, createdAt: 2,
            body: {
                t: 'pending-changed', sid: client.sessionId, pendingCount: 1,
                pendingBlockedCount: 0, pendingVersion: 2,
                recipient: { kind: 'execution_run', runId: 'run-b' },
            },
        }, { source: 'user-scoped' });
        handleUpdate({
            id: 'wake-a', seq: 3, createdAt: 3,
            body: {
                t: 'pending-changed', sid: client.sessionId, pendingCount: 1,
                pendingBlockedCount: 0, pendingVersion: 1,
                recipient: { kind: 'execution_run', runId: 'run-a' },
            },
        }, { source: 'user-scoped' });

        await vi.waitFor(() => expect(reconciled).toEqual(['run-b', 'run-a']));
    });

    it.each(['plain', 'e2ee'] as const)('keeps target custody independent from main and settles the exact sidechain once (%s)', async (encryptionMode) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            ...currentFeatures,
            capabilities: { session: { ...currentFeatures.capabilities.session, pendingInput: { protocolVersion: 3 } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })));
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        const session = createMockSession({ encryptionMode, pendingCount: 0, pendingVersion: 4 });
        const authoredPayload = {
            role: 'user', content: { type: 'text', text: 'Side input' },
            meta: { happier: { kind: 'participant_message.v1', payload: { recipient } }, attachmentMarker: 'preserved' },
        };
        const content = encryptionMode === 'plain'
            ? { t: 'plain' as const, v: authoredPayload }
            : { t: 'encrypted' as const, c: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, authoredPayload)) };
        const message = {
            id: null, seq: null, localId: 'target-input', content, createdAt: 1, updatedAt: 1,
            requestedAction: { v: 1, kind: 'enqueue' }, providerAction: 'send', inputAdmissionReceipt: null,
        };
        const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event) => {
            if (event === 'session-pending-admission-settlement-v1') return {
                v: 1, result: { status: 'accepted', localId: 'target-input' },
            };
            if (event === 'session-pending-execution-run-materialize-next-v2') return {
                v: 2, ok: true, didMaterialize: true, didWrite: false, recipient, sidechainId: 'chain-a', authorAccountId: 'author-a',
                message, deliveryState: { mode: 'provider', unresolved: true }, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 8,
            };
            if (event === 'session-pending-execution-run-delivery-accepted-v2') return {
                v: 2, recipient, sidechainId: 'chain-a', result: {
                    ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 9,
                    message: { id: 'committed-a', seq: 5, localId: 'target-input', content, createdAt: 1, updatedAt: 1 },
                },
            };
            return { ok: true };
        } });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', session, {
            localMachineId: 'test-machine',
            durableMutationDeliveryInitiallyActive: false,
        });
        clients.add(client);
        await waitForPendingInputContract(client, 3);
        const received: unknown[] = [];
        const target = client.bindExecutionRunPendingInput({
            recipient, sidechainId: 'chain-a', isCurrent: () => true, foregroundState: () => 'ready',
            getMetadataSnapshot: () => client.getMetadataSnapshot(),
            consume: (input) => { received.push(input); return true; },
        });
        await expect(target.materializeNextPendingMessageSafely!()).resolves.toMatchObject({ type: 'materialized', localId: 'target-input' });
        expect(received).toMatchObject([{ localId: 'target-input', authorAccountId: 'author-a', meta: { attachmentMarker: 'preserved' } }]);
        const admissionSettlements = sessionSocket.emitWithAck.mock.calls.filter(([event]) => event === 'session-pending-admission-settlement-v1');
        if (encryptionMode === 'e2ee') {
            expect(admissionSettlements).toMatchObject([['session-pending-admission-settlement-v1', {
                decision: { kind: 'admit', finalContent: content, requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: expect.any(String) } },
            }]]);
        } else {
            expect(admissionSettlements).toEqual([]);
        }
        expect(client.getPendingQueueState()).toMatchObject({ pendingCount: 0, pendingVersion: 4 });
        await expect(client.peekPendingMessageQueueV2Count()).resolves.toBe(0);
        await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);
        expect(client.hasPendingProviderInput('target-input')).toBe(true);
        await target.materializeNextPendingMessageSafely!();
        expect(received).toHaveLength(1);
        await target.observeProviderInputSettlement({ kind: 'accepted', localId: 'target-input', userMessageSeq: null });
        expect(client.getCommittedUserMessageSeq('target-input')).toBe(5);
        await expect(target.readDurableProviderInputAcceptanceV1('target-input')).resolves.toBe('accepted');
        expect(client.hasPendingProviderInput('target-input')).toBe(false);
        expect(client.getPendingQueueState()).toMatchObject({ pendingCount: 0, pendingVersion: 4 });
        target.dispose();
    });

    it('does not deliver or settle a target claim after its runtime binding is replaced', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            ...currentFeatures,
            capabilities: { session: { ...currentFeatures.capabilities.session, pendingInput: { protocolVersion: 3 } } },
        }), { status: 200 })));
        const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
        let releaseClaim!: (value: unknown) => void;
        const claim = new Promise<unknown>((resolve) => { releaseClaim = resolve; });
        const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event) =>
            event === 'session-pending-execution-run-materialize-next-v2' ? claim : { ok: true } });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        const client = createTestApiSessionClient(ApiSessionClient, 'fake-token', createMockSession({ encryptionMode: 'plain' }), {
            localMachineId: 'test-machine', durableMutationDeliveryInitiallyActive: false,
        });
        clients.add(client);
        await waitForPendingInputContract(client, 3);
        const received: unknown[] = [];
        const binding = {
            recipient, sidechainId: 'chain-a', isCurrent: () => true, foregroundState: () => 'ready' as const,
            getMetadataSnapshot: () => client.getMetadataSnapshot(),
            consume: (input: unknown) => { received.push(input); return true; },
            wake: vi.fn(),
        };
        const oldTarget = client.bindExecutionRunPendingInput(binding);
        const materializing = oldTarget.materializeNextPendingMessageSafely!();
        await vi.waitFor(() => expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('session-pending-execution-run-materialize-next-v2', expect.anything()));
        const replacement = client.bindExecutionRunPendingInput(binding);
        const reconcileTarget = vi.fn();
        client.subscribeExecutionRunPendingTarget(reconcileTarget);
        (client as any).updateRuntime.handleUpdate({
            id: 'target-pending-wake', seq: 1, createdAt: 1,
            body: {
                t: 'pending-changed', sid: client.sessionId, pendingCount: 0,
                pendingBlockedCount: 0, pendingVersion: 1, recipient,
            },
        }, { source: 'user-scoped' });
        expect(binding.wake).toHaveBeenCalledTimes(1);
        expect(reconcileTarget).toHaveBeenCalledWith('run-a');
        releaseClaim({
            v: 2, ok: true, didMaterialize: true, didWrite: false, recipient, sidechainId: 'chain-a', authorAccountId: null,
            message: { id: null, seq: null, localId: 'stale-input', createdAt: 1, updatedAt: 1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'stale' } } },
                providerAction: 'send', requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: null,
            },
            deliveryState: { mode: 'provider', unresolved: true }, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
        });
        await expect(materializing).resolves.toMatchObject({ type: 'retryable_transport' });
        expect(received).toEqual([]);
        expect(client.hasPendingProviderInput('stale-input')).toBe(false);
        await oldTarget.observeProviderInputSettlement({ kind: 'accepted', localId: 'stale-input', userMessageSeq: null });
        expect(sessionSocket.emitWithAck.mock.calls.some(([event]) => event === 'session-pending-execution-run-delivery-accepted-v2')).toBe(false);
        replacement.dispose();
        await expect(replacement.materializeNextPendingMessageSafely!()).resolves.toMatchObject({ type: 'no_pending' });
    });

    it('popPendingMessage uses pending-materialize-next and returns true when server materializes', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                        role: 'user', content: { type: 'text', text: 'pending input' }, meta: { source: 'ui' },
                    })) },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const client = createClient(session);
        await waitForPendingInputContract(client);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: session.id,
            pendingVersion: 3,
            deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready',
            foregroundState: 'ready',
        });
    });

    it('does not call materialize-next when the initial pending queue state is known empty', async () => {
        mockSession = createMockSession({ pendingCount: 0, pendingVersion: 4 });
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({ ok: true, didMaterialize: true }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(mockSession);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(false);
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith(
            'pending-materialize-next',
            expect.anything(),
        );
    });

    it('leaves foreground eligibility with the server Pending claim owner', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                        role: 'user', content: { type: 'text', text: 'pending input' }, meta: { source: 'ui' },
                    })) },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        // The server owns final foreground/action eligibility; the CLI only projects the fact.
        sessionSnapshotHttpResponse = createSessionSnapshotHttpResponse({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 3,
            latestTurnStatus: 'in_progress',
        });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            latestTurnStatus: 'in_progress',
        }));

        await waitForPendingInputContract(client);
        expect(client.shouldAttemptPendingMaterialization()).toBe(true);
        await expect(client.popPendingMessage()).resolves.toBe(true);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: mockSession.id,
            pendingVersion: 3,
            deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready',
            foregroundState: 'ready',
        });
    });

    it('wakes pending input after the socket-affine authority contract settles', async () => {
        let resolveFeatures = (_response: Response): void => {
            throw new Error('Feature request did not start');
        };
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
            resolveFeatures = resolve;
        })));
        const authoritySession = createMockSession({ pendingCount: 1, pendingVersion: 1 });
        const authorityContent = {
            t: 'encrypted' as const,
            c: encodeBase64(encrypt(authoritySession.encryptionKey, authoritySession.encryptionVariant, {
                role: 'user', content: { type: 'text', text: 'authority input' }, meta: { source: 'ui' },
            })),
        };
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: false,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-authority',
                    seq: null,
                    localId: 'local-authority',
                    messageRole: 'user',
                    content: authorityContent,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(authoritySession);
        client.onUserMessage(vi.fn());
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({
            type: 'retryable_transport',
        });

        let authorityWake: boolean | null = null;
        const abortController = new AbortController();
        void client.waitForMetadataUpdate(abortController.signal).then((value) => {
            authorityWake = value;
        });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        resolveFeatures(new Response(JSON.stringify(currentFeatures), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await waitForPendingInputContract(client);

        try {
            await vi.waitFor(() => expect(authorityWake).toBe(true));
        } finally {
            abortController.abort();
        }
        await expect(client.popPendingMessage()).resolves.toBe(true);
    });

    it('refreshes durable turn status without making a local foreground eligibility decision', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                        role: 'user', content: { type: 'text', text: 'pending input' }, meta: { source: 'ui' },
                    })) },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        sessionSnapshotHttpResponse = createSessionSnapshotHttpResponse({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            latestTurnStatus: 'in_progress',
        });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'completed',
        }));

        await waitForPendingInputContract(client);
        await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
            type: 'materialized',
            localId: 'local-p1',
        });
        expectSessionSnapshotRead('session-detail:explicit-drain');
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: mockSession.id,
            pendingVersion: 4,
            deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready',
            foregroundState: 'ready',
        });
    });

    it('does not materialize pending messages when durable turn status refresh fails', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        // The real snapshot read fails at its HTTP boundary; the drain must not proceed.
        sessionSnapshotHttpResponse = { status: 503, data: { error: 'snapshot unavailable' } };

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'completed',
        }));

        await waitForPendingInputContract(client);
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        expectSessionSnapshotRead('session-detail:explicit-drain');
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith(
            'pending-materialize-next',
            expect.anything(),
        );
    });

    it('materializeNextPendingMessageSafely force reconciles known-empty state before returning no_pending', async () => {
        mockSession = createMockSession({ pendingCount: 0, pendingVersion: 4 });
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({ ok: true, didMaterialize: true }),
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        sessionSnapshotHttpResponse = createSessionSnapshotHttpResponse({
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 5,
        });

        const client = createClient(mockSession);
        await waitForPendingInputContract(client);
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });

        expectSessionSnapshotRead('session-detail:startup-drain');
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalledWith(
            'pending-materialize-next',
            expect.anything(),
        );
    });

    it('does not reconcile or fetch the pending list for passive known-empty pending peeks', async () => {
        mockSession = createMockSession({ pendingCount: 0, pendingVersion: 4 });
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        sessionSnapshotHttpResponse = createSessionSnapshotHttpResponse({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 5,
        });

        const client = createClient(mockSession);
        const count = await client.peekPendingMessageQueueV2Count();

        expect(count).toBe(0);
        expect(readSessionSnapshotRequestPurposes()).toEqual([]);
    });

    it('updates pending queue state from a materialize no-op response', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: false,
                pendingCount: 0,
                pendingVersion: 9,
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await waitForPendingInputContract(client);
        await expect(client.popPendingMessage()).resolves.toBe(false);
        await expect(client.popPendingMessage()).resolves.toBe(false);

        expect(sessionSocket.emitWithAck.mock.calls.filter(
            ([event]) => event === 'pending-materialize-next',
        )).toHaveLength(1);
    });

    it('tracks materialized localIds for recovery even when the server reports an idempotent write', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: false,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                        role: 'user', content: { type: 'text', text: 'pending input' }, meta: { source: 'ui' },
                    })) },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await waitForPendingInputContract(client);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect((client as any).materializationRuntime.hasPendingQueueMaterializedLocalId('local-p1')).toBe(true);
    });

    it('delivers a materialized pending message immediately and does not double-deliver socket echoes', async () => {
        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, plaintext));
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        installAxiosGetBoundaryMock(async () => ({
            status: 200,
            data: { messages: [] },
        }));

        const client = createClient(session);
        const deliveryAnchors: Array<number | null> = [];
        const onUserMessage = vi.fn((message: { localId?: string | null }) => {
            deliveryAnchors.push(
                typeof message.localId === 'string'
                    ? client.getCommittedUserMessageSeq(message.localId)
                    : null,
            );
        });
        client.onUserMessage(onUserMessage);
        await waitForPendingInputContract(client);

        const popped = await client.popPendingMessage();
        expect(popped).toBe(true);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage.mock.calls[0]?.[0]).toMatchObject({
            content: { type: 'text', text: 'hello' },
            localId: 'local-p1',
        });
        expect(deliveryAnchors).toEqual([2]);
        expect(client.getCommittedUserMessageSeq('local-p1')).toBe(2);
        expect(client.hasPendingQueueMaterializedLocalId('local-p1')).toBe(true);

        const sessionUpdateHandler = sessionSocket.getHandler('update');
        const userUpdateHandler = userSocket.getHandler('update');
        expect(typeof sessionUpdateHandler).toBe('function');
        expect(typeof userUpdateHandler).toBe('function');

        const update = {
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: {
                t: 'new-message', delivery: 'full' as const,
                sid: mockSession.id,
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    content: { t: 'encrypted', c: encrypted },
                },
            },
        } as any;

        userUpdateHandler?.(update);
        sessionUpdateHandler?.(update);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it.each(['timeout', 'account_timeout', 'server_error', 'database_connection_unavailable', 'forbidden', 'missing_receipt'] as const)(
        'retains the exact Follow original through %s without a duplicate native acceptance', async failure => {
        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const sourceSessionId = 'source-session';
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake', event: { kind: 'message' },
            original: { sourceSessionId, sourceMessage: { localId: 'original', seq: 1 } } });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: session.id, original: delivery.original });
        const request = SessionInputRequestV1Schema.parse({ v: 1, producer: 'sessionAction', followDeliveryV1: delivery,
            permission: { requestedPermissionCeiling: 'default' } });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine',
            followDeliveryV1: delivery, admittedTarget: { homeId: 'home', accountId: 'account', sessionId: session.id,
                machineId: 'test-machine', installationId: 'installation' } });
        const content = { t: 'encrypted' as const, c: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, {
            role: 'user', content: { type: 'text', text: '' }, meta: { happierInputRequestV1: request },
        })) };
        const observed = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
        const delivered = { ...observed, transcriptSeq: 0 };
        let accepted = false;
        let blocked = false;
        let sourceReads = 0;
        let admittedContent: SessionMessageContent | undefined;
        const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
            if (event === 'pending-materialize-next') return accepted || blocked
                ? { ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: blocked ? 1 : 0, pendingVersion: 4 }
                : { ok: true, didMaterialize: true, didWrite: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3,
                    deliveryState: { mode: 'provider', unresolved: true }, message: { id: null, seq: null, localId,
                        messageRole: 'user', content, ...(failure === 'missing_receipt' ? {} : { inputAdmissionReceipt: receipt }),
                        requestedAction: { v: 1, kind: 'enqueue' }, providerAction: 'send', createdAt: 1, updatedAt: 1 } };
            if (event === 'session-pending-admission-settlement-v1') {
                const settlement = SessionPendingAdmissionSettlementRequestV1Schema.parse(payload);
                expect(settlement.localId).toBe(localId);
                if (failure === 'missing_receipt') return { v: 1, result: { status: 'rejected', code: 'session_input_untrusted_assertion' } };
                if (settlement.decision.kind !== 'admit') throw new Error('Expected Follow original admission');
                const alreadyAdmitted = admittedContent !== undefined;
                admittedContent = settlement.decision.finalContent;
                return { v: 1, result: { status: alreadyAdmitted ? 'alreadyAccepted' : 'accepted', localId } };
            }
            if (event === 'session-follow-observe-pending-v1') return { ok: true, v: 1, sessionId: session.id,
                publisherGeneration: '1', currentSourceSessionIds: [sourceSessionId], observations: [{ kind: 'admitted_input',
                    localInputId: localId, delivery, effectiveDelivery: delivery.delivery,
                    sourceSessionId, destinationSessionId: session.id, delivered, observed }] };
            if (event === 'session-follow-acknowledge-v1') return { ok: true, v: 1, sourceSessionId,
                destinationSessionId: session.id, delivered: observed };
            return resolveApiSessionSocketDefaultAck(event, payload);
        } });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        installAxiosGetBoundaryMock(async url => {
            if (url.includes('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
            if (url.endsWith(`/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(localId)}`)) {
                if (!admittedContent) throw new Error('Follow original was read before receiver admission');
                return { status: 200, data: { message: { id: 'committed-follow-original', seq: 1, localId,
                    messageRole: 'user', content: admittedContent, inputAdmissionReceipt: receipt, createdAt: 1, updatedAt: 1 } } };
            }
            if (url.endsWith(`/v2/sessions/${sourceSessionId}`)) {
                sourceReads += 1;
                if (sourceReads === 1) throw new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED');
                return { status: 200, data: { session: createSessionRecordFixture({ id: sourceSessionId,
                    encryptionMode: 'plain', metadata: '{}', seq: 1, agentStateVersion: 0 }) } };
            }
            if (url.includes(`/v1/sessions/${sourceSessionId}/messages`)) return { status: 200, data: {
                messages: projection.messages.map(row => ({ ...row, id: 'source-1', localId: 'original', updatedAt: 1 })),
                hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
            } };
            return { status: 200, data: { messages: [] } };
        });
        const projection = SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1,
            source: { id: sourceSessionId, encryptionMode: 'plain', metadata: '{}', archivedAt: null, createdAt: 1, updatedAt: 1,
                active: true, activeAt: 1, thinking: false, thinkingAt: null, latestTurnStatus: null,
                latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
                meaningfulActivityAt: null, agentStateVersion: 0 },
            messages: [{ seq: 1, localId: 'original', createdAt: 1, messageRole: 'agent', content: { t: 'plain', v:
                buildAcpAgentMessageEnvelope({ provider: 'codex', body: { type: 'message', message: 'RETAINED_FOLLOW_ORIGINAL' } }) } }],
            hasMore: false });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/follows/source-projection')) {
                sourceReads += 1;
                if (sourceReads === 1) {
                    if (failure === 'timeout') throw new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED');
                    if (failure === 'database_connection_unavailable') throw Object.assign(new Error('Home unavailable'), { code: failure });
                    if (failure === 'server_error') return { status: 503, data: { error: 'database_connection_unavailable' } };
                    if (failure === 'forbidden') return { status: 403, data: { error: 'forbidden' } };
                }
                return { status: 200, data: projection };
            }
            if (String(url).endsWith('/delivery/block')) {
                blocked = true;
                return { status: 200, data: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 4 } };
            }
            throw new Error(`Unexpected HTTP POST: ${new URL(String(url)).pathname}`);
        });
        const client = createClient(session);
        const queue = createPermissionModeQueueState({ session: client, agentTargetKey: 'agent:happier.agent.codex/codex',
            initialPermissionMode: 'default', inFlightSteer: { isTurnInFlight: () => false, supportsInFlightSteer: () => false,
                steerText: async () => {}, registerProviderAcceptedEffect: () => {}, rejectPromptBeforeProvider: input => {
                for (const id of input.localIds ?? []) void client.observeProviderInputSettlement({ kind: 'rejected_before_effect',
                    localId: id, userMessageSeq: null, reason: 'unsupported_action',
                    diagnostic: { code: 'unsupported_action', severity: 'warning' }, retryable: false });
            } } });
        await waitForPendingInputContract(client);
        const material = createSessionFollowSourceMaterialResolver();
        const reconcile = createSessionFollowContextReconciler({ session: client, maxFollowContextUtf8Bytes: 100_000,
            hydrateObservation: createSessionFollowSourceHydrator({ session: client, credentials: { token: 'fake-token', encryption: null },
                ...(failure === 'account_timeout' ? {} : { sourceMaterialResolver: material }) }) });
        const controller = new AbortController();
        const sent: string[] = [];
        const failures: unknown[] = [];
        const effects = new Map<string, () => void>();
        const loop = runPermissionModePromptLoop({ providerName: 'Test', agentMessageType: 'codex', explicitPermissionMode: undefined,
            session: client, messageQueue: queue.messageQueue, permissionHandler: { setPermissionMode() {}, reset() {} },
            runtime: { beginTurnLifecycle() {}, async sendTurnPrompt(prompt, meta) {
                sent.push(prompt); accepted = true; if (meta?.localId) effects.get(meta.localId)?.();
            }, async steerInFlightTurn() {}, async waitForTurnCompletion() {}, subscribeRuntimeEvents: () => () => {},
                async cancelTurn() {}, readSessionIdentity: () => ({ sessionId: null }), async updateSessionRuntimeConfig() {}, async resetOrDisposeRuntime() {} },
            prepareHostContext: async input => await reconcile(input),
            createOverrideSynchronizer: () => ({ syncFromMetadata() {}, async flushPendingAfterStart() {} }),
            messageBuffer: new MessageBuffer(), shouldExit: () => accepted || blocked || controller.signal.aborted,
            getAbortSignal: () => controller.signal, keepAlive() {}, setThinking() {}, sendReady() {},
            currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
            registerProviderAcceptedEffect: (id, effect) => { if (effect) effects.set(id, effect); else effects.delete(id); },
            formatPromptErrorMessage: String, onPromptFailure: error => { failures.push(error); } });
        try {
            if (failure === 'forbidden' || failure === 'missing_receipt') {
                await vi.waitFor(() => expect(blocked || failure === 'missing_receipt' && sessionSocket.emitWithAck.mock.calls.some(
                    ([event, payload]) => event === 'session-pending-admission-settlement-v1'
                        && (payload as { decision?: { kind?: string } }).decision?.kind === 'reject')).toBe(true));
                if (failure === 'forbidden') {
                    await vi.waitFor(() => expect(failures).toMatchObject([{
                        status: 'attachment_unavailable',
                        cause: { classification: { statusCode: 403, retryable: false } },
                    }]));
                    expect(sourceReads).toBe(1);
                }
            } else {
                // Silent timeout recovery uses existing preparation pacing; other
                // transient failures exercise the metadata/reconnect wake.
                await vi.waitFor(() => expect(sourceReads).toBe(1));
                if (failure !== 'timeout') client.emit('metadata-updated');
                await vi.waitFor(() => expect(sent).toEqual([expect.stringContaining('RETAINED_FOLLOW_ORIGINAL')]), {
                    timeout: failure === 'timeout' ? 15_000 : 1_000,
                });
                client.emit('metadata-updated');
                expect(failures).toEqual([]);
                expect(blocked).toBe(false);
                expect(axios.get).toHaveBeenCalledWith(expect.stringContaining(
                    `/v2/sessions/${session.id}/messages/by-local-id/${encodeURIComponent(localId)}`), expect.any(Object));
            }
            expect(sent).toHaveLength(failure === 'forbidden' || failure === 'missing_receipt' ? 0 : 1);
        } finally {
            controller.abort();
            await loop;
            material.dispose();
        }
    });

    it('delivers an idempotent current transcript row with its exact committed sequence', async () => {
        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'already current' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, plaintext));
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: false,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-current-9',
                    seq: 9,
                    localId: 'local-current-9',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        installAxiosGetBoundaryMock(async () => ({ status: 200, data: { messages: [] } }));

        const client = createClient(session);
        const delivered: Array<Readonly<{ localId: string; seq: number | null }>> = [];
        client.onUserMessage((message) => {
            delivered.push({
                localId: message.localId!,
                seq: client.getCommittedUserMessageSeq(message.localId!),
            });
        });
        await waitForPendingInputContract(client);

        await expect(client.popPendingMessage()).resolves.toBe(true);
        expect(delivered).toEqual([{ localId: 'local-current-9', seq: 9 }]);
        expect(client.hasPendingQueueMaterializedLocalId('local-current-9')).toBe(true);
    });

    it.each([null, 'run-a'] as const)('retries retained acceptance on the same connection after two lost settlement replies without redelivering to the Agent (%s)', async runId => {
        const localId = 'accepted-response-loss';
        const recipient = runId ? { kind: 'execution_run' as const, runId } : null;
        if (recipient) vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            ...currentFeatures,
            capabilities: { session: { ...currentFeatures.capabilities.session, pendingInput: { protocolVersion: 3 } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })));
        const session = createMockSession({ encryptionMode: 'plain', pendingCount: recipient ? 0 : 1, pendingVersion: 3 });
        const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one input' },
            meta: recipient ? { happier: { kind: 'participant_message.v1', payload: { recipient } } } : { source: 'ui' } } };
        const materializeEvent = recipient ? 'session-pending-execution-run-materialize-next-v2' : 'pending-materialize-next';
        const acceptanceEvent = recipient ? 'session-pending-execution-run-delivery-accepted-v2' : 'pending-delivery-accepted-v1';
        let settlementAttempts = 0;
        const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event) => {
            if (event === materializeEvent) return {
                ok: true, didMaterialize: true, didWrite: false,
                ...(recipient ? { v: 2, recipient, sidechainId: 'chain-a', authorAccountId: 'author-a' } : {}),
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3,
                deliveryState: { mode: 'provider', unresolved: true },
                message: { id: null, seq: null, localId, messageRole: 'user', content,
                    requestedAction: { v: 1, kind: 'enqueue' }, providerAction: 'send', createdAt: 1, updatedAt: 1 },
            };
            if (event === acceptanceEvent) {
                settlementAttempts += 1;
                if (settlementAttempts <= 2) throw new SocketAckError({ code: 'socket_ack_timeout', event });
                // The first lost reply may have committed: reconcile the exact idempotent replay.
                const result = { ok: true, didResolve: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4,
                    message: { id: 'committed-input', seq: 9, localId, messageRole: 'user', content, createdAt: 1, updatedAt: 1 } };
                return recipient ? { v: 2, recipient, sidechainId: 'chain-a', result } : result;
            }
            return { ok: true };
        } });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        installAxiosGetBoundaryMock(async url => ({ status: 200, data: url.endsWith('/pending') ? { pending: [] } : { messages: [] } }));
        const client = createClient(session);
        const delivered = vi.fn(() => true);
        const target = recipient ? client.bindExecutionRunPendingInput({
            recipient, sidechainId: 'chain-a', isCurrent: () => true, foregroundState: () => 'ready',
            getMetadataSnapshot: () => client.getMetadataSnapshot(), consume: delivered,
        }) : null;
        if (!target) client.onUserMessage(delivered);
        await waitForPendingInputContract(client, recipient ? 3 : 1);
        if (target) await expect(target.materializeNextPendingMessageSafely!()).resolves.toMatchObject({ type: 'materialized', localId });
        else await expect(client.popPendingMessage()).resolves.toBe(true);
        vi.useFakeTimers();
        try {
            const accepted = client.observeProviderInputSettlement({ kind: 'accepted', localId, userMessageSeq: null });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(settlementAttempts).toBe(2);
            expect(client.hasPendingProviderInput(localId)).toBe(true);
            if (target) {
                await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);
                expect(settlementAttempts).toBe(2);
            }
            // The containing settlement operation retains custody and retries
            // response loss until it commits or its socket authority retires.
            // Awaiting it after only the first retry freezes the fake clock and
            // also strands close() waiting on that same unfinished operation.
            await vi.advanceTimersByTimeAsync(1_000);
            await accepted;
            expect(client.hasPendingProviderInput(localId)).toBe(false);
            expect(client.getCommittedUserMessageSeq(localId)).toBe(9);
            expect(client.getPendingQueueState()).toMatchObject({ known: true, pendingCount: 0, pendingVersion: recipient ? 3 : 4 });
            expect(delivered).toHaveBeenCalledOnce();
            expect(settlementAttempts).toBe(3);
        } finally {
            vi.useRealTimers();
            target?.dispose();
        }
    });

    it.each(['pending-delivery-accepted-v1', 'session-publisher-authority-check'] as const)(
        'keeps %s pending until the containing server operation responds beyond the control ACK cutoff', async event => {
            const localId = 'delayed-operation';
            const session = createMockSession({ encryptionMode: 'plain', pendingCount: 1, pendingVersion: 3 });
            const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'slow settlement' }, meta: { source: 'ui' } } };
            let acknowledge!: (value: unknown) => void;
            const acknowledgement = new Promise<unknown>(resolve => { acknowledge = resolve; });
            const sessionSocket = createApiSessionSocketStub({ emitWithAck: async requestedEvent => {
                if (requestedEvent === event) return acknowledgement;
                if (requestedEvent === 'pending-materialize-next') return {
                    ok: true, didMaterialize: true, didWrite: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3,
                    deliveryState: { mode: 'provider', unresolved: true },
                    message: { id: null, seq: null, localId, messageRole: 'user', content,
                        requestedAction: { v: 1, kind: 'enqueue' }, providerAction: 'send', createdAt: 1, updatedAt: 1 },
                };
                return { ok: true };
            } });
            bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
            installAxiosGetBoundaryMock(async () => ({ status: 200, data: { messages: [] } }));
            const client = createClient(session);
            client.onUserMessage(() => {});
            await waitForPendingInputContract(client);
            if (event === 'pending-delivery-accepted-v1') await client.popPendingMessage();
            vi.useFakeTimers();
            try {
                let settled = false;
                const operation = (event === 'pending-delivery-accepted-v1'
                    ? client.observeProviderInputSettlement({ kind: 'accepted', localId, userMessageSeq: null })
                    : client.checkCurrentPublisherAuthority()).then(value => { settled = true; return value; }, error => { settled = true; return error; });
                await vi.advanceTimersByTimeAsync(30_000);
                expect(settled).toBe(false);
                acknowledge(event === 'pending-delivery-accepted-v1'
                    ? { ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4,
                        message: { id: 'committed-input', seq: 9, localId, messageRole: 'user', content, createdAt: 1, updatedAt: 1 } }
                    : { status: 'current', sessionId: session.id,
                        publisherPrecondition: { machineId: 'test-machine', committedFenceMs: 1, publisherGeneration: '1' } });
                const result = await operation;
                if (event === 'session-publisher-authority-check') expect(result).toBe(true);
                else expect(client.hasPendingProviderInput(localId)).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('joins a seq-null native delivery to the exact accepted settlement after turn completion', async () => {
        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const localId = ' causal-local ';
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'causal settlement' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(
            session.encryptionKey,
            session.encryptionVariant,
            plaintext,
        ));
        let resolveSettlement!: (value: unknown) => void;
        const settlement = new Promise<unknown>((resolve) => {
            resolveSettlement = resolve;
        });
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event) => {
                if (event === 'pending-materialize-next') {
                    return {
                        ok: true,
                        didMaterialize: true,
                        didWrite: false,
                        pendingCount: 1,
                        pendingBlockedCount: 0,
                        pendingVersion: 3,
                        deliveryState: { mode: 'provider', unresolved: true },
                        message: {
                            id: null,
                            seq: null,
                            localId,
                            messageRole: 'user',
                            content: { t: 'encrypted', c: encrypted },
                            requestedAction: { v: 1, kind: 'enqueue' },
                            providerAction: 'send',
                            createdAt: 1_000,
                            updatedAt: 1_000,
                        },
                    };
                }
                if (event === 'pending-delivery-accepted-v1') {
                    return await settlement;
                }
                return { ok: true };
            },
        });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        installAxiosGetBoundaryMock(async () => ({ status: 200, data: { messages: [] } }));

        const client = createClient(session);
        const queueState = createPermissionModeQueueState({
            session: client,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            initialPermissionMode: 'default',
        });
        await waitForPendingInputContract(client);
        await expect(client.popPendingMessage()).resolves.toBe(true);

        const queued = queueState.messageQueue.queue[0]?.message;
        expect(queued).toMatchObject({
            localId,
            text: 'causal settlement',
        });
        expect(queued?.userMessageSeq ?? null).toBeNull();
        if (!queued) throw new Error('expected materialized Queue prompt');

        const nativeListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
        const nativeSession: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch(listener) {
                nativeListeners.add(listener);
                return { dispose: () => { nativeListeners.delete(listener); } };
            },
            dispose: vi.fn(),
        };
        const mutations: SessionTurnMutationV1[] = [];
        const rollbackBoundaries: Array<Readonly<{
            turnId: string;
            providerCheckpoint: Extract<
                AgentSessionRuntimeEvent,
                { kind: 'turn-rollback-boundary' }
            >['providerCheckpoint'];
            startUserMessageSeq: number;
        }>> = [];
        const turnLifecycle = createSessionTurnLifecycle({
            agentId: 'codex',
            session: {
                sessionId: session.id,
                enqueueSessionTurnMutation: (mutation) => {
                    mutations.push(mutation);
                },
            },
        });
        const runtime = createNativeAgentSessionOperations(
            nativeSession,
            session.id,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                // This SDK boundary emits only exact delivery/lifecycle events in this test.
                context: {} as AgentSessionRuntimeContext,
                cwd: '/workspace', connectedAccounts: [],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false },
                configuration: { declared: false },
                compaction: { capability: null },
            },
            undefined,
            [],
            {
                onTurnTerminal: () => undefined,
                subscribeCommittedUserMessageSeq: (listener) => (
                    client.subscribeCommittedUserMessageSeq(listener)
                ),
                getCommittedUserMessageSeq: (pendingLocalId) => (
                    client.getCommittedUserMessageSeq(pendingLocalId)
                ),
                // The runtime's interaction lifecycle is the canonical rollback-anchor seam the
                // host consumes to write `mark_rollback_eligible`.
                onRollbackBoundary: ({ event, startUserMessageSeq }) => {
                    rollbackBoundaries.push({
                        turnId: event.turnId,
                        providerCheckpoint: event.providerCheckpoint,
                        startUserMessageSeq,
                    });
                },
            },
        );
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) turnLifecycle.observeRuntimeEvent(event);
        });
        runtime.setOnPromptDeliveryOutcome((outcome) => {
            if (outcome.type !== 'input-accepted') return;
            if (!('localId' in outcome)) {
                throw new Error('expected host-mapped native delivery outcome');
            }
            client.observeProviderInputSettlement({
                kind: 'accepted',
                localId: outcome.localId,
                userMessageSeq: outcome.userMessageSeq,
                ...(outcome.userMessageSeqs
                    ? { userMessageSeqs: outcome.userMessageSeqs }
                    : {}),
                providerTurnId: outcome.delivery.turnId,
                providerDeliveryKind: outcome.delivery.kind,
            });
        });

        await runtime.sendTurnPrompt(queued.text, {
            localId: queued.localId ?? undefined,
            userMessageSeq: queued.userMessageSeq,
            ...(queued.userMessageSeqs ? { userMessageSeqs: queued.userMessageSeqs } : {}),
            turnId: 'causal-turn',
        });
        for (const listener of nativeListeners) {
            listener({
                sequence: 1,
                sessionId: session.id,
                emittedAtMs: 1,
                kind: 'input-accepted',
                inputIds: [localId],
                delivery: { kind: 'newTurn', turnId: 'causal-turn' },
            });
        }
        await vi.waitFor(() => {
            expect(sessionSocket.emitWithAck).toHaveBeenCalledWith(
                'pending-delivery-accepted-v1',
                { v: 1, sessionId: session.id, localId },
            );
        });
        for (const listener of nativeListeners) {
            listener({
                sequence: 2,
                sessionId: session.id,
                emittedAtMs: 2,
                kind: 'turn-start',
                turnId: 'causal-turn',
                agentTurnId: 'provider-causal-turn',
                startedBy: 'host',
            });
            listener({
                sequence: 3,
                sessionId: session.id,
                emittedAtMs: 3,
                kind: 'turn-rollback-boundary',
                turnId: 'causal-turn',
                agentTurnId: 'provider-causal-turn',
                providerCheckpoint: 'provider-causal-turn',
            });
            listener({
                sequence: 4,
                sessionId: session.id,
                emittedAtMs: 4,
                kind: 'turn-complete',
                turnId: 'causal-turn',
                agentTurnId: 'provider-causal-turn',
            });
        }
        expect(rollbackBoundaries).toEqual([]);

        resolveSettlement({
            ok: true,
            didResolve: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            message: {
                id: 'causal-message-9',
                seq: 9,
                localId,
                messageRole: 'user',
                content: { t: 'encrypted', c: encrypted },
                requestedAction: { v: 1, kind: 'enqueue' },
                providerAction: 'send',
                createdAt: 1_000,
                updatedAt: 1_001,
            },
        });
        await vi.waitFor(() => {
            expect(rollbackBoundaries).toHaveLength(1);
        });
        expect(rollbackBoundaries).toEqual([{
            turnId: 'causal-turn',
            providerCheckpoint: 'provider-causal-turn',
            startUserMessageSeq: 9,
        }]);
        expect(mutations.map((mutation) => mutation.action)).toEqual(['begin', 'complete']);

        await runtime.resetOrDisposeRuntime();
    });

    it('delivers each materialized pending local id once under multi-row drain and duplicate echoes', async () => {
        const session = createMockSession({
            pendingCount: 2,
            pendingVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: { machineId: null },
        });
        const makeEncryptedUser = (text: string) => encodeBase64(encrypt(
            session.encryptionKey,
            session.encryptionVariant,
            {
                role: 'user',
                content: { type: 'text', text },
                meta: { source: 'ui' },
            },
        ));
        const firstEncrypted = makeEncryptedUser('first pending');
        const secondEncrypted = makeEncryptedUser('second pending');
        const materializeResponses = [
            {
                ok: true,
                didMaterialize: true,
                didWrite: true,
                pendingCount: 1,
                pendingVersion: 2,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted' as const, c: firstEncrypted },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            },
            {
                ok: true,
                didMaterialize: true,
                didWrite: true,
                pendingCount: 0,
                pendingVersion: 3,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-3',
                    seq: 3,
                    localId: 'local-p2',
                    messageRole: 'user',
                    content: { t: 'encrypted' as const, c: secondEncrypted },
                    providerAction: 'send',
                    createdAt: 1_100,
                    updatedAt: 1_100,
                },
            },
        ];
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event) => {
                if (event === 'update-metadata') {
                    return {
                        result: 'success',
                        version: 1,
                        metadata: encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, session.metadata)),
                    };
                }
                if (event !== 'pending-materialize-next') {
                    return { ok: true };
                }
                const next = materializeResponses.shift();
                if (!next) {
                    throw new Error('unexpected materialize call');
                }
                return next;
            },
        });
        const userSocket = createApiSessionSocketStub({ connected: true });

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(session);
        await waitForPendingInputContract(client);
        await expect(client.popPendingMessage()).resolves.toBe(true);
        await expect(client.popPendingMessage()).resolves.toBe(true);

        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        expect(onUserMessage.mock.calls.map((call) => call[0]?.localId)).toEqual(['local-p1', 'local-p2']);

        const sessionUpdateHandler = sessionSocket.getHandler('update');
        const userUpdateHandler = userSocket.getHandler('update');
        expect(typeof sessionUpdateHandler).toBe('function');
        expect(typeof userUpdateHandler).toBe('function');

        const updates = [
            {
                id: 'update-echo-1',
                seq: 2,
                createdAt: Date.now(),
                body: {
                    t: 'new-message', delivery: 'full' as const,
                    sid: session.id,
                    message: {
                        id: 'msg-2',
                        seq: 2,
                        localId: 'local-p1',
                        content: { t: 'encrypted', c: firstEncrypted },
                    },
                },
            },
            {
                id: 'update-echo-2',
                seq: 3,
                createdAt: Date.now(),
                body: {
                    t: 'new-message', delivery: 'full' as const,
                    sid: session.id,
                    message: {
                        id: 'msg-3',
                        seq: 3,
                        localId: 'local-p2',
                        content: { t: 'encrypted', c: secondEncrypted },
                    },
                },
            },
        ] as any[];

        for (const update of updates) {
            userUpdateHandler?.(update);
            sessionUpdateHandler?.(update);
            userUpdateHandler?.(update);
        }

        expect(onUserMessage.mock.calls.map((call) => call[0]?.localId)).toEqual(['local-p1', 'local-p2']);
        await expect(client.popPendingMessage()).resolves.toBe(false);
        expect(materializeResponses).toHaveLength(0);
    });

    it('materializeNextPendingMessageSafely returns structured materialized payload details', async () => {
        installAxiosGetBoundaryMock(async () => ({ data: { messages: [] } }));
        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, plaintext));
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        await waitForPendingInputContract(client);

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({
            type: 'materialized',
            localId: 'local-p1',
            seq: 2,
            content: { t: 'encrypted', c: encrypted },
            createdAt: 1_000,
            updatedAt: 1_001,
        });
        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it.each(['mcp', 'skills'] as const)('delivers queued input once through one shared gateway after both consumers replace with a captured %s launch baseline', async kind => {
      await withConfiguredDaemonTestHome({ prefix: 'pending-gateway-replacement-' }, async ({ homeDir }) => {
        vi.unstubAllGlobals();
        const nativeFetch = globalThis.fetch;
        // Home feature discovery is the network boundary. Gateway HTTP must
        // reach the real consumer application and its supervised OS process.
        vi.stubGlobal('fetch', ((input, init) => String(input).endsWith('/features')
            ? Promise.resolve(new Response(JSON.stringify(currentFeatures), { status: 200,
                headers: { 'content-type': 'application/json' } }))
            : nativeFetch(input, init)) satisfies typeof fetch);
        const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'),
            happyHomeDir: homeDir, physicalGateway: true });
        const gateway = fixture.gateway!;
        const identity = gateway.identity;
        const declaration = fixture.contributes.providersByContributionKey.get(`${identity.pluginId}/${identity.localId}`)!.definition;
        const signal = new AbortController().signal;
        const models = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, happyHomeDir: homeDir,
            featureGate: { isEnabled: () => true }, registry: fixture.contributes, getAccountSettingsSnapshot: () => fixture.snapshot,
            acquireRuntimeLease: async () => {
                const lease = gateway.controller.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('Expected serving gateway registry');
                return lease;
            }, resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
            modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected model mutation'); } });
        const open = createAccountConnectionManagedConsumerSourceOpen({ homeId: 'home', accountId: 'account', machineId: fixture.machineId,
            expectedAccountSettingsScopeKey: fixture.snapshot.scopeKey!, getAccountSettingsSnapshot: () => fixture.snapshot,
            custody: createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir,
                controller: gateway.controller }), withRegistry: async read => await read(fixture.contributes),
            resolveBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent,
            // Authenticated Home Session liveness is the external boundary.
            admitConsumer: async () => true,
            projectModels: request => models.projectModelsForAccount(request, { getAccountSettingsSnapshot: () => fixture.snapshot,
                resolveManagedPurposeBindingIntent: gateway.purposeBindingOwner.resolveBindingIntent, signal, isCurrent: () => true }) });
        const applications: Awaited<ReturnType<typeof startManagedProviderConsumerApplication>>[] = [];
        const sources: NonNullable<Awaited<ReturnType<typeof open>>>[] = [];
        const nativeSessions: AgentSessionRuntime[] = [];
        const attach = async (sessionId: string) => {
            const source = await open({ signal, consumer: { kind: 'session', sessionId }, consumerMachineId: fixture.machineId,
                source: { kind: 'account_connection', connectionId: fixture.record.connectionId,
                    expectedConnectionSecurityFingerprint: fixture.record.connectionSecurityFingerprint,
                    expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({ implementationIdentity: identity,
                        managedRuntime: declaration.managedRuntime!, purposeBindings: gateway.purposeBindings }) },
                application: { agentTargetKey: fixture.agentTargetKey, implementationIdentity: identity,
                    endpointTemplateId: 'api', protocol: 'openai-responses' } });
            if (!source) throw new Error('Expected admitted Session gateway consumer');
            sources.push(source);
            const application = await startManagedProviderConsumerApplication({ signal, endpointUrl: source.access.endpointUrl('api')!,
                credentialTransport: declaration.credential!.transports[0]!,
                request: async request => await source.revalidate(request.signal)
                    ? { ok: true, response: await source.access.request(request) } : { ok: false, reasonCode: 'resource_forbidden' } });
            applications.push(application);
            return { source, application, async retire() { await application.cleanup(); await source.retire(); } };
        };
        try {
        const registration = fixture.lease.registry.agentRuntimesByAgentId.get(fixture.agentId);
        if (!registration?.hasPrimaryRuntime) throw new Error('Expected installed fixture Agent');
        const nativeRuntime = await registration.createRuntime({ signal });
        const originalConsumers = await Promise.all([attach(TEST_SESSION_ID), attach('second-session')]);
        const processFile = join(gateway.directory, 'gateway-started');
        const originalPid = Number(await readFile(processFile, 'utf8'));
        expect((await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n')).toEqual([String(originalPid)]);
        const localId = 'queued-across-capability-replacement';
        const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: false,
            servers: [{ id: 'inherited', name: 'inherited', transport: 'http',
                remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
            bindings: [{ id: 'rule', serverId: 'inherited', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
        // A retained status can still be pending while the replacement has
        // positively resolved and launched the requested server set.
        const session = createMockSession({ encryptionMode: 'plain', pendingCount: 1, pendingVersion: 3,
            metadata: { capabilitySelectionApplyV1: { [kind]: { source: 'rules', reason: 'next_turn' } } } });
        let claims = 0;
        const bindTransport = () => {
            const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
                if (event !== 'pending-materialize-next') return resolveApiSessionSocketDefaultAck(event, payload);
                claims += 1;
                return { ok: true, didMaterialize: true, didWrite: false,
                    pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4,
                    deliveryState: { mode: 'provider', unresolved: true },
                    message: { id: null, seq: null, localId, messageRole: 'user', providerAction: 'send',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'deliver once' }, meta: { source: 'ui' } } },
                        createdAt: 1, updatedAt: 1 } };
            } });
            bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        };
        // Physical runner retirement closes its transport. Resume owns a new
        // client/consumer; the server retains the exact unclaimed original.
        bindTransport();
        const retired = createClient(session);
        await waitForPendingInputContract(retired);
        const context = { machineId: fixture.machineId, machinePlatform: 'posix' as const,
            directory: '/repo', projectKey: null, agentId: fixture.agentId };
        const skillRules = [{ id: 'skill-rule', skillId: 'library', target: { t: 'allMachines' as const },
            enabled: true, createdAt: 1, updatedAt: 1 }];
        let releaseRestart!: () => void;
        const restartCompletion = new Promise<void>(resolve => { releaseRestart = resolve; });
        // Daemon restart is an OS/process boundary. The canonical synchronizer,
        // Pending transport, queue and input-consumer logic remain real.
        let restartRequests = 0;
        const restart = vi.fn(async () => {
            restartRequests += 1;
            if (restartRequests > 2) await restartCompletion;
            await originalConsumers[0]!.retire();
            return { ok: true as const, status: 'restarted' as const, sessionId: retired.sessionId };
        });
        const originalSync = createRuntimeOverrideSynchronizers({ agentTargetKey: fixture.agentTargetKey, session: retired,
            runtime: { setSessionMode: async () => {}, setSessionConfigOption: async () => {}, setSessionModelSelection: async () => {} },
            isStarted: () => true,
            capabilitySelection: { session: retired, isStarted: () => true, isSettled: () => true,
                agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
                ...(kind === 'mcp' ? {
                    initialMcpRules: { context, settings: { ...settings, bindings: [] }, mcpPluginItems: [], selectedServerIds: [] },
                    readMcpRules: () => ({ context, settings, mcpPluginItems: [] }),
                } : {
                    initialSkillRules: { context, rules: [] },
                    readSkillRules: () => ({ context, rules: skillRules }),
                }), requestRestart: restart } });
        bindTransport();
        const secondRetired = createClient(createMockSession({ ...session, id: 'second-session', pendingCount: 0 }));
        await waitForPendingInputContract(secondRetired);
        const secondSync = createRuntimeOverrideSynchronizers({ agentTargetKey: fixture.agentTargetKey, session: secondRetired,
            runtime: { setSessionMode: async () => {}, setSessionConfigOption: async () => {}, setSessionModelSelection: async () => {} },
            isStarted: () => true,
            capabilitySelection: { session: secondRetired, isStarted: () => true, isSettled: () => true,
                agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
                ...(kind === 'mcp' ? {
                    initialMcpRules: { context, settings: { ...settings, bindings: [] }, mcpPluginItems: [], selectedServerIds: [] },
                    readMcpRules: () => ({ context, settings, mcpPluginItems: [] }),
                } : { initialSkillRules: { context, rules: [] }, readSkillRules: () => ({ context, rules: skillRules }) }),
                requestRestart: async () => { restartRequests += 1; await originalConsumers[1]!.retire();
                    return { ok: true, status: 'restarted', sessionId: secondRetired.sessionId }; } } });
        try {
            await Promise.all([originalSync.flushPendingAfterStart(), secondSync.flushPendingAfterStart()]);
            expect(restart).toHaveBeenCalledTimes(1);
            expect(restartRequests).toBe(2);
            expect(claims).toBe(0);
        } finally {
            await originalSync.dispose?.();
            await secondSync.dispose?.();
            await retired.close();
            await secondRetired.close();
        }
        expect(await waitForProcessExit(originalPid)).toBe(true);
        const replacements = await Promise.all([attach(TEST_SESSION_ID), attach('second-session')]);
        const replacementPid = Number(await readFile(processFile, 'utf8'));
        expect(replacementPid).not.toBe(originalPid);
        expect(replacements[0]!.source.access.endpointUrl('api')).toBe(replacements[1]!.source.access.endpointUrl('api'));
        expect(replacements[0]!.application.renderedCredential).not.toBe(replacements[1]!.application.renderedCredential);
        expect((await readFile(join(gateway.directory, 'gateway-starts'), 'utf8')).trim().split('\n')).toEqual([
            String(originalPid), String(replacementPid),
        ]);
        bindTransport();
        const client = createClient(session);
        await waitForPendingInputContract(client);
        const queue = new MessageQueue2<{ id: string }>(() => 'mode');
        const pendingLocalIds: string[] = [];
        client.onUserMessage(message => {
            pendingLocalIds.push(message.localId!);
            queue.pushImmediate(message.content.text, { id: 'mode' });
        });
        const sync = createRuntimeOverrideSynchronizers({ agentTargetKey: fixture.agentTargetKey, session: client,
            runtime: { setSessionMode: async () => {}, setSessionConfigOption: async () => {}, setSessionModelSelection: async () => {} },
            isStarted: () => true,
            capabilitySelection: { session: client, isStarted: () => true, isSettled: () => true,
                agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
                ...(kind === 'mcp' ? {
                    initialMcpRules: { context, settings, mcpPluginItems: [], selectedServerIds: ['inherited'] },
                    readMcpRules: () => ({ context, settings, mcpPluginItems: [] }),
                } : {
                    initialSkillRules: { context, rules: skillRules },
                    readSkillRules: () => ({ context, rules: skillRules }),
                }), requestRestart: restart } });
        const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
            session: { waitForMetadataUpdate: signal => client.waitForMetadataUpdate(signal),
                materializeNextPendingMessageSafely: options => client.materializeNextPendingMessageSafely(options),
                getMetadataSnapshot: () => client.getMetadataSnapshot(),
                hasPendingProviderInput: () => { const state = client.getPendingQueueState(); return state.known && state.pendingCount > 0; },
                reconcilePendingProviderInputCustodyBeforeMaterialization: () => client.reconcilePendingProviderInputCustodyBeforeMaterialization() },
            beforeCollectQueuedBatch: () => sync.flushPendingAfterStart(), refreshBeforeQueuedBatch: false, reconcileWhenEmpty: 'skip' });
        const controller = new AbortController();
        const delivered: unknown[] = [];
        const waiting = consumer.waitForNextInput({ abortSignal: controller.signal }).then(batch => { delivered.push(batch); return batch; });
        try {
            await vi.waitFor(() => expect(delivered).toEqual([expect.objectContaining({ message: 'deliver once' })]));
            expect(restart).toHaveBeenCalledTimes(1);
            expect(claims).toBe(1);
            expect(queue.size()).toBe(0);
            const batch = await waiting;
            if (!batch) throw new Error('Expected original Pending input');
            const endpoint = replacements[0]!.application;
            if (!nativeRuntime.sessions) throw new Error('Expected fixture Agent Session runtime');
            const nativeSession = await nativeRuntime.sessions.open({ kind: 'create', sessionId: TEST_SESSION_ID, cwd: homeDir,
                launchEnvironment: { values: { RUN_PROVIDER_TOKEN: endpoint.credential }, unset: [] },
                providerBinding: { connectionId: 'fixture-provider', upstream: { protocol: 'openai-responses', normalizedUrl: endpoint.endpointUrl, credential: 'apiKey' },
                    model: { id: 'example', name: 'Example' }, materialization: { v: 1, kind: 'spawnEnv' } } },
                // This installed boundary fixture reads only the cancellation signal;
                // no host domain service is replaced by the reduced context.
                { signal } as AgentSessionRuntimeContext);
            nativeSessions.push(nativeSession);
            expect(pendingLocalIds).toEqual([localId]);
            await expect(nativeSession.send({ inputIds: [pendingLocalIds[0]!], input: { text: batch.message },
                delivery: { kind: 'newTurn', turnId: 'retained-pending-turn' } })).resolves.toEqual({ status: 'admitted' });
            // The HTTP boundary withholds advisory status writes. Reobserving
            // that retained status still cannot restart or redeliver the input.
            sync.syncFromMetadata();
            await sync.flushPendingAfterStart();
            expect(restart).toHaveBeenCalledTimes(1);
            expect(delivered).toHaveLength(1);
            expect(claims).toBe(1);
            expect((await readFile(join(gateway.directory, 'gateway-inputs'), 'utf8')).trim().split('\n')).toEqual(['deliver once']);
            expect(await readFile(processFile, 'utf8')).toBe(String(replacementPid));
        } finally {
            controller.abort(); releaseRestart(); await sync.dispose?.(); await waiting;
        }
        } finally {
            await Promise.all(nativeSessions.map(session => session.dispose()));
            await Promise.all(applications.map(application => application.cleanup()));
            await Promise.all(sources.map(source => source.retire()));
            await fixture.cleanup();
        }
      });
    }, 30_000);

    it.each(['recover', 'cancel'] as const)('rejoins the same Pending claim through repeated settlement uncertainty until %s', async (outcome) => {
        const localId = 'retained-first-input';
        const session = createMockSession({ encryptionMode: 'plain', pendingCount: 1, pendingVersion: 1 });
        const request = SessionInputRequestV1Schema.parse({
            v: 1, producer: 'happierApp', caller: { kind: 'host' },
            permission: { requestedPermissionCeiling: 'default' },
        });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({
            v: 1, issuer: 'authenticatedAccount', actorAccountId: 'owner', sessionRelationship: 'owner',
        });
        const settlementLocalIds: string[] = [];
        let available = false;
        const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
            if (event === 'pending-materialize-next') return {
                ok: true, didMaterialize: true, didWrite: false, localId,
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1,
                deliveryState: { mode: 'provider', unresolved: true },
                message: { id: null, seq: null, localId, messageRole: 'user', createdAt: 1, updatedAt: 1,
                    providerAction: 'send', inputAdmissionReceipt: receipt,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained prompt' },
                        localId, meta: { happierInputRequestV1: request } } } },
            };
            if (event === 'session-pending-admission-settlement-v1') {
                settlementLocalIds.push((payload as { localId: string }).localId);
                return { v: 1, result: available ? { status: 'accepted', localId }
                    : { status: 'outcomeUnknown', localId, code: 'session_input_settlement_outcome_unknown' } };
            }
            return { ok: true };
        } });
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket: createApiSessionSocketStub() });
        const client = createClient(session);
        await waitForPendingInputContract(client);
        const queue = new MessageQueue2<{ id: string }>(() => 'mode');
        client.onUserMessage(message => {
            queue.pushImmediate(message.content.text, { id: 'mode' });
        });
        const consumer = createSessionProviderInputConsumer({
            messageQueue: queue,
            session: {
                waitForMetadataUpdate: signal => client.waitForMetadataUpdate(signal),
                materializeNextPendingMessageSafely: options => client.materializeNextPendingMessageSafely(options),
                getMetadataSnapshot: () => client.getMetadataSnapshot(),
                hasPendingProviderInput: () => { const state = client.getPendingQueueState(); return state.known && state.pendingCount > 0; },
                reconcilePendingProviderInputCustodyBeforeMaterialization: () => client.reconcilePendingProviderInputCustodyBeforeMaterialization(),
            },
            reconcileWhenEmpty: 'skip',
        });
        const controller = new AbortController();
        vi.useFakeTimers();
        const delivered: unknown[] = [];
        const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
        void waiting.then(value => { delivered.push(value); });
        try {
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(500);
            expect(delivered).toEqual([]);
            available = true;
            if (outcome === 'cancel') controller.abort();
            await vi.advanceTimersByTimeAsync(500);
            expect(delivered).toEqual(outcome === 'recover'
                ? [expect.objectContaining({ message: 'retained prompt' })] : [null]);
            expect(new Set(settlementLocalIds)).toEqual(new Set([localId]));
            expect(settlementLocalIds.length).toBeGreaterThan(2);
            const completedSettlements = settlementLocalIds.length;
            await vi.advanceTimersByTimeAsync(1_000);
            expect(settlementLocalIds).toHaveLength(completedSettlements);
        } finally {
            controller.abort();
            await waiting;
            vi.useRealTimers();
        }
    });

    it.each(['recover', 'cancel'] as const)('rejoins an active-turn Pending claim after the server retry delay without another wake or duplicate input (%s)', async outcome => {
        const localId = 'active-turn-retained-claim';
        const claimRequests: unknown[] = [];
        let claimAvailable = false;
        const session = createMockSession({ encryptionMode: 'plain', pendingCount: 1, pendingVersion: 3,
            latestTurnStatus: 'in_progress' });
        const sessionSocket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') return resolveApiSessionSocketDefaultAck(event, payload);
            if (!claimAvailable) return { ok: true, didMaterialize: false,
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 };
            claimRequests.push(payload);
            if (claimRequests.length === 1) return { ok: false, error: 'transaction-unavailable', retryAfterMs: 750 };
            return {
                ok: true, didMaterialize: true, didWrite: false,
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4,
                deliveryState: { mode: 'provider', unresolved: true },
                message: { id: null, seq: null, localId, messageRole: 'user',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send this once' },
                        meta: { source: 'ui' } } },
                    requestedAction: { v: 1, kind: 'send_now' }, providerAction: 'send', createdAt: 1, updatedAt: 1 },
            };
        } });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        const client = createClient(session);
        const delivered: string[] = [];
        client.onUserMessage(message => { delivered.push(message.content.text); });
        await waitForPendingInputContract(client);
        const consumer = createSessionProviderInputConsumer({
            messageQueue: new MessageQueue2<{ id: string }>(() => 'mode'),
            session: {
                waitForMetadataUpdate: signal => client.waitForMetadataUpdate(signal),
                materializeNextPendingMessageSafely: options => client.materializeNextPendingMessageSafely(options),
                getMetadataSnapshot: () => client.getMetadataSnapshot(),
                reconcilePendingProviderInputCustodyBeforeMaterialization: () => client.reconcilePendingProviderInputCustodyBeforeMaterialization(),
            },
        });
        const controller = new AbortController();
        vi.useFakeTimers();
        const pump = consumer.pumpPendingWhileActive({ abortSignal: controller.signal });
        try {
            // Settle attach/contract wakes before introducing the retained claim.
            await vi.advanceTimersByTimeAsync(0);
            claimAvailable = true;
            userSocket.trigger('update', { id: 'new-pending-claim', seq: 1, createdAt: 1,
                body: { t: 'pending-changed', sid: session.id, pendingCount: 1,
                    pendingBlockedCount: 0, pendingVersion: 4 } });
            await vi.advanceTimersByTimeAsync(0);
            expect(claimRequests).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(749);
            expect(claimRequests).toHaveLength(1);
            expect(delivered).toEqual([]);
            if (outcome === 'cancel') controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            const expectedDelivered = outcome === 'recover' ? ['send this once'] : [];
            expect(delivered).toEqual(expectedDelivered);
            expect(claimRequests).toHaveLength(outcome === 'recover' ? 2 : 1);
            if (outcome === 'recover') expect(claimRequests[1]).toEqual(claimRequests[0]);
            await vi.advanceTimersByTimeAsync(1_500);
            expect(delivered).toEqual(expectedDelivered);
        } finally {
            controller.abort();
            await pump;
            vi.useRealTimers();
        }
    });

    it('does not redrive materialization over HTTP after a connected socket RPC becomes ambiguous', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('timeout');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await vi.waitFor(() => {
            expect((client as any).socket).toBe(sessionSocket);
        });
        const result = await client.materializeNextPendingMessageSafely();

        expect(result).toEqual({ type: 'retryable_transport' });
        expect(postSpy).not.toHaveBeenCalled();
    });


    it('keeps materialization pending beyond the control cutoff and does not redrive over HTTP after actual ACK loss', async () => {
        const previousTimeout = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '5';

        try {
            let loseAck!: (error: Error) => void;
            const materializationAck = new Promise<never>((_resolve, reject) => { loseAck = reject; });
            const sessionSocket = createApiSessionSocketStub({
                connected: true,
                // Lose only this operation's ACK. Registration/activity/close
                // still obey the canonical socket boundary contract.
                emitWithAck: async (event, payload) => event === 'pending-materialize-next'
                    ? materializationAck
                    : resolveApiSessionSocketDefaultAck(event, payload),
            });
            const userSocket = createApiSessionSocketStub();

            bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

            const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

            const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
            await waitForPendingInputContract(client);
            vi.useFakeTimers();
            let settled = false;
            const materializePromise = client.materializeNextPendingMessageSafely().then((value) => {
                settled = true;
                return { status: 'resolved' as const, value };
            });

            await vi.waitFor(() => expect(sessionSocket.emitWithAck.mock.calls.some(
                ([event]) => event === 'pending-materialize-next',
            )).toBe(true));
            await vi.advanceTimersByTimeAsync(100);
            expect(settled).toBe(false);
            loseAck(new SocketAckError({ code: 'socket_ack_timeout', event: 'pending-materialize-next' }));
            await expect(materializePromise).resolves.toMatchObject({ status: 'resolved', value: { type: 'retryable_transport' } });
            expect(postSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            if (typeof previousTimeout === 'string') {
                process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = previousTimeout;
            } else {
                delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
            }
        }
    });


    it('reports terminal auth failures from socket pending materialization into the session supervisor state', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event) => {
                if (event === 'pending-materialize-next') throw new HttpStatusError(401, 'Authentication failed');
                return { ok: true };
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await waitForPendingInputContract(client);

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });
        expect(postSpy).not.toHaveBeenCalled();

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('auth_failed');
        });
    });


    it('popPendingMessage fails fast when the session supervisor is already auth_failed', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post');

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 1 }));
        const supervisor = (client as any).sessionConnectionSupervisor;
        const probeScope = supervisor?.captureProbeReportScope?.();
        supervisor?.reportProbeResult?.({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: 'expired token',
        }, probeScope);

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('auth_failed');
        });

        await expect(client.popPendingMessage()).resolves.toBe(false);
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('does not redrive a connected socket materialization over HTTP while the supervisor is offline', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
                throw new Error('socket materialize unavailable');
            },
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post');

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 1 }));
        const supervisor = (client as any).sessionConnectionSupervisor;
        const probeScope = supervisor?.captureProbeReportScope?.();
        supervisor?.reportProbeResult?.({
            status: 'server_unreachable',
            errorMessage: 'offline',
        }, probeScope);

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('offline');
        });

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'retryable_transport' });
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('waitForMetadataUpdate resolves when pending-changed update arrives', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(mockSession);
        const waitPromise = client.waitForMetadataUpdate();

        const updateHandler = userSocket.getHandler('update');
        expect(typeof updateHandler).toBe('function');

        updateHandler?.({
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: { t: 'pending-changed', sid: mockSession.id, pendingCount: 1, pendingVersion: 1 },
        } as any);

        await expect(waitPromise).resolves.toBe(true);
    });

    it('publishes pending-changed once without owning a recursive materialization retry timer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket, fallbackSocket: sessionSocket });
        const client = createClient(createMockSession({ pendingCount: 0, pendingVersion: 0 }));

        try {
            const firstWake = client.waitForMetadataUpdate();
            userSocket.getHandler('update')?.({
                id: 'pending-changed-retry',
                seq: 1,
                createdAt: Date.now(),
                body: {
                    t: 'pending-changed',
                    sid: client.sessionId,
                    pendingCount: 1,
                    pendingBlockedCount: 0,
                    pendingVersion: 1,
                },
            } as any);

            await expect(firstWake).resolves.toBe(true);

            const abortController = new AbortController();
            let secondWakeResult: boolean | null = null;
            void client.waitForMetadataUpdate(abortController.signal).then((result) => {
                secondWakeResult = result;
            });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(secondWakeResult).toBeNull();
            abortController.abort();
            await vi.waitFor(() => expect(secondWakeResult).toBe(false));
        } finally {
            await client.close();
            vi.useRealTimers();
        }
    });

    it('committed materialized payloads can still be decrypted for assertions', async () => {
        // The committed transcript wire is the canonical Session transcript observation.
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
                }
                if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                    return {
                        ok: true,
                        status: 'observed',
                        id: 'observed-msg-1',
                        seq: 1,
                        localId: (payload as { localId: string }).localId,
                        didWrite: true,
                        ingestedAt: 1_000,
                    };
                }
                return { ok: true };
            },
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(mockSession);
        await waitForPendingInputContract(client);
        await client.activateDurableMutationDelivery();
        await client.enqueueAgentMessageCommitted('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { filePath: '/etc/hosts' },
            id: 'msg-1',
        }, {
            localId: 'msg-1',
            provenance: { kind: 'non_dependent', source: 'background' },
        });

        await flushApiSessionClientMessageCommitQueue(client as any);

        const call = sessionSocket.emitWithAck.mock.calls.find(
            (args: unknown[]) => args[0] === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
                && typeof args[1] === 'object' && args[1] !== null && 'localId' in args[1] && args[1].localId === 'msg-1',
        );
        expect(call?.[1]).toMatchObject({
            v: 1,
            sessionId: mockSession.id,
            localId: 'msg-1',
            provenance: { kind: 'non_dependent', source: 'background' },
        });
        const encrypted = (call?.[1] as { content?: unknown } | undefined)?.content;
        expect(typeof encrypted).toBe('string');
        const decrypted = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant, decodeBase64(encrypted as string));
        expect((decrypted as any).content?.type).toBe('acp');
    });
    it('keeps the cached turn status truthful for locally enqueued turn mutations and wakes pending drain on turn end', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => ({ ok: true }) });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            latestTurnStatus: 'completed',
        }));

        expect(client.shouldAttemptPendingMaterialization()).toBe(true);

        void client.enqueueSessionTurnMutation({
            v: 1,
            sessionId: mockSession.id,
            mutationId: 'mutation-begin-1',
            action: 'begin',
            turnId: 'turn-1',
            observedAt: 1,
        });
        expect(client.shouldAttemptPendingMaterialization()).toBe(true);

        const wakes: string[] = [];
        client.on('metadata-updated', () => wakes.push('wake'));

        const completeMutation = client.enqueueSessionTurnMutation({
            v: 1,
            sessionId: mockSession.id,
            mutationId: 'mutation-complete-1',
            action: 'complete',
            turnId: 'turn-1',
            observedAt: 2,
        });

        expect(client.shouldAttemptPendingMaterialization()).toBe(true);
        await completeMutation;
        await vi.waitFor(() => {
            expect(wakes.length).toBeGreaterThan(0);
        });
    });

    it('self-heals a stale busy turn status when no local turn is active', async () => {
        const session = createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'in_progress',
        });
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'owed prompt' },
            meta: { source: 'ui' },
        };
        const encryptedBody = encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, plaintext));
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                deliveryState: { mode: 'provider', unresolved: true },
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encryptedBody },
                    providerAction: 'send',
                    createdAt: 1_000,
                    updatedAt: 1_001,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        sessionSnapshotHttpResponse = createSessionSnapshotHttpResponse({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 4,
            latestTurnStatus: 'completed',
        });

        // Stale busy gate: server snapshot said in_progress but no local turn ever began
        // (e.g. a respawned runner) — queued messages must not starve forever.
        const client = createClient(session);

        await waitForPendingInputContract(client);

        const result = await client.materializeNextPendingMessageSafely();
        expectSessionSnapshotRead('session-detail:explicit-drain');
        expect(result.type).toBe('materialized');
    });

    it('does not self-heal the busy gate while a local turn is active', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => ({ ok: true }) });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'in_progress',
        }));
        void client.enqueueSessionTurnMutation({
            v: 1,
            sessionId: mockSession.id,
            mutationId: 'mutation-begin-2',
            action: 'begin',
            turnId: 'turn-2',
            observedAt: 1,
        });

        await waitForPendingInputContract(client);

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        expect(readSessionSnapshotRequestPurposes()).toEqual([]);
    });

    it('does not apply a local active-turn skip before the server Pending owner', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => ({ ok: true }) });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const { logger } = await import('@/ui/logger');
        const debugSpy = vi.spyOn(logger, 'debug');

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'in_progress',
        }));
        void client.enqueueSessionTurnMutation({
            v: 1,
            sessionId: mockSession.id,
            mutationId: 'mutation-begin-3',
            action: 'begin',
            turnId: 'turn-3',
            observedAt: 1,
        });

        await waitForPendingInputContract(client);

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        const skipLog = debugSpy.mock.calls.find((call) => String(call[0]).includes('materialization skipped'));
        expect(skipLog).toBeUndefined();
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: mockSession.id,
            pendingVersion: 4,
            deliveryState: 'provider',
            deliveryTiming: 'after_foreground_ready',
            foregroundState: 'ready',
        });
    });
});
