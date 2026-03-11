import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';

const ioSpy = vi.hoisted(() => vi.fn());
const machineRpcSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
    io: (...args: unknown[]) => ioSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (...args: unknown[]) => machineRpcSpy(...args),
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

describe('machineRpcWithServerScope', () => {
    afterEach(() => {
        ioSpy.mockReset();
        machineRpcSpy.mockReset();
        getCredentialsSpy.mockReset();
        createEncryptionSpy.mockReset();
        listServerProfilesSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        vi.unstubAllGlobals();
        resetScopedMachineDataKeyCacheForTests();
    });

    it('delegates to apiSocket.machineRPC when target server is omitted', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockResolvedValue({ ok: true });

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 1 },
        });

        expect(result).toEqual({ ok: true });
        expect(machineRpcSpy).toHaveBeenCalledWith(
            'machine-1',
            'method-test',
            { value: 1 },
            { timeoutMs: 30000 },
        );
        expect(ioSpy).not.toHaveBeenCalled();
    });

    it('routes RPC through a scoped socket when target server differs from active server', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([
            { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
        ]);
        getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') {
                    cb();
                }
            }),
            off: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({ ok: true, result: 'encrypted-result' })),
            })),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 2 },
            serverId: 'server-b',
            timeoutMs: 5000,
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).not.toHaveBeenCalled();
            expect(ioSpy).toHaveBeenCalledWith(
                'https://server-b.example.test',
                expect.objectContaining({
                    path: '/v1/updates',
                    auth: expect.objectContaining({
                        token: 'token-b',
                        clientType: 'user-scoped',
                    }),
                }),
            );
            const opts = ioSpy.mock.calls[0]?.[1] as any;
            expect(opts).not.toHaveProperty('transports');
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect((fakeSocket.timeout as any).mock.results[0].value.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:method-test',
            params: 'encrypted-payload',
            timeoutMs: 5000,
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket on the active server when active machine encryption is unavailable', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(new Error('Machine encryption not found for machine-1'));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') cb();
            }),
            off: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({ ok: true, result: 'encrypted-result' })),
            })),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'method-test',
            payload: { value: 3 },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://server-a.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                }),
            }),
        );
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ value: 3 });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket on the active server when the active machine rpc reports method not available', async () => {
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockRejectedValue(Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') cb();
            }),
            off: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({ ok: true, result: 'encrypted-result' })),
            })),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const result = await machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            payload: { directory: '/tmp/repo' },
        });

        expect(result).toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://server-a.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                }),
            }),
        );
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ directory: '/tmp/repo' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('falls back to a scoped socket when the active machine rpc call hangs past the timeout', async () => {
        vi.useFakeTimers();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        });
        machineRpcSpy.mockImplementation(() => new Promise(() => {}));
        getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

        const machineEncryption = {
            encryptRaw: vi.fn(async () => 'encrypted-payload'),
            decryptRaw: vi.fn(async () => ({ decoded: true })),
        };
        createEncryptionSpy.mockResolvedValue({
            decryptEncryptionKey: vi.fn(async () => null),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: vi.fn(() => machineEncryption),
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
        })));

        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') cb();
            }),
            off: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({ ok: true, result: 'encrypted-result' })),
            })),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
        const rpcPromise = machineRpcWithServerScope({
            machineId: 'machine-1',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: { handoffId: 'handoff_1' },
            timeoutMs: 1_000,
        });

        await vi.advanceTimersByTimeAsync(1_000);

        await expect(rpcPromise).resolves.toEqual({ decoded: true });
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://server-a.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                }),
            }),
        );
        expect(machineEncryption.encryptRaw).toHaveBeenCalledWith({ handoffId: 'handoff_1' });
        expect(machineEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
        expect((fakeSocket.timeout as any).mock.results[0].value.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
            method: 'machine-1:daemon.sessionHandoff.prepareTarget',
            params: 'encrypted-payload',
            timeoutMs: 1_000,
        });
        expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});
