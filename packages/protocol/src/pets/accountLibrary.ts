import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  appendCanonicalPetSpritesheetMediaTypeIssueV1,
  PetCanonicalSpritesheetMediaTypeV1Schema,
} from './assetFormats.js';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';
import { PetCellBoundsV1Schema } from './atlasPixelInspection.js';

export const PetAssetMediaTypeV1Schema = PetCanonicalSpritesheetMediaTypeV1Schema;
export type PetAssetMediaTypeV1 = z.infer<typeof PetAssetMediaTypeV1Schema>;

export const AccountPetAssetRefV1Schema = lazyZodSchema(() => z.looseObject({
    assetId: z.string().check(z.minLength(1), z.maxLength(500)),
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.string().check(z.minLength(1), z.maxLength(500)),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
  }));

export type AccountPetAssetRefV1 = z.infer<typeof AccountPetAssetRefV1Schema>;

export const AccountPetOriginV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('builtInImport'), petId: z.string().check(z.minLength(1), z.maxLength(200)) }),
  z.looseObject({ kind: z.literal('detectedCodexHome'), homeKind: z.enum(['user', 'connectedService']) }),
  z.looseObject({ kind: z.literal('manualImport') }),
  z.looseObject({ kind: z.literal('registry'), sourceId: z.string().check(z.minLength(1)), itemId: z.string().check(z.minLength(1)) }),
]));

export type AccountPetOriginV1 = z.infer<typeof AccountPetOriginV1Schema>;

export const AccountPetLibraryEntryV1Schema = lazyZodSchema(() => z.looseObject({
    accountPetId: z.string().check(z.minLength(1), z.maxLength(500)),
    packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
    manifest: PetPackageManifestV1Schema,
    spritesheetAssetRef: AccountPetAssetRefV1Schema,
    digest: z.string().check(z.minLength(1), z.maxLength(500)),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
    createdAt: z.number().check(z.int(), z.minimum(0)),
    updatedAt: z.number().check(z.int(), z.minimum(0)),
    origin: AccountPetOriginV1Schema,
    opaqueBounds: z.optional(PetCellBoundsV1Schema),
    hasNeutralLookCell: z.optional(z.boolean()),
  }).check(z.superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.spritesheetAssetRef.mediaType,
      mediaTypePath: ['spritesheetAssetRef', 'mediaType'],
    });
  })));

export type AccountPetLibraryEntryV1 = z.infer<typeof AccountPetLibraryEntryV1Schema>;

export const AccountPetCreateRequestV1Schema = lazyZodSchema(() => z.looseObject({
    manifest: PetPackageManifestV1Schema,
    spritesheet: z.object({
      mediaType: PetAssetMediaTypeV1Schema,
      encoding: z.literal('base64'),
      data: z.string().check(z.minLength(1)),
      sizeBytes: z.number().check(z.int(), z.minimum(1)),
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
    origin: AccountPetOriginV1Schema,
  }).check(z.superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.spritesheet.mediaType,
      mediaTypePath: ['spritesheet', 'mediaType'],
    });
  })));

export type AccountPetCreateRequestV1 = z.infer<typeof AccountPetCreateRequestV1Schema>;

export const AccountPetCreateResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), pet: AccountPetLibraryEntryV1Schema }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum([
        'invalid_request',
        'feature_disabled',
        'quota_exceeded',
        'custom_pet_sync_requires_plaintext',
        'internal_error',
      ]),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type AccountPetCreateResponseV1 = z.infer<typeof AccountPetCreateResponseV1Schema>;

export const ACCOUNT_PET_SYNC_UNAVAILABLE_ERROR_CODE_V1 = 'custom_pet_sync_unavailable' as const;

export const AccountPetSyncUnavailableResponseV1Schema = lazyZodSchema(() => z.looseObject({
    ok: z.literal(false),
    errorCode: z.literal(ACCOUNT_PET_SYNC_UNAVAILABLE_ERROR_CODE_V1),
    error: z.string().check(z.minLength(1)),
  }));

export type AccountPetSyncUnavailableResponseV1 = z.infer<typeof AccountPetSyncUnavailableResponseV1Schema>;

export const AccountPetListResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), pets: z.array(AccountPetLibraryEntryV1Schema) }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum(['feature_disabled', 'custom_pet_sync_unavailable', 'internal_error']),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type AccountPetListResponseV1 = z.infer<typeof AccountPetListResponseV1Schema>;

export const AccountPetDeleteRequestV1Schema = lazyZodSchema(() => z.strictObject({
    accountPetId: z.string().check(z.minLength(1), z.maxLength(500)),
  }));

export type AccountPetDeleteRequestV1 = z.infer<typeof AccountPetDeleteRequestV1Schema>;

export const AccountPetDeleteResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      accountPetId: z.string().check(z.minLength(1), z.maxLength(500)),
      deletedAt: z.number().check(z.int(), z.minimum(0)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum(['not_found', 'forbidden', 'feature_disabled', 'internal_error']),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type AccountPetDeleteResponseV1 = z.infer<typeof AccountPetDeleteResponseV1Schema>;

export const AccountPetChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
    domain: z.literal('accountPet'),
    action: z.enum(['create', 'update', 'delete']),
    accountPetId: z.string().check(z.minLength(1), z.maxLength(500)),
    changedAt: z.number().check(z.int(), z.minimum(0)),
    digest: z.optional(z.string().check(z.minLength(1), z.maxLength(500))),
    version: z.optional(z.number().check(z.int(), z.minimum(0))),
  }));

export type AccountPetChangeHintV1 = z.infer<typeof AccountPetChangeHintV1Schema>;

export const AccountPetAssetReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      mediaType: PetAssetMediaTypeV1Schema,
      encoding: z.literal('base64'),
      data: z.string(),
      sizeBytes: z.number().check(z.int(), z.minimum(0)),
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum([
        'not_found',
        'forbidden',
        'feature_disabled',
        'payload_too_large',
        'custom_pet_sync_unavailable',
        'internal_error',
      ]),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type AccountPetAssetReadResponseV1 = z.infer<typeof AccountPetAssetReadResponseV1Schema>;
