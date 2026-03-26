import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { fetchAndApplyMachines } from './syncMachines';

describe('fetchAndApplyMachines error propagation', () => {
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
                request: vi.fn(async () => {
                    throw networkError;
                }),
                applyMachines,
            }),
        ).rejects.toBe(networkError);

        expect(applyMachines).not.toHaveBeenCalled();
    });
});
