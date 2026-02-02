import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { ApiMachineClient } from './apiMachine';

const { mockIo, socket, axiosGet, readLastChangesCursor, writeLastChangesCursor } = vi.hoisted(() => {
    const handlersByEvent = new Map<string, Array<(...args: any[]) => void>>();
    const ioHandlersByEvent = new Map<string, Array<(...args: any[]) => void>>();

    const socket: any = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
            const arr = handlersByEvent.get(event) ?? [];
            arr.push(handler);
            handlersByEvent.set(event, arr);
        }),
        emit: vi.fn(),
        emitWithAck: vi.fn().mockResolvedValue({ result: 'success', version: 1, metadata: null, daemonState: null }),
        close: vi.fn(),
        timeout: vi.fn().mockReturnThis(),
        io: {
            on: vi.fn((event: string, handler: (...args: any[]) => void) => {
                const arr = ioHandlersByEvent.get(event) ?? [];
                arr.push(handler);
                ioHandlersByEvent.set(event, arr);
            }),
        },
        __trigger: (event: string, ...args: any[]) => {
            const list = handlersByEvent.get(event) ?? [];
            for (const h of list) h(...args);
        },
        __reset: () => {
            handlersByEvent.clear();
            ioHandlersByEvent.clear();
        },
    };

    return {
        mockIo: vi.fn(() => socket),
        socket,
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

describe('ApiMachineClient /v2/changes reconnect', () => {
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

        socket.__reset();
        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.connect();

        // First connect
        socket.__trigger('connect');
        await new Promise((r) => setTimeout(r, 0));

        // Disconnect + reconnect
        socket.__trigger('disconnect');
        socket.__trigger('connect');
        await new Promise((r) => setTimeout(r, 0));

        expect(machine.metadataVersion).toBe(2);
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

        socket.__reset();
        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.connect();

        // First connect
        socket.__trigger('connect');
        await new Promise((r) => setTimeout(r, 0));

        // Disconnect + reconnect
        socket.__trigger('disconnect');
        socket.__trigger('connect');
        await new Promise((r) => setTimeout(r, 0));

        expect(machine.metadataVersion).toBe(2);
        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeLastChangesCursor).not.toHaveBeenCalled();
    });
});
