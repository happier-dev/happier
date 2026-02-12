import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ApiSessionClient } from './session/sessionClient';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { createMockSession } from './testkit/sessionClientTestkit';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

function createSocketStub(overrides: Record<string, unknown> = {}) {
    return {
        connected: false,
        connect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        disconnect: vi.fn(),
        close: vi.fn(),
        emit: vi.fn(),
        ...overrides,
    };
}

describe('ApiSessionClient pending queue materialization', () => {
    let mockSession: any;

    beforeEach(() => {
        mockSession = createMockSession();
        mockIo.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('popPendingMessage uses pending-materialize-next and returns true when server materializes', async () => {
        const sessionSocket = createSocketStub({
            connected: true,
            timeout: vi.fn().mockReturnThis(),
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createSocketStub();

        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
        const popped = await client.popPendingMessage();

        expect(popped).toBe(true);
        expect((sessionSocket as any).emitWithAck).toHaveBeenCalledWith('pending-materialize-next', { sid: mockSession.id });
    });

    it('does not double-deliver a materialized message when both sockets observe it', async () => {
        const sessionSocket = createSocketStub({
            connected: true,
            timeout: vi.fn().mockReturnThis(),
            emitWithAck: vi.fn().mockResolvedValue({
                ok: true,
                didMaterialize: true,
                didWrite: true,
                message: { id: 'msg-2', seq: 2, localId: 'local-p1' },
            }),
        });
        const userSocket = createSocketStub({ connected: true });

        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
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

        const sessionUpdateHandler = (((sessionSocket as any).on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1]);
        const userUpdateHandler = (((userSocket as any).on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1]);
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

        userUpdateHandler(update);
        sessionUpdateHandler(update);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it('popPendingMessage falls back to HTTP materialize when socket RPC fails', async () => {
        const sessionSocket = createSocketStub({
            connected: true,
            timeout: vi.fn().mockReturnThis(),
            emitWithAck: vi.fn().mockRejectedValue(new Error('timeout')),
        });
        const userSocket = createSocketStub();

        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
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
        const sessionSocket = createSocketStub({
            connected: false,
            timeout: vi.fn().mockReturnThis(),
            emitWithAck: vi.fn(),
        });
        const userSocket = createSocketStub();

        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: { ok: true, didMaterialize: false } });

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
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

    it('waitForMetadataUpdate resolves when pending-changed update arrives', async () => {
        const sessionSocket = createSocketStub({ connected: true });
        const userSocket = createSocketStub();

        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const client = new ApiSessionClient('fake-token', { ...mockSession, metadata: {} });
        const waitPromise = client.waitForMetadataUpdate();

        const updateHandler = (((userSocket as any).on.mock.calls.find((call: any[]) => call[0] === 'update') ?? [])[1]);
        expect(typeof updateHandler).toBe('function');

        updateHandler({
            id: 'update-1',
            seq: 1,
            createdAt: Date.now(),
            body: { t: 'pending-changed', sid: mockSession.id, pendingCount: 1, pendingVersion: 1 },
        } as any);

        await expect(waitPromise).resolves.toBe(true);
    });

    it('committed materialized payloads can still be decrypted for assertions', async () => {
        const sessionSocket = createSocketStub();
        const userSocket = createSocketStub();
        mockIo.mockImplementationOnce(() => sessionSocket).mockImplementationOnce(() => userSocket);

        const client = new ApiSessionClient('fake-token', mockSession);
        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: { filePath: '/etc/hosts' },
            id: 'msg-1',
        });

        const call = ((sessionSocket as any).emit.mock.calls.find((args: any[]) => args[0] === 'message'));
        const encrypted = call?.[1]?.message;
        const decrypted = decrypt(mockSession.encryptionKey, mockSession.encryptionVariant, decodeBase64(encrypted));
        expect((decrypted as any).content?.type).toBe('acp');
    });
});
