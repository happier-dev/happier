import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { ConnectedAccountServiceConfigurationCatalogV1Schema } from '../account/settings/connectedAccountServiceConfigurationsV1.js';
import { QualifiedConnectedAccountPurposeBindingsV1RecordSchema } from './connectedAccountPurposeBindings.js';
import { AccountSettingsStoredContentEnvelopeWriteSchema } from '../account/settings/accountSettingsStoredContentEnvelope.js';
import { AccountRemoteAlertPolicyV1Schema } from '../account/settings/accountRemoteAlertPolicySchema.js';

export const ConnectedAccountCatalogKeyV1Schema = lazyZodSchema(() => z.enum(['configurations', 'purposes']));
export type ConnectedAccountCatalogKeyV1 = z.infer<typeof ConnectedAccountCatalogKeyV1Schema>;
export const ConnectedConfigurationCatalogV1Schema = ConnectedAccountServiceConfigurationCatalogV1Schema;
export const ConnectedPurposeCatalogV1Schema = QualifiedConnectedAccountPurposeBindingsV1RecordSchema;
export type ConnectedConfigurationCatalogV1 = z.infer<typeof ConnectedConfigurationCatalogV1Schema>;
export type ConnectedPurposeCatalogV1 = z.infer<typeof ConnectedPurposeCatalogV1Schema>;
export const ConnectedAccountCatalogRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('key', [
  z.object({ key: z.literal('configurations'), value: ConnectedConfigurationCatalogV1Schema }).strict(),
  z.object({ key: z.literal('purposes'), value: ConnectedPurposeCatalogV1Schema }).strict(),
]));
export type ConnectedAccountCatalogRecordV1 = z.infer<typeof ConnectedAccountCatalogRecordV1Schema>;
export const StoredConnectedAccountCatalogRecordV1Schema = createStoredReadSchema(ConnectedAccountCatalogRecordV1Schema);
export const ConnectedAccountCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: ConnectedAccountCatalogRecordV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type ConnectedAccountCatalogContentV1 = z.infer<typeof ConnectedAccountCatalogContentV1Schema>;
// Keep original JSON until the domain owner classifies independent entries and references.
export const StoredConnectedAccountCatalogContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: z.unknown() }).passthrough(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).passthrough(),
]));
export type StoredConnectedAccountCatalogContentV1 = z.infer<typeof StoredConnectedAccountCatalogContentV1Schema>;
/** Conversion retains complete stored JSON, rather than authoring a new declaration. */
export const ConnectedAccountCatalogMigrationContentV1Schema = lazyZodSchema(() => StoredConnectedAccountCatalogContentV1Schema
  .refine(value => StrictJsonValueSchema.safeParse(value).success, 'Stored conversion content must be JSON'));
export type ConnectedAccountCatalogMigrationSourceV1 = Readonly<{ content: StoredConnectedAccountCatalogContentV1; payload: JsonValue }>;
export type ConnectedAccountCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export type ConnectedAccountCatalogOpenResultV1 = Readonly<{ status: 'opened'; record: ConnectedAccountCatalogRecordV1;
  migrationSource?: ConnectedAccountCatalogMigrationSourceV1 }>
  | Readonly<{ status: 'partial'; record: ConnectedAccountCatalogRecordV1; diagnostics: readonly ConnectedAccountCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

const revision = lazyZodSchema(() => z.number().int().nonnegative().safe());
export const ConnectedAccountCatalogRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.string().optional(),
}).strict());
export const ConnectedAccountCatalogRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: StoredConnectedAccountCatalogContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(),
  ConnectedAccountCatalogRowFailureV1Schema,
]));
export type ConnectedAccountCatalogRowReadResponseV1 = z.infer<typeof ConnectedAccountCatalogRowReadResponseV1Schema>;
export const ConnectedAccountCatalogRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: ConnectedAccountCatalogContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(),
  referencedSavedSecretIds: z.array(z.string().min(1)).default([]),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: revision }).strict()).optional(),
  settingsMutation: z.object({ expectedSettingsVersion: revision, content: AccountSettingsStoredContentEnvelopeWriteSchema.nullable(),
    remoteAlertPolicy: AccountRemoteAlertPolicyV1Schema.nullable().optional() }).strict().optional(),
}).strict().superRefine((mutation, context) => {
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
}));
export type ConnectedAccountCatalogRowMutationV1 = z.infer<typeof ConnectedAccountCatalogRowMutationV1Schema>;
export const ConnectedAccountCatalogRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision, settingsVersion: revision.optional() }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1).safe() }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision }).strict(), ConnectedAccountCatalogRowFailureV1Schema,
]));
export type ConnectedAccountCatalogRowMutationResponseV1 = z.infer<typeof ConnectedAccountCatalogRowMutationResponseV1Schema>;

function directiveSchema(key: ConnectedAccountCatalogKeyV1) {
  return z.object({ expectedRevision: revision, content: ConnectedAccountCatalogMigrationContentV1Schema.nullable() }).strict().superRefine((directive, context) => {
    const record = directive.content?.t === 'plain' ? directive.content.v : undefined;
    if (directive.content?.t === 'plain' && (record === null || typeof record !== 'object' || Array.isArray(record)
      || !('key' in record) || record.key !== key)) {
      context.addIssue({ code: 'custom', path: ['content'], message: 'Catalog content must match its domain' });
    }
  });
}
export const AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema = lazyZodSchema(() => directiveSchema('configurations'));
export const AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema = lazyZodSchema(() => directiveSchema('purposes'));
export type AccountEncryptionMigrateConnectedConfigurationsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema>;
export const AccountEncryptionMigrateConnectedConfigurationsResultV1Schema = lazyZodSchema(() => z.object({ row: z.object({ revision,
  content: ConnectedAccountCatalogMigrationContentV1Schema.nullable() }).strict().nullable() }).strict());
export const AccountEncryptionMigrateConnectedPurposesResultV1Schema = AccountEncryptionMigrateConnectedConfigurationsResultV1Schema;
export type AccountEncryptionMigrateConnectedConfigurationsResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsResultV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesResultV1Schema>;
