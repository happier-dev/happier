import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createEphemeralServerSocketClient as createEphemeralServerSocketClientFn } from './createEphemeralServerSocketClient';
import type { resolveServerScopedContext as resolveServerScopedContextFn } from './resolveServerScopedContext';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const state = vi.hoisted(() => ({
    profileId: 'user-1',
}));

const createEphemeralServerSocketClientSpy = vi.hoisted(() => vi.fn<typeof createEphemeralServerSocketClientFn>());
const resolveServerScopedContextSpy = vi.hoisted(() => vi.fn<typeof resolveServerScopedContextFn>());

const storageMock = createStorageModuleStub({
    storage: {
        getState: () => ({
            profile: state.profileId ? { id: state.profileId } : null,
        }),
    } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

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

type TestScopedSocket<TPayload> = {
    emit: (event: string, payload: TPayload) => void;
    on: (event: string, listener: (payload: TPayload) => void) => void;
    off: (event: string, listener: (payload: TPayload) => void) => void;
    timeout: (ms: number) => {
        emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
    };
};

describe('resolveServerScopedRelaySocket', () => {
    beforeEach(() => {
        state.profileId = 'user-1';
        createEphemeralServerSocketClientSpy.mockReset();
        resolveServerScopedContextSpy.mockReset();
    });

    it('uses the active scoped transport with the configured active socket id', async () => {
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'active',
            machineId: 'machine-1',
            timeoutMs: 2_000,
        });

        const sendSpy = vi.fn<(payload: string) => void>();
        const onSpy = vi.fn<(listener: (payload: string) => void) => () => void>().mockImplementation(() => {
            return () => {
                // no-op
            };
        });
        const activeSocketId = 'active-socket-1';

        const { createServerScopedRelaySocket } = await import('./serverScopedRelaySocket');
        const socket = await createServerScopedRelaySocket<string>({
            machineId: 'machine-1',
            serverId: 'server-a',
            getActiveSocketId: () => activeSocketId,
            createActiveTransport: {
                send: (payload) => {
                    sendSpy(payload);
                },
                on: (listener) => onSpy(listener),
            },
            createScopedTransport: vi.fn(),
        });

        expect(socket.scopeUserId).toBe('user-1');
        expect(socket.machineId).toBe('machine-1');
        expect(socket.socketId).toBe(activeSocketId);
        expect(socket.disconnect).not.toThrow();

        const payload = 'relay-payload-active';
        socket.sendEnvelope(payload);
        expect(sendSpy).toHaveBeenCalledWith(payload);

        const listener = vi.fn<(payload: string) => void>();
        const unsubscribe = socket.onEnvelope(listener);
        expect(onSpy).toHaveBeenCalledWith(listener);
        unsubscribe();

        socket.disconnect();
        expect(createEphemeralServerSocketClientSpy).not.toHaveBeenCalled();
    });

    it('prefers an explicit scoped socketId from getScopedSocketId before transport and socket fallback', async () => {
        const socketOnSpy = vi.fn();
        const socketOffSpy = vi.fn();
        const socketEmitSpy = vi.fn();
        const socketGetSocketIdSpy = vi.fn(() => 'socket-default');
        createEphemeralServerSocketClientSpy.mockResolvedValue({
            emit: socketEmitSpy,
            timeout: vi.fn(),
            disconnect: vi.fn(),
            on: socketOnSpy,
            off: socketOffSpy,
            getSocketId: socketGetSocketIdSpy,
        });
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'machine-2',
            timeoutMs: 2_000,
            targetServerId: 'server-b',
            targetServerUrl: 'https://server-b.example.test',
            token: 'token-b',
            encryption: {
                decryptEncryptionKey: async () => null,
                initializeMachines: async () => {},
                getMachineEncryption: () => null,
            },
        });

        const transportOnSpy = vi.fn<(listener: (payload: string) => void) => () => void>().mockImplementation(() => {
            return () => {
                // no-op
            };
        });
        const scopedTransportFactorySpy = vi.fn((socket: TestScopedSocket<string>) => ({
            send: (payload: string) => socket.emit('payload', payload),
            on: (listener: (payload: string) => void) => {
                transportOnSpy(listener);
                socket.on('payload', listener);
                return () => {
                    socket.off('payload', listener);
                };
            },
            socketId: 'static-socket-id',
        }));
        const getScopedSocketIdSpy = vi.fn(() => 'overridden-socket-id');

        const { createServerScopedRelaySocket } = await import('./serverScopedRelaySocket');
        const socket = await createServerScopedRelaySocket<string>({
            machineId: 'machine-2',
            serverId: 'server-b',
            createActiveTransport: {
                send: () => {},
                on: () => () => {},
            },
            createScopedTransport: scopedTransportFactorySpy,
            getScopedSocketId: getScopedSocketIdSpy,
        });

        expect(createEphemeralServerSocketClientSpy).toHaveBeenCalledWith({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 2_000,
        });
        expect(scopedTransportFactorySpy).toHaveBeenCalledWith(expect.objectContaining({
            emit: expect.any(Function),
            on: expect.any(Function),
        }));
        expect(socket.socketId).toBe('overridden-socket-id');

        const listener = vi.fn<(payload: string) => void>();
        const unsubscribe = socket.onEnvelope(listener);
        expect(transportOnSpy).toHaveBeenCalledWith(listener);
        expect(socketOnSpy).toHaveBeenCalledWith('payload', listener);

        socket.sendEnvelope('scoped-payload');
        expect(socketEmitSpy).toHaveBeenCalledWith('payload', 'scoped-payload');

        unsubscribe();
        expect(socketOffSpy).toHaveBeenCalledWith('payload', listener);

        socket.disconnect();
        expect(resolveServerScopedContextSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to transport- and socket-provided socket ids when scoped overrides are missing', async () => {
        const socketGetSocketIdSpy = vi.fn(() => 'socket-fallback-id');
        const socketOnSpy = vi.fn();
        const socketOffSpy = vi.fn();
        createEphemeralServerSocketClientSpy.mockResolvedValue({
            emit: vi.fn(),
            timeout: vi.fn(),
            disconnect: vi.fn(),
            on: socketOnSpy,
            off: socketOffSpy,
            getSocketId: socketGetSocketIdSpy,
        });
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'machine-3',
            timeoutMs: 2_000,
            targetServerId: 'server-c',
            targetServerUrl: 'https://server-c.example.test',
            token: 'token-c',
            encryption: {
                decryptEncryptionKey: async () => null,
                initializeMachines: async () => {},
                getMachineEncryption: () => null,
            },
        });

        const transportSocketIdSpy = vi.fn(() => 'transport-static-socket');
        const scopedTransportSpy = vi.fn((socket: TestScopedSocket<string>) => ({
            send: () => {},
            on: () => () => {},
            socketId: transportSocketIdSpy(),
        }));

        const { createServerScopedRelaySocket } = await import('./serverScopedRelaySocket');
        const socket = await createServerScopedRelaySocket<string>({
            machineId: 'machine-3',
            createActiveTransport: {
                send: () => {},
                on: () => () => {},
            },
            createScopedTransport: scopedTransportSpy,
        });

        expect(socket.socketId).toBe('transport-static-socket');
        expect(transportSocketIdSpy).toHaveBeenCalledTimes(1);
        expect(socketGetSocketIdSpy).not.toHaveBeenCalled();
    });

    it('falls back to the scoped socket getSocketId when transport-level socketId is absent', async () => {
        const socketGetSocketIdSpy = vi.fn(() => 'socket-default-id');
        const socketOnSpy = vi.fn();
        const socketOffSpy = vi.fn();
        createEphemeralServerSocketClientSpy.mockResolvedValue({
            emit: vi.fn(),
            timeout: vi.fn(),
            disconnect: vi.fn(),
            on: socketOnSpy,
            off: socketOffSpy,
            getSocketId: socketGetSocketIdSpy,
        });
        resolveServerScopedContextSpy.mockResolvedValue({
            scope: 'scoped',
            machineId: 'machine-4',
            timeoutMs: 2_000,
            targetServerId: 'server-d',
            targetServerUrl: 'https://server-d.example.test',
            token: 'token-d',
            encryption: {
                decryptEncryptionKey: async () => null,
                initializeMachines: async () => {},
                getMachineEncryption: () => null,
            },
        });

        const scopedTransportSpy = vi.fn(() => ({
            send: () => {},
            on: () => () => {},
        }));

        const { createServerScopedRelaySocket } = await import('./serverScopedRelaySocket');
        const socket = await createServerScopedRelaySocket<string>({
            machineId: 'machine-4',
            createActiveTransport: {
                send: () => {},
                on: () => () => {},
            },
            createScopedTransport: scopedTransportSpy,
        });

        expect(scopedTransportSpy).toHaveBeenCalledTimes(1);
        expect(socketGetSocketIdSpy).toHaveBeenCalledTimes(1);
        expect(socket.socketId).toBe('socket-default-id');
    });
});
