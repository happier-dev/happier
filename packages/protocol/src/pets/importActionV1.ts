import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { encodeBase64 } from '../crypto/base64.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';
import { AccountPetLibraryEntryV1Schema, type AccountPetCreateRequestV1, type AccountPetLibraryEntryV1 } from './accountLibrary.js';
import { DaemonPetImportAccountPackageRequestV1Schema, DaemonPetValidatePackageResponseV1Schema, PetPackageValidationResultV1Schema, hasPetPackageLocatorV1 } from './daemonRpc.js';
import { PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1 } from '../actions/actionIdsPetsV1.js';
import type { ApprovalExecutionV2 } from '../approvals/approvalRequestV1.js';

/** Retain source identity, never registry-supplied download URLs, in an invocation. */
export const PetImportInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)),
      packagePath: DaemonPetImportAccountPackageRequestV1Schema.def.shape.packagePath,
      sourceKey: DaemonPetImportAccountPackageRequestV1Schema.def.shape.sourceKey,
    }).check(z.refine(hasPetPackageLocatorV1, { message: 'packagePath or sourceKey is required' })),
    z.strictObject({ kind: z.literal('registry'), sourceId: z.string().check(z.minLength(1)),
      itemId: z.string().check(z.minLength(1)) }),
  ]),
}));
export type PetImportInputV1 = z.infer<typeof PetImportInputV1Schema>;
export const PetImportResultV1Schema = lazyZodSchema(() => z.strictObject({ pet: AccountPetLibraryEntryV1Schema }));
export type PetImportResultV1 = z.infer<typeof PetImportResultV1Schema>;

/** Typed contents of the existing approval preview carrier, produced by daemon validation. */
export const PetImportPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  validation: PetPackageValidationResultV1Schema.def.options[0],
  previewHandle: DaemonPetValidatePackageResponseV1Schema.def.options[0].def.shape.previewHandle.def.innerType,
}));
export type PetImportPreviewV1 = z.infer<typeof PetImportPreviewV1Schema>;

export type PetImportOutcomeV1 = Readonly<{
  kind: 'added'; pet: AccountPetLibraryEntryV1;
  undo: Readonly<{ actionId: typeof PET_DELETE_ACTION_ID_V1; input: Readonly<{ accountPetId: string }> }>;
}> | Readonly<{
  kind: 'could_not_add' | 'library_full' | 'pet_sync_off'; errorCode: string; details?: unknown;
}>;
export type PetImportExecutionV1 = Pick<ApprovalExecutionV2, 'ok' | 'result' | 'errorCode' | 'details'>;

/** Presentation only: Account and daemon owners still decide validation, quota and feature availability. */
export function readPetImportOutcomeV1(execution: PetImportExecutionV1): PetImportOutcomeV1 | null {
  if (execution.ok) {
    const parsed = PetImportResultV1Schema.safeParse(execution.result);
    return parsed.success ? { kind: 'added', pet: parsed.data.pet,
      undo: { actionId: PET_DELETE_ACTION_ID_V1, input: { accountPetId: parsed.data.pet.accountPetId } } } : null;
  }
  if (!execution.errorCode) return null;
  const kind = execution.errorCode === 'quota_exceeded' ? 'library_full'
    : execution.errorCode === 'feature_disabled' || execution.errorCode === 'custom_pet_sync_requires_plaintext'
      || execution.errorCode === 'custom_pet_sync_unavailable' ? 'pet_sync_off' : 'could_not_add';
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
