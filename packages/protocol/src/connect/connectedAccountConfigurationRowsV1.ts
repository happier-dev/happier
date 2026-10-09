import { z } from 'zod';
import tweetnacl from 'tweetnacl';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ConnectedAccountServiceConfigurationCatalogV1Schema, ConnectedAccountServiceConfigurationEntryV1Schema } from '../account/settings/connectedAccountServiceConfigurationsV1.js';
import { QualifiedConnectedAccountPurposeBindingsV1RecordSchema, QualifiedConnectedAccountPurposeBindingV1Schema,
  QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema, qualifiedPurposeKey, readEarlierTeamResourcePurposeTargetsV1 } from './connectedAccountPurposeBindings.js';
import { AccountSettingsStoredContentEnvelopeWriteSchema } from '../account/settings/accountSettingsStoredContentEnvelope.js';
import { AccountRemoteAlertPolicyV1Schema } from '../account/settings/accountRemoteAlertPolicySchema.js';
import { appendSavedSecretReferencePathV1, listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';

export const CONNECTED_CONFIGURATION_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/connected-configurations/v1/' as const;
export const CONNECTED_PURPOSE_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/connected-purposes/v1/' as const;
export const CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 = '/v1/account/entity-rows/connected-accounts' as const;
export const CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1 = {
  configurations: 'connectedAccountServiceConfigurationsV1', purposes: 'connectedAccountPurposeBindingsV1',
} as const;
export const CONNECTED_CONFIGURATION_ACCOUNT_CIPHER_KIND_V1 = 'account_connected_configuration' as const;
export const CONNECTED_PURPOSE_ACCOUNT_CIPHER_KIND_V1 = 'account_connected_purposes' as const;
export const ConnectedAccountCatalogKeyV1Schema = lazyZodSchema(() => z.enum(['configurations', 'purposes']));
export type ConnectedAccountCatalogKeyV1 = z.infer<typeof ConnectedAccountCatalogKeyV1Schema>;
export const ConnectedConfigurationCatalogV1Schema = ConnectedAccountServiceConfigurationCatalogV1Schema;
export const ConnectedPurposeCatalogV1Schema = QualifiedConnectedAccountPurposeBindingsV1RecordSchema;
export type ConnectedConfigurationCatalogV1 = z.infer<typeof ConnectedConfigurationCatalogV1Schema>;
export type ConnectedPurposeCatalogV1 = z.infer<typeof ConnectedPurposeCatalogV1Schema>;

export function emptyConnectedAccountCatalogRecordV1(key: ConnectedAccountCatalogKeyV1): ConnectedAccountCatalogRecordV1 {
  return key === 'configurations' ? { key, value: { v: 1, entries: [] } } : { key, value: { v: 1, bindings: [] } };
}
/** Only this named retained-source entry participates in pre-admission SavedSecret promotion. */
export function readRetainedConnectedAccountCatalogRecordV1(raw: Readonly<Record<string, unknown>>, key: ConnectedAccountCatalogKeyV1) {
  if (!Object.hasOwn(raw, CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[key])) {
    return { status: 'ready' as const, record: emptyConnectedAccountCatalogRecordV1(key) };
  }
  const opened = projectConnectedAccountCatalogRecordV1({ key, value: raw[CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[key]] }, key, 'retained-source');
  return opened.status === 'opened' ? { status: 'ready' as const, record: opened.record } : opened;
}

export function buildConnectedAccountCatalogPhysicalKeyV1(key: ConnectedAccountCatalogKeyV1): string {
  return (ConnectedAccountCatalogKeyV1Schema.parse(key) === 'configurations'
    ? CONNECTED_CONFIGURATION_ACCOUNT_ROW_PREFIX_V1 : CONNECTED_PURPOSE_ACCOUNT_ROW_PREFIX_V1) + 'catalog';
}
export function parseConnectedAccountCatalogPhysicalKeyV1(key: string): ConnectedAccountCatalogKeyV1 | null {
  if (key === CONNECTED_CONFIGURATION_ACCOUNT_ROW_PREFIX_V1 + 'catalog') return 'configurations';
  if (key === CONNECTED_PURPOSE_ACCOUNT_ROW_PREFIX_V1 + 'catalog') return 'purposes';
  return null;
}
export function connectedAccountCatalogCipherKindV1(key: ConnectedAccountCatalogKeyV1) {
  return key === 'configurations' ? CONNECTED_CONFIGURATION_ACCOUNT_CIPHER_KIND_V1 : CONNECTED_PURPOSE_ACCOUNT_CIPHER_KIND_V1;
}
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
export type ConnectedAccountCatalogDiagnosticV1 = Readonly<{ path: string; reason: 'invalid-stored-content' | 'unclassified-reference' }>;
export type ConnectedAccountCatalogOpenResultV1 = Readonly<{ status: 'opened'; record: ConnectedAccountCatalogRecordV1 }>
  | Readonly<{ status: 'partial'; record: ConnectedAccountCatalogRecordV1; diagnostics: readonly ConnectedAccountCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;

const storedConfiguration = createStoredReadSchema(ConnectedAccountServiceConfigurationEntryV1Schema);
const storedPurpose = createStoredReadSchema(QualifiedConnectedAccountPurposeBindingV1Schema);
const storedTeamSelection = createStoredReadSchema(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema);
function storedObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}
/** Safe projections are display/repair data only. Duplicate identities have no winning entry. */
export function projectStoredConnectedAccountCatalogRecordV1(value: unknown, key: ConnectedAccountCatalogKeyV1): ConnectedAccountCatalogOpenResultV1 {
  return projectConnectedAccountCatalogRecordV1(value, key, 'active');
}
function projectConnectedAccountCatalogRecordV1(value: unknown, key: ConnectedAccountCatalogKeyV1,
  referenceAuthority: 'active' | 'retained-source'): ConnectedAccountCatalogOpenResultV1 {
  const wrapper = storedObject(value);
  const original = storedObject(wrapper?.value);
  const unavailable = { status: 'unavailable', reason: 'invalid-stored-content' } as const;
  if (wrapper?.key !== key || !original || original.v !== 1) return unavailable;
  const diagnostics: ConnectedAccountCatalogDiagnosticV1[] = [];
  const admittedPaths = new Set<string>();
  let record: ConnectedAccountCatalogRecordV1;
  if (key === 'configurations') {
    if (!Array.isArray(original.entries)) return unavailable;
    const candidates = original.entries.flatMap((entry, index) => {
      const parsed = storedConfiguration.safeParse(entry);
      if (!parsed.success) { diagnostics.push({ path: `entries[${index}]`, reason: 'invalid-stored-content' }); return []; }
      for (const ref of listConnectedConfigurationCatalogSavedSecretRefsV1({ v: 1, entries: [parsed.data] })) {
        const path = ref.path.replace(/^entries\[0\]/u, `entries[${index}]`);
        admittedPaths.add(path);
        try {
          if (parseSavedSecretRefV1(ref.secretId).kind !== 'shared_resource' && referenceAuthority === 'active') {
            diagnostics.push({ path, reason: 'invalid-stored-content' });
          }
        } catch { diagnostics.push({ path, reason: 'invalid-stored-content' }); }
      }
      return [{ entry: parsed.data, index, identity: JSON.stringify([parsed.data.service.pluginId, parsed.data.service.localId, parsed.data.modeId]) }];
    });
    const counts = new Map<string, number>();
    candidates.forEach(candidate => counts.set(candidate.identity, (counts.get(candidate.identity) ?? 0) + 1));
    const entries = candidates.flatMap(candidate => {
      if (counts.get(candidate.identity) === 1) return [candidate.entry];
      diagnostics.push({ path: `entries[${candidate.index}]`, reason: 'invalid-stored-content' }); return [];
    });
    record = { key, value: { v: 1, entries } };
  } else {
    if (!Array.isArray(original.bindings) || original.teamResourceSelections !== undefined && !Array.isArray(original.teamResourceSelections)) return unavailable;
    // Normalize each earlier Team carrier independently, retaining its original
    // position for diagnostics rather than reindexing remaining bindings.
    const normalized = original.bindings.map((binding, index) => ({ index,
      value: storedObject(readEarlierTeamResourcePurposeTargetsV1({ v: 1, bindings: [binding] }))! }));
    const bindings = normalized.flatMap(({ value: current, index }) => Array.isArray(current.bindings) && current.bindings.length > 0
      ? [{ parsed: storedPurpose.safeParse(current.bindings[0]), path: `bindings[${index}]` }] : []);
    const movedTeams = normalized.flatMap(({ value: current, index }) => Array.isArray(current.teamResourceSelections) && current.teamResourceSelections.length > 0
      ? [{ parsed: storedTeamSelection.safeParse(current.teamResourceSelections[0]), path: `bindings[${index}]` }] : []);
    const teams = [...(Array.isArray(original.teamResourceSelections) ? original.teamResourceSelections : [])
      .map((selection, index) => ({ parsed: storedTeamSelection.safeParse(selection), path: `teamResourceSelections[${index}]` })),
    ...movedTeams];
    const counts = new Map<string, number>();
    for (const candidate of [...bindings, ...teams]) if (candidate.parsed.success) {
      const identity = qualifiedPurposeKey(candidate.parsed.data.purpose);
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    const admittedBindings = bindings.flatMap(candidate => {
      if (candidate.parsed.success && counts.get(qualifiedPurposeKey(candidate.parsed.data.purpose)) === 1) return [candidate.parsed.data];
      diagnostics.push({ path: candidate.path, reason: 'invalid-stored-content' }); return [];
    });
    const admittedTeams = teams.flatMap(candidate => {
      if (candidate.parsed.success && counts.get(qualifiedPurposeKey(candidate.parsed.data.purpose)) === 1) return [candidate.parsed.data];
      diagnostics.push({ path: candidate.path, reason: 'invalid-stored-content' }); return [];
    });
    record = { key, value: { v: 1, bindings: admittedBindings,
      ...(original.teamResourceSelections === undefined && movedTeams.length === 0 ? {} : { teamResourceSelections: admittedTeams }) } };
  }
  for (const path of listSavedSecretReferenceCarrierPathsV1(original)) {
    if (!admittedPaths.has(path)) diagnostics.push({ path, reason: 'unclassified-reference' });
  }
  for (const path of listSavedSecretReferenceCarrierPathsV1(wrapper)) {
    if (!path.startsWith('value.')) diagnostics.push({ path: `record.${path}`, reason: 'unclassified-reference' });
  }
  return diagnostics.length ? { status: 'partial', record, diagnostics } : { status: 'opened', record };
}

function hasDroppedReferenceCarrier(value: unknown, projected: unknown): boolean {
  const known = new Set(listSavedSecretReferenceCarrierPathsV1(projected));
  return listSavedSecretReferenceCarrierPathsV1(value).some(path => !known.has(path));
}
/** Tolerant projection cannot silently discard a recognizable future credential reference. */
export function parseStoredConnectedAccountCatalogContentV1(value: unknown): ConnectedAccountCatalogContentV1 | null {
  const parsed = StoredConnectedAccountCatalogContentV1Schema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.t === 'encrypted') {
    const content = { t: 'encrypted', c: parsed.data.c } as const;
    return hasDroppedReferenceCarrier(value, content) ? null : content;
  }
  const key = ConnectedAccountCatalogKeyV1Schema.safeParse(storedObject(parsed.data.v)?.key);
  if (!key.success) return null;
  const record = projectStoredConnectedAccountCatalogRecordV1(parsed.data.v, key.data);
  return record.status === 'opened' && !hasDroppedReferenceCarrier(value, { t: 'plain', v: record.record })
    ? { t: 'plain', v: record.record } : null;
}

export function assertConnectedAccountCatalogContentForModeV1(content: StoredConnectedAccountCatalogContentV1,
  mode: 'plain' | 'e2ee', key: ConnectedAccountCatalogKeyV1): void {
  if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: connectedAccountCatalogCipherKindV1(key), ciphertext: content.c }))) {
    throw new Error('account-mode-mismatch');
  }
}
export function openConnectedAccountCatalogContentV1(input: Readonly<{
  key: ConnectedAccountCatalogKeyV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): ConnectedAccountCatalogOpenResultV1 {
  const parsed = StoredConnectedAccountCatalogContentV1Schema.safeParse(input.content);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const content = parsed.data;
  try { assertConnectedAccountCatalogContentForModeV1(content, input.mode, input.key); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let value: unknown;
  if (content.t === 'plain') value = content.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(input.key), material: input.material, ciphertext: content.c })?.value;
  }
  const projected = projectStoredConnectedAccountCatalogRecordV1(value, input.key);
  if (projected.status === 'unavailable') return projected;
  const outerDiagnostics: ConnectedAccountCatalogDiagnosticV1[] = listSavedSecretReferenceCarrierPathsV1(content)
    .filter(path => content.t !== 'plain' || !path.startsWith('v.'))
    .map(path => ({ path: `content.${path}`, reason: 'unclassified-reference' }));
  if (!outerDiagnostics.length) return projected;
  return { status: 'partial', record: projected.record,
    diagnostics: [...(projected.status === 'partial' ? projected.diagnostics : []), ...outerDiagnostics] };
}
export function sealConnectedAccountCatalogContentV1(input: Readonly<{
  record: ConnectedAccountCatalogRecordV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedAccountCatalogContentV1 {
  const record = ConnectedAccountCatalogRecordV1Schema.parse(input.record);
  if (projectStoredConnectedAccountCatalogRecordV1(record, record.key).status !== 'opened') throw new Error('invalid-stored-content');
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(record.key), material: input.material,
    payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}

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
  return z.object({ expectedRevision: revision, content: ConnectedAccountCatalogContentV1Schema.nullable() }).strict().superRefine((directive, context) => {
    if (directive.content?.t === 'plain' && directive.content.v.key !== key) {
      context.addIssue({ code: 'custom', path: ['content'], message: 'Catalog content must match its domain' });
    }
  });
}
export const AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema = lazyZodSchema(() => directiveSchema('configurations'));
export const AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema = lazyZodSchema(() => directiveSchema('purposes'));
export type AccountEncryptionMigrateConnectedConfigurationsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema>;
export const AccountEncryptionMigrateConnectedConfigurationsResultV1Schema = lazyZodSchema(() => z.object({ row: z.object({ revision,
  content: ConnectedAccountCatalogContentV1Schema.nullable() }).strict().nullable() }).strict());
export const AccountEncryptionMigrateConnectedPurposesResultV1Schema = AccountEncryptionMigrateConnectedConfigurationsResultV1Schema;
export type AccountEncryptionMigrateConnectedConfigurationsResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedConfigurationsResultV1Schema>;
export type AccountEncryptionMigrateConnectedPurposesResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedPurposesResultV1Schema>;

export function listConnectedConfigurationCatalogSavedSecretRefsV1(catalog: ConnectedConfigurationCatalogV1): readonly Readonly<{ path: string; secretId: string }>[] {
  return catalog.entries.flatMap((entry, index) => Object.entries(entry.secretRefs).map(([field, secretId]) => ({
    path: appendSavedSecretReferencePathV1(`entries[${index}].secretRefs`, field), secretId,
  })));
}
export function rewriteConnectedConfigurationCatalogSavedSecretRefsV1(catalog: ConnectedConfigurationCatalogV1, oldSecretId: string,
  newSecretId: string): ConnectedConfigurationCatalogV1 {
  return ConnectedConfigurationCatalogV1Schema.parse({ ...catalog, entries: catalog.entries.map(entry => ({ ...entry,
    secretRefs: Object.fromEntries(Object.entries(entry.secretRefs).map(([field, reference]) => [field, reference === oldSecretId ? newSecretId : reference])),
  })) });
}
