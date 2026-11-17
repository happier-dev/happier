import { describe, expect, it } from 'vitest';
import { resolvePetPackage } from './resolvePetPackage';

describe('resolvePetPackage', () => {
    it('distinguishes a cold library from a deleted pet and a disabled feature', () => {
        const ref = { kind: 'accountPet', accountPetId: 'pet-1' } as const;
        const input = { ref, petsEnabled: true, syncEnabled: true, accountPetsStatus: 'pending' as const,
            accountPetsById: new Map(), builtInPetIds: ['blink'] };
        expect(resolvePetPackage(input)).toEqual({ status: 'pending', source: null });
        expect(resolvePetPackage({ ...input, accountPetsStatus: 'ready' })).toEqual({ status: 'unavailable', source: null });
        expect(resolvePetPackage({ ...input, syncEnabled: false })).toEqual({ status: 'unavailable', source: null });
        const source = { kind: 'accountPet', accountPetId: 'pet-1', sourceKey: 'pet-1' } as const;
        expect(resolvePetPackage({ ...input, accountPetsById: new Map([['pet-1', source]]) })).toEqual({ status: 'ready', source });
        expect(resolvePetPackage({ ...input, accountPetsStatus: 'unavailable', accountPetsById: new Map([['pet-1', source]]) })).toEqual({ status: 'unavailable', source: null });
        expect(resolvePetPackage({ ...input, ref: { kind: 'builtIn', petId: 'blink' }, syncEnabled: false })).toEqual({
            status: 'ready', source: { kind: 'builtIn', petId: 'blink' },
        });
        expect(resolvePetPackage({ ...input, petsEnabled: false })).toEqual({ status: 'unavailable', source: null });
    });
});
