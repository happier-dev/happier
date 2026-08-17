import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';

import { areStoredMachinesEqual } from './areStoredMachinesEqual';

describe('areStoredMachinesEqual', () => {
    it('treats Machine storage availability and locked reason transitions as state changes', () => {
        const available = createMachineFixture({
            storageMode: 'e2ee',
            availability: { kind: 'available' },
        });
        const materialUnavailable = {
            ...available,
            metadata: null,
            daemonState: null,
            availability: {
                kind: 'locked',
                reason: 'encryption_material_unavailable',
            },
        } as const;
        const decryptionFailed = {
            ...materialUnavailable,
            availability: {
                kind: 'locked',
                reason: 'decryption_failed',
            },
        } as const;

        expect(areStoredMachinesEqual(available, materialUnavailable)).toBe(false);
        expect(areStoredMachinesEqual(materialUnavailable, decryptionFailed)).toBe(false);
        expect(areStoredMachinesEqual(
            available,
            { ...available, storageMode: 'plain' },
        )).toBe(false);
    });
});
