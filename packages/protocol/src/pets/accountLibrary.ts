import { z } from 'zod';

import {
  appendCanonicalPetSpritesheetMediaTypeIssueV1,
  PetCanonicalSpritesheetMediaTypeV1Schema,
} from './assetFormats.js';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1, PET_SYNC_SUPPORTED_MEDIA_TYPES_V1 } from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';

export const PetAssetMediaTypeV1Schema = PetCanonicalSpritesheetMediaTypeV1Schema;
export type PetAssetMediaTypeV1 = z.infer<typeof PetAssetMediaTypeV1Schema>;

export const AccountPetAssetRefV1Schema = z
  .object({
    assetId: z.string().min(1).max(500),
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.string().min(1).max(500),
    sizeBytes: z.number().int().min(0),
  })
  .passthrough();

export type AccountPetAssetRefV1 = z.infer<typeof AccountPetAssetRefV1Schema>;

export const AccountPetOriginV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtInImport'), petId: z.string().min(1).max(200) }).passthrough(),
  z.object({ kind: z.literal('detectedCodexHome'), homeKind: z.enum(['user', 'connectedService']) }).passthrough(),
  z.object({ kind: z.literal('manualImport') }).passthrough(),
]);

export type AccountPetOriginV1 = z.infer<typeof AccountPetOriginV1Schema>;

export const AccountPetLibraryEntryV1Schema = z
  .object({
    accountPetId: z.string().min(1).max(500),
    packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
    manifest: PetPackageManifestV1Schema,
    spritesheetAssetRef: AccountPetAssetRefV1Schema,
    digest: z.string().min(1).max(500),
    sizeBytes: z.number().int().min(0),
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    origin: AccountPetOriginV1Schema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.spritesheetAssetRef.mediaType,
      mediaTypePath: ['spritesheetAssetRef', 'mediaType'],
    });
  });

export type AccountPetLibraryEntryV1 = z.infer<typeof AccountPetLibraryEntryV1Schema>;

export const AccountPetCreateRequestV1Schema = z
  .object({
    manifest: PetPackageManifestV1Schema,
    spritesheet: z.object({
      mediaType: PetAssetMediaTypeV1Schema,
      encoding: z.literal('base64'),
      data: z.string().min(1),
      sizeBytes: z.number().int().min(1),
      digest: z.string().min(1).max(500),
    }),
    origin: AccountPetOriginV1Schema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.spritesheet.mediaType,
      mediaTypePath: ['spritesheet', 'mediaType'],
    });
  });

export type AccountPetCreateRequestV1 = z.infer<typeof AccountPetCreateRequestV1Schema>;

export const AccountPetCreateResponseV1Schema = z.union([
  z.object({ ok: z.literal(true), pet: AccountPetLibraryEntryV1Schema }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum([
        'invalid_request',
        'feature_disabled',
        'quota_exceeded',
        'custom_pet_sync_requires_plaintext',
        'internal_error',
      ]),
      error: z.string().min(1),
    })
    .passthrough(),
]);

export type AccountPetCreateResponseV1 = z.infer<typeof AccountPetCreateResponseV1Schema>;

export const AccountPetListResponseV1Schema = z.union([
  z.object({ ok: z.literal(true), pets: z.array(AccountPetLibraryEntryV1Schema) }).passthrough(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['feature_disabled', 'internal_error']), error: z.string().min(1) }).passthrough(),
]);

export type AccountPetListResponseV1 = z.infer<typeof AccountPetListResponseV1Schema>;

export const AccountPetDeleteRequestV1Schema = z
  .object({
    accountPetId: z.string().min(1).max(500),
  })
  .strict();

export type AccountPetDeleteRequestV1 = z.infer<typeof AccountPetDeleteRequestV1Schema>;

export const AccountPetDeleteResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      accountPetId: z.string().min(1).max(500),
      deletedAt: z.number().int().min(0),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['not_found', 'forbidden', 'feature_disabled', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);

export type AccountPetDeleteResponseV1 = z.infer<typeof AccountPetDeleteResponseV1Schema>;

export const AccountPetChangeHintV1Schema = z
  .object({
    domain: z.literal('accountPet'),
    action: z.enum(['create', 'update', 'delete']),
    accountPetId: z.string().min(1).max(500),
    changedAt: z.number().int().min(0),
    digest: z.string().min(1).max(500).optional(),
    version: z.number().int().min(0).optional(),
  })
  .strict();

export type AccountPetChangeHintV1 = z.infer<typeof AccountPetChangeHintV1Schema>;

export const AccountPetAssetReadResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      mediaType: PetAssetMediaTypeV1Schema,
      encoding: z.literal('base64'),
      data: z.string(),
      sizeBytes: z.number().int().min(0),
      digest: z.string().min(1).max(500),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['not_found', 'forbidden', 'feature_disabled', 'payload_too_large', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);

export type AccountPetAssetReadResponseV1 = z.infer<typeof AccountPetAssetReadResponseV1Schema>;
