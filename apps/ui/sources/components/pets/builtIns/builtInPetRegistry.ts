import { BUILT_IN_PET_IDS_V1, PET_ATLAS_V1 } from '@happier-dev/protocol/pets/constants';
import type { PetPackageManifestV1 } from '@happier-dev/protocol/pets/manifest';
import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import type { ImageProps } from 'expo-image';

export type BuiltInPetId = typeof BUILT_IN_PET_IDS_V1[number];

export type BuiltInPetPackage = Readonly<{
    id: BuiltInPetId;
    manifest: PetPackageManifestV1;
    atlas: typeof PET_ATLAS_V1;
    opaqueBounds: PetCellBoundsV1;
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

// Measured once from the bundled atlases by inspectPetAtlasRgbaPixelsV1.
// The registry test checks these constants against every actual spritesheet.
const BUILT_IN_OPAQUE_BOUNDS = { x: 5, y: 5, width: 182, height: 198 } as const satisfies PetCellBoundsV1;

export const BUILT_IN_PET_PACKAGES: Readonly<Record<BuiltInPetId, BuiltInPetPackage>> = {
    blink: {
        id: 'blink',
        manifest: {
            id: 'blink',
            displayName: 'Blink',
            description: 'Friendly alpine marmot inspired by the reference photo.',
            spritesheetPath: 'spritesheet.webp',
        },
        atlas: PET_ATLAS_V1,
        opaqueBounds: BUILT_IN_OPAQUE_BOUNDS,
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
        opaqueBounds: BUILT_IN_OPAQUE_BOUNDS,
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
        opaqueBounds: BUILT_IN_OPAQUE_BOUNDS,
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
        opaqueBounds: BUILT_IN_OPAQUE_BOUNDS,
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
        opaqueBounds: BUILT_IN_OPAQUE_BOUNDS,
        spritesheetSource: titiSpritesheetSource,
        provenance: {
            kind: 'localUserProvidedCodexPetPackage',
            sourcePackageId: 'titi',
            sourcePackageDisplayName: 'Titi',
        },
    },
} as const satisfies Record<BuiltInPetId, BuiltInPetPackage>;

export const BUILT_IN_PET_IDS = Object.freeze(BUILT_IN_PET_IDS_V1);

export function resolveBuiltInPetPackage(petId: string): BuiltInPetPackage {
    if (petId in BUILT_IN_PET_PACKAGES) {
        return BUILT_IN_PET_PACKAGES[petId as BuiltInPetId];
    }

    return BUILT_IN_PET_PACKAGES[DEFAULT_BUILT_IN_PET_ID];
}
