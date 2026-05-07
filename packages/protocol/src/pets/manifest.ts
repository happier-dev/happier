import { z } from 'zod';

import {
  PET_CANONICAL_SPRITESHEET_PATHS_V1,
  type PetCanonicalSpritesheetPathV1,
} from './assetFormats.js';

export const PET_MANIFEST_SPRITESHEET_PATHS_V1 = PET_CANONICAL_SPRITESHEET_PATHS_V1;

export type PetManifestSpritesheetPathV1 = PetCanonicalSpritesheetPathV1;

export function isCanonicalPetSpritesheetPathV1(value: unknown): value is PetManifestSpritesheetPathV1 {
  return typeof value === 'string'
    && (PET_MANIFEST_SPRITESHEET_PATHS_V1 as readonly string[]).includes(value);
}

export const PetManifestSpritesheetPathV1Schema = z.enum(PET_MANIFEST_SPRITESHEET_PATHS_V1);

export const PetPackageManifestV1Schema = z
  .object({
    id: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    spritesheetPath: PetManifestSpritesheetPathV1Schema,
  })
  .strict();

export type PetPackageManifestV1 = z.infer<typeof PetPackageManifestV1Schema>;
