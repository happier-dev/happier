import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

import { ApiSessionClient } from './session/sessionClient';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { HttpStatusError } from './client/httpStatusError';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import type {
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import {
    bindApiSessionSocketPairMock as bindApiSessionSocketPairHarness,
    createApiSessionSocketStub,
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

const installAxiosGetBoundaryMock = (
    fallback: (url: string) => Promise<unknown> = async () => ({ status: 200, data: {} }),
) => vi.spyOn(axios, 'get').mockImplementation((async (url: string) => {
    if (url.includes('/v1/access-keys/')) {
        return { status: 200, data: { accessKey: 'test-session-access-key' } };
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
        const client = new ApiSessionClient('fake-token', session, { localMachineId: 'test-machine' });
        clients.add(client);
        return client;
    };

    const waitForPendingInputContract = async (client: ApiSessionClient): Promise<void> => {
        await vi.waitFor(() => {
            expect((client as any).sessionSyncPendingInputServerContractResult).toMatchObject({
                mode: 'session_sync_v2_pending_input_v1',
                socket: (client as any).socket,
            });
        });
    };

    beforeEach(() => {
        previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(currentFeatures), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })));
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
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        // The server owns final foreground/action eligibility; the CLI only projects the fact.
        const snapshotSync = await import('./session/snapshotSync');
        vi.spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer').mockResolvedValue({
            latestTurnStatus: 'in_progress',
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 3,
            },
        } as Awaited<ReturnType<typeof snapshotSync.fetchSessionSnapshotUpdateFromServer>>);

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
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 1 }));
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
                    providerAction: 'send',
                },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const snapshotSync = await import('./session/snapshotSync');
        const refreshedSnapshot = {
            pendingQueueState: {
                known: true,
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 4,
            },
            latestTurnStatus: 'in_progress',
        } satisfies Awaited<ReturnType<typeof snapshotSync.fetchSessionSnapshotUpdateFromServer>> & {
            latestTurnStatus: 'in_progress';
        };
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValueOnce(refreshedSnapshot);

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'completed',
        }));

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });
        await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
            type: 'materialized',
            localId: 'local-p1',
        });
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: mockSession.id,
            reason: 'explicit-drain',
        }));
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

        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockRejectedValueOnce(new Error('snapshot unavailable'));

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 4,
            latestTurnStatus: 'completed',
        }));

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: mockSession.id,
            reason: 'explicit-drain',
        }));
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
        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValueOnce({
                pendingQueueState: {
                    known: true,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 5,
                },
            });

        const client = createClient(mockSession);
        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });

        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            token: 'fake-token',
            sessionId: mockSession.id,
        }));
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
        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValueOnce({
                pendingQueueState: {
                    known: true,
                    pendingCount: 1,
                    pendingBlockedCount: 0,
                    pendingVersion: 5,
                },
            });

        const client = createClient(mockSession);
        const count = await client.peekPendingMessageQueueV2Count();

        expect(count).toBe(0);
        expect(fetchSnapshotSpy).not.toHaveBeenCalled();
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
                t: 'new-message',
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
            agentTargetKey: 'backend:codex',
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
            undefined,
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
            },
        );
        runtime.subscribeRuntimeEvents((event) => {
            if ('kind' in event) turnLifecycle.observeRuntimeEvent(event);
        });
        runtime.setOnPromptDeliveryOutcome?.((outcome) => {
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
        expect(mutations.filter((mutation) => mutation.action === 'mark_rollback_eligible')).toEqual([]);

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
            expect(mutations.filter(
                (mutation) => mutation.action === 'mark_rollback_eligible',
            )).toHaveLength(1);
        });
        expect(mutations.filter(
            (mutation) => mutation.action === 'mark_rollback_eligible',
        )).toEqual([
            expect.objectContaining({
                turnId: 'causal-turn',
                transcriptAnchors: {
                    startUserMessageSeq: 9,
                    providerCheckpoint: 'provider-causal-turn',
                },
            }),
        ]);

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
                    t: 'new-message',
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
                    t: 'new-message',
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
        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

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


    it('does not redrive materialization over HTTP after a connected socket ACK is lost', async () => {
        const previousTimeout = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '5';
        vi.useFakeTimers();

        try {
            const sessionSocket = createApiSessionSocketStub({
                connected: true,
                emitWithAck: async () => new Promise<never>(() => {}),
            });
            const userSocket = createApiSessionSocketStub();

            bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

            const axiosMod = await import('axios');
            const axios = axiosMod.default as any;
            const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

            const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
            const materializePromise = client.materializeNextPendingMessageSafely().then((value) => ({
                status: 'resolved' as const,
                value,
            }));

            await vi.advanceTimersByTimeAsync(100);
            const outcome = await Promise.race([
                materializePromise,
                Promise.resolve({ status: 'pending' as const }),
            ]);

            expect(outcome).toEqual({ status: 'resolved', value: { type: 'retryable_transport' } });
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
            emitWithAck: async () => {
                throw new HttpStatusError(401, 'Authentication failed');
            },
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

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
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(mockSession);
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

        const call = sessionSocket.emitWithAck.mock.calls.find((args: any[]) => args[0] === 'message');
        const encrypted = call?.[1]?.message;
        const decrypted = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant, decodeBase64(encrypted));
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

        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockResolvedValue({
                pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 4 },
                latestTurnStatus: 'completed',
            } as Awaited<ReturnType<typeof snapshotSync.fetchSessionSnapshotUpdateFromServer>>);

        // Stale busy gate: server snapshot said in_progress but no local turn ever began
        // (e.g. a respawned runner) — queued messages must not starve forever.
        const client = createClient(session);

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

        const result = await client.materializeNextPendingMessageSafely();
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: mockSession.id,
            reason: 'explicit-drain',
        }));
        expect(result.type).toBe('materialized');
    });

    it('does not self-heal the busy gate while a local turn is active', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => ({ ok: true }) });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const snapshotSync = await import('./session/snapshotSync');
        const fetchSnapshotSpy = vi.spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer');

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

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        expect(fetchSnapshotSpy).not.toHaveBeenCalled();
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

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

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
