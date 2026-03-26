import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import { fetchAndApplyMachines } from './syncMachines';

describe('fetchAndApplyMachines error propagation', () => {
    it('throws when the machine list request fails', async () => {
        const credentials: AuthCredentials = { token: 't', secret: 's' };

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
                    throw new Error('Network request failed');
                }),
                applyMachines: vi.fn(),
            }),
        ).rejects.toThrow('Network request failed');
    });
});
