import { AcpCatalogRecordV1Schema, StoredAcpCatalogRecordV1Schema, StoredAcpCatalogContentV1Schema } from "./catalogSchemasV1.js";
import type { AcpCatalogRecordV1, AcpCatalogContentV1, StoredAcpCatalogContentV1, AcpCatalogDiagnosticV1 } from "./catalogSchemasV1.js";
export { AcpCatalogRecordV1Schema, StoredAcpCatalogRecordV1Schema, AcpCatalogContentV1Schema, StoredAcpCatalogContentV1Schema, AcpCatalogMigrationContentV1Schema, AcpCatalogRowFailureV1Schema, AcpCatalogRowReadResponseV1Schema, AcpCatalogRowMutationV1Schema, AcpCatalogRowMutationResponseV1Schema, AccountEncryptionMigrateAcpCatalogDirectiveV1Schema, AccountEncryptionMigrateAcpCatalogResultV1Schema } from "./catalogSchemasV1.js";
export type { AcpCatalogRecordV1, AcpCatalogContentV1, StoredAcpCatalogContentV1, AcpCatalogRowMutationV1, AcpCatalogDiagnosticV1, AcpCatalogSnapshotV1, AccountEncryptionMigrateAcpCatalogDirectiveV1 } from "./catalogSchemasV1.js";
import tweetnacl from 'tweetnacl';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';

import { listSavedSecretReferenceCarrierPathsV1 } from '../../account/settings/savedSecretReferenceV1.js';

import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { AcpCatalogSettingsV1Schema } from './settingsV1.js';

export const ACP_CATALOG_ACCOUNT_ROW_KEY_V1 = '@happier/account/acp/v1/catalog' as const;
export const ACP_CATALOG_ROWS_ROUTE_V1 = '/v1/account/entity-rows/acp' as const;
export const ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1 = 'account_acp_catalog' as const;

/** Fresh authority can be established only after opening the real raw source; invalid sources never mean empty. */
export function isFreshAcpCatalogSourceV1(rawSettings: unknown): boolean {
  return readFreshAcpCatalogSourceV1(rawSettings).status === 'ready';
}

export function readFreshAcpCatalogSourceV1(rawSettings: unknown): Readonly<{ status: 'ready'; record: AcpCatalogRecordV1 }>
  | Readonly<{ status: 'unavailable'; reason: 'source-transfer-required' | 'invalid-stored-content' }> {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const empty = { v: 1 as const, definitions: [] };
  if (!Object.hasOwn(rawSettings, 'acpCatalogSettingsV1')) return { status: 'ready', record: empty };
  const raw = Reflect.get(rawSettings, 'acpCatalogSettingsV1');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (Reflect.get(raw, 'v') !== 2 || !Array.isArray(Reflect.get(raw, 'backends'))) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const parsed = AcpCatalogSettingsV1Schema.safeParse(raw);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (parsed.data.backends.length === 0 && listSavedSecretReferenceCarrierPathsV1(raw).length > 0) return { status: 'unavailable', reason: 'invalid-stored-content' };
  return parsed.data.backends.length === 0 ? { status: 'ready', record: empty }
    : { status: 'unavailable', reason: 'source-transfer-required' };
}

export function assertAcpCatalogContentForModeV1(content: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }>, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c })) throw new Error('account-mode-mismatch');
}

export type AcpCatalogMigrationSourceV1 = Readonly<{ content: StoredAcpCatalogContentV1; payload: JsonValue }>;
type AcpCatalogOpenInputV1 = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown; admission?: 'migration';
}>;
type AcpCatalogOpenResultV1 = Readonly<{ status: 'opened'; record: AcpCatalogRecordV1; migrationSource?: AcpCatalogMigrationSourceV1 }>
  | Readonly<{ status: 'partial'; reason: 'incomplete-inventory'; record: AcpCatalogRecordV1; diagnostics: readonly AcpCatalogDiagnosticV1[] }>
  | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}>;

export function openAcpCatalogContentV1(input: AcpCatalogOpenInputV1 & Readonly<{ admission: 'migration' }>):
  Exclude<AcpCatalogOpenResultV1, { status: 'opened' }> | Readonly<{ status: 'opened'; record: AcpCatalogRecordV1; migrationSource: AcpCatalogMigrationSourceV1 }>;
export function openAcpCatalogContentV1(input: AcpCatalogOpenInputV1): AcpCatalogOpenResultV1;
export function openAcpCatalogContentV1(input: AcpCatalogOpenInputV1): AcpCatalogOpenResultV1 {
  const content = StoredAcpCatalogContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertAcpCatalogContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let raw: unknown;
  if (content.data.t === 'plain') raw = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    raw = openAccountScopedBlobCiphertext({ kind: ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1,
      material: input.material, ciphertext: content.data.c })?.value;
  }
  const projection = projectStoredAcpCatalogRecordV1(raw);
  if (projection.status === 'unavailable') return projection;
  const envelopeDiagnostics = listAcpCatalogEnvelopeSavedSecretDiagnosticsV1(content.data);
  if (envelopeDiagnostics.length > 0) return { status: 'partial', reason: 'incomplete-inventory', record: projection.record,
    diagnostics: [...(projection.status === 'partial' ? projection.diagnostics : []), ...envelopeDiagnostics] };
  if (input.admission !== 'migration' || projection.status !== 'opened') return projection;
  const payload = StrictJsonValueSchema.safeParse(raw);
  return payload.success ? { ...projection, migrationSource: { content: content.data, payload: payload.data } }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

/** One complete retained-envelope admission for both conversion source and target. */
export function parseAcpCatalogMigrationContentV1(value: unknown): StoredAcpCatalogContentV1 | null {
  const content = StoredAcpCatalogContentV1Schema.safeParse(value);
  if (!content.success || listAcpCatalogEnvelopeSavedSecretDiagnosticsV1(content.data).length > 0) return null;
  try { assertAcpCatalogContentForModeV1(content.data, content.data.t === 'plain' ? 'plain' : 'e2ee'); }
  catch { return null; }
  return content.data.t === 'encrypted'
    || openAcpCatalogContentV1({ mode: 'plain', material: null, content: content.data, admission: 'migration' }).status === 'opened'
    ? content.data : null;
}

/** Visible envelope references must not gain authority even when the catalog payload stays opaque. */
export function listAcpCatalogEnvelopeSavedSecretDiagnosticsV1(content: StoredAcpCatalogContentV1): readonly AcpCatalogDiagnosticV1[] {
  return listSavedSecretReferenceCarrierPathsV1(content, { initialPath: 'content' })
    .filter(path => content.t !== 'plain' || !(path === 'content.v' || path.startsWith('content.v.') || path.startsWith('content.v[')))
    .map(path => ({ path: path.slice(path.startsWith('content.') ? 'content.'.length : 'content'.length), reason: 'unclassified_reference' as const }));
}

function projectStoredAcpCatalogRecordV1(raw: unknown): ReturnType<typeof openAcpCatalogContentV1> {
  const complete = StoredAcpCatalogRecordV1Schema.safeParse(raw);
  if (complete.success) {
    const admitted = new Set(listAcpCatalogSavedSecretRefsV1(complete.data).map(reference => reference.path));
    const diagnostics = listSavedSecretReferenceCarrierPathsV1(raw).filter(path => !admitted.has(path))
      .map(path => ({ path, reason: 'unclassified_reference' as const }));
    return diagnostics.length > 0 ? { status: 'partial', reason: 'incomplete-inventory', record: complete.data, diagnostics }
      : { status: 'opened', record: complete.data };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Reflect.get(raw, 'v') !== 1) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const inventory: unknown = Reflect.get(raw, 'definitions');
  if (!Array.isArray(inventory)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const definitionSchema = createStoredReadSchema(AcpCatalogRecordV1Schema.shape.definitions.element);
  const candidates = inventory.map((value: unknown, index: number) => ({ index, parsed: definitionSchema.safeParse(value) }));
  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (const { parsed } of candidates) if (parsed.success) {
    ids.set(parsed.data.id, (ids.get(parsed.data.id) ?? 0) + 1);
    names.set(parsed.data.name, (names.get(parsed.data.name) ?? 0) + 1);
  }
  const definitions: AcpCatalogRecordV1['definitions'] = [];
  const admitted = new Set<string>();
  const diagnostics: AcpCatalogDiagnosticV1[] = [];
  for (const { index, parsed } of candidates) {
    if (!parsed.success || ids.get(parsed.data.id) !== 1 || names.get(parsed.data.name) !== 1) {
      diagnostics.push({ path: `definitions[${index}]`, reason: 'invalid_definition' });
      continue;
    }
    definitions.push(parsed.data);
    for (const reference of listAcpCatalogSavedSecretRefsV1({ v: 1, definitions: [parsed.data] })) {
      admitted.add(reference.path.replace(/^definitions\[0\]/, `definitions[${index}]`));
    }
  }
  for (const path of listSavedSecretReferenceCarrierPathsV1(raw)) if (!admitted.has(path)) diagnostics.push({ path, reason: 'unclassified_reference' });
  return { status: 'partial', reason: 'incomplete-inventory', record: { v: 1, definitions }, diagnostics };
}

export function sealAcpCatalogContentV1(input: Readonly<{
  record: AcpCatalogRecordV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array;
}>): AcpCatalogContentV1 {
  const record = AcpCatalogRecordV1Schema.parse(input.record);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}

/** Account conversion reseals complete original JSON; ordinary new writes remain closed above. */
export function sealAcpCatalogMigrationContentV1(input: Readonly<{
  source: AcpCatalogMigrationSourceV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): StoredAcpCatalogContentV1 {
  const sourceContent = parseAcpCatalogMigrationContentV1(input.source.content);
  const payload = StrictJsonValueSchema.parse(input.source.payload);
  if (!sourceContent || projectStoredAcpCatalogRecordV1(payload).status !== 'opened'
    || sourceContent.t === 'plain' && !sameStrictJsonValue(sourceContent.v, payload)) throw new Error('invalid-stored-content');
  const metadata = Object.fromEntries(Object.entries(sourceContent).filter(([key]) =>
    key !== 't' && key !== (sourceContent.t === 'plain' ? 'v' : 'c')));
  if (Object.hasOwn(metadata, input.mode === 'plain' ? 'v' : 'c')) throw new Error('invalid-stored-content');
  let converted: unknown;
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    converted = { ...metadata, t: 'plain', v: payload };
  } else {
    if (!input.material) throw new Error('encryption-material-unavailable');
    converted = { ...metadata, t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1, material: input.material, payload,
      randomBytes: input.randomBytes ?? tweetnacl.randomBytes,
    }) };
  }
  const content = parseAcpCatalogMigrationContentV1(converted);
  if (!content) throw new Error('invalid-stored-content');
  return content;
}

/** The configured catalog owns its credential slots; the composite Secret owner consumes this census. */
export function listAcpCatalogSavedSecretRefsV1(record: AcpCatalogRecordV1): readonly Readonly<{ path: string; secretId: string }>[] {
  return record.definitions.flatMap((definition, index) => Object.entries(definition.env).flatMap(([name, value]) =>
    value.t === 'savedSecret' ? [{ path: `definitions[${index}].env.${name}`, secretId: value.secretId }] : []));
}

export function rewriteAcpCatalogSavedSecretRefsV1(record: AcpCatalogRecordV1, previousId: string, nextId: string): AcpCatalogRecordV1 {
  return AcpCatalogRecordV1Schema.parse({ ...record, definitions: record.definitions.map(definition => ({ ...definition,
    env: Object.fromEntries(Object.entries(definition.env).map(([name, value]) => [name,
      value.t === 'savedSecret' && value.secretId === previousId ? { t: 'savedSecret', secretId: nextId } : value])),
  })) });
}
