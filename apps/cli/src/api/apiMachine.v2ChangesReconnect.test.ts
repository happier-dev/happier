import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ApiMachineClient } from './apiMachine';

const { mockIo, axiosGet, readLastChangesCursor, writeLastChangesCursor } = vi.hoisted(() => {
    return {
        mockIo: vi.fn(),
        axiosGet: vi.fn(),
        readLastChangesCursor: vi.fn(async () => 0),
        writeLastChangesCursor: vi.fn(async () => {}),
    };
});

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('axios', () => ({
    default: {
        get: axiosGet,
    },
}));

vi.mock('@/persistence', () => ({
    readLastChangesCursor,
    writeLastChangesCursor,
}));

function createMachineSocket(options: {
    emitWithAck?: (event: string, payload: unknown) => Promise<unknown> | unknown;
} = {}) {
    return createApiSessionSocketStub({
        emitWithAck: async (event, payload) => {
            if (options.emitWithAck) {
                return await options.emitWithAck(event, payload);
            }

            if (event === 'machine-update-state' && payload && typeof payload === 'object') {
                return {
                    result: 'success',
                    version: 1,
                    daemonState: (payload as { daemonState?: unknown }).daemonState,
                };
            }

            if (event === 'machine-update-metadata' && payload && typeof payload === 'object') {
                return {
                    result: 'success',
                    version: 1,
                    metadata: (payload as { metadata?: unknown }).metadata,
                };
            }

            return { result: 'success', version: 1 };
        },
    });
}

describe('ApiMachineClient /v2/changes reconnect', () => {
    it('connect uses an http(s) base URL and explicitly connects the socket', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        expect(mockIo).toHaveBeenCalled();
        const url = ((mockIo as any).mock?.calls as any[] | undefined)?.[0]?.[0];
        expect(typeof url).toBe('string');
        expect(String(url).startsWith('http')).toBe(true);
        expect(socket.connect).toHaveBeenCalled();
    });

    it('connect does not crash if the socket lacks connect() and uses open() as a fallback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socketNoConnect = {
            ...createMachineSocket(),
            connect: undefined,
            open: vi.fn(),
        } as any;
        bindApiSessionSocketMock(mockIo, socketNoConnect);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        expect(socketNoConnect.open).toHaveBeenCalled();
    });

    it('refreshes machine snapshot when /v2/changes includes a machine change', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: { changes: [{ cursor: 1, kind: 'machine', entityId: 'machine-1', changedAt: 1, hint: null }], nextCursor: 1 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.connect();

        // First connect
        socket.trigger('connect');

        // Disconnect + reconnect
        socket.trigger('disconnect');
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(machine.metadataVersion).toBe(2);
        });

        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('refreshes machine snapshot when /v2/changes is missing (e.g. old server 404) on reconnect', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 404,
                    data: { error: 'not-found' },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeLastChangesCursor).not.toHaveBeenCalled();
    });
});
