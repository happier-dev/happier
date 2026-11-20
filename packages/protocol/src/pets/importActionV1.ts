import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { encodeBase64 } from '../crypto/base64.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import { AccountPetCreateRequestV1Schema, AccountPetDeleteRequestV1Schema, AccountPetLibraryEntryV1Schema, type AccountPetCreateRequestV1 } from './accountLibrary.js';
import { PET_PACKAGE_LIMITS_V1 } from './constants.js';
import { PetRegistryOriginV1Schema } from './portablePetV1.js';
import { DaemonPetImportAccountPackageRequestV1Schema, DaemonPetValidatePackageResponseV1Schema, PetPackageValidationResultV1Schema, hasPetPackageLocatorV1, type DaemonPetValidatePackageRequestV1 } from './daemonRpc.js';
import { PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1 } from '../actions/actionIdsPetsV1.js';
import type { ApprovalExecutionV2 } from '../approvals/approvalRequestV1.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';

/** Portable sources carry either registry identity or the Account create owner's package envelope. */
export const PetPortableImportSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PetRegistryOriginV1Schema,
  z.strictObject({ kind: z.literal('package'), package: AccountPetCreateRequestV1Schema }).check(
    z.refine(source => source.package.origin.kind !== 'registry', {
      path: ['package', 'origin'],
      message: 'Registry pets must use a registry reference',
    }),
    z.refine(source => {
      const { data } = source.package.spritesheet;
      // At the limit, padded base64 can use the same number of characters as a larger sheet.
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      return Math.floor((data.length - padding) * 3 / 4) <= PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes;
    }, { path: ['package', 'spritesheet', 'data'], message: 'Bundled spritesheet exceeds the byte limit' }),
  ),
]));
export type PetPortableImportSourceV1 = z.infer<typeof PetPortableImportSourceV1Schema>;

/** Retain source identity, never registry-supplied download URLs, in an invocation. */
export const PetImportInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)),
      packagePath: DaemonPetImportAccountPackageRequestV1Schema.def.shape.packagePath,
      sourceKey: DaemonPetImportAccountPackageRequestV1Schema.def.shape.sourceKey,
    }).check(z.refine(hasPetPackageLocatorV1, { message: 'packagePath or sourceKey is required' })),
    ...PetPortableImportSourceV1Schema.def.options,
  ]),
}));
export type PetImportInputV1 = z.infer<typeof PetImportInputV1Schema>;
export const PetImportResultV1Schema = lazyZodSchema(() => z.strictObject({
  pet: AccountPetLibraryEntryV1Schema,
  reused: z.optional(z.literal(true)),
}));
export type PetImportResultV1 = z.infer<typeof PetImportResultV1Schema>;

/** Typed contents of the existing approval preview carrier, produced by daemon validation. */
export const PetImportPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  validation: PetPackageValidationResultV1Schema.def.options[0],
  previewHandle: DaemonPetValidatePackageResponseV1Schema.def.options[0].def.shape.previewHandle.def.innerType,
}));
export type PetImportPreviewV1 = z.infer<typeof PetImportPreviewV1Schema>;

/** Every host prepares the same validated package and opaque locator before approval. */
export async function prepareMachinePetImportV1(
  input: PetImportInputV1,
  validate: (machineId: string, request: DaemonPetValidatePackageRequestV1) => Promise<unknown>,
): Promise<Readonly<{ input: PetImportInputV1; preview: PetImportPreviewV1 }> | ActionExecuteFailure> {
  if (input.source.kind !== 'machine') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  const source = input.source;
  const response = DaemonPetValidatePackageResponseV1Schema.parse(await validate(source.machineId, {
    ...(source.packagePath ? { packagePath: source.packagePath } : {}),
    ...(source.sourceKey ? { sourceKey: source.sourceKey } : {}), strict: true,
  }));
  if (!response.ok) return response;
  if (!response.validation.ok) return { ok: false, errorCode: 'validation_failed', error: 'validation_failed',
    details: { validation: response.validation } };
  const preview = PetImportPreviewV1Schema.parse({ validation: response.validation, previewHandle: response.previewHandle });
  return { input: { source: { kind: 'machine', machineId: source.machineId, sourceKey: preview.previewHandle.sourceKey } }, preview };
}

export const PetImportOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('added'), pet: AccountPetLibraryEntryV1Schema, reused: z.optional(z.literal(true)),
    undo: z.optional(z.strictObject({ actionId: z.literal(PET_DELETE_ACTION_ID_V1), input: AccountPetDeleteRequestV1Schema })),
  }),
  z.strictObject({ kind: z.enum(['could_not_add', 'library_full', 'pet_sync_off']),
    errorCode: z.string().check(z.minLength(1)), details: z.optional(z.unknown()) }),
]));
export type PetImportOutcomeV1 = Readonly<z.infer<typeof PetImportOutcomeV1Schema>>;
export type PetImportExecutionV1 = Pick<ApprovalExecutionV2, 'ok' | 'result' | 'errorCode' | 'details'>;

/** Presentation only: Account and daemon owners still decide validation, quota and feature availability. */
export function readPetImportOutcomeV1(execution: PetImportExecutionV1): PetImportOutcomeV1 | null {
  if (execution.ok) {
    const parsed = PetImportResultV1Schema.safeParse(execution.result);
    return parsed.success ? { kind: 'added', pet: parsed.data.pet,
      ...(parsed.data.reused ? { reused: true as const }
        : { undo: { actionId: PET_DELETE_ACTION_ID_V1, input: { accountPetId: parsed.data.pet.accountPetId } } }) } : null;
  }
  if (!execution.errorCode) return null;
  // Only the pets.sync feature decision is "pet sync off"; Account mode and Home storage refusals are not.
  const kind = execution.errorCode === 'quota_exceeded' ? 'library_full'
    : execution.errorCode === 'feature_disabled' ? 'pet_sync_off' : 'could_not_add';
  return { kind, errorCode: execution.errorCode, ...(execution.details === undefined ? {} : { details: execution.details }) };
}

export type PetImportConfirmationV1 = Readonly<{
  actionId: typeof PET_IMPORT_ACTION_ID_V1; input: PetImportInputV1; preview: PetImportPreviewV1;
  outcome: PetImportOutcomeV1 | null;
}>;

/** Add approves the existing pending request; its execution carries the eventual Account identity. */
export function readPetImportConfirmationV1(request: Readonly<{
  actionId: string; actionArgs: unknown; preview?: unknown; execution?: PetImportExecutionV1;
}>): PetImportConfirmationV1 | null {
  if (request.actionId !== PET_IMPORT_ACTION_ID_V1) return null;
  const input = PetImportInputV1Schema.safeParse(request.actionArgs);
  const preview = PetImportPreviewV1Schema.safeParse(request.preview);
  if (!input.success || !preview.success) return null;
  return { actionId: PET_IMPORT_ACTION_ID_V1, input: input.data, preview: preview.data,
    outcome: request.execution ? readPetImportOutcomeV1(request.execution) : null };
}

/** Both filesystem and registry imports use the Account create owner's byte envelope. */
export function buildAccountPetCreateRequestV1(input: Readonly<{
  manifest: AccountPetCreateRequestV1['manifest'];
  mediaType: AccountPetCreateRequestV1['spritesheet']['mediaType'];
  spritesheetBytes: Uint8Array;
  origin: AccountPetCreateRequestV1['origin'];
}>): AccountPetCreateRequestV1 {
  return { manifest: input.manifest, origin: input.origin, spritesheet: {
    mediaType: input.mediaType, encoding: 'base64', data: encodeBase64(input.spritesheetBytes),
    sizeBytes: input.spritesheetBytes.byteLength, digest: `sha256:${computeSha256HexDigest(input.spritesheetBytes)}`,
  } };
}
