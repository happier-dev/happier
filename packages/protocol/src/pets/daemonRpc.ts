import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { AccountPetCreateResponseV1Schema, PetAssetMediaTypeV1Schema } from './accountLibrary.js';
import { appendCanonicalPetSpritesheetMediaTypeIssueV1 } from './assetFormats.js';
import { PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 } from './constants.js';
import { PetPackageManifestV1Schema } from './manifest.js';
import { PetPackageSourceV1Schema } from './source.js';

export const PET_DAEMON_RPC_METHODS = Object.freeze({
  DISCOVER_PACKAGES: 'pets.discoverPackages',
  VALIDATE_PACKAGE: 'pets.validatePackage',
  IMPORT_LOCAL_PACKAGE: 'pets.importLocalPackage',
  IMPORT_ACCOUNT_PACKAGE: 'pets.importAccountPackage',
  FORGET_LOCAL_PACKAGE: 'pets.forgetLocalPackage',
  READ_PREVIEW_ASSET: 'pets.readPreviewAsset',
});

export const PetDiscoveryDiagnosticCodeV1Schema = lazyZodSchema(() => z.enum([
  'root_not_found',
  'root_unreadable',
  'pet_limit_exceeded',
  'root_limit_exceeded',
  'time_budget_exceeded',
  'invalid_package',
]));

export type PetDiscoveryDiagnosticCodeV1 = z.infer<typeof PetDiscoveryDiagnosticCodeV1Schema>;

export const PetDiscoveryDiagnosticV1Schema = lazyZodSchema(() => z.looseObject({
    code: PetDiscoveryDiagnosticCodeV1Schema,
    message: z.string().check(z.minLength(1)),
    rootPath: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
    packagePath: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  }));

export type PetDiscoveryDiagnosticV1 = z.infer<typeof PetDiscoveryDiagnosticV1Schema>;

const PetSourcePreviewHandleV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('daemonSourceKey'),
    sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
  }));

export const DiscoveredPetPackageV1Schema = lazyZodSchema(() => z.strictObject({
    sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    kind: z.enum(PetPackageSourceV1Schema.def.options.map((source) => source.shape.kind.def.values[0])),
    petId: z.string().check(z.minLength(1), z.maxLength(200)),
    displayName: z.string().check(z.minLength(1), z.maxLength(200)),
    description: PetPackageManifestV1Schema.shape.description,
    originLabel: z.string().check(z.minLength(1), z.maxLength(200)),
    packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
    manifest: PetPackageManifestV1Schema,
    previewHandle: z.optional(PetSourcePreviewHandleV1Schema),
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.optional(z.string().check(z.minLength(1), z.maxLength(500))),
    sizeBytes: z.optional(z.number().check(z.int(), z.minimum(0))),
  }).check(z.superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.mediaType,
    });
  })));

export type DiscoveredPetPackageV1 = z.infer<typeof DiscoveredPetPackageV1Schema>;

export const DaemonPetDiscoverRequestV1Schema = lazyZodSchema(() => z.looseObject({
    includeDetectedCodexHomes: z.optional(z.boolean()),
    includeUserCodexHome: z._default(z.optional(z.boolean()), true),
    includeConnectedServiceCodexHomes: z._default(z.optional(z.boolean()), true),
    includeManagedLocal: z._default(z.optional(z.boolean()), true),
    maxPetsPerRoot: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1000))),
    maxRoots: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(1000))),
    maxDiscoveryWallClockMs: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(60_000))),
  }));

export type DaemonPetDiscoverRequestV1 = z.infer<typeof DaemonPetDiscoverRequestV1Schema>;

export const DaemonPetDiscoverResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      pets: z.array(DiscoveredPetPackageV1Schema),
      diagnostics: z.optional(z.array(PetDiscoveryDiagnosticV1Schema)),
      partial: z.optional(z.boolean()),
    }),
  z.looseObject({ ok: z.literal(false), errorCode: z.enum(['invalid_request', 'feature_disabled', 'rate_limited', 'internal_error']), error: z.string().check(z.minLength(1)) }),
]));

export type DaemonPetDiscoverResponseV1 = z.infer<typeof DaemonPetDiscoverResponseV1Schema>;

export const PetPackageValidationIssueCodeV1Schema = lazyZodSchema(() => z.enum([
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
  'symlink_escape',
  'internal_error',
]));

export type PetPackageValidationIssueCodeV1 = z.infer<typeof PetPackageValidationIssueCodeV1Schema>;

export const PetPackageValidationIssueV1Schema = lazyZodSchema(() => z.looseObject({
    code: PetPackageValidationIssueCodeV1Schema,
    message: z.string().check(z.minLength(1)),
    path: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  }));

export type PetPackageValidationIssueV1 = z.infer<typeof PetPackageValidationIssueV1Schema>;

export const PetPackageValidationResultV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      packageFormat: z.literal(PET_PACKAGE_FORMAT_CODEX_ATLAS_V1),
      manifest: PetPackageManifestV1Schema,
      spritesheetPath: z.string().check(z.minLength(1), z.maxLength(10_000)),
      mediaType: PetAssetMediaTypeV1Schema,
      width: z.number().check(z.int(), z.minimum(1)),
      height: z.number().check(z.int(), z.minimum(1)),
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
      sizeBytes: z.number().check(z.int(), z.minimum(0)),
    }).check(z.superRefine((value, ctx) => {
      appendCanonicalPetSpritesheetMediaTypeIssueV1({
        ctx,
        spritesheetPath: value.manifest.spritesheetPath,
        mediaType: value.mediaType,
      });
    })),
  z.looseObject({ ok: z.literal(false), issues: z.array(PetPackageValidationIssueV1Schema).check(z.minLength(1)) }),
]));

export type PetPackageValidationResultV1 = z.infer<typeof PetPackageValidationResultV1Schema>;

export const DaemonPetValidatePackageRequestV1Schema = lazyZodSchema(() => z.looseObject({
    packagePath: DaemonPetImportAccountPackageRequestV1Schema.def.shape.packagePath,
    sourceKey: DaemonPetImportAccountPackageRequestV1Schema.def.shape.sourceKey,
    strict: z._default(z.optional(z.boolean()), false),
    maxManifestBytes: z.optional(z.number().check(z.int(), z.minimum(1))),
    maxSpritesheetBytes: z.optional(z.number().check(z.int(), z.minimum(1))),
  }).check(z.refine(hasPetPackageLocatorV1, { message: 'sourceKey or packagePath is required' })));

export type DaemonPetValidatePackageRequestV1 = z.infer<typeof DaemonPetValidatePackageRequestV1Schema>;

export const DaemonPetValidatePackageResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), validation: PetPackageValidationResultV1Schema, previewHandle: z.optional(PetSourcePreviewHandleV1Schema) }),
  z.looseObject({ ok: z.literal(false), errorCode: z.enum(['invalid_request', 'feature_disabled', 'rate_limited', 'internal_error']), error: z.string().check(z.minLength(1)) }),
]));

export type DaemonPetValidatePackageResponseV1 = z.infer<typeof DaemonPetValidatePackageResponseV1Schema>;

/** Import may name a discovered source or an explicit package; explicit paths take precedence. */
export function hasPetPackageLocatorV1(value: Readonly<{ sourceKey?: string; packagePath?: string }>): boolean {
  return Boolean(value.sourceKey || value.packagePath);
}

export const DaemonPetImportLocalPackageRequestV1Schema = lazyZodSchema(() => z
  .object({
    sourceKey: z.optional(z.string().check(z.minLength(1), z.maxLength(500))),
    packagePath: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
  }).check(z.refine(hasPetPackageLocatorV1, {
    message: 'sourceKey or packagePath is required',
  })));

export type DaemonPetImportLocalPackageRequestV1 = z.infer<typeof DaemonPetImportLocalPackageRequestV1Schema>;

export const ImportedLocalPetPackageV1Schema = lazyZodSchema(() => z.strictObject({
    sourceKey: DiscoveredPetPackageV1Schema.shape.sourceKey,
    kind: z.literal('happierManagedLocal'),
    petId: DiscoveredPetPackageV1Schema.shape.petId,
    displayName: DiscoveredPetPackageV1Schema.shape.displayName,
    description: DiscoveredPetPackageV1Schema.shape.description,
    originLabel: DiscoveredPetPackageV1Schema.shape.originLabel,
    digest: z.string().check(z.minLength(1), z.maxLength(500)),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
    mediaType: PetAssetMediaTypeV1Schema,
    previewHandle: PetSourcePreviewHandleV1Schema,
    manifest: PetPackageManifestV1Schema,
  }).check(z.superRefine((value, ctx) => {
    appendCanonicalPetSpritesheetMediaTypeIssueV1({
      ctx,
      spritesheetPath: value.manifest.spritesheetPath,
      mediaType: value.mediaType,
    });
  })));

export type ImportedLocalPetPackageV1 = z.infer<typeof ImportedLocalPetPackageV1Schema>;

export const DaemonPetImportLocalPackageResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      importedPet: ImportedLocalPetPackageV1Schema,
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'quota_exceeded', 'validation_failed', 'rate_limited', 'internal_error']),
      error: z.string().check(z.minLength(1)),
      validation: z.optional(PetPackageValidationResultV1Schema),
    }),
]));

export type DaemonPetImportLocalPackageResponseV1 = z.infer<typeof DaemonPetImportLocalPackageResponseV1Schema>;

export const DaemonPetImportAccountPackageRequestV1Schema = lazyZodSchema(() => z
  .object({
    sourceKey: z.optional(z.string().check(z.minLength(1), z.maxLength(500))),
    packagePath: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
    petsSyncEnabled: z._default(z.optional(z.boolean()), false),
  }).check(z.refine(hasPetPackageLocatorV1, {
    message: 'sourceKey or packagePath is required',
  })));

export type DaemonPetImportAccountPackageRequestV1 = z.infer<typeof DaemonPetImportAccountPackageRequestV1Schema>;

export const DaemonPetForgetLocalPackageRequestV1Schema = lazyZodSchema(() => z.looseObject({
    sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
  }));

export type DaemonPetForgetLocalPackageRequestV1 = z.infer<typeof DaemonPetForgetLocalPackageRequestV1Schema>;

export const DaemonPetForgetLocalPackageResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'validation_failed', 'unsupported_source', 'rate_limited', 'internal_error']),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type DaemonPetForgetLocalPackageResponseV1 = z.infer<typeof DaemonPetForgetLocalPackageResponseV1Schema>;

export const DaemonPetImportRequestV1Schema = lazyZodSchema(() => z.looseObject({
    target: z.enum(['local', 'account']),
    packagePath: z.string().check(z.minLength(1), z.maxLength(10_000)),
    source: z.optional(PetPackageSourceV1Schema),
    petsSyncEnabled: z._default(z.optional(z.boolean()), false),
  }));

export type DaemonPetImportRequestV1 = z.infer<typeof DaemonPetImportRequestV1Schema>;

export const DaemonPetImportResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      ok: z.literal(true),
      target: z.literal('local'),
      source: PetPackageSourceV1Schema,
      manifest: PetPackageManifestV1Schema,
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
      sizeBytes: z.number().check(z.int(), z.minimum(0)),
      mediaType: PetAssetMediaTypeV1Schema,
    }),
  z.looseObject({
      ok: z.literal(true),
      target: z.literal('account'),
      account: AccountPetCreateResponseV1Schema,
    }),
  z.looseObject({
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
      error: z.string().check(z.minLength(1)),
      validation: z.optional(PetPackageValidationResultV1Schema),
    }),
]));

export type DaemonPetImportResponseV1 = z.infer<typeof DaemonPetImportResponseV1Schema>;

export const DaemonPetReadPreviewAssetRequestV1Schema = lazyZodSchema(() => z
  .object({
    sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    maxBytes: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(50 * 1024 * 1024))),
  }));

export type DaemonPetReadPreviewAssetRequestV1 = z.infer<typeof DaemonPetReadPreviewAssetRequestV1Schema>;

export const DaemonPetReadPreviewAssetResponseV1Schema = lazyZodSchema(() => z.union([
  z.looseObject({
      sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
      mediaType: PetAssetMediaTypeV1Schema,
      digest: z.string().check(z.minLength(1), z.maxLength(500)),
      dataBase64: z.string(),
      sizeBytes: z.number().check(z.int(), z.minimum(0)),
    }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: z.enum(['invalid_request', 'feature_disabled', 'not_found', 'payload_too_large', 'validation_failed', 'unsupported_source', 'rate_limited', 'internal_error']),
      error: z.string().check(z.minLength(1)),
    }),
]));

export type DaemonPetReadPreviewAssetResponseV1 = z.infer<typeof DaemonPetReadPreviewAssetResponseV1Schema>;
