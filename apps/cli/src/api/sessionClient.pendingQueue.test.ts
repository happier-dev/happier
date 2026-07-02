import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ApiSessionClient } from './session/sessionClient';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import { HttpStatusError } from './client/httpStatusError';
import {
    bindApiSessionSocketPairMock,
    createApiSessionSocketStub,
    flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

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
        const client = new ApiSessionClient('fake-token', session);
        clients.add(client);
        return client;
    };

    beforeEach(() => {
        previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
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
    });

    it('popPendingMessage uses pending-materialize-next and returns true when server materializes', async () => {
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

        const session = createMockSession({ pendingCount: 1, pendingVersion: 3 });
        const client = createClient(session);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: session.id,
            pendingVersion: 3,
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
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('does not materialize pending messages while continuation recovery is unresolved', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            metadata: {
                sessionContinuationRecoveryV1: {
                    v: 1,
                    attemptsById: {
                        'generation-1:restart-1': {
                            v: 1,
                            attemptId: 'generation-1:restart-1',
                            status: 'pending_provider_context',
                            failureAtMs: 100,
                            updatedAtMs: 110,
                            resumePromptMode: 'standard',
                        },
                    },
                },
            },
        }));

        expect(client.shouldAttemptPendingMaterialization()).toBe(false);
        await expect(client.popPendingMessage()).resolves.toBe(false);
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('does not materialize pending messages while the durable session turn status is active', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            latestTurnStatus: 'in_progress',
        }));

        expect(client.shouldAttemptPendingMaterialization()).toBe(false);
        await expect(client.popPendingMessage()).resolves.toBe(false);
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('refreshes durable turn status before materializing newly queued pending messages', async () => {
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
        const refreshedSnapshot = {
            pendingQueueState: {
                known: true,
                pendingCount: 1,
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
        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
        expect(fetchSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: mockSession.id,
            reason: 'explicit-drain',
        }));
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
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
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('materializes pending messages after continuation recovery reaches a terminal state', async () => {
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

        const session = createMockSession({
            pendingCount: 1,
            pendingVersion: 3,
            metadata: {
                sessionContinuationRecoveryV1: {
                    v: 1,
                    attemptsById: {
                        'generation-1:restart-1': {
                            v: 1,
                            attemptId: 'generation-1:restart-1',
                            status: 'sent',
                            failureAtMs: 100,
                            updatedAtMs: 120,
                            resumePromptMode: 'standard',
                            sentAtMs: 120,
                        },
                    },
                },
            },
        });
        const client = createClient(session);

        expect(client.shouldAttemptPendingMaterialization()).toBe(true);
        await expect(client.popPendingMessage()).resolves.toBe(true);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', {
            sid: session.id,
            pendingVersion: 3,
        });
    });

    it('discards pending messages even while continuation recovery blocks materialization', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
            data: {
                pending: [
                    { localId: 'local-p1' },
                    { localId: 'local-p2' },
                ],
            },
        });
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } });
        const session = createMockSession({
            pendingCount: 2,
            pendingVersion: 5,
            metadata: {
                sessionContinuationRecoveryV1: {
                    v: 1,
                    attemptsById: {
                        'generation-1:restart-1': {
                            v: 1,
                            attemptId: 'generation-1:restart-1',
                            status: 'sending',
                            failureAtMs: 100,
                            updatedAtMs: 110,
                            resumePromptMode: 'standard',
                        },
                    },
                },
            },
        });
        const client = createClient(session);

        expect(client.shouldAttemptPendingMaterialization()).toBe(false);
        await expect(client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' })).resolves.toBe(2);
        expect(getSpy).toHaveBeenCalled();
        expect(postSpy.mock.calls.map((call) => String(call[0]))).toEqual([
            expect.stringContaining('/pending/local-p1/discard'),
            expect.stringContaining('/pending/local-p2/discard'),
        ]);
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
        expect(sessionSocket.emitWithAck).not.toHaveBeenCalled();
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
        await expect(client.popPendingMessage()).resolves.toBe(false);
        await expect(client.popPendingMessage()).resolves.toBe(false);

        expect(sessionSocket.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('tracks materialized localIds for recovery even when the server reports an idempotent write', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: false,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
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
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
                    createdAt: 1_000,
                    updatedAt: 1_000,
                },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const popped = await client.popPendingMessage();
        expect(popped).toBe(true);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage.mock.calls[0]?.[0]).toMatchObject({
            content: { type: 'text', text: 'hello' },
            localId: 'local-p1',
        });

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

    it('delivers each materialized pending local id once under multi-row drain and duplicate echoes', async () => {
        const session = createMockSession({ pendingCount: 2, pendingVersion: 1 });
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
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted' as const, c: firstEncrypted },
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
                message: {
                    id: 'msg-3',
                    seq: 3,
                    localId: 'local-p2',
                    messageRole: 'user',
                    content: { t: 'encrypted' as const, c: secondEncrypted },
                    createdAt: 1_100,
                    updatedAt: 1_100,
                },
            },
        ];
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => {
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
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await expect(client.popPendingMessage()).resolves.toBe(true);
        await expect(client.popPendingMessage()).resolves.toBe(true);
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
        const axiosMod = await import('axios');
        vi.spyOn(axiosMod.default, 'get').mockResolvedValue({ data: { messages: [] } });
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
                message: {
                    id: 'msg-2',
                    seq: 2,
                    localId: 'local-p1',
                    messageRole: 'user',
                    content: { t: 'encrypted', c: encrypted },
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

    it('popPendingMessage falls back to HTTP materialize when socket RPC fails', async () => {
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
        const popped = await client.popPendingMessage();

        expect(popped).toBe(false);
        expect(postSpy).toHaveBeenCalled();
        expect(String(postSpy.mock.calls[0]?.[0] ?? '')).toContain(`/v2/sessions/${mockSession.id}/pending/materialize-next`);
        expect(postSpy.mock.calls[0]?.[1]).toEqual({});
        expect(postSpy.mock.calls[0]?.[2]).toMatchObject({
            headers: expect.objectContaining({
                Authorization: 'Bearer fake-token',
                'Content-Type': 'application/json',
            }),
        });
    });

    it('popPendingMessage falls back to HTTP materialize when the session socket is disconnected', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: false });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        const popped = await client.popPendingMessage();

        expect(popped).toBe(false);
        expect(postSpy).toHaveBeenCalled();
        expect(String(postSpy.mock.calls[0]?.[0] ?? '')).toContain(`/v2/sessions/${mockSession.id}/pending/materialize-next`);
        expect(postSpy.mock.calls[0]?.[1]).toEqual({});
        expect(postSpy.mock.calls[0]?.[2]).toMatchObject({
            headers: expect.objectContaining({
                Authorization: 'Bearer fake-token',
                'Content-Type': 'application/json',
            }),
        });
    });

    it('popPendingMessage falls back to HTTP materialize when the socket ACK never settles', async () => {
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
            const poppedPromise = client.popPendingMessage().then((value) => ({
                status: 'resolved' as const,
                value,
            }));

            await vi.advanceTimersByTimeAsync(100);
            const outcome = await Promise.race([
                poppedPromise,
                Promise.resolve({ status: 'pending' as const }),
            ]);

            expect(outcome).toEqual({ status: 'resolved', value: false });
            expect(postSpy).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            if (typeof previousTimeout === 'string') {
                process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = previousTimeout;
            } else {
                delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
            }
        }
    });

    it('popPendingMessage rethrows terminal auth failures from the HTTP fallback instead of collapsing them to false', async () => {
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
        vi.spyOn(axios, 'post').mockRejectedValueOnce(new HttpStatusError(401, 'Authentication failed'));

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });
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

    it('reports retryable HTTP materialization failures into the session supervisor state', async () => {
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
        vi.spyOn(axios, 'post').mockRejectedValueOnce(new HttpStatusError(503, 'Server busy'));

        const client = createClient(createMockSession({ pendingCount: 1, pendingVersion: 3 }));
        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('online');
        });

        await expect(client.popPendingMessage()).resolves.toBe(false);

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState).toMatchObject({
                phase: 'offline',
                reason: 'probe_failed',
                lastErrorMessage: 'Server busy',
            });
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

        await expect(client.popPendingMessage()).rejects.toMatchObject({
            name: 'HttpStatusError',
            response: { status: 401 },
        });
        expect(postSpy).not.toHaveBeenCalled();
    });

    it('materializeNextPendingMessageSafely defers when the session supervisor is not online', async () => {
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
            status: 'server_unreachable',
            errorMessage: 'offline',
        }, probeScope);

        await vi.waitFor(() => {
            expect((client as any).currentConnectionState.phase).toBe('offline');
        });

        await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({
            type: 'deferred',
            reason: 'supervisor_offline',
        });
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

    it('committed materialized payloads can still be decrypted for assertions', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();
        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = createClient(mockSession);
        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { filePath: '/etc/hosts' },
            id: 'msg-1',
        });

        await flushApiSessionClientMessageCommitQueue(client as any);

        const call = sessionSocket.emitWithAck.mock.calls.find((args: any[]) => args[0] === 'message');
        const encrypted = call?.[1]?.message;
        const decrypted = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant, decodeBase64(encrypted));
        expect((decrypted as any).content?.type).toBe('acp');
    });
});
