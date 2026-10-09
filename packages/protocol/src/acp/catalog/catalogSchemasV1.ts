import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { AccountSettingsCleanupV1Schema } from '../../account/settings/accountSettingsStoredContentEnvelope.js';
import { AcpBackendDefinitionV1Schema, AcpBackendAuthConfigV1Schema, AcpBackendCapabilitiesV1Schema, AcpCatalogCommandV1Schema, AcpEnvKeyV1Schema } from './settingsV1.js';


const activeSavedSecretReference = lazyZodSchema(() => z.string().min(1).refine(value => {
  try { return parseSavedSecretRefV1(value).kind === 'shared_resource'; }
  catch { return false; }
}, 'Active ACP credentials require a shared SavedSecret resource'));

/** Current executable declarations are closed; retained recipes are never silently normalized into this shape. */
export const AcpCatalogRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  definitions: z.array(AcpBackendDefinitionV1Schema.extend({
    auth: AcpBackendAuthConfigV1Schema.extend({ loginCommand: AcpCatalogCommandV1Schema.strict().optional() }).strict().optional(),
    capabilities: AcpBackendCapabilitiesV1Schema.strict().default(() => AcpBackendDefinitionV1Schema.shape.capabilities.parse(undefined)),
    env: z.record(AcpEnvKeyV1Schema, z.discriminatedUnion('t', [
      z.object({ t: z.literal('literal'), v: z.string() }).strict(),
      z.object({ t: z.literal('savedSecret'), secretId: activeSavedSecretReference }).strict(),
    ])).default(() => AcpBackendDefinitionV1Schema.shape.env.parse(undefined)),
  }).strict()),
}).strict().superRefine((record, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, definition] of record.definitions.entries()) {
    if (ids.has(definition.id)) context.addIssue({ code: 'custom', path: ['definitions', index, 'id'], message: 'Duplicate ACP definition identity' });
    if (names.has(definition.name)) context.addIssue({ code: 'custom', path: ['definitions', index, 'name'], message: 'Duplicate ACP definition name' });
    ids.add(definition.id); names.add(definition.name);
  }
}));
export type AcpCatalogRecordV1 = z.infer<typeof AcpCatalogRecordV1Schema>;
export const StoredAcpCatalogRecordV1Schema = createStoredReadSchema(AcpCatalogRecordV1Schema);

export const AcpCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: AcpCatalogRecordV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type AcpCatalogContentV1 = z.infer<typeof AcpCatalogContentV1Schema>;
/** Read transport preserves the stored JSON until the catalog owner establishes complete or partial authority. */
export const StoredAcpCatalogContentV1Schema = createStoredReadSchema(lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: StrictJsonValueSchema }).catchall(StrictJsonValueSchema),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).catchall(StrictJsonValueSchema),
])));
export type StoredAcpCatalogContentV1 = z.infer<typeof StoredAcpCatalogContentV1Schema>;
/** Conversion transports retained stored JSON, not a newly authored declaration. */
export const AcpCatalogMigrationContentV1Schema = StoredAcpCatalogContentV1Schema;

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const AcpCatalogRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference', 'source-transfer-required']),
  reason: z.string().optional(),
}).strict());
export const AcpCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: StoredAcpCatalogContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(), AcpCatalogRowFailureV1Schema,
]));
export const AcpCatalogRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: AcpCatalogContentV1Schema,
  sourceSettingsVersion: revision.optional(),
  source: z.enum(['fresh', 'predecessor']).optional(),
  settingsCleanup: AccountSettingsCleanupV1Schema.optional(),
  referencedSavedSecretIds: z.array(z.string().min(1)).default([]),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: revision }).strict()).optional(),
}).strict().superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' ? mutation.sourceSettingsVersion === undefined || mutation.source === undefined
    : mutation.sourceSettingsVersion !== undefined || mutation.source !== undefined || mutation.settingsCleanup !== undefined) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Only initial catalog authority requires captured source currentness' });
  }
  if (mutation.source === 'predecessor' && mutation.settingsCleanup === undefined) {
    context.addIssue({ code: 'custom', path: ['settingsCleanup'], message: 'Source transfer requires atomic captured Settings cleanup' });
  }
  if (mutation.settingsCleanup !== undefined && (mutation.settingsCleanup.expectedSettingsVersion !== mutation.sourceSettingsVersion
    || mutation.settingsCleanup.nextSettings === null)) {
    context.addIssue({ code: 'custom', path: ['settingsCleanup'], message: 'Cleanup must preserve the captured source document at the same Settings version' });
  }
}));
export type AcpCatalogRowMutationV1 = z.infer<typeof AcpCatalogRowMutationV1Schema>;
export const AcpCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision }).strict(), AcpCatalogRowFailureV1Schema,
]));

export type AcpCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'unclassified_reference' | 'invalid_definition' }>;
export type AcpCatalogSnapshotV1 = Readonly<{ status: 'loading' }> | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'partial'; reason: 'incomplete-inventory'; record: AcpCatalogRecordV1; diagnostics: readonly AcpCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'ready'; record: AcpCatalogRecordV1; revision: number }>
  | Readonly<{ status: 'ready'; record: AcpCatalogRecordV1; revision: 'absent'; sourceSettingsVersion: number; source: 'fresh' | 'predecessor' }>;

export const AccountEncryptionMigrateAcpCatalogDirectiveV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: revision,
  content: AcpCatalogMigrationContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateAcpCatalogDirectiveV1 = z.infer<typeof AccountEncryptionMigrateAcpCatalogDirectiveV1Schema>;
export const AccountEncryptionMigrateAcpCatalogResultV1Schema = lazyZodSchema(() => z.object({
  row: z.object({ revision, content: AcpCatalogMigrationContentV1Schema.nullable() }).strict().nullable(),
}).strict());
