import { z } from 'zod';

import { AccountPetCreateResponseV1Schema, PetAssetMediaTypeV1Schema } from './accountLibrary.js';
import { appendCanonicalPetSpritesheetMediaTypeIssueV1 } from './assetFormats.js';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';
import { PetSourcePreviewHandleV1Schema, PetSourceUiKindV1Schema } from './source.js';

export const PET_DAEMON_RPC_METHODS = Object.freeze({
  DISCOVER_PACKAGES: 'pets.discoverPackages',
  VALIDATE_PACKAGE: 'pets.validatePackage',
  IMPORT_LOCAL_PACKAGE: 'pets.importLocalPackage',
  IMPORT_ACCOUNT_PACKAGE: 'pets.importAccountPackage',
  FORGET_LOCAL_PACKAGE: 'pets.forgetLocalPackage',
  READ_PREVIEW_ASSET: 'pets.readPreviewAsset',
});

export const PetDiscoveryDiagnosticCodeV1Schema = z.enum([
  'root_not_found',
  'root_unreadable',
  'pet_limit_exceeded',
  'root_limit_exceeded',
  'time_budget_exceeded',
  'invalid_package',
]);

export type PetDiscoveryDiagnosticCodeV1 = z.infer<typeof PetDiscoveryDiagnosticCodeV1Schema>;

export const PetDiscoveryDiagnosticV1Schema = z
  .object({
    code: PetDiscoveryDiagnosticCodeV1Schema,
    message: z.string().min(1),
    rootPath: z.string().min(1).max(10_000).optional(),
    packagePath: z.string().min(1).max(10_000).optional(),
  })
  .passthrough();

export type PetDiscoveryDiagnosticV1 = z.infer<typeof PetDiscoveryDiagnosticV1Schema>;

export const DiscoveredPetPackageV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
    kind: PetSourceUiKindV1Schema,
    petId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    originLabel: z.string().min(1).max(200),
    packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
    manifest: PetPackageManifestV1Schema,
    previewHandle: PetSourcePreviewHandleV1Schema.optional(),
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.string().min(1).max(500).optional(),
    sizeBytes: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.mediaType,
    });
  });

export type DiscoveredPetPackageV1 = z.infer<typeof DiscoveredPetPackageV1Schema>;

export const DaemonPetDiscoverRequestV1Schema = z
  .object({
    includeDetectedCodexHomes: z.boolean().optional(),
    includeUserCodexHome: z.boolean().optional().default(true),
    includeConnectedServiceCodexHomes: z.boolean().optional().default(true),
    includeManagedLocal: z.boolean().optional().default(true),
    maxPetsPerRoot: z.number().int().min(1).max(1000).optional(),
    maxRoots: z.number().int().min(1).max(1000).optional(),
    maxDiscoveryWallClockMs: z.number().int().min(1).max(60_000).optional(),
  })
  .passthrough();

export type DaemonPetDiscoverRequestV1 = z.infer<typeof DaemonPetDiscoverRequestV1Schema>;

export const DaemonPetDiscoverResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      pets: z.array(DiscoveredPetPackageV1Schema),
      diagnostics: z.array(PetDiscoveryDiagnosticV1Schema).optional(),
      partial: z.boolean().optional(),
    })
    .passthrough(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_request', 'feature_disabled', 'rate_limited', 'internal_error']), error: z.string().min(1) }).passthrough(),
]);

export type DaemonPetDiscoverResponseV1 = z.infer<typeof DaemonPetDiscoverResponseV1Schema>;

export const PetPackageValidationIssueCodeV1Schema = z.enum([
  'manifest_missing',
  'manifest_too_large',
  'manifest_invalid_json',
  'manifest_invalid_shape',
  'spritesheet_path_unsafe',
  'spritesheet_missing',
  'spritesheet_too_large',
  'spritesheet_invalid_media_type',
  'spritesheet_invalid_dimensions',
  'spritesheet_opaque_background',
  'package_path_unsafe',
  'package_too_large',
  'symlink_escape',
  'internal_error',
]);

export type PetPackageValidationIssueCodeV1 = z.infer<typeof PetPackageValidationIssueCodeV1Schema>;

export const PetPackageValidationIssueV1Schema = z
  .object({
    code: PetPackageValidationIssueCodeV1Schema,
    message: z.string().min(1),
    path: z.string().min(1).max(10_000).optional(),
  })
  .passthrough();

export type PetPackageValidationIssueV1 = z.infer<typeof PetPackageValidationIssueV1Schema>;

export const PetPackageValidationResultV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
      manifest: PetPackageManifestV1Schema,
      spritesheetPath: z.string().min(1).max(10_000),
      mediaType: PetAssetMediaTypeV1Schema,
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      digest: z.string().min(1).max(500),
      sizeBytes: z.number().int().min(0),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      appendCanonicalPetSpritesheetMediaTypeIssueV1({
        ctx,
        spritesheetPath: value.manifest.spritesheetPath,
        mediaType: value.mediaType,
      });
    }),
  z.object({ ok: z.literal(false), issues: z.array(PetPackageValidationIssueV1Schema).min(1) }).passthrough(),
]);

export type PetPackageValidationResultV1 = z.infer<typeof PetPackageValidationResultV1Schema>;

export const DaemonPetValidatePackageRequestV1Schema = z
  .object({
    packagePath: z.string().min(1).max(10_000),
    strict: z.boolean().optional().default(false),
    maxManifestBytes: z.number().int().min(1).optional(),
    maxSpritesheetBytes: z.number().int().min(1).optional(),
  })
  .passthrough();

export type DaemonPetValidatePackageRequestV1 = z.infer<typeof DaemonPetValidatePackageRequestV1Schema>;

export const DaemonPetValidatePackageResponseV1Schema = z.union([
  z.object({ ok: z.literal(true), validation: PetPackageValidationResultV1Schema }).passthrough(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_request', 'feature_disabled', 'rate_limited', 'internal_error']), error: z.string().min(1) }).passthrough(),
]);

export type DaemonPetValidatePackageResponseV1 = z.infer<typeof DaemonPetValidatePackageResponseV1Schema>;

export const DaemonPetImportLocalPackageRequestV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
  })
  .strict();

export type DaemonPetImportLocalPackageRequestV1 = z.infer<typeof DaemonPetImportLocalPackageRequestV1Schema>;

export const ImportedLocalPetPackageV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
    kind: z.literal('happierManagedLocal'),
    petId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    originLabel: z.string().min(1).max(200),
    digest: z.string().min(1).max(500),
    sizeBytes: z.number().int().min(0),
    mediaType: PetAssetMediaTypeV1Schema,
    previewHandle: PetSourcePreviewHandleV1Schema,
    manifest: PetPackageManifestV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.mediaType,
    });
  });

export type ImportedLocalPetPackageV1 = z.infer<typeof ImportedLocalPetPackageV1Schema>;

export const DaemonPetImportLocalPackageResponseV1Schema = z.union([
  z
    .object({
      importedPet: ImportedLocalPetPackageV1Schema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'validation_failed', 'quota_exceeded', 'rate_limited', 'internal_error']),
      error: z.string().min(1),
      validation: PetPackageValidationResultV1Schema.optional(),
    })
    .passthrough(),
]);

export type DaemonPetImportLocalPackageResponseV1 = z.infer<typeof DaemonPetImportLocalPackageResponseV1Schema>;

export const DaemonPetImportAccountPackageRequestV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
    petsSyncEnabled: z.boolean().optional().default(false),
  })
  .strict();

export type DaemonPetImportAccountPackageRequestV1 = z.infer<typeof DaemonPetImportAccountPackageRequestV1Schema>;

export const DaemonPetForgetLocalPackageRequestV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
  })
  .passthrough();

export type DaemonPetForgetLocalPackageRequestV1 = z.infer<typeof DaemonPetForgetLocalPackageRequestV1Schema>;

export const DaemonPetForgetLocalPackageResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      sourceKey: z.string().min(1).max(500),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'validation_failed', 'unsupported_source', 'rate_limited', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);

export type DaemonPetForgetLocalPackageResponseV1 = z.infer<typeof DaemonPetForgetLocalPackageResponseV1Schema>;

export const DaemonPetImportRequestV1Schema = z
  .object({
    target: z.enum(['local', 'account']),
    sourceKey: z.string().min(1).max(500),
    petsSyncEnabled: z.boolean().optional().default(false),
  })
  .strict();

export type DaemonPetImportRequestV1 = z.infer<typeof DaemonPetImportRequestV1Schema>;

export const DaemonPetImportResponseV1Schema = z.union([
  z
    .object({
      ok: z.literal(true),
      target: z.literal('local'),
      importedPet: ImportedLocalPetPackageV1Schema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(true),
      target: z.literal('account'),
      account: AccountPetCreateResponseV1Schema,
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum([
        'invalid_request',
        'feature_disabled',
        'account_upload_unavailable',
        'validation_failed',
        'quota_exceeded',
        'custom_pet_sync_requires_plaintext',
        'rate_limited',
        'internal_error',
      ]),
      error: z.string().min(1),
      validation: PetPackageValidationResultV1Schema.optional(),
    })
    .passthrough(),
]);

export type DaemonPetImportResponseV1 = z.infer<typeof DaemonPetImportResponseV1Schema>;

export const DaemonPetReadPreviewAssetRequestV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(500),
    maxBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
  });

export type DaemonPetReadPreviewAssetRequestV1 = z.infer<typeof DaemonPetReadPreviewAssetRequestV1Schema>;

export const DaemonPetReadPreviewAssetResponseV1Schema = z.union([
  z
    .object({
      sourceKey: z.string().min(1).max(500),
      mediaType: PetAssetMediaTypeV1Schema,
      digest: z.string().min(1).max(500),
      dataBase64: z.string(),
      sizeBytes: z.number().int().min(0),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'payload_too_large', 'validation_failed', 'unsupported_source', 'stale_object', 'rate_limited', 'internal_error']),
      error: z.string().min(1),
    })
    .passthrough(),
]);

export type DaemonPetReadPreviewAssetResponseV1 = z.infer<typeof DaemonPetReadPreviewAssetResponseV1Schema>;
