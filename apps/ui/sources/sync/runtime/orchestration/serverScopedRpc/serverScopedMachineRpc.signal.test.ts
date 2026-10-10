import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';

const HOME_URL = 'https://signal-home.example.test';
const TOKEN = `hdr.${btoa(JSON.stringify({ sub: 'signal-account' }))}.sig`;
const ioSpy = vi.hoisted(() => vi.fn());
const runtimeFetchSpy = vi.hoisted(() => vi.fn());

// Only credential persistence and the HTTP/Socket.IO network edges are replaced.
// Scope selection, transport acquisition, encryption mode and cancellation stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return await createTokenStorageModuleMock({
        importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: {
            getCredentialsForServerUrl: async (serverUrl: string) => (
                serverUrl === HOME_URL ? { token: TOKEN } : null
            ),
        },
    });
});

vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchSpy(...args),
}));

describe('machineRpcWithServerScope signal', () => {
    let boundary: ReturnType<typeof createSocketIoBoundaryStub>;
    let serverId: string;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `signal_${crypto.randomUUID()}`;
        const profile = await upsertServerProfile({ serverUrl: HOME_URL, name: 'Signal Home' });
        serverId = profile.id;
        boundary = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(boundary.socket);
        runtimeFetchSpy.mockImplementation(async (input: unknown) => {
            if (new URL(String(input)).pathname === '/v1/account/encryption') {
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            return Response.json({
                machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
            });
        });
    });

    afterEach(async () => {
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        ioSpy.mockReset();
        runtimeFetchSpy.mockReset();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('rejects with an abort error when the signal fires during an in-flight attempt', async () => {
        boundary.socket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const rpcPromise = machineRpcWithServerScope({
            serverId,
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            signal: controller.signal,
        });
        const captured = rpcPromise.catch((error: unknown) => error);

        await vi.waitFor(() => expect(boundary.socket.emitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.CALL,
            expect.objectContaining({ method: 'machine-1:method-test', params: { value: 1 } }),
        ));
        const request = boundary.socket.emitWithAck.mock.calls.find(([event]) => event === SOCKET_RPC_EVENTS.CALL)?.[1];
        if (!request || typeof request !== 'object' || !('requestId' in request) || typeof request.requestId !== 'string') {
            throw new Error('The cancellable network request must have a request id');
        }
        controller.abort();

        const error = await captured;
        expect(error).toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        expect(boundary.socket.emit).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.CANCEL,
            { requestId: request.requestId },
        );
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const error = await machineRpcWithServerScope({
            serverId,
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
            signal: controller.signal,
        }).catch((failure: unknown) => failure);

        expect(error).toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        expect(readRpcRequestDisposition(error)).toBe('notSent');
        expect(boundary.socket.emitWithAck).not.toHaveBeenCalled();
        expect(boundary.socket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, expect.anything());
        expect(runtimeFetchSpy).not.toHaveBeenCalled();
    });

    it('resolves normally when no signal is provided', async () => {
        boundary.socket.emitWithAck.mockResolvedValue({ ok: true, result: { ok: true } });
        await expect(machineRpcWithServerScope({
            serverId,
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
        })).resolves.toEqual({ ok: true });
    });
});
