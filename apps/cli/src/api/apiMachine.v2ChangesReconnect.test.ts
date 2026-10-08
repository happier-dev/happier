import { describe, expect, it, vi } from 'vitest';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createDeferred } from '@/testkit/async/deferred';
import { ConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { ApiMachineClient } from './apiMachine';

const { mockIo, axiosGet, readAccountChangesCursor, writeAccountChangesCursor } = vi.hoisted(() => {
    return {
        mockIo: vi.fn(),
        axiosGet: vi.fn(),
        readAccountChangesCursor: vi.fn(async () => 0),
        writeAccountChangesCursor: vi.fn(async () => {}),
    };
});

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('axios', () => ({
    default: {
        get: axiosGet,
        isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: unknown } | null)?.isAxiosError),
    },
}));

vi.mock('@/persistence', () => ({
    readAccountChangesCursor,
    writeAccountChangesCursor,
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 2);
    });

    it('replays one exact inactive Pending activation from durable session changes before advancing the cursor', async () => {
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
                        changes: [{
                            cursor: 7,
                            kind: 'session',
                            entityId: 'inactive-session',
                            changedAt: 1,
                            hint: {
                                pendingVersion: 9,
                                pendingCount: 1,
                                pendingActivationRequestId: 'pending-after-ui-death',
                            },
                        }],
                        nextCursor: 7,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const observedOrder: string[] = [];
        const onPendingSessionActivationHint = vi.fn(async () => {
            observedOrder.push('activation');
        });
        writeAccountChangesCursor.mockImplementationOnce(async () => {
            observedOrder.push('cursor');
        });

        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(onPendingSessionActivationHint);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onPendingSessionActivationHint).toHaveBeenCalledWith({
            sessionId: 'inactive-session',
            requestId: 'pending-after-ui-death',
            pendingVersion: 9,
            source: 'changes',
        });
        expect(observedOrder).toEqual(['activation', 'cursor']);
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 7);
    });

    it('surfaces the same exact Pending authorization from a live machine-only update', async () => {
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
        const onPendingSessionActivationHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(onPendingSessionActivationHint);
        client.connect();

        socket.trigger('update', {
            id: 'update-1',
            seq: 7,
            createdAt: 1,
            body: {
                t: 'pending-changed',
                sid: 'inactive-session',
                sessionId: 'inactive-session',
                pendingVersion: 9,
                pendingCount: 1,
                pendingActivationRequestId: 'pending-after-ui-death',
            },
        });

        await vi.waitFor(() => {
            expect(onPendingSessionActivationHint).toHaveBeenCalledWith({
                sessionId: 'inactive-session',
                requestId: 'pending-after-ui-death',
                pendingVersion: 9,
                source: 'live',
            });
        });
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('does not advance the cursor when connected-services reconciliation fails', async () => {
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
            if (url.includes('/v1/account/profile')) return {
                status: 200,
                data: {
                    id: 'acc-1',
                    connectedServicesV2: [{
                        serviceId: 'anthropic',
                        profiles: [],
                        groups: [{
                            groupId: 'group-1',
                            activeProfileId: 'profile-1',
                            generation: 7,
                            memberProfileIds: ['profile-1'],
                        }],
                    }],
                    connectedServiceCredentialRevisionsV1: [{
                        serviceId: 'anthropic',
                        profileId: 'profile-1',
                        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    }],
                },
            };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 1,
                            kind: 'account',
                            entityId: 'self',
                            changedAt: 1,
                            hint: { connectedServices: true },
                        }],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const reconcile = vi.fn(async ({ source }: { source: string }) => {
            if (source === 'changes') throw new Error('durable disposition unavailable');
        });
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(reconcile);

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' }))
            .rejects.toThrow('durable disposition unavailable');
        expect(reconcile.mock.calls.map(([input]) => input.source)).toEqual(['reconnect', 'changes']);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('continues /v2/changes catch-up without timer retry when generation reconciliation awaits another domain event', async () => {
        vi.useFakeTimers();
        try {
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
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
            }
            if (url.includes('/v2/changes')) {
                return { status: 200, data: { changes: [], nextCursor: 9 } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        const reconcile = vi.fn(async () => {
            throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
        });
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(reconcile);

        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.advanceTimersByTimeAsync(0);
        await (client as any).connectedServicesProjectionRetry.waitForIdle();

        expect(reconcile).toHaveBeenCalledOnce();
        expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(reconcile).toHaveBeenCalledOnce();

        (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
        await vi.advanceTimersByTimeAsync(0);
        await (client as any).connectedServicesProjectionRetry.waitForIdle();
        expect(reconcile).toHaveBeenCalledTimes(2);
        await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs startup connected-services reconciliation even when the change page is empty', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
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
            if (url.includes('/v1/account/profile')) return {
                status: 200,
                data: {
                    id: 'acc-1',
                    connectedServicesV2: [{
                        serviceId: 'anthropic',
                        profiles: [],
                        groups: [{
                            groupId: 'group-1',
                            activeProfileId: 'profile-1',
                            generation: 7,
                            memberProfileIds: ['profile-1'],
                        }],
                    }],
                    connectedServiceCredentialRevisionsV1: [{
                        serviceId: 'anthropic',
                        profileId: 'profile-1',
                        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    }],
                },
            };
            if (url.includes('/v2/changes')) {
                return { status: 200, data: { changes: [], nextCursor: 8 } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const reconcile = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            source: 'startup',
            executionAuthority: 'passive_projection',
            connectedServicesV2: [{
                serviceId: 'anthropic',
                profiles: [],
                groups: [{
                    groupId: 'group-1',
                    displayName: null,
                    activeProfileId: 'profile-1',
                    generation: 7,
                    memberProfileIds: ['profile-1'],
                }],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'anthropic',
                profileId: 'profile-1',
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            }],
        }));
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('preserves live connected-service projection authority instead of downgrading it to reconnect catch-up', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
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
                if (url.includes('/v1/account/profile')) return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
                throw new Error(`unexpected url: ${url}`);
            });
            const reconcile = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjectionChange(reconcile);

            await (client as any).syncChangesOnConnect({ reason: 'live' });

            expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
                source: 'live',
                executionAuthority: 'runtime_recovery',
            }));
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('retries after transient account-id failure without requiring another projection hint', async () => {
        vi.useFakeTimers();
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'true';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            let profileRequests = 0;
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    profileRequests += 1;
                    if (profileRequests === 2) throw new Error('transient account-id lookup failure');
                    return { status: 200, data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] } };
                }
                if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 9 } };
                throw new Error(`unexpected url: ${url}`);
            });
            axiosGet.mockClear();
            writeAccountChangesCursor.mockClear();
            const reconcile = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjectionChange(reconcile);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
            await vi.advanceTimersByTimeAsync(999);
            expect(reconcile).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
            await (client as any).connectedServicesProjectionRetry.waitForIdle();

            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('aborts an in-flight projection request and awaits scheduler quiescence on shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            let requestSignal: AbortSignal | undefined;
            axiosGet.mockImplementation(async (_url: string, config?: { signal?: AbortSignal }) => {
                requestSignal = config?.signal;
                await new Promise<void>((_resolve, reject) => {
                    config?.signal?.addEventListener('abort', () => reject(config.signal?.reason), { once: true });
                });
                throw new Error('unreachable');
            });
            axiosGet.mockClear();
            const listener = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjectionChange(listener);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledOnce());
            await client.shutdown();

            expect(requestSignal?.aborted).toBe(true);
            expect(listener).not.toHaveBeenCalled();
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('threads shutdown cancellation through the projection listener before changes or cursor side effects', async () => {
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
            status: 200,
            data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
        });
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        const listenerSideEffects: string[] = [];
        let listenerSignal: AbortSignal | undefined;
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(async (notification) => {
            const signal = (notification as typeof notification & { signal: AbortSignal }).signal;
            listenerSignal = signal;
            listenerSideEffects.push('entered');
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (!signal.aborted) listenerSideEffects.push('after-abort');
        });

        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.waitFor(() => expect(listenerSideEffects).toEqual(['entered']));
        await client.shutdown();

        expect(listenerSignal?.aborted).toBe(true);
        expect(listenerSideEffects).toEqual(['entered']);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('refetches AGY group generations and credential revisions after a legacy-filtered live push', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
                metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            };
            const socket = createMachineSocket();
            axiosGet.mockImplementation(async (url: string, config: any) => {
                if (!url.includes('/v1/account/profile')) throw new Error(`unexpected url: ${url}`);
                expect(config.headers.Accept).toBe('application/json; happier-connected-service-antigravity=1');
                return { status: 200, data: { id: 'acc-1', connectedServicesV2: [{
                    serviceId: 'antigravity', profiles: [], groups: [{ groupId: 'work', generation: 7, memberProfileIds: ['default'] }],
                }], connectedServiceCredentialRevisionsV1: [{
                    serviceId: 'antigravity', profileId: 'default', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                }] } };
            });
            const reconcile = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjectionChange(reconcile);
            (client as any).socket = socket;
            (client as any).activeTransportGeneration = 1;
            (client as any).installSocketEventHandlers(socket, 1);
            socket.trigger('update', { body: {
                t: 'update-account', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [], connectedServicesProfileChanged: true,
            } });
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
                source: 'live', executionAuthority: 'runtime_recovery',
                connectedServicesV2: [expect.objectContaining({ serviceId: 'antigravity', groups: [expect.objectContaining({ generation: 7 })] })],
                connectedServiceCredentialRevisionsV1: [expect.objectContaining({ serviceId: 'antigravity', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' })],
            })));
            await (client as any).connectedServicesProjectionRetry.waitForIdle();
            await client.shutdown();
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('serializes a live projection hint behind connect catch-up through one scheduler owner', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'true';
        try {
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
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return { status: 200, data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] } };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 1 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            axiosGet.mockClear();
            const first = createDeferred<void>();
            let active = 0;
            let maxActive = 0;
            let calls = 0;
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjectionChange(async () => {
                calls += 1;
                active += 1;
                maxActive = Math.max(maxActive, active);
                if (calls === 1) await first.promise;
                active -= 1;
            });

            (client as any).socket = socket;
            (client as any).activeTransportGeneration = 1;
            (client as any).installSocketEventHandlers(socket, 1);
            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(calls).toBe(1));
            socket.trigger('update', {
                body: {
                    t: 'update-account',
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [],
                },
            });
            await Promise.resolve();
            expect(calls).toBe(1);

            first.resolve();
            await (client as any).connectedServicesProjectionRetry.waitForIdle();
            expect(calls).toBe(2);
            expect(maxActive).toBe(1);
            await client.shutdown();
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('rejects projection producers that race with or follow terminal shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'true';
        try {
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
                    return { status: 200, data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] } };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 1 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            axiosGet.mockClear();
            const current = createDeferred<void>();
            let calls = 0;
            const client = new ApiMachineClient('token', machine);
            const socket = createMachineSocket();
            (client as any).socket = socket;
            (client as any).activeTransportGeneration = 1;
            (client as any).installSocketEventHandlers(socket, 1);
            client.onConnectedServicesProjectionChange(async () => {
                calls += 1;
                if (calls === 1) await current.promise;
            });
            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(calls).toBe(1));

            const shutdown = client.shutdown();
            socket.trigger('update', {
                body: { t: 'update-account', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            current.resolve();
            await shutdown;
            socket.trigger('update', {
                body: { t: 'update-account', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await Promise.resolve();

            expect(calls).toBe(1);
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('keeps every initial-connect catch-up notification passive instead of restoring runtime authority', async () => {
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
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 1,
                            kind: 'account',
                            entityId: 'self',
                            changedAt: 1,
                            hint: { connectedServices: true },
                        }],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        const notifications: unknown[] = [];
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(async (notification) => {
            notifications.push(notification);
        });

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(notifications.map((notification) => {
            const { signal: _signal, ...withoutSignal } = notification as typeof notification & { signal: AbortSignal };
            return withoutSignal;
        })).toEqual([
            {
                source: 'startup',
                executionAuthority: 'passive_projection',
                connectedServicesV2: [],
                connectedServiceCredentialRevisionsV1: [],
            },
            {
                source: 'changes',
                executionAuthority: 'passive_projection',
                connectedServicesV2: [],
                connectedServiceCredentialRevisionsV1: [],
            },
        ]);
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: null,
            source: 'cursor-gone',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
    });

    it('does not advance a cursor-gone cursor until connected-services snapshot reconciliation succeeds', async () => {
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
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) return { status: 410, data: { error: 'cursor-gone', currentCursor: 9 } };
            if (url.includes('/v1/machines/machine-1')) {
                return { status: 200, data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjectionChange(async ({ source }) => {
            if (source === 'cursor-gone') throw new Error('snapshot reconciliation failed');
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' }))
            .rejects.toThrow('snapshot reconciliation failed');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
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
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

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
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
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

    it('keeps retryable machine snapshot refresh failures from deciding socket health', async () => {
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

        expect(reportProbeResult).not.toHaveBeenCalled();
    });
});
