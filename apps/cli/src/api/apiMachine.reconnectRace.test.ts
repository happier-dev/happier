import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const {
    configurationMock,
    createLoopbackReadinessProbeMock,
    createMachineSocketTransportMock,
    createManagedConnectionSupervisorMock,
    harness,
} = vi.hoisted(() => {
    const configurationMock = {
        apiServerUrl: 'http://localhost:3005',
        socketIoTransports: ['websocket', 'polling'] as string[],
    };

    type State = {
        phase: 'idle' | 'connecting' | 'online' | 'offline' | 'auth_failed' | 'shutting_down';
        reason: string | null;
        attempt: number;
        nextRetryAt: number | null;
        lastConnectedAt: number | null;
        lastDisconnectedAt: number | null;
        lastErrorMessage: string | null;
    };

    type SocketHandler = (...args: any[]) => void;
    type DisconnectListener = (event: { intentional?: boolean; reason?: string | null; error?: unknown }) => void;

    const initialState = (): State => ({
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    });

    let supervisorConfig: any = null;
    let currentState: State = initialState();
    const socketHarnesses: Array<{
        socket: {
            connected: boolean;
            emit: ReturnType<typeof vi.fn>;
            emitWithAck: ReturnType<typeof vi.fn>;
            on: ReturnType<typeof vi.fn>;
            removeAllListeners: ReturnType<typeof vi.fn>;
            __trigger: (event: string, ...args: any[]) => void;
        };
        transport: {
            connect: ReturnType<typeof vi.fn>;
            disconnect: ReturnType<typeof vi.fn>;
            destroy: ReturnType<typeof vi.fn>;
            isConnected: () => boolean;
            onConnected: (listener: () => void) => () => boolean;
            onDisconnected: (listener: DisconnectListener) => () => boolean;
            onError: (listener: (error: unknown) => void) => () => boolean;
        };
    }> = [];

    function createSocketHarness() {
        const socketHandlers = new Map<string, Set<SocketHandler>>();
        const transportDisconnectListeners = new Set<DisconnectListener>();
        const transportConnectedListeners = new Set<() => void>();
        const transportErrorListeners = new Set<(error: unknown) => void>();

        const socket = {
            connected: false,
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ result: 'success', version: 1 })),
            on: vi.fn((event: string, handler: SocketHandler) => {
                const handlers = socketHandlers.get(event) ?? new Set<SocketHandler>();
                handlers.add(handler);
                socketHandlers.set(event, handlers);
            }),
            removeAllListeners: vi.fn(() => {
                socketHandlers.clear();
            }),
            __trigger: (event: string, ...args: any[]) => {
                for (const handler of socketHandlers.get(event) ?? []) {
                    handler(...args);
                }
                if (event === 'connect') {
                    socket.connected = true;
                    for (const listener of transportConnectedListeners) {
                        listener();
                    }
                }
                if (event === 'disconnect') {
                    socket.connected = false;
                    const reason = typeof args[0] === 'string' ? args[0] : null;
                    for (const listener of transportDisconnectListeners) {
                        listener({ reason });
                    }
                }
                if (event === 'connect_error') {
                    for (const listener of transportErrorListeners) {
                        listener(args[0]);
                    }
                }
            },
        };

        const transport = {
            connect: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}),
            destroy: vi.fn(async () => {}),
            isConnected: () => socket.connected,
            onConnected: (listener: () => void) => {
                transportConnectedListeners.add(listener);
                return () => transportConnectedListeners.delete(listener);
            },
            onDisconnected: (listener: DisconnectListener) => {
                transportDisconnectListeners.add(listener);
                return () => transportDisconnectListeners.delete(listener);
            },
            onError: (listener: (error: unknown) => void) => {
                transportErrorListeners.add(listener);
                return () => transportErrorListeners.delete(listener);
            },
        };

        return { socket, transport };
    }

    function publishState(next: Partial<State>): void {
        currentState = {
            ...currentState,
            ...next,
        };
        supervisorConfig?.onStateChange?.(currentState);
    }

    function attachTransportToSupervisor(transport: { onDisconnected: (listener: DisconnectListener) => () => boolean }) {
        transport.onDisconnected((event) => {
            void supervisorConfig?.onDisconnected?.({ state: currentState, event });
        });
    }

    const createMachineSocketTransportMock = vi.fn(() => {
        const socketHarness = createSocketHarness();
        socketHarnesses.push(socketHarness);
        return {
            socket: socketHarness.socket,
            transport: socketHarness.transport,
        };
    });

    const createManagedConnectionSupervisorMock = vi.fn((config: any) => {
        supervisorConfig = config;
        currentState = initialState();
        return {
            start: vi.fn(async () => {
                const transport = supervisorConfig.createTransport();
                attachTransportToSupervisor(transport);
            }),
            stop: vi.fn(async () => {}),
            getState: vi.fn(() => currentState),
        };
    });

    const createLoopbackReadinessProbeMock = vi.fn(() => async () => ({ status: 'ready' as const }));

    return {
        configurationMock,
        createLoopbackReadinessProbeMock,
        createMachineSocketTransportMock,
        createManagedConnectionSupervisorMock,
        harness: {
            reset() {
                currentState = initialState();
                supervisorConfig = null;
                socketHarnesses.length = 0;
                createMachineSocketTransportMock.mockClear();
                createManagedConnectionSupervisorMock.mockClear();
                createLoopbackReadinessProbeMock.mockClear();
            },
            publishState,
            establishReconnectTransport() {
                const transport = supervisorConfig.createTransport();
                attachTransportToSupervisor(transport);
            },
            getSocket(index: number) {
                const next = socketHarnesses[index];
                if (!next) {
                    throw new Error(`missing socket harness at index ${index}`);
                }
                return next.socket;
            },
            async emitAuthFailedFromStaleAttempt() {
                await supervisorConfig?.onAuthFailed?.({
                    state: {
                        ...currentState,
                        phase: 'auth_failed',
                        reason: 'auth_invalid',
                    },
                    probe: { status: 'auth_failed' as const, statusCode: 401, errorMessage: 'expired token' },
                });
            },
        },
    };
});

vi.mock('@/configuration', () => ({
    configuration: configurationMock,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/scm', () => ({ registerScmHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/fileSystem', () => ({ registerFileSystemHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({ registerMachineFileBrowserHandlers: vi.fn() }));
vi.mock('./machine/rpcHandlers', () => ({ registerMachineRpcHandlers: vi.fn() }));
vi.mock('./rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect() {}
        onSocketDisconnect() {}
        async handleRequest() {
            return { ok: true };
        }
        async invokeLocal() {
            return { ok: true };
        }
        async waitForIdle() {}
    },
}));
vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
vi.mock('@/persistence', () => ({ readLastChangesCursor: vi.fn(async () => 0), writeLastChangesCursor: vi.fn(async () => {}) }));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
    createLoopbackReadinessProbe: createLoopbackReadinessProbeMock,
}));
vi.mock('@/api/machine/connection/createMachineSocketTransport', () => ({
    createMachineSocketTransport: createMachineSocketTransportMock,
}));
vi.mock('@happier-dev/connection-supervisor', () => ({
    DEFAULT_MANAGED_CONNECTION_POLICY: {
        initialFastRetryDelayMs: 0,
        maxFastRetries: 0,
        backoffMinMs: 0,
        backoffMaxMs: 0,
        jitterRatio: 0,
    },
    createManagedConnectionSupervisor: createManagedConnectionSupervisorMock,
}));

describe('ApiMachineClient reconnect race handling', () => {
    beforeEach(() => {
        vi.resetModules();
        harness.reset();
    });

    it('does not let a stale disconnect callback clear a newer transport socket', async () => {
        const { ApiMachineClient } = await import('./apiMachine');

        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const client = new ApiMachineClient('token', machine);
        client.connect();

        harness.publishState({ phase: 'online', reason: 'initial_connect', attempt: 0 });
        harness.establishReconnectTransport();
        harness.publishState({ phase: 'online', reason: 'transport_disconnect', attempt: 1 });

        const firstSocket = harness.getSocket(0);
        const secondSocket = harness.getSocket(1);

        firstSocket.__trigger('disconnect', 'transport closed');

        client.sendMachineTransferEnvelope({
            targetMachineId: 'machine-2',
            envelope: {
                transferId: 'transfer-1',
                kind: 'chunk',
                sequence: 1,
                payloadBase64: 'YQ==',
            },
        });

        expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
            targetMachineId: 'machine-2',
            envelope: {
                transferId: 'transfer-1',
                kind: 'chunk',
                sequence: 1,
                payloadBase64: 'YQ==',
            },
        });
    });

    it('still clears the active socket when the current transport disconnects', async () => {
        const { ApiMachineClient } = await import('./apiMachine');

        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const client = new ApiMachineClient('token', machine);
        client.connect();

        const firstSocket = harness.getSocket(0);
        firstSocket.__trigger('disconnect', 'transport closed');

        client.sendMachineTransferEnvelope({
            targetMachineId: 'machine-2',
            envelope: {
                transferId: 'transfer-3',
                kind: 'chunk',
                sequence: 3,
                payloadBase64: 'Yw==',
            },
        });

        expect(firstSocket.emit).not.toHaveBeenCalled();
    });

    it('does not let a stale auth-failed callback clear a newer transport socket', async () => {
        const { ApiMachineClient } = await import('./apiMachine');

        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const client = new ApiMachineClient('token', machine);
        client.connect();

        harness.publishState({ phase: 'online', reason: 'initial_connect', attempt: 0 });
        harness.establishReconnectTransport();
        harness.publishState({ phase: 'online', reason: 'transport_disconnect', attempt: 1 });

        const secondSocket = harness.getSocket(1);

        await harness.emitAuthFailedFromStaleAttempt();

        client.sendMachineTransferEnvelope({
            targetMachineId: 'machine-2',
            envelope: {
                transferId: 'transfer-2',
                kind: 'chunk',
                sequence: 2,
                payloadBase64: 'Yg==',
            },
        });

        expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
            targetMachineId: 'machine-2',
            envelope: {
                transferId: 'transfer-2',
                kind: 'chunk',
                sequence: 2,
                payloadBase64: 'Yg==',
            },
        });
    });
});
