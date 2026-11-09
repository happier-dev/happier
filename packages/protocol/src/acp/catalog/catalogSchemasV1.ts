import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { AccountSettingsCleanupV1Schema } from '../../account/settings/accountSettingsStoredContentEnvelope.js';
import { AcpBackendDefinitionV1Schema, AcpBackendAuthConfigV1Schema, AcpBackendCapabilitiesV1Schema, AcpCatalogCommandV1Schema, AcpEnvKeyV1Schema, foldStoredAcpBackendLaunchV1 } from './settingsV1.js';
import { ValueRefV1Schema, listValueRefSecretIdsV1 } from '../../valueRefs/valueRefV1.js';


// Private personal resources and shared resources use the same canonical resource ref (IR-97).
// Opaque predecessor Settings ids remain transfer-only, never current credential authority.
const activeValueReference = lazyZodSchema(() => ValueRefV1Schema.check(z.refine(value => {
  try { return listValueRefSecretIdsV1(value).every(reference => parseSavedSecretRefV1(reference).kind === 'shared_resource'); }
  catch { return false; }
}, 'Active ACP credentials require a canonical SavedSecret resource')));

const AcpCatalogDefinitionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AcpBackendDefinitionV1Schema, {
    auth: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AcpBackendAuthConfigV1Schema, { loginCommand: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(AcpCatalogCommandV1Schema)) }))),
    capabilities: z._default((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(AcpBackendCapabilitiesV1Schema), () => AcpBackendDefinitionV1Schema.shape.capabilities.parse(undefined)),
    env: z._default(z.record(AcpEnvKeyV1Schema, activeValueReference), () => AcpBackendDefinitionV1Schema.shape.env.parse(undefined)),
  })));
defineStoredReadProjection(AcpCatalogDefinitionV1Schema, () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(foldStoredAcpBackendLaunchV1), createStoredReadSchema(lazyZodSchema(() => z.extend(AcpCatalogDefinitionV1Schema, {})))));

/** Current executable declarations are closed; predecessor launch fields are folded only at stored ingress. */
export const AcpCatalogRecordV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  definitions: z.array(AcpCatalogDefinitionV1Schema),
}).check(z.superRefine((record, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, definition] of record.definitions.entries()) {
    if (ids.has(definition.id)) context.addIssue({ code: 'custom', path: ['definitions', index, 'id'], message: 'Duplicate ACP definition identity' });
    if (names.has(definition.name)) context.addIssue({ code: 'custom', path: ['definitions', index, 'name'], message: 'Duplicate ACP definition name' });
    ids.add(definition.id); names.add(definition.name);
  }
})));
export type AcpCatalogRecordV1 = z.infer<typeof AcpCatalogRecordV1Schema>;
export const StoredAcpCatalogRecordV1Schema = createStoredReadSchema(AcpCatalogRecordV1Schema);

export const AcpCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: AcpCatalogRecordV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type AcpCatalogContentV1 = z.infer<typeof AcpCatalogContentV1Schema>;
/** Read transport preserves the stored JSON until the catalog owner establishes complete or partial authority. */
export const StoredAcpCatalogContentV1Schema = createStoredReadSchema(lazyZodSchema(() => z.discriminatedUnion('t', [
  z.catchall(z.object({ t: z.literal('plain'), v: StrictJsonValueSchema }), StrictJsonValueSchema),
  z.catchall(z.object({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }), StrictJsonValueSchema),
])));
export type StoredAcpCatalogContentV1 = z.infer<typeof StoredAcpCatalogContentV1Schema>;
/** Conversion transports retained stored JSON, not a newly authored declaration. */
export const AcpCatalogMigrationContentV1Schema = StoredAcpCatalogContentV1Schema;

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const AcpCatalogRowFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference', 'source-transfer-required']),
  reason: z.optional(z.string()),
}));
export const AcpCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: StoredAcpCatalogContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }), AcpCatalogRowFailureV1Schema,
]));
export const AcpCatalogRowMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: AcpCatalogContentV1Schema,
  sourceSettingsVersion: z.optional(revision),
  source: z.optional(z.enum(['fresh', 'predecessor'])),
  settingsCleanup: z.optional(AccountSettingsCleanupV1Schema),
  referencedSavedSecretIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  savedSecretRevisions: z.optional(z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1)), expectedRevision: revision }))),
}).check(z.superRefine((mutation, context) => {
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
})));
export type AcpCatalogRowMutationV1 = z.infer<typeof AcpCatalogRowMutationV1Schema>;
export const AcpCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1)) }),
  z.strictObject({ status: z.literal('settings-conflict'), revision }), AcpCatalogRowFailureV1Schema,
]));

export type AcpCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'unclassified_reference' | 'invalid_definition' }>;
export type AcpCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: string;
      /** Observing a row revision does not require opening its content or grant write authority. */
      revision?: number }>
  | Readonly<{ status: 'partial'; reason: 'incomplete-inventory'; record: AcpCatalogRecordV1; diagnostics: readonly AcpCatalogDiagnosticV1[];
      /** Destination row evidence; predecessor-only partial inventories have no numeric row revision. */
      revision?: number | 'absent' }>
  | Readonly<{ status: 'ready'; record: AcpCatalogRecordV1; revision: number }>
  | Readonly<{ status: 'ready'; record: AcpCatalogRecordV1; revision: 'absent'; sourceSettingsVersion: number; source: 'fresh' | 'predecessor' }>;

export const AccountEncryptionMigrateAcpCatalogDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: revision,
  content: z.nullable(AcpCatalogMigrationContentV1Schema),
}));
export type AccountEncryptionMigrateAcpCatalogDirectiveV1 = z.infer<typeof AccountEncryptionMigrateAcpCatalogDirectiveV1Schema>;
export const AccountEncryptionMigrateAcpCatalogResultV1Schema = lazyZodSchema(() => z.strictObject({
  row: z.nullable(z.strictObject({ revision, content: z.nullable(AcpCatalogMigrationContentV1Schema) })),
}));
