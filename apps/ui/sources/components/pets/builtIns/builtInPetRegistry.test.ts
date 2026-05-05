import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PET_ATLAS_V1, PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_PET_IDS,
    BUILT_IN_PET_PACKAGES,
    DEFAULT_BUILT_IN_PET_ID,
    resolveBuiltInPetPackage,
} from './builtInPetRegistry';

describe('builtInPetRegistry', () => {
    const expectedBuiltInPetIds = ['blink', 'fury', 'milo', 'oli', 'titi'] as const;

    it('registers Blink as the default built-in pet package', () => {
        expect(DEFAULT_BUILT_IN_PET_ID).toBe('blink');
        expect(BUILT_IN_PET_IDS).toContain('blink');

        const blink = resolveBuiltInPetPackage('blink');
        expect(blink).toEqual(BUILT_IN_PET_PACKAGES.blink);
        expect(blink.manifest).toEqual(expect.objectContaining({
            id: 'blink',
            displayName: 'Blink',
            spritesheetPath: 'spritesheet.webp',
        }));
        expect(blink.atlas).toEqual(PET_ATLAS_V1);
    });

    it('registers every source-validated built-in pet package', () => {
        expect(BUILT_IN_PET_IDS).toEqual(expect.arrayContaining([...expectedBuiltInPetIds]));
        expect(BUILT_IN_PET_IDS).not.toContain('holly');

        for (const petId of expectedBuiltInPetIds) {
            const petPackage = resolveBuiltInPetPackage(petId);
            expect(petPackage.id).toBe(petId);
            expect(petPackage.manifest.id).toBe(petId);
            expect(petPackage.atlas).toEqual(PET_ATLAS_V1);
            expect(petPackage.provenance.sourcePackageId).toBe(petId);
        }
    });

    it('bundles each built-in manifest and spritesheet inside the UI assets tree', () => {
        for (const petId of expectedBuiltInPetIds) {
            const petPackage = resolveBuiltInPetPackage(petId);
            const packageDir = resolve(process.cwd(), 'sources/assets/pets', petId);
            const manifestPath = resolve(packageDir, 'pet.json');
            const spritesheetPath = resolve(packageDir, petPackage.manifest.spritesheetPath);

            expect(existsSync(manifestPath)).toBe(true);
            expect(existsSync(spritesheetPath)).toBe(true);
            expect(statSync(spritesheetPath).size).toBeLessThanOrEqual(
                PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
            );
            expect(petPackage.spritesheetSource).toBe(spritesheetPath);
        }
    });

    it('falls back to Blink for unknown built-in ids without mutating settings', () => {
        expect(resolveBuiltInPetPackage('newer-client-pet')).toBe(resolveBuiltInPetPackage('blink'));
    });
});
