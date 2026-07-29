import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';
import type { createEphemeralServerSocketClient as createEphemeralServerSocketClientFn } from './createEphemeralServerSocketClient';
import type { resolveServerScopedContext as resolveServerScopedContextFn } from './resolveServerScopedContext';
import type { ScopedRpcEncryptionContext } from './serverScopedRpcTypes';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const state = vi.hoisted(() => ({
    profileId: 'user-1',
}));

const apiSocketSendSpy = vi.hoisted(() => vi.fn<(payload: MachineLiveStreamRelayEnvelopeV1) => void>());
const apiSocketOnSpy = vi.hoisted(() => vi.fn<(listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => () => void>(() => () => {}));
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
        sendMachineLiveStreamRelayEnvelope: (payload: MachineLiveStreamRelayEnvelopeV1) => apiSocketSendSpy(payload),
        onMachineLiveStreamRelayEnvelope: (listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => apiSocketOnSpy(listener),
        getSocketId: () => 'viewer-socket-1',
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

function makeStartEnvelope(): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: 'daemon-1',
        // The relay target machine is the capture daemon; the per-tab viewer rides
        // `viewerSocketId`, never a viewer id masquerading as a machine id (C4).
        targetMachineId: 'daemon-1',
        viewerSocketId: 'viewer-socket-1',
        message: {
            kind: 'control',
            control: {
                v: 1,
                streamId: 'stream-1',
                kind: 'stop',
                reasonCode: 'viewer_closed',
            },
        },
    };
}

describe('resolveServerScopedMachineLiveStreamRelaySocket', () => {
    beforeEach(() => {
        state.profileId = 'user-1';
        apiSocketSendSpy.mockReset();
        apiSocketOnSpy.mockReset();
        apiSocketOnSpy.mockImplementation(() => () => {});
        createEphemeralServerSocketClientSpy.mockReset();
        resolveServerScopedContextSpy.mockReset();
    });

    it('rides the active apiSocket when the target server is active', async () => {
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'active',
            machineId: 'daemon-1',
            timeoutMs: 1_000,
        });

        const { resolveServerScopedMachineLiveStreamRelaySocket } = await import('./serverScopedMachineLiveStreamRelaySocket');
        const client = await resolveServerScopedMachineLiveStreamRelaySocket({
            machineId: 'daemon-1',
            serverId: 'server-a',
            timeoutMs: 1_000,
        });

        expect(client.scopeUserId).toBe('user-1');
        expect(client.machineId).toBe('daemon-1');
        // The viewer identity is the account id + per-tab socket id — NOT a machine id.
        expect(client.viewerId).toBe('user-1');
        expect(client.socketId).toBe('viewer-socket-1');

        const listener = vi.fn();
        client.onEnvelope(listener);
        const envelope = makeStartEnvelope();
        client.sendEnvelope(envelope);

        expect(apiSocketOnSpy).toHaveBeenCalledWith(listener);
        expect(apiSocketSendSpy).toHaveBeenCalledWith(envelope);

        client.disconnect();
        expect(createEphemeralServerSocketClientSpy).not.toHaveBeenCalled();
    });

    it('opens an ephemeral scoped socket on the live-stream channel for a non-active server', async () => {
        const socketOffSpy = vi.fn();
        const socketDisconnectSpy = vi.fn();
        const socketOnSpy = vi.fn();
        const socketEmitSpy = vi.fn();
        createEphemeralServerSocketClientSpy.mockResolvedValue({
            emit: socketEmitSpy,
            timeout: vi.fn(),
            disconnect: socketDisconnectSpy,
            on: socketOnSpy,
            off: socketOffSpy,
            getSocketId: () => 'viewer-socket-2',
        });
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'daemon-2',
            timeoutMs: 2_000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            encryption: scopedRpcEncryptionStub,
        });

        const { resolveServerScopedMachineLiveStreamRelaySocket } = await import('./serverScopedMachineLiveStreamRelaySocket');
        const client = await resolveServerScopedMachineLiveStreamRelaySocket({
            machineId: 'daemon-2',
            serverId: 'server-b',
            timeoutMs: 2_000,
        });

        // The ephemeral cross-server socket now surfaces its connection id, so the viewer is
        // targeted per-tab (`io.to(socketId)`) instead of falling back to the shared user room.
        expect(client.socketId).toBe('viewer-socket-2');

        const listener = vi.fn();
        const unsubscribe = client.onEnvelope(listener);

        expect(createEphemeralServerSocketClientSpy).toHaveBeenCalledWith({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 2_000,
        });
        expect(socketOnSpy).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, listener);

        const envelope = makeStartEnvelope();
        client.sendEnvelope(envelope);
        expect(socketEmitSpy).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope);

        unsubscribe();
        expect(socketOffSpy).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, listener);

        client.disconnect();
        expect(socketDisconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the active account profile id is unavailable', async () => {
        state.profileId = '';
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'active',
            machineId: 'daemon-1',
            timeoutMs: 1_000,
        });

        const { resolveServerScopedMachineLiveStreamRelaySocket } = await import('./serverScopedMachineLiveStreamRelaySocket');

        await expect(resolveServerScopedMachineLiveStreamRelaySocket({
            machineId: 'daemon-1',
            serverId: 'server-a',
            timeoutMs: 1_000,
        })).rejects.toThrow('Active account profile id is unavailable for machine live-stream relay');
    });
});
