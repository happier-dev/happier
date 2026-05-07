import {
    PET_ATLAS_V1,
    type BuiltInPetIdV1,
    type PetPackageManifestV1,
} from '@happier-dev/protocol';
import type { ImageProps } from 'expo-image';

export type BuiltInPetId = BuiltInPetIdV1;

export type BuiltInPetPackage = Readonly<{
    id: BuiltInPetId;
    manifest: PetPackageManifestV1;
    atlas: typeof PET_ATLAS_V1;
    spritesheetSource: ImageProps['source'];
    provenance: Readonly<{
        kind: 'localUserProvidedCodexPetPackage';
        sourcePackageId: string;
        sourcePackageDisplayName: string;
    }>;
}>;

const blinkSpritesheetSource = require('@/assets/pets/blink/spritesheet.webp') as ImageProps['source'];
const furySpritesheetSource = require('@/assets/pets/fury/spritesheet.webp') as ImageProps['source'];
const miloSpritesheetSource = require('@/assets/pets/milo/spritesheet.webp') as ImageProps['source'];
const oliSpritesheetSource = require('@/assets/pets/oli/spritesheet.webp') as ImageProps['source'];
const titiSpritesheetSource = require('@/assets/pets/titi/spritesheet.webp') as ImageProps['source'];

export const DEFAULT_BUILT_IN_PET_ID = 'blink' satisfies BuiltInPetId;

export const BUILT_IN_PET_PACKAGES = {
    blink: {
        id: 'blink',
        manifest: {
            id: 'blink',
            displayName: 'Blink',
            description: 'Friendly alpine marmot inspired by the reference photo.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        spritesheetSource: blinkSpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'blink',
            sourcePackageDisplayName: 'Blink',
        },
    },
    fury: {
        id: 'fury',
        manifest: {
            id: 'fury',
            displayName: 'Fury',
            description: 'Bold ibex companion inspired by the sunset ibex reference.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        spritesheetSource: furySpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'fury',
            sourcePackageDisplayName: 'Fury',
        },
    },
    milo: {
        id: 'milo',
        manifest: {
            id: 'milo',
            displayName: 'Milo',
            description: 'A compact white-and-tabby cat digital pet with green eyes and a small collar tag.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        spritesheetSource: miloSpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'milo',
            sourcePackageDisplayName: 'Milo',
        },
    },
    oli: {
        id: 'oli',
        manifest: {
            id: 'oli',
            displayName: 'Oli',
            description: 'A compact black cat digital pet with green eyes and a small light collar tag.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        spritesheetSource: oliSpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'oli',
            sourcePackageDisplayName: 'Oli',
        },
    },
    titi: {
        id: 'titi',
        manifest: {
            id: 'titi',
            displayName: 'Titi',
            description: 'Tabby cat companion inspired by the reference photo.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        spritesheetSource: titiSpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'titi',
            sourcePackageDisplayName: 'Titi',
        },
    },
} as const satisfies Record<BuiltInPetId, BuiltInPetPackage>;

export const BUILT_IN_PET_IDS = Object.freeze(
    Object.keys(BUILT_IN_PET_PACKAGES),
) as readonly BuiltInPetId[];

export function resolveBuiltInPetPackage(petId: string): BuiltInPetPackage {
    if (petId in BUILT_IN_PET_PACKAGES) {
        return BUILT_IN_PET_PACKAGES[petId as BuiltInPetId];
    }

    return BUILT_IN_PET_PACKAGES[DEFAULT_BUILT_IN_PET_ID];
}
