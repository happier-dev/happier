import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const storageMock = vi.hoisted(() => ({
    getState: vi.fn(),
}));

type SocketRpcCallPayload = Readonly<{
    method: string;
    params: unknown;
    timeoutMs?: number;
    requestId?: string;
}>;

type SocketRpcEmitWithAck = (
    event: string,
    payload: SocketRpcCallPayload,
) => Promise<unknown>;
type SocketRpcEmit = (
    event: string,
    payload: Readonly<{ requestId: string }>,
) => void;
type SocketRpcTimeout = (
    timeoutMs: number,
) => Readonly<{ emitWithAck: SocketRpcEmitWithAck }>;
type SessionEncryptionTestDouble = Readonly<{
    encryptRaw(value: unknown): Promise<unknown>;
    decryptRaw(value: unknown): Promise<unknown>;
}>;
type ApiSocketPrivateTestOverrides = Readonly<{
    socket: Readonly<{
        connected?: boolean;
        timeout?: SocketRpcTimeout;
        emitWithAck: SocketRpcEmitWithAck;
        emit?: SocketRpcEmit;
    }>;
    encryption: Readonly<{
        getSessionEncryption(sessionId: string): SessionEncryptionTestDouble | null;
    }>;
    currentConnectionState?: ManagedConnectionState;
}>;

function installApiSocketTestOverrides(
    apiSocket: object,
    overrides: ApiSocketPrivateTestOverrides,
): void {
    Object.assign(apiSocket, overrides);
}

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

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            async () => ({ ok: true, result: { ok: true, value: 123 } }),
        );

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { emitWithAck },
            encryption: { getSessionEncryption: () => null },
        });

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
        installApiSocketTestOverrides(apiSocket, {
            socket: { emitWithAck: vi.fn<SocketRpcEmitWithAck>() },
            encryption: { getSessionEncryption: () => null },
        });

        await expect(apiSocket.sessionRPC('s1', 'ping', { hello: 'world' })).rejects.toThrow('Session encryption not found');
    });

    it('prefers plaintext params when local state reports encryptionMode=plain even if an encryption object exists', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            async () => ({ ok: true, result: { ok: true, value: 456 } }),
        );
        const encryptRaw = vi.fn<(value: unknown) => Promise<unknown>>(
            async () => ({ encrypted: true }),
        );
        const decryptRaw = vi.fn<(value: unknown) => Promise<unknown>>(
            async () => ({ decrypted: true }),
        );

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { emitWithAck },
            encryption: { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) },
        });

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

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            async () => ({ ok: true, result: { ok: true, value: 789 } }),
        );
        const timeout = vi.fn<SocketRpcTimeout>(() => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { timeout, emitWithAck: vi.fn<SocketRpcEmitWithAck>() },
            encryption: { getSessionEncryption: () => null },
        });

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

    it('cancels the exact issued relay request when its caller signal aborts', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });
        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            () => new Promise<never>(() => {}),
        );
        const emit = vi.fn<SocketRpcEmit>();
        const controller = new AbortController();

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { emitWithAck, emit },
            encryption: { getSessionEncryption: () => null },
        });

        const pending = apiSocket.sessionRPC(
            's1',
            'catalog.list',
            { cwd: '/workspace' },
            { signal: controller.signal },
        );
        await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
        const issuedCall = emitWithAck.mock.calls[0];
        if (!issuedCall || !issuedCall[1].requestId) {
            throw new Error('Expected session RPC cancellation request id');
        }
        const requestId = issuedCall[1].requestId;

        controller.abort();

        const settled = await Promise.race([
            pending.then(
                () => ({ status: 'resolved' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            ),
            new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
        ]);
        expect(settled).toMatchObject({
            status: 'rejected',
            error: { name: 'AbortError', code: 'SOCKET_RPC_ABORTED' },
        });
        expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
            requestId,
        });
    });

    it('preserves an explicit unbounded session RPC lifetime without forwarding a timeout', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'plain' },
            },
        });

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            async () => ({ ok: true, result: { ok: true, value: 790 } }),
        );
        const timeout = vi.fn<SocketRpcTimeout>();

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { timeout, emitWithAck },
            encryption: { getSessionEncryption: () => null },
        });

        const response = await apiSocket.sessionRPC<{ ok: true; value: number }, { hello: string }>(
            's1',
            'watch',
            { hello: 'world' },
            { timeoutMs: null },
        );

        expect(timeout).not.toHaveBeenCalled();
        expect(emitWithAck).toHaveBeenCalledWith(
            expect.any(String),
            {
                method: 's1:watch',
                params: { hello: 'world' },
            },
        );
        expect(response).toEqual({ ok: true, value: 790 });
    });

    it('signals exact issuance only after encryption, socket validation, and timeout emitter preparation', async () => {
        storageMock.getState.mockReturnValue({
            sessions: {
                s1: { id: 's1', encryptionMode: 'e2ee' },
            },
        });
        const calls: string[] = [];
        const encryptRaw = vi.fn<(value: unknown) => Promise<unknown>>(async () => {
            calls.push('encrypt');
            return 'encrypted-params';
        });
        const decryptRaw = vi.fn<(value: unknown) => Promise<unknown>>(
            async () => ({ ok: true }),
        );
        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(async () => {
            calls.push('emit');
            return { ok: true, result: 'encrypted-result' };
        });
        const timeout = vi.fn<SocketRpcTimeout>(() => {
            calls.push('timeout-emitter');
            return { emitWithAck };
        });
        const onIssued = vi.fn(() => calls.push('issued'));

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: {
                connected: true,
                timeout,
                emitWithAck: vi.fn<SocketRpcEmitWithAck>(),
            },
            encryption: { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) },
        });

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

            const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
                () => new Promise<never>(() => {}),
            );
            const timeout = vi.fn<SocketRpcTimeout>(
                (_timeoutMs) => ({ emitWithAck }),
            );

            const { apiSocket } = await import('./apiSocket');
            installApiSocketTestOverrides(apiSocket, {
                socket: { timeout, emitWithAck: vi.fn<SocketRpcEmitWithAck>() },
                encryption: { getSessionEncryption: () => null },
                currentConnectionState: {
                    phase: 'online',
                    reason: 'initial_connect',
                    attempt: 1,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                },
            });

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

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(async () => {
            throw new Error('operation has timed out');
        });
        const timeout = vi.fn<SocketRpcTimeout>((_timeoutMs) => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { timeout, emitWithAck: vi.fn<SocketRpcEmitWithAck>() },
            encryption: { getSessionEncryption: () => null },
            currentConnectionState: {
                phase: 'auth_failed',
                reason: 'auth_invalid',
                attempt: 1,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: Date.now(),
                lastErrorMessage: 'HTTP 401',
            },
        });

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

        const emitWithAck = vi.fn<SocketRpcEmitWithAck>(
            async () => ({ ok: true, result: { ok: true } }),
        );
        const timeout = vi.fn<SocketRpcTimeout>((_timeoutMs) => ({ emitWithAck }));

        const { apiSocket } = await import('./apiSocket');
        installApiSocketTestOverrides(apiSocket, {
            socket: { connected: false, timeout, emitWithAck },
            encryption: { getSessionEncryption: () => null },
            currentConnectionState: {
                phase: 'online',
                reason: 'initial_connect',
                attempt: 1,
                nextRetryAt: null,
                lastConnectedAt: Date.now(),
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            },
        });

        await expect(
            apiSocket.sessionRPC('s1', 'ping', { hello: 'world' }, { timeoutMs: 7500 }),
        ).rejects.toThrow('Socket not connected');
        expect(timeout).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
    });
});
