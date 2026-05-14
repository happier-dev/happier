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

describe('ApiSessionClient pending queue materialization', () => {
    let mockSession: any;
    let previousEnableV2Changes: string | undefined;

    beforeEach(() => {
        previousEnableV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        mockSession = createMockSession();
        mockIo.mockReset();
    });

    afterEach(() => {
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

        const client = new ApiSessionClient('fake-token', mockSession);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect(sessionSocket.emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: mockSession.id });
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

        const client = new ApiSessionClient('fake-token', mockSession);
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect((client as any).materializationRuntime.hasPendingQueueMaterializedLocalId('local-p1')).toBe(true);
    });

    it('does not double-deliver a materialized message when both sockets observe it', async () => {
        const sessionSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createApiSessionSocketStub({ connected: true });

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui' },
        };
        const encrypted = encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, plaintext));

        const popped = await client.popPendingMessage();
        expect(popped).toBe(true);

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

        const client = new ApiSessionClient('fake-token', mockSession);
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

        const client = new ApiSessionClient('fake-token', mockSession);
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

            const client = new ApiSessionClient('fake-token', mockSession);
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

        const client = new ApiSessionClient('fake-token', mockSession);

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

        const client = new ApiSessionClient('fake-token', mockSession);
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

        const client = new ApiSessionClient('fake-token', mockSession);
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

        const client = new ApiSessionClient('fake-token', mockSession);
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

    it('waitForMetadataUpdate resolves when pending-changed update arrives', async () => {
        const sessionSocket = createApiSessionSocketStub({ connected: true });
        const userSocket = createApiSessionSocketStub();

        bindApiSessionSocketPairMock(mockIo, { sessionSocket, userSocket });

        const client = new ApiSessionClient('fake-token', mockSession);
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

        const client = new ApiSessionClient('fake-token', mockSession);
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
