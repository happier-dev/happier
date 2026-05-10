import { describe, expect, it, vi } from 'vitest';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

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

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debugLargeJson: vi.fn(),
    },
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

    it('reports account settings version hints from /v2/changes to the refresh callback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                            { cursor: 2, kind: 'account', entityId: 'self', changedAt: 2, hint: { settingsVersion: 3 } },
                        ],
                        nextCursor: 2,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 2);
    });

    it('advances the changes cursor when account settings refresh for a hint fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });
        const secondListener = vi.fn(async () => {});
        client.onAccountSettingsVersionHint(secondListener);

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(secondListener).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('does not surface an unhandled rejection when a background changes sync fails on connect', async () => {
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
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            const client = new ApiMachineClient('token', machine);
            client.onAccountSettingsVersionHint(async () => {
                throw new Error('settings refresh failed');
            });
            client.connect();

            await vi.waitFor(() => {
                expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
            });
            await new Promise((resolve) => setImmediate(resolve));

            expect(unhandledRejections).toEqual([]);
            expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 1);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    it('refreshes account settings conservatively when the changes cursor is gone', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: null,
            source: 'cursor-gone',
        });
        expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 9);
    });

    it('advances a cursor-gone cursor when conservative account settings refresh fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(writeLastChangesCursor).toHaveBeenCalledWith('acc-1', 9);
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

    it.each([401, 403] as const)('reports /v2/changes auth status %i to the machine supervisor without snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeLastChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports profile auth status %i to the machine supervisor before /v2/changes sync', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeLastChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('throws /v2/changes auth status %i without a machine supervisor instead of snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeLastChangesCursor.mockClear();
        readLastChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: null,
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' })).rejects.toMatchObject({
            code: 'not_authenticated',
            response: { status },
        });

        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeLastChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports machine snapshot refresh auth status %i to the machine supervisor', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockResolvedValue({
            status,
            data: { error: 'not-authenticated' },
        });
        axiosGet.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).refreshMachineFromServer();

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('reports retryable machine snapshot refresh failures to the machine supervisor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockResolvedValue({
            status: 503,
            data: { error: 'busy' },
        });
        axiosGet.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).refreshMachineFromServer();

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'retry_later',
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });
});
