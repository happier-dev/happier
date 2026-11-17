import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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

export const PetManifestSpritesheetPathV1Schema = lazyZodSchema(() => z.enum(PET_MANIFEST_SPRITESHEET_PATHS_V1));

export const PetPackageManifestV1Schema = lazyZodSchema(() => z.looseObject({
    id: z.string().check(z.minLength(1), z.maxLength(200)),
    displayName: z.string().check(z.minLength(1), z.maxLength(200)),
    description: z.string().check(z.minLength(1), z.maxLength(2000)),
    spritesheetPath: PetManifestSpritesheetPathV1Schema,
    spriteVersionNumber: z.optional(z.union([z.literal(1), z.literal(2)])),
  }));

export type PetPackageManifestV1 = z.infer<typeof PetPackageManifestV1Schema>;
