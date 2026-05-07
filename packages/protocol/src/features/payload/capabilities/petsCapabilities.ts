import { z } from 'zod';

import {
  BUILT_IN_PET_IDS_V1,
  PET_PACKAGE_LIMITS_V1,
  PET_SYNC_SUPPORTED_MEDIA_TYPES_V1,
} from '../../../pets/constants.js';

function positiveIntWithDefault(defaultValue: number) {
  return z.number().int().positive().optional().default(defaultValue);
}

export const PetsPackageLimitsCapabilitiesSchema = z.object({
  maxManifestBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxManifestBytes),
  maxCanonicalSpritesheetBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes),
  maxCanonicalPackageBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes),
  maxPreCanonicalImportBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxPreCanonicalImportBytes),
  maxImportedPetsPerAccount: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount),
  maxImportedPetBytesPerAccount: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount),
  maxImportedPetsPerDevice: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice),
  maxImportedPetBytesPerDevice: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice),
});

export type PetsPackageLimitsCapabilities = z.infer<typeof PetsPackageLimitsCapabilitiesSchema>;

export const DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES: PetsPackageLimitsCapabilities = {
  maxManifestBytes: PET_PACKAGE_LIMITS_V1.maxManifestBytes,
  maxCanonicalSpritesheetBytes: PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes,
  maxCanonicalPackageBytes: PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes,
  maxPreCanonicalImportBytes: PET_PACKAGE_LIMITS_V1.maxPreCanonicalImportBytes,
  maxImportedPetsPerAccount: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount,
  maxImportedPetBytesPerAccount: PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount,
  maxImportedPetsPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice,
  maxImportedPetBytesPerDevice: PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice,
};

export const PetsCompanionCapabilitiesSchema = z.object({
  builtInPetIds: z.array(z.string().min(1).max(200)).optional().default([...BUILT_IN_PET_IDS_V1]),
});

export type PetsCompanionCapabilities = z.infer<typeof PetsCompanionCapabilitiesSchema>;

export const DEFAULT_PETS_COMPANION_CAPABILITIES: PetsCompanionCapabilities = {
  builtInPetIds: [...BUILT_IN_PET_IDS_V1],
};

export const PetsEncryptedCustomPetSyncPolicySchema = z.enum(['disabled', 'allowedWithClientValidation']);
export type PetsEncryptedCustomPetSyncPolicy = z.infer<typeof PetsEncryptedCustomPetSyncPolicySchema>;

export const PetsSyncSupportedMediaTypeSchema = z.enum(PET_SYNC_SUPPORTED_MEDIA_TYPES_V1);
export type PetsSyncSupportedMediaType = z.infer<typeof PetsSyncSupportedMediaTypeSchema>;

export const PetsSyncCapabilitiesSchema = PetsPackageLimitsCapabilitiesSchema.extend({
  supportedMediaTypes: z
    .array(PetsSyncSupportedMediaTypeSchema)
    .optional()
    .default([...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1]),
  encryptedCustomPetSyncPolicy: PetsEncryptedCustomPetSyncPolicySchema.optional().default('disabled'),
});

export type PetsSyncCapabilities = z.infer<typeof PetsSyncCapabilitiesSchema>;

export const DEFAULT_PETS_SYNC_CAPABILITIES: PetsSyncCapabilities = {
  ...DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES,
  supportedMediaTypes: [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1],
  encryptedCustomPetSyncPolicy: 'disabled',
};

export const PetsCapabilitiesSchema = z.object({
  companion: PetsCompanionCapabilitiesSchema.optional().default(DEFAULT_PETS_COMPANION_CAPABILITIES),
  limits: PetsPackageLimitsCapabilitiesSchema.optional().default(DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES),
  sync: PetsSyncCapabilitiesSchema.optional().default(DEFAULT_PETS_SYNC_CAPABILITIES),
});

export type PetsCapabilities = z.infer<typeof PetsCapabilitiesSchema>;

export const DEFAULT_PETS_CAPABILITIES: PetsCapabilities = {
  companion: DEFAULT_PETS_COMPANION_CAPABILITIES,
  limits: DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES,
  sync: DEFAULT_PETS_SYNC_CAPABILITIES,
};
