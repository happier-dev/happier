import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    getState: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: storageMock,
});
});

describe('apiSocket.sessionRPC plaintext sessions', () => {
    beforeEach(() => {
        storageMock.getState.mockReset();
    });

    it('sends plaintext params when session encryptionMode is plain and session encryption is missing', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn(async () => ({ ok: true, result: { ok: true, value: 123 } }));

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).socket = { emitWithAck };
        (apiSocket as any).encryption = { getSessionEncryption: () => null };

        const response = await apiSocket.sessionRPC<{ ok: true; value: number }, { hello: string }>('s1', 'ping', { hello: 'world' });

        expect(emitWithAck).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                method: 's1:ping',
                params: { hello: 'world' },
            }),
        );
        expect(response).toEqual({ ok: true, value: 123 });
    });

    it('fails closed when encryptionMode is not plain and session encryption is missing', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'e2ee' },
            },
        });

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).socket = { emitWithAck: vi.fn() };
        (apiSocket as any).encryption = { getSessionEncryption: () => null };

        await expect(apiSocket.sessionRPC('s1', 'ping', { hello: 'world' })).rejects.toThrow('Session encryption not found');
    });

    it('prefers plaintext params when local state reports encryptionMode=plain even if an encryption object exists', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn(async () => ({ ok: true, result: { ok: true, value: 456 } }));
        const encryptRaw = vi.fn(async () => ({ encrypted: true }));
        const decryptRaw = vi.fn(async () => ({ decrypted: true }));

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).socket = { emitWithAck };
        (apiSocket as any).encryption = { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) };

        const response = await apiSocket.sessionRPC<{ ok: true; value: number }, { hello: string }>('s1', 'ping', { hello: 'world' });

        expect(encryptRaw).not.toHaveBeenCalled();
        expect(decryptRaw).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                method: 's1:ping',
                params: { hello: 'world' },
            }),
        );
        expect(response).toEqual({ ok: true, value: 456 });
    });

    it('uses socket ack timeouts when session RPC options provide timeoutMs', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn(async () => ({ ok: true, result: { ok: true, value: 789 } }));
        const timeout = vi.fn(() => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).socket = { timeout, emitWithAck: vi.fn() };
        (apiSocket as any).encryption = { getSessionEncryption: () => null };

        const response = await apiSocket.sessionRPC<{ ok: true; value: number }, { hello: string }>(
            's1',
            'ping',
            { hello: 'world' },
            { timeoutMs: 7500 },
        );

        expect(timeout).toHaveBeenCalledWith(7500);
        expect(emitWithAck).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                method: 's1:ping',
                params: { hello: 'world' },
            }),
        );
        expect(response).toEqual({ ok: true, value: 789 });
    });
});
