import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchAndApplyMachines } from './syncMachines';

describe('fetchAndApplyMachines error propagation', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('throws when the machine list request fails', async () => {
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const networkError = new Error('Network request failed');
        const applyMachines = vi.fn();

        await expect(
            fetchAndApplyMachines({
                credentials,
                encryption: {
                    decryptEncryptionKey: vi.fn(async () => null),
                    initializeMachines: vi.fn(async () => {}),
                    getMachineEncryption: vi.fn(() => null),
                },
                machineDataKeys: new Map(),
                throwOnError: true,
                request: vi.fn(async () => {
                    throw networkError;
                }),
                applyMachines,
            }),
        ).rejects.toBe(networkError);

        expect(applyMachines).not.toHaveBeenCalled();
    });

    it('does not drop machines when machine encryption is unavailable (keeps list stable)', async () => {
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const applyMachines = vi.fn();

        await fetchAndApplyMachines({
            credentials,
            encryption: {
                decryptEncryptionKey: vi.fn(async () => null),
                initializeMachines: vi.fn(async () => {}),
                getMachineEncryption: vi.fn(() => null),
            },
            machineDataKeys: new Map(),
            throwOnError: true,
            request: vi.fn(async () => ({
                ok: true,
                async json() {
                    return [{
                        id: 'm1',
                        metadata: 'cipher',
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                        dataEncryptionKey: null,
                        seq: 1,
                        active: true,
                        activeAt: 1,
                        revokedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    }];
                },
            } as any)),
            applyMachines,
        });

        expect(applyMachines).toHaveBeenCalledTimes(1);
        const [machines] = applyMachines.mock.calls[0]!;
        expect(machines).toHaveLength(1);
        expect(machines[0]!.id).toBe('m1');
    });

    it('still applies cached machine display rows when machine encryption initialization fails', async () => {
        const credentials: AuthCredentials = { token: 't', secret: 's' };
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();

        await fetchAndApplyMachines({
            credentials,
            encryption: {
                decryptEncryptionKey: vi.fn(async () => null),
                initializeMachines: vi.fn(async () => {
                    throw new Error('Failed to initialize machines');
                }),
                getMachineEncryption: vi.fn(() => null),
            },
            machineDataKeys: new Map(),
            request: vi.fn(async () => ({
                ok: true,
                async json() {
                    return [
                        {
                            id: 'm1',
                            metadata: 'cipher1',
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            dataEncryptionKey: null,
                            seq: 1,
                            active: true,
                            activeAt: 10,
                            revokedAt: null,
                            createdAt: 1,
                            updatedAt: 2,
                        },
                        {
                            id: 'm2',
                            metadata: 'cipher2',
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                            dataEncryptionKey: null,
                            seq: 2,
                            active: false,
                            activeAt: 20,
                            revokedAt: null,
                            createdAt: 3,
                            updatedAt: 4,
                        },
                    ];
                },
            } as any)),
            cachedMachineDisplayEntries: {
                m1: { metadataVersion: 1, displayName: 'one', host: 'h1', homeDir: '/h1' } as any,
                m2: { metadataVersion: 2, displayName: 'two', host: 'h2', homeDir: '/h2' } as any,
            },
            applyMachineDisplayEntries,
            applyMachines,
        });

        expect(applyMachineDisplayEntries).toHaveBeenCalledTimes(1);
        expect(applyMachines).toHaveBeenCalledTimes(1);
        expect(applyMachineDisplayEntries.mock.calls[0]?.[0]).toHaveLength(2);
        expect(applyMachines.mock.calls[0]?.[0]).toHaveLength(2);
    });
});
