import { ConnectedAccountCatalogKeyV1Schema, ConnectedConfigurationCatalogV1Schema, ConnectedAccountCatalogRecordV1Schema, StoredConnectedAccountCatalogContentV1Schema } from "./connectedAccountCatalogSchemasV1.js";
import type { ConnectedAccountCatalogKeyV1, ConnectedConfigurationCatalogV1, ConnectedAccountCatalogRecordV1, ConnectedAccountCatalogContentV1, StoredConnectedAccountCatalogContentV1, ConnectedAccountCatalogDiagnosticV1, ConnectedAccountCatalogOpenResultV1 } from "./connectedAccountCatalogSchemasV1.js";
export { ConnectedAccountCatalogKeyV1Schema, ConnectedConfigurationCatalogV1Schema, ConnectedPurposeCatalogV1Schema, ConnectedAccountCatalogRecordV1Schema, StoredConnectedAccountCatalogRecordV1Schema, ConnectedAccountCatalogContentV1Schema, StoredConnectedAccountCatalogContentV1Schema, ConnectedAccountCatalogRowFailureV1Schema, ConnectedAccountCatalogRowReadResponseV1Schema, ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowMutationResponseV1Schema, AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema, AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema, AccountEncryptionMigrateConnectedConfigurationsResultV1Schema, AccountEncryptionMigrateConnectedPurposesResultV1Schema } from "./connectedAccountCatalogSchemasV1.js";
export type { ConnectedAccountCatalogKeyV1, ConnectedConfigurationCatalogV1, ConnectedPurposeCatalogV1, ConnectedAccountCatalogRecordV1, ConnectedAccountCatalogContentV1, StoredConnectedAccountCatalogContentV1, ConnectedAccountCatalogDiagnosticV1, ConnectedAccountCatalogOpenResultV1, ConnectedAccountCatalogRowReadResponseV1, ConnectedAccountCatalogRowMutationV1, ConnectedAccountCatalogRowMutationResponseV1, AccountEncryptionMigrateConnectedConfigurationsDirectiveV1, AccountEncryptionMigrateConnectedPurposesDirectiveV1, AccountEncryptionMigrateConnectedConfigurationsResultV1, AccountEncryptionMigrateConnectedPurposesResultV1 } from "./connectedAccountCatalogSchemasV1.js";
import tweetnacl from 'tweetnacl';
import { ConnectedAccountCatalogMigrationContentV1Schema } from './connectedAccountCatalogSchemasV1.js';
import type { ConnectedAccountCatalogMigrationSourceV1 } from './connectedAccountCatalogSchemasV1.js';
export { ConnectedAccountCatalogMigrationContentV1Schema } from './connectedAccountCatalogSchemasV1.js';
export type { ConnectedAccountCatalogMigrationSourceV1 } from './connectedAccountCatalogSchemasV1.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../json/strictJsonValue.js';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ConnectedAccountServiceConfigurationEntryV1Schema } from '../account/settings/connectedAccountServiceConfigurationsV1.js';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema, qualifiedPurposeKey, readEarlierTeamResourcePurposeTargetsV1 } from './connectedAccountPurposeBindings.js';


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
type ConnectedAccountCatalogOpenInputV1 = Readonly<{
  key: ConnectedAccountCatalogKeyV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
  admission?: 'migration';
}>;
export function openConnectedAccountCatalogContentV1(input: ConnectedAccountCatalogOpenInputV1 & Readonly<{ admission: 'migration' }>):
  Exclude<ConnectedAccountCatalogOpenResultV1, { status: 'opened' }>
  | Readonly<{ status: 'opened'; record: ConnectedAccountCatalogRecordV1; migrationSource: ConnectedAccountCatalogMigrationSourceV1 }>;
export function openConnectedAccountCatalogContentV1(input: ConnectedAccountCatalogOpenInputV1): ConnectedAccountCatalogOpenResultV1;
export function openConnectedAccountCatalogContentV1(input: ConnectedAccountCatalogOpenInputV1): ConnectedAccountCatalogOpenResultV1 {
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
  if (!outerDiagnostics.length) {
    if (projected.status !== 'opened' || input.admission !== 'migration') return projected;
    const payload = StrictJsonValueSchema.safeParse(value);
    return payload.success && ConnectedAccountCatalogMigrationContentV1Schema.safeParse(content).success
      ? { ...projected, migrationSource: { content, payload: payload.data } }
      : { status: 'unavailable', reason: 'invalid-stored-content' };
  }
  return { status: 'partial', record: projected.record,
    diagnostics: [...(projected.status === 'partial' ? projected.diagnostics : []), ...outerDiagnostics] };
}
/** Complete original-envelope admission is shared by conversion sources and targets. */
export function parseConnectedAccountCatalogMigrationContentV1(value: unknown,
  key: ConnectedAccountCatalogKeyV1): StoredConnectedAccountCatalogContentV1 | null {
  const parsed = ConnectedAccountCatalogMigrationContentV1Schema.safeParse(value);
  if (!parsed.success) return null;
  try { assertConnectedAccountCatalogContentForModeV1(parsed.data, parsed.data.t === 'plain' ? 'plain' : 'e2ee', key); }
  catch { return null; }
  if (parsed.data.t === 'encrypted') return hasDroppedReferenceCarrier(parsed.data, { t: 'encrypted', c: parsed.data.c }) ? null : parsed.data;
  return openConnectedAccountCatalogContentV1({ key, mode: 'plain', material: null, content: parsed.data,
    admission: 'migration' }).status === 'opened' ? parsed.data : null;
}

/** Account conversion reseals complete original JSON; ordinary writes remain strict below. */
export function sealConnectedAccountCatalogMigrationContentV1(input: Readonly<{
  source: ConnectedAccountCatalogMigrationSourceV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): StoredConnectedAccountCatalogContentV1 {
  const payload = StrictJsonValueSchema.parse(input.source.payload);
  const key = ConnectedAccountCatalogKeyV1Schema.parse(storedObject(payload)?.key);
  const source = parseConnectedAccountCatalogMigrationContentV1(input.source.content, key);
  if (!source || projectStoredConnectedAccountCatalogRecordV1(payload, key).status !== 'opened'
    || source.t === 'plain' && !sameStrictJsonValue(source.v, payload)) throw new Error('invalid-stored-content');
  const metadata = Object.fromEntries(Object.entries(source).filter(([field]) => field !== 't' && field !== (source.t === 'plain' ? 'v' : 'c')));
  if (Object.hasOwn(metadata, input.mode === 'plain' ? 'v' : 'c')) throw new Error('invalid-stored-content');
  let converted: unknown;
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    converted = { ...metadata, t: 'plain', v: payload };
  } else {
    if (!input.material) throw new Error('encryption-material-unavailable');
    converted = { ...metadata, t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(key),
      material: input.material, payload, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
  }
  const content = parseConnectedAccountCatalogMigrationContentV1(converted, key);
  if (!content) throw new Error('invalid-stored-content');
  return content;
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
