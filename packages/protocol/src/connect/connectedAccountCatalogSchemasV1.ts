import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { ConnectedAccountServiceConfigurationCatalogV1Schema } from '../account/settings/connectedAccountServiceConfigurationsV1.js';
import { QualifiedConnectedAccountPurposeBindingsV1RecordSchema } from './connectedAccountPurposeBindings.js';
import { AccountSettingsStoredContentEnvelopeWriteSchema } from '../account/settings/accountSettingsStoredContentEnvelope.js';
import { AccountRemoteAlertPolicyV1Schema } from '../account/settings/accountRemoteAlertPolicySchema.js';

export const ConnectedAccountCatalogUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'account-not-found', 'account-inconsistent', 'account-mode-mismatch',
  'encryption-material-unavailable', 'invalid-stored-content', 'invalid-reference', 'unauthorized', 'forbidden', 'unsupported',
  'unreachable', 'database_transaction_conflict_exhausted', 'scope-retired', 'cancelled', 'source-version-conflict', 'authority-not-confirmed',
]));
export type ConnectedAccountCatalogUnavailableReasonV1 = z.infer<typeof ConnectedAccountCatalogUnavailableReasonV1Schema>;

export const ConnectedAccountCatalogKeyV1Schema = lazyZodSchema(() => z.enum(['configurations', 'purposes']));
export type ConnectedAccountCatalogKeyV1 = z.infer<typeof ConnectedAccountCatalogKeyV1Schema>;
export const ConnectedConfigurationCatalogV1Schema = ConnectedAccountServiceConfigurationCatalogV1Schema;
export const ConnectedPurposeCatalogV1Schema = QualifiedConnectedAccountPurposeBindingsV1RecordSchema;
export type ConnectedConfigurationCatalogV1 = z.infer<typeof ConnectedConfigurationCatalogV1Schema>;
export type ConnectedPurposeCatalogV1 = z.infer<typeof ConnectedPurposeCatalogV1Schema>;
export const ConnectedAccountCatalogRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('key', [
  z.strictObject({ key: z.literal('configurations'), value: ConnectedConfigurationCatalogV1Schema }),
  z.strictObject({ key: z.literal('purposes'), value: ConnectedPurposeCatalogV1Schema }),
]));
export type ConnectedAccountCatalogRecordV1 = z.infer<typeof ConnectedAccountCatalogRecordV1Schema>;
export const StoredConnectedAccountCatalogRecordV1Schema = createStoredReadSchema(ConnectedAccountCatalogRecordV1Schema);
export const ConnectedAccountCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: ConnectedAccountCatalogRecordV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ConnectedAccountCatalogContentV1 = z.infer<typeof ConnectedAccountCatalogContentV1Schema>;
// Keep original JSON until the domain owner classifies independent entries and references.
export const StoredConnectedAccountCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.looseObject({ t: z.literal('plain'), v: z.unknown() }),
  z.looseObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type StoredConnectedAccountCatalogContentV1 = z.infer<typeof StoredConnectedAccountCatalogContentV1Schema>;
/** Conversion retains complete stored JSON, rather than authoring a new declaration. */
export const ConnectedAccountCatalogMigrationContentV1Schema = lazyZodSchema(() => StoredConnectedAccountCatalogContentV1Schema.check(z.refine(value => StrictJsonValueSchema.safeParse(value).success, 'Stored conversion content must be JSON')));
export type ConnectedAccountCatalogMigrationSourceV1 = Readonly<{ content: StoredConnectedAccountCatalogContentV1; payload: JsonValue }>;
export type ConnectedAccountCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export type ConnectedAccountCatalogOpenResultV1 = Readonly<{ status: 'opened'; record: ConnectedAccountCatalogRecordV1;
  migrationSource?: ConnectedAccountCatalogMigrationSourceV1 }>
  | Readonly<{ status: 'partial'; record: ConnectedAccountCatalogRecordV1; diagnostics: readonly ConnectedAccountCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
export const ConnectedAccountCatalogRowFailureV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.optional(z.string()),
}));
export const ConnectedAccountCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('present'), revision, content: StoredConnectedAccountCatalogContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }),
  ConnectedAccountCatalogRowFailureV1Schema,
]));
export type ConnectedAccountCatalogRowReadResponseV1 = z.infer<typeof ConnectedAccountCatalogRowReadResponseV1Schema>;
export const ConnectedAccountCatalogRowMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.union([revision, z.literal('absent')]), content: z.nullable(ConnectedAccountCatalogContentV1Schema),
  sourceSettingsVersion: z.optional(revision),
  referencedSavedSecretIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  savedSecretRevisions: z.optional(z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1)), expectedRevision: revision }))),
  settingsMutation: z.optional(z.strictObject({ expectedSettingsVersion: revision, content: z.nullable(AccountSettingsStoredContentEnvelopeWriteSchema),
    remoteAlertPolicy: z.optional(z.nullable(AccountRemoteAlertPolicyV1Schema)) })),
}).check(z.superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null || mutation.settingsMutation)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Initialization requires captured source currentness only' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes destination authority only' });
  }
  if (new Set(mutation.referencedSavedSecretIds).size !== mutation.referencedSavedSecretIds.length
    || new Set(mutation.savedSecretRevisions?.map(item => item.resourceId)).size !== (mutation.savedSecretRevisions?.length ?? 0)) {
    context.addIssue({ code: 'custom', path: ['referencedSavedSecretIds'], message: 'Reference captures must be unique' });
  }
})));
export type ConnectedAccountCatalogRowMutationV1 = z.infer<typeof ConnectedAccountCatalogRowMutationV1Schema>;
export const ConnectedAccountCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('updated'), revision, cursor: revision, settingsVersion: z.optional(revision) }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.minimum(-1), z.int()) }),
  z.strictObject({ status: z.literal('settings-conflict'), revision }), ConnectedAccountCatalogRowFailureV1Schema,
]));
export type ConnectedAccountCatalogRowMutationResponseV1 = z.infer<typeof ConnectedAccountCatalogRowMutationResponseV1Schema>;

function directiveSchema(key: ConnectedAccountCatalogKeyV1) {
  return z.strictObject({ expectedRevision: revision, content: z.nullable(ConnectedAccountCatalogMigrationContentV1Schema) }).check(z.superRefine((directive, context) => {
    const record = directive.content?.t === 'plain' ? directive.content.v : undefined;
    if (directive.content?.t === 'plain' && (record === null || typeof record !== 'object' || Array.isArray(record)
      || !('key' in record) || record.key !== key)) {
      context.addIssue({ code: 'custom', path: ['content'], message: 'Catalog content must match its domain' });
    }
  }));
}
export const AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema = lazyZodSchema(() => directiveSchema('configurations'));
export const AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema = lazyZodSchema(() => directiveSchema('purposes'));
export type AccountEncryptionMigrateConnectedConfigurationsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema>;
export const AccountEncryptionMigrateConnectedConfigurationsResultV1Schema = lazyZodSchema(() => z.strictObject({ row: z.nullable(z.strictObject({ revision,
  content: z.nullable(ConnectedAccountCatalogMigrationContentV1Schema) })) }));
export const AccountEncryptionMigrateConnectedPurposesResultV1Schema = AccountEncryptionMigrateConnectedConfigurationsResultV1Schema;
export type AccountEncryptionMigrateConnectedConfigurationsResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsResultV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesResultV1Schema>;
