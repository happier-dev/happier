import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { ProfileRecordIdV1Schema, ProfileRowMutationV1Schema, ProfileRowRevisionV1Schema, ProfileReferenceGuardRevisionV1Schema, ProfileRowStorageFailureV1Schema } from './profileRecordSchemaV1.js';

export const PROFILE_TRANSFER_ROUTE_V1 = '/v1/account/entity-rows/profiles/transfer' as const;
export const PROFILE_TRANSFER_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'account_profile_transfer' as const;

export const ProfileTransferInventoryEntryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account_row'), id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema }).strict(),
  z.object({ kind: z.literal('artifact'), id: z.string().min(1), revision: z.object({
    headerVersion: ProfileRowRevisionV1Schema, bodyVersion: ProfileRowRevisionV1Schema,
  }).strict() }).strict(),
  z.object({ kind: z.literal('saved_secret'), id: z.string().refine((id) => {
    try { formatSharedSavedSecretRefV1(id); return true; } catch { return false; }
  }, 'SavedSecret inventory identity must be addressable'), revision: ProfileRowRevisionV1Schema }).strict(),
]));
export type ProfileTransferInventoryEntryV1 = z.infer<typeof ProfileTransferInventoryEntryV1Schema>;

const inventorySchema = lazyZodSchema(() => z.array(ProfileTransferInventoryEntryV1Schema).superRefine((entries, context) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const key = JSON.stringify([entry.kind, entry.id]);
    if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate transfer inventory identity' });
    seen.add(key);
  });
}));

/** Destination-owned proof for the complete genuine predecessor Profile inventory. */
export const ProfileTransferControlV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), phase: z.enum(['prepared', 'active']),
  sourceSettingsVersion: ProfileRowRevisionV1Schema, migratedLogicalRevision: ProfileRowRevisionV1Schema,
  inventory: inventorySchema,
}).strict());
export type ProfileTransferControlV1 = z.infer<typeof ProfileTransferControlV1Schema>;
export const StoredProfileTransferControlV1Schema = createStoredReadSchema(ProfileTransferControlV1Schema);

export const ProfileTransferContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: ProfileTransferControlV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type ProfileTransferContentV1 = z.infer<typeof ProfileTransferContentV1Schema>;
export const StoredProfileTransferContentV1Schema = createStoredReadSchema(ProfileTransferContentV1Schema);

export function assertProfileTransferContentForModeV1(content: ProfileTransferContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && (
    content.t !== 'encrypted' || !isAccountScopedBlobCiphertextForKind({ kind: PROFILE_TRANSFER_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })
  ))) throw new Error('account-mode-mismatch');
}

export function profileTransferInventoriesEqualV1(left: readonly ProfileTransferInventoryEntryV1[], right: readonly ProfileTransferInventoryEntryV1[]): boolean {
  if (left.length !== right.length) return false;
  const entries = new Map(right.map(entry => [JSON.stringify([entry.kind, entry.id]), entry]));
  return left.every(entry => {
    const candidate = entries.get(JSON.stringify([entry.kind, entry.id]));
    if (!candidate || candidate.kind !== entry.kind) return false;
    if (entry.kind === 'artifact' && candidate.kind === 'artifact') return entry.revision.headerVersion === candidate.revision.headerVersion
      && entry.revision.bodyVersion === candidate.revision.bodyVersion;
    return entry.revision === candidate.revision;
  });
}

export const ProfileTransferRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision: ProfileRowRevisionV1Schema, content: ProfileTransferContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('deleted'), revision: ProfileRowRevisionV1Schema }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export type ProfileTransferRowReadResponseV1 = z.infer<typeof ProfileTransferRowReadResponseV1Schema>;

export const ProfileTransferMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), sourceSettingsVersion: ProfileRowRevisionV1Schema,
    expectedRevision: ProfileReferenceGuardRevisionV1Schema, inventory: inventorySchema, content: ProfileTransferContentV1Schema,
    imports: z.array(ProfileRowMutationV1Schema),
  }).strict(),
  z.object({ operation: z.literal('activate'), sourceSettingsVersion: ProfileRowRevisionV1Schema,
    expectedRevision: ProfileReferenceGuardRevisionV1Schema, inventory: inventorySchema, content: ProfileTransferContentV1Schema,
  }).strict(),
]).superRefine((mutation, context) => {
  if (mutation.operation === 'prepare') mutation.imports.forEach((entry, index) => {
    if (entry.operation !== 'import') context.addIssue({ code: 'custom', path: ['imports', index, 'operation'], message: 'Preparation accepts imports only' });
  });
  if (mutation.content.t === 'plain' && (mutation.content.v.phase !== (mutation.operation === 'prepare' ? 'prepared' : 'active')
    || mutation.content.v.sourceSettingsVersion !== mutation.sourceSettingsVersion
    || !profileTransferInventoriesEqualV1(mutation.inventory, mutation.content.v.inventory))) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Transfer control must match the captured activation proof' });
  }
}));
export type ProfileTransferMutationV1 = z.infer<typeof ProfileTransferMutationV1Schema>;

export const ProfileTransferMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision: ProfileRowRevisionV1Schema, cursor: ProfileRowRevisionV1Schema }).strict(),
  z.object({ status: z.literal('already-active'), revision: ProfileRowRevisionV1Schema }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision: ProfileRowRevisionV1Schema }).strict(),
  z.object({ status: z.literal('inventory-incomplete') }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export type ProfileTransferMutationResponseV1 = z.infer<typeof ProfileTransferMutationResponseV1Schema>;
