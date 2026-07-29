import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import type { createEphemeralServerSocketClient as createEphemeralServerSocketClientFn } from './createEphemeralServerSocketClient';
import type { resolveServerScopedContext as resolveServerScopedContextFn } from './resolveServerScopedContext';
import type { ScopedRpcEncryptionContext } from './serverScopedRpcTypes';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const state = vi.hoisted(() => ({
    profileId: 'user-1',
}));

const apiSocketSendTransferRelayV2EnvelopeSpy = vi.hoisted(() => vi.fn<(payload: TransferRelayV2SendEnvelope) => void>());
const apiSocketOnTransferRelayV2EnvelopeSpy = vi.hoisted(() => vi.fn<(listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void>(() => () => {}));
const createEphemeralServerSocketClientSpy = vi.hoisted(() => vi.fn<typeof createEphemeralServerSocketClientFn>());
const resolveServerScopedContextSpy = vi.hoisted(() => vi.fn<typeof resolveServerScopedContextFn>());
const scopedRpcEncryptionStub: ScopedRpcEncryptionContext = {
    decryptEncryptionKey: async () => null,
    initializeMachines: async () => {},
    getMachineEncryption: () => null,
};

const storageMock = createStorageModuleStub({
    storage: {
        getState: () => ({
            profile: state.profileId ? { id: state.profileId } : null,
        }),
    } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        sendTransferRelayV2Envelope: (payload: TransferRelayV2SendEnvelope) => apiSocketSendTransferRelayV2EnvelopeSpy(payload),
        onTransferRelayV2Envelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => apiSocketOnTransferRelayV2EnvelopeSpy(listener),
    },
}));

vi.mock('./createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (
        params: Parameters<typeof createEphemeralServerSocketClientFn>[0],
    ) => createEphemeralServerSocketClientSpy(params),
}));

vi.mock('./resolveServerScopedContext', () => ({
    resolveServerScopedContext: (
        params: Parameters<typeof resolveServerScopedContextFn>[0],
    ) => resolveServerScopedContextSpy(params),
}));

describe('resolveServerScopedTransferRelaySocket', () => {
    beforeEach(() => {
        state.profileId = 'user-1';
        apiSocketSendTransferRelayV2EnvelopeSpy.mockReset();
        apiSocketOnTransferRelayV2EnvelopeSpy.mockReset();
        apiSocketOnTransferRelayV2EnvelopeSpy.mockImplementation(() => () => {});
        createEphemeralServerSocketClientSpy.mockReset();
        resolveServerScopedContextSpy.mockReset();
    });

    it('uses the active apiSocket when the target server is active', async () => {
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 1_000,
        });

        const { resolveServerScopedTransferRelaySocket } = await import('./serverScopedTransferRelaySocket');
        const client = await resolveServerScopedTransferRelaySocket({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 1_000,
        });

        expect(client.scopeUserId).toBe('user-1');
        expect(client.machineId).toBe('machine-1');

        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);
        const envelope: TransferRelayV2SendEnvelope = {
            scopeUserId: 'user-1',
            sender: {
                kind: 'user',
                socketId: 'socket-source',
            },
            recipient: {
                kind: 'machine',
                machineId: 'machine-1',
            },
            envelope: {
                transferId: 'transfer-1',
                kind: 'ack',
                nextSequence: 2,
            },
        };
        client.sendEnvelope(envelope);

        expect(apiSocketOnTransferRelayV2EnvelopeSpy).toHaveBeenCalledWith(listener);
        expect(apiSocketSendTransferRelayV2EnvelopeSpy).toHaveBeenCalledWith(envelope);

        unsubscribe();
        client.disconnect();
        expect(createEphemeralServerSocketClientSpy).not.toHaveBeenCalled();
    });

    it('uses an ephemeral scoped socket when the target server is not active', async () => {
        const socketOffSpy = vi.fn();
        const socketDisconnectSpy = vi.fn();
        const socketOnSpy = vi.fn();
        createEphemeralServerSocketClientSpy.mockResolvedValue({
            emit: vi.fn(),
            timeout: vi.fn(),
            getSocketId: vi.fn(() => 'socket-scoped'),
            disconnect: socketDisconnectSpy,
            on: socketOnSpy,
            off: socketOffSpy,
        });
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'machine-2',
            timeoutMs: 2_000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            encryption: scopedRpcEncryptionStub,
        });

        const { resolveServerScopedTransferRelaySocket } = await import('./serverScopedTransferRelaySocket');
        const client = await resolveServerScopedTransferRelaySocket({
            machineId: 'machine-2',
            serverId: 'server-b',
            timeoutMs: 2_000,
        });

        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);

        expect(createEphemeralServerSocketClientSpy).toHaveBeenCalledWith({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 2_000,
        });
        expect(socketOnSpy).toHaveBeenCalledWith(expect.any(String), listener);

        unsubscribe();
        expect(socketOffSpy).toHaveBeenCalledWith(expect.any(String), listener);

        client.disconnect();
        expect(socketDisconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the active account profile id is unavailable', async () => {
        state.profileId = '';
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 1_000,
        });

        const { resolveServerScopedTransferRelaySocket } = await import('./serverScopedTransferRelaySocket');

        await expect(resolveServerScopedTransferRelaySocket({
            machineId: 'machine-1',
            serverId: 'server-a',
            timeoutMs: 1_000,
        })).rejects.toThrow('Active account profile id is unavailable for transfer relay');
    });
});
