import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

const storageMock = vi.hoisted(() => ({
    getState: vi.fn(),
}));

type ApiSocketPrivateTestSurface = {
    socket: {
        connected?: boolean;
        timeout: (timeoutMs: number) => { emitWithAck: ReturnType<typeof vi.fn> };
        emitWithAck: ReturnType<typeof vi.fn>;
    };
    encryption: { getSessionEncryption: () => null };
    currentConnectionState: ManagedConnectionState;
};

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

    it('signals exact issuance only after encryption, socket validation, and timeout emitter preparation', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'e2ee' },
            },
        });
        const calls: string[] = [];
        const encryptRaw = vi.fn(async () => {
            calls.push('encrypt');
            return 'encrypted-params';
        });
        const decryptRaw = vi.fn(async () => ({ ok: true }));
        const emitWithAck = vi.fn(async () => {
            calls.push('emit');
            return { ok: true, result: 'encrypted-result' };
        });
        const timeout = vi.fn(() => {
            calls.push('timeout-emitter');
            return { emitWithAck };
        });
        const onIssued = vi.fn(() => calls.push('issued'));

        const { apiSocket } = await import('./apiSocket');
        (apiSocket as any).socket = { connected: true, timeout, emitWithAck: vi.fn() };
        (apiSocket as any).encryption = { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) };

        await expect(apiSocket.sessionRPC(
            's1',
            'exact',
            { localId: 'exact-local' },
            { timeoutMs: 7500, onIssued },
        )).resolves.toEqual({ ok: true });

        expect(calls).toEqual(['encrypt', 'timeout-emitter', 'issued', 'emit']);
        expect(onIssued).toHaveBeenCalledTimes(1);
    });

    it('does not hang when Socket.IO ACK never settles after the configured timeout', async () => {
        vi.useFakeTimers();
        try {
            storageMock.getState.mockReturnValue({
                sessions: {
                    s1: { id: 's1', encryptionMode: 'plain' },
                },
            });

            const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
            const timeout = vi.fn(() => ({ emitWithAck }));

            const { apiSocket } = await import('./apiSocket');
            const apiSocketTestSurface = apiSocket as unknown as ApiSocketPrivateTestSurface;
            apiSocketTestSurface.socket = { timeout, emitWithAck: vi.fn() };
            apiSocketTestSurface.encryption = { getSessionEncryption: () => null };
            apiSocketTestSurface.currentConnectionState = {
                phase: 'online',
                reason: 'initial_connect',
                attempt: 1,
                nextRetryAt: null,
                lastConnectedAt: Date.now(),
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            };

            const responsePromise = apiSocket.sessionRPC('s1', 'ping', { hello: 'world' }, { timeoutMs: 7500 });
            const settled = responsePromise.then(
                () => ({ state: 'resolved' as const }),
                (error: unknown) => ({ state: 'rejected' as const, error }),
            );

            await vi.advanceTimersByTimeAsync(7_500);
            await vi.advanceTimersByTimeAsync(250);

            await expect(Promise.race([settled, Promise.resolve({ state: 'pending' as const })])).resolves.toMatchObject({
                state: 'rejected',
                error: expect.any(Error),
            });
            expect(timeout).toHaveBeenCalledWith(7500);
        } finally {
            vi.useRealTimers();
        }
    });

    it('surfaces reachability auth_failed as a non-retryable auth HappyError instead of waiting for socket ack timeout', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn(async () => {
            throw new Error('operation has timed out');
        });
        const timeout = vi.fn(() => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        const apiSocketTestSurface = apiSocket as unknown as ApiSocketPrivateTestSurface;
        apiSocketTestSurface.socket = { timeout, emitWithAck: vi.fn() };
        apiSocketTestSurface.encryption = { getSessionEncryption: () => null };
        apiSocketTestSurface.currentConnectionState = {
            phase: 'auth_failed',
            reason: 'auth_invalid',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'HTTP 401',
        };

        await expect(
            apiSocket.sessionRPC('s1', 'ping', { hello: 'world' }, { timeoutMs: 7500 }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            code: 'not_authenticated',
            canTryAgain: false,
        });
        expect(timeout).not.toHaveBeenCalled();
    });

    it('rejects immediately when the retained socket object is disconnected', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn(async () => ({ ok: true, result: { ok: true } }));
        const timeout = vi.fn(() => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        const apiSocketTestSurface = apiSocket as unknown as ApiSocketPrivateTestSurface;
        apiSocketTestSurface.socket = { connected: false, timeout, emitWithAck };
        apiSocketTestSurface.encryption = { getSessionEncryption: () => null };
        apiSocketTestSurface.currentConnectionState = {
            phase: 'online',
            reason: 'initial_connect',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        };

        await expect(
            apiSocket.sessionRPC('s1', 'ping', { hello: 'world' }, { timeoutMs: 7500 }),
        ).rejects.toThrow('Socket not connected');
        expect(timeout).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
    });
});
