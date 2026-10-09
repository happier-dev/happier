import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';

import { areStoredMachinesEqual } from './areStoredMachinesEqual';

describe('areStoredMachinesEqual', () => {
    it('keeps changed encryption/access authority even when display content is equal', () => {
        const previous = createMachineFixture({ dataEncryptionKey: 'old', keyBasis: { dataEncryptionKey: 'owner-old', metadataVersion: 1, daemonStateVersion: 1 } });
        expect(areStoredMachinesEqual(previous, { ...previous, dataEncryptionKey: 'new' })).toBe(false);
        expect(areStoredMachinesEqual(previous, { ...previous, keyBasis: { ...previous.keyBasis!, dataEncryptionKey: 'owner-new' } })).toBe(false);
        const access = { custodian: { accountId: 'custodian', displayName: 'Owner' }, role: 'use' as const, resourceMode: 'e2ee' as const, accessState: 'ready' as const };
        expect(areStoredMachinesEqual({ ...previous, access }, { ...previous, access: { ...access, accessState: 'key_pending' } })).toBe(false);
    });
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
