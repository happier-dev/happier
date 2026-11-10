import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import {
  BUILT_IN_PET_IDS_V1,
  PET_PACKAGE_LIMITS_V1,
  PET_SYNC_SUPPORTED_MEDIA_TYPES_V1,
} from '../../../pets/constants.js';

function positiveIntWithDefault(defaultValue: number) {
  return z._default(z.optional(z.number().check(z.int(), z.positive())), defaultValue);
}

export const PetsPackageLimitsCapabilitiesSchema = lazyZodSchema(() => z.object({
  maxManifestBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxManifestBytes),
  maxCanonicalSpritesheetBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes),
  maxCanonicalPackageBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes),
  maxPreCanonicalImportBytes: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxPreCanonicalImportBytes),
  maxImportedPetsPerAccount: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetsPerAccount),
  maxImportedPetBytesPerAccount: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerAccount),
  maxImportedPetsPerDevice: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice),
  maxImportedPetBytesPerDevice: positiveIntWithDefault(PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice),
}));

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

export const PetsCompanionCapabilitiesSchema = lazyZodSchema(() => z.object({
  builtInPetIds: z._default(z.optional(z.array(z.string().check(z.minLength(1), z.maxLength(200)))), [...BUILT_IN_PET_IDS_V1]),
}));

export type PetsCompanionCapabilities = z.infer<typeof PetsCompanionCapabilitiesSchema>;

export const DEFAULT_PETS_COMPANION_CAPABILITIES: PetsCompanionCapabilities = {
  builtInPetIds: [...BUILT_IN_PET_IDS_V1],
};

export const PetsEncryptedCustomPetSyncPolicySchema = lazyZodSchema(() => z.enum(['disabled', 'allowedWithClientValidation']));
export type PetsEncryptedCustomPetSyncPolicy = z.infer<typeof PetsEncryptedCustomPetSyncPolicySchema>;

export const PetsSyncSupportedMediaTypeSchema = lazyZodSchema(() => z.enum(PET_SYNC_SUPPORTED_MEDIA_TYPES_V1));
export type PetsSyncSupportedMediaType = z.infer<typeof PetsSyncSupportedMediaTypeSchema>;

export const PetsSyncCapabilitiesSchema = lazyZodSchema(() => z.extend(PetsPackageLimitsCapabilitiesSchema, {
  supportedMediaTypes: z._default(z.optional(z
    .array(PetsSyncSupportedMediaTypeSchema)), [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1]),
  encryptedCustomPetSyncPolicy: z._default(z.optional(PetsEncryptedCustomPetSyncPolicySchema), 'disabled'),
}));

export type PetsSyncCapabilities = z.infer<typeof PetsSyncCapabilitiesSchema>;

export const DEFAULT_PETS_SYNC_CAPABILITIES: PetsSyncCapabilities = {
  ...DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES,
  supportedMediaTypes: [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1],
  encryptedCustomPetSyncPolicy: 'disabled',
};

export const PetsCapabilitiesSchema = lazyZodSchema(() => z.object({
  companion: z._default(z.optional(PetsCompanionCapabilitiesSchema), DEFAULT_PETS_COMPANION_CAPABILITIES),
  limits: z._default(z.optional(PetsPackageLimitsCapabilitiesSchema), DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES),
  sync: z._default(z.optional(PetsSyncCapabilitiesSchema), DEFAULT_PETS_SYNC_CAPABILITIES),
}));

export type PetsCapabilities = z.infer<typeof PetsCapabilitiesSchema>;

export const DEFAULT_PETS_CAPABILITIES: PetsCapabilities = {
  companion: DEFAULT_PETS_COMPANION_CAPABILITIES,
  limits: DEFAULT_PETS_PACKAGE_LIMITS_CAPABILITIES,
  sync: DEFAULT_PETS_SYNC_CAPABILITIES,
};
