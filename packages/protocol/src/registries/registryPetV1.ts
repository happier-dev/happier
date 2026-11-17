import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PetPackageManifestV1Schema, type PetPackageManifestV1 } from '../pets/manifest.js';
import type { PetAssetMediaTypeV1 } from '../pets/accountLibrary.js';

export const RegistryPetContentUrlV1Schema = lazyZodSchema(() => z.string().check(z.url(), z.refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
})));
export const RegistryPetMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  spritesheetUrl: RegistryPetContentUrlV1Schema, spriteVersionNumber: z.optional(z.number().check(z.int(), z.minimum(1))),
  reportUrl: RegistryPetContentUrlV1Schema, termsUrl: RegistryPetContentUrlV1Schema,
}));
export type RegistryPetMetadataV1 = z.infer<typeof RegistryPetMetadataV1Schema>;
export const RegistryPetListingV1Schema = lazyZodSchema(() => z.strictObject({
  ...RegistryPetMetadataV1Schema.def.shape, manifest: PetPackageManifestV1Schema,
}));
export type RegistryPetListingV1 = z.infer<typeof RegistryPetListingV1Schema>;
export type RegistryPetAcquisitionV1 = Readonly<{
  manifest: PetPackageManifestV1; spritesheetBytes: Uint8Array; mediaType: PetAssetMediaTypeV1;
  origin: Readonly<{ kind: 'registry'; sourceId: string; itemId: string }>;
}>;
