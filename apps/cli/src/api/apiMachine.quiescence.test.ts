import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    bindApiSessionSocketSequenceMock,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import type { DaemonState, Machine, MachineMetadata } from './types';

import { ApiMachineClient } from './apiMachine';
import { encodeBase64, encrypt } from './encryption';

const ioMock = vi.hoisted(() => vi.fn());
const probeReadinessMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));
const backoffMock = vi.hoisted(() => vi.fn(async (fn: () => Promise<unknown>) => await fn()));

vi.mock('socket.io-client', () => ({
    io: ioMock,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://example.test',
        apiServerUrl: 'https://example.test',
        activeServerDir: '/tmp/happier-api-machine-quiescence-test',
        currentCliVersion: '0.0.0-test',
        socketForceWebsocketOnly: false,
        socketIoTransports: ['polling', 'websocket'],
    },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
    getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
    createLoopbackReadinessProbe: () => probeReadinessMock,
}));

vi.mock('@/utils/time', () => ({
    backoff: backoffMock,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => undefined,
        warn: () => undefined,
        debugLargeJson: () => undefined,
    },
}));

function createMachine(): Machine {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createMachineMetadata(): MachineMetadata {
    return {
        host: 'test-host',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happier',
        happyLibDir: '/Users/test/.happier/lib',
    };
}

function encryptForMachine(machine: Machine, value: unknown): string {
    return encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, value));
}

describe('ApiMachineClient daemon quiescence admission', () => {
    afterEach(() => {
        backoffMock.mockReset();
        backoffMock.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
        probeReadinessMock.mockClear();
        ioMock.mockReset();
        vi.unstubAllEnvs();
    });

    it('suppresses first metadata and daemon-state attempts while quiescing', async () => {
        const socket = createApiSessionSocketStub({ connected: true });
        const metadataHandler = vi.fn(() => createMachineMetadata());
        const daemonStateHandler = vi.fn(() => ({ status: 'running' as const }));
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => true },
        );
        Reflect.set(client, 'socket', socket);

        const metadataOutcome = await client.updateMachineMetadata(metadataHandler);
        const daemonStateOutcome = await client.updateDaemonState(daemonStateHandler);

        expect(metadataOutcome).toBe('suppressed');
        expect(daemonStateOutcome).toBe('suppressed');
        expect(metadataHandler).not.toHaveBeenCalled();
        expect(daemonStateHandler).not.toHaveBeenCalled();
        expect(backoffMock).not.toHaveBeenCalled();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('reports unchanged metadata without emitting an update', async () => {
        const metadata = createMachineMetadata();
        const machine = {
            ...createMachine(),
            metadata,
        };
        const socket = createApiSessionSocketStub({ connected: true });
        const client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateMachineMetadata(() => ({ ...metadata }));

        expect(outcome).toBe('unchanged');
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('reports a successful metadata acknowledgement as published', async () => {
        const machine = createMachine();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                if (event !== 'machine-update-metadata') {
                    throw new Error(`unexpected event: ${event}`);
                }
                return {
                    result: 'success',
                    version: 1,
                    metadata: (payload as { metadata: string }).metadata,
                };
            },
        });
        const client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateMachineMetadata(() => createMachineMetadata());

        expect(outcome).toBe('published');
        expect(machine.metadata).toEqual(createMachineMetadata());
    });

    it('allows an explicit shutdown-state publication while quiescing', async () => {
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                if (event !== 'machine-update-state') {
                    throw new Error(`unexpected event: ${event}`);
                }
                return {
                    result: 'success',
                    version: 1,
                    daemonState: (payload as { daemonState: string }).daemonState,
                };
            },
        });
        const daemonStateHandler = vi.fn(() => ({ status: 'shutting-down' as const }));
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => true },
        );
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateDaemonState(
            daemonStateHandler,
            { allowWhileQuiescing: true },
        );

        expect(outcome).toBe('published');
        expect(daemonStateHandler).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck).toHaveBeenCalledWith(
            'machine-update-state',
            expect.any(Object),
        );
    });

    it('suppresses the next metadata and daemon-state retry when quiescence starts after an admitted mismatch', async () => {
        let quiescing = false;
        const eventAttempts = new Map<string, number>();
        const machine = createMachine();
        const desiredMetadata = createMachineMetadata();
        const serverCurrentMetadata: MachineMetadata = {
            ...desiredMetadata,
            host: 'server-current-host',
        };
        const serverCurrentDaemonState: DaemonState = {
            status: 'running',
            pid: 404,
            startedAt: 1,
        };
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                const attempt = (eventAttempts.get(event) ?? 0) + 1;
                eventAttempts.set(event, attempt);
                const encryptedPayload = payload as {
                    metadata?: string;
                    daemonState?: string;
                };
                if (event === 'machine-update-metadata') {
                    return {
                        result: attempt === 1 ? 'version-mismatch' : 'success',
                        version: attempt,
                        metadata: attempt === 1
                            ? encryptForMachine(machine, serverCurrentMetadata)
                            : encryptedPayload.metadata,
                    };
                }
                if (event === 'machine-update-state') {
                    return {
                        result: attempt === 1 ? 'version-mismatch' : 'success',
                        version: attempt,
                        daemonState: attempt === 1
                            ? encryptForMachine(machine, serverCurrentDaemonState)
                            : encryptedPayload.daemonState,
                    };
                }
                throw new Error(`unexpected event: ${event}`);
            },
        });
        const client = new ApiMachineClient(
            'token',
            machine,
            undefined,
            { isDaemonQuiescing: () => quiescing },
        );
        Reflect.set(client, 'socket', socket);

        const runWithOneRetry = async (fn: () => Promise<unknown>): Promise<unknown> => {
            try {
                return await fn();
            } catch {
                quiescing = true;
                return await fn();
            }
        };

        const metadataHandler = vi.fn(() => desiredMetadata);
        backoffMock.mockImplementationOnce(runWithOneRetry);
        const metadataOutcome = await client.updateMachineMetadata(metadataHandler);
        expect(metadataOutcome).toBe('suppressed');
        expect(metadataHandler).toHaveBeenCalledTimes(1);
        expect(eventAttempts.get('machine-update-metadata')).toBe(1);
        expect(machine.metadata).toEqual(serverCurrentMetadata);
        expect(machine.metadataVersion).toBe(1);
        expect(machine.metadata).not.toEqual(desiredMetadata);

        quiescing = false;
        const daemonStateHandler = vi.fn(() => ({ status: 'running' as const, pid: 123 }));
        backoffMock.mockImplementationOnce(runWithOneRetry);
        const daemonStateOutcome = await client.updateDaemonState(daemonStateHandler);
        expect(daemonStateOutcome).toBe('suppressed');
        expect(daemonStateHandler).toHaveBeenCalledTimes(1);
        expect(eventAttempts.get('machine-update-state')).toBe(1);
        expect(machine.daemonState).toEqual(serverCurrentDaemonState);
        expect(machine.daemonStateVersion).toBe(1);
    });

    it('rejects unknown metadata and daemon-state acknowledgement results', async () => {
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: () => ({ result: 'unexpected-result' }),
        });
        const client = new ApiMachineClient('token', createMachine());
        Reflect.set(client, 'socket', socket);

        await expect(
            client.updateMachineMetadata(() => createMachineMetadata()),
        ).rejects.toBeInstanceOf(Error);
        await expect(
            client.updateDaemonState(() => ({ status: 'running' })),
        ).rejects.toBeInstanceOf(Error);
    });

    it('does not publish running state on a reconnect that arrives while quiescing', async () => {
        vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
        let quiescing = false;
        const firstSocket = createApiSessionSocketStub({
            id: 'machine-socket-1',
            disconnectReason: 'transport close',
            emitWithAck: (event, payload) => {
                if (event === 'machine-update-state') {
                    return {
                        result: 'success',
                        version: 1,
                        daemonState: (payload as { daemonState: string }).daemonState,
                    };
                }
                return { result: 'success', version: 1 };
            },
        });
        const secondSocket = createApiSessionSocketStub({
            id: 'machine-socket-2',
            disconnectReason: 'transport close',
            emitWithAck: (event, payload) => {
                if (event === 'machine-update-state') {
                    return {
                        result: 'success',
                        version: 2,
                        daemonState: (payload as { daemonState: string }).daemonState,
                    };
                }
                return { result: 'success', version: 2 };
            },
        });
        bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);
        const onConnect = vi.fn();
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => quiescing },
        );
        client.onConnectedServicesProjection(async () => {});

        try {
            client.connect({ onConnect });
            await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
            expect(firstSocket.emitWithAck).toHaveBeenCalledWith(
                'machine-update-state',
                expect.any(Object),
            );

            quiescing = true;
            firstSocket.disconnect();
            await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));

            expect(secondSocket.emitWithAck).not.toHaveBeenCalledWith(
                'machine-update-state',
                expect.any(Object),
            );
            const socketOptions = ioMock.mock.calls[1]?.[1] as {
                auth?: Record<string, unknown>;
            };
            expect(socketOptions.auth).not.toHaveProperty('isDaemonQuiescing');
        } finally {
            await client.shutdown();
        }
    }, 5_000);
});
