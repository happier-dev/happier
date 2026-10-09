import { splitProviderSettingsV1 } from "./catalogSchemasV1.js";
export { splitProviderSettingsV1, composeProviderSettingsV1 } from "./catalogSchemasV1.js";
import { ProviderConnectionsCatalogV1Schema, StoredProviderConnectionsCatalogV1Schema, StoredProviderConnectionsContentV1Schema } from "./catalogSchemasV1.js";
import type { ProviderConnectionsCatalogV1, ProviderConnectionsContentV1, StoredProviderConnectionsContentV1 } from "./catalogSchemasV1.js";
export { ProviderConnectionsCatalogV1Schema, StoredProviderConnectionsCatalogV1Schema, ProviderConnectionsContentV1Schema, StoredProviderConnectionsContentV1Schema, ProviderConnectionsMigrationContentV1Schema, ProviderConnectionsRowFailureV1Schema, ProviderConnectionsRowReadResponseV1Schema, ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema } from "./catalogSchemasV1.js";
export type { ProviderConnectionsCatalogV1, ProviderConnectionsContentV1, StoredProviderConnectionsContentV1, ProviderConnectionsMigrationContentV1, ProviderConnectionsRowMutationV1, ProviderConnectionsCatalogSnapshotV1, ProviderConnectionsCatalogRowReadResultV1 } from "./catalogSchemasV1.js";
import tweetnacl from 'tweetnacl';
import { StrictJsonValueSchema, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import { ProviderConnectionsMigrationContentV1Schema } from './catalogSchemasV1.js';
import type { ProviderConnectionsMigrationContentV1 } from './catalogSchemasV1.js';


import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema, type ProviderDefaultModelSelectionsByAgentTargetKeyV1 } from '../selection/v1.js';
import { DEFAULT_PROVIDER_SETTINGS_V1, parseProviderSettingsV1Narrow, type ProviderSettingsParseDiagnosticV1 } from '../settings/v1.js';
import { appendSavedSecretReferencePathV1, listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';

export const PROVIDER_CONNECTIONS_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/provider-connections/v1/' as const;
export const PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 = `${PROVIDER_CONNECTIONS_ACCOUNT_ROW_PREFIX_V1}catalog` as const;
export const PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 = '/v1/account/entity-rows/provider-connections' as const;
export const PROVIDER_CONNECTIONS_ACCOUNT_CIPHER_KIND_V1 = 'account_provider_connections' as const;

export { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema };
export type { ProviderDefaultModelSelectionsByAgentTargetKeyV1 };

/** A transient domain view for existing operations, never a Settings persistence shape. */
const { defaultsByAgentTargetKey: _defaultModelSelections, ...emptyCatalog } = DEFAULT_PROVIDER_SETTINGS_V1;
export const DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1: ProviderConnectionsCatalogV1 = emptyCatalog;

export function assertProviderConnectionsContentForModeV1(content: StoredProviderConnectionsContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || content.t === 'plain' && Object.hasOwn(content, 'c')
    || content.t === 'encrypted' && Object.hasOwn(content, 'v') || (content.t === 'encrypted' && !isAccountScopedBlobCiphertextForKind({
    kind: PROVIDER_CONNECTIONS_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c,
  }))) throw new Error('account-mode-mismatch');
}
export type ProviderConnectionsMigrationSourceV1 = Readonly<{ content: ProviderConnectionsMigrationContentV1; payload: JsonValue }>;
type ProviderConnectionsOpenInputV1 = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown; admission?: 'migration';
}>;
type ProviderConnectionsOpenResultV1 = Readonly<{ status: 'opened'; catalog: ProviderConnectionsCatalogV1; migrationSource?: ProviderConnectionsMigrationSourceV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> | Readonly<{ status: 'partial'; catalog: ProviderConnectionsCatalogV1; diagnostics: readonly ProviderSettingsParseDiagnosticV1[] }>;
export function openProviderConnectionsContentV1(input: ProviderConnectionsOpenInputV1 & Readonly<{ admission: 'migration' }>):
  Exclude<ProviderConnectionsOpenResultV1, { status: 'opened' }> | Readonly<{ status: 'opened'; catalog: ProviderConnectionsCatalogV1; migrationSource: ProviderConnectionsMigrationSourceV1 }>;
export function openProviderConnectionsContentV1(input: ProviderConnectionsOpenInputV1): ProviderConnectionsOpenResultV1;
export function openProviderConnectionsContentV1(input: ProviderConnectionsOpenInputV1): ProviderConnectionsOpenResultV1 {
  const content = StoredProviderConnectionsContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertProviderConnectionsContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let value: unknown;
  if (content.data.t === 'plain') value = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: PROVIDER_CONNECTIONS_ACCOUNT_CIPHER_KIND_V1, material: input.material, ciphertext: content.data.c })?.value;
  }
  const projection = readProviderConnectionsCatalogV1(value);
  if (projection.status === 'unavailable') return projection;
  const envelopeDiagnostics = listProviderConnectionsEnvelopeSavedSecretDiagnosticsV1(content.data);
  if (envelopeDiagnostics.length > 0) return { status: 'partial', catalog: projection.catalog,
    diagnostics: [...(projection.status === 'partial' ? projection.diagnostics : []), ...envelopeDiagnostics] };
  if (input.admission !== 'migration' || projection.status !== 'opened') return projection;
  const payload = StrictJsonValueSchema.safeParse(value);
  const source = ProviderConnectionsMigrationContentV1Schema.safeParse(content.data);
  return payload.success && source.success ? { ...projection, migrationSource: { content: source.data, payload: payload.data } }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

/** Retained-envelope admission preserves complete source bodies; new writes stay strict. */
export function parseProviderConnectionsMigrationContentV1(value: unknown): ProviderConnectionsMigrationContentV1 | null {
  const content = ProviderConnectionsMigrationContentV1Schema.safeParse(value);
  if (!content.success || listProviderConnectionsEnvelopeSavedSecretDiagnosticsV1(content.data).length > 0) return null;
  try { assertProviderConnectionsContentForModeV1(content.data, content.data.t === 'plain' ? 'plain' : 'e2ee'); }
  catch { return null; }
  return content.data.t === 'encrypted' || openProviderConnectionsContentV1({ mode: 'plain', material: null,
    content: content.data, admission: 'migration' }).status === 'opened' ? content.data : null;
}

/** Unknown visible references never become complete authority merely because the payload stays opaque. */
function listProviderConnectionsEnvelopeSavedSecretDiagnosticsV1(content: StoredProviderConnectionsContentV1): readonly ProviderSettingsParseDiagnosticV1[] {
  return listSavedSecretReferenceCarrierPathsV1(content, { initialPath: 'content' })
    .filter(path => content.t !== 'plain' || !(path === 'content.v' || path.startsWith('content.v.') || path.startsWith('content.v[')))
    .map(path => ({ path: path.slice('content.'.length), reason: 'unclassified_reference' as const }));
}

/** Reseal the original stored JSON rather than the deliberately narrower display catalog. */
export function sealProviderConnectionsMigrationContentV1(input: Readonly<{
  source: ProviderConnectionsMigrationSourceV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): ProviderConnectionsMigrationContentV1 {
  const source = parseProviderConnectionsMigrationContentV1(input.source.content);
  const payload = StrictJsonValueSchema.parse(input.source.payload);
  if (!source || readProviderConnectionsCatalogV1(payload).status !== 'opened'
    || source.t === 'plain' && !sameStrictJsonValue(source.v, payload)) throw new Error('invalid-stored-content');
  const metadata = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 't' && key !== (source.t === 'plain' ? 'v' : 'c')));
  let converted: unknown;
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    converted = { ...metadata, t: 'plain', v: payload };
  } else {
    if (!input.material) throw new Error('encryption-material-unavailable');
    converted = { ...metadata, t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: PROVIDER_CONNECTIONS_ACCOUNT_CIPHER_KIND_V1,
      material: input.material, payload, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
  }
  const result = parseProviderConnectionsMigrationContentV1(converted);
  if (!result) throw new Error('invalid-stored-content');
  return result;
}

/** One display projection; incomplete inventories never become writable catalog authority. */
export function readProviderConnectionsCatalogV1(value: unknown):
  Readonly<{ status: 'opened'; catalog: ProviderConnectionsCatalogV1 }>
  | Readonly<{ status: 'partial'; catalog: ProviderConnectionsCatalogV1; diagnostics: readonly ProviderSettingsParseDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }> {
  return readStoredProviderConnectionsCatalogV1(value, false);
}

function readStoredProviderConnectionsCatalogV1(value: unknown, retainedSource: boolean):
  ReturnType<typeof readProviderConnectionsCatalogV1> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('v' in value) || value.v !== 1) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const parsed = StoredProviderConnectionsCatalogV1Schema.safeParse(value);
  let catalog: ProviderConnectionsCatalogV1;
  let diagnostics: ProviderSettingsParseDiagnosticV1[];
  if (parsed.success) { catalog = parsed.data; diagnostics = []; }
  else {
    const narrow = parseProviderSettingsV1Narrow({ ...value, defaultsByAgentTargetKey: {} });
    catalog = splitProviderSettingsV1(narrow.settings).catalog;
    diagnostics = [...narrow.diagnostics];
    if (diagnostics.length === 0) diagnostics.push({ path: 'catalog', reason: 'invalid_record' });
  }
  const references = listProviderConnectionsCatalogSavedSecretRefsV1(catalog);
  const knownPaths = new Set(references.map(ref => ref.path));
  if (!retainedSource) {
    for (const reference of references) {
      try {
        if (parseSavedSecretRefV1(reference.secretId).kind === 'shared_resource') continue;
      } catch { /* Malformed references have no active resource authority. */ }
      diagnostics.push({ path: reference.path, reason: 'unclassified_reference' });
    }
  }
  diagnostics.push(...listSavedSecretReferenceCarrierPathsV1(value)
    .filter(path => !knownPaths.has(path)).map(path => ({ path, reason: 'unclassified_reference' })));
  return diagnostics.length > 0 ? { status: 'partial', catalog, diagnostics } : { status: 'opened', catalog };
}

/** Only the still-inactive source can contain personal material awaiting the S2 importer. */
export function readRetainedProviderConnectionsCatalogV1(raw: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(raw, 'providerSettingsV1')) return { status: 'ready' as const,
    catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaults: {} };
  const source = raw.providerSettingsV1;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  const defaultsByAgentTargetKey: unknown = Reflect.get(source, 'defaultsByAgentTargetKey');
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(source)
    .filter(([key]) => key !== 'defaultsByAgentTargetKey'));
  const opened = readStoredProviderConnectionsCatalogV1(body, true);
  if (opened.status === 'unavailable') return opened;
  const defaults = ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.safeParse(defaultsByAgentTargetKey ?? {});
  const diagnostics = [...(opened.status === 'partial' ? opened.diagnostics : []),
    ...(defaults.success ? [] : [{ path: 'defaultsByAgentTargetKey', reason: 'invalid_record' }])];
  return diagnostics.length > 0 ? { status: 'partial' as const, catalog: opened.catalog, defaults: defaults.success ? defaults.data : {}, diagnostics }
    : { status: 'ready' as const, catalog: opened.catalog, defaults: defaults.success ? defaults.data : {} };
}

export function listProviderConnectionsCatalogSavedSecretRefsV1(catalog: ProviderConnectionsCatalogV1): readonly Readonly<{ path: string; secretId: string }>[] {
  const refs: Array<{ path: string; secretId: string }> = [];
  for (const [id, bindings] of Object.entries(catalog.secretBindingsByConnectionId)) {
    const connectionPath = appendSavedSecretReferencePathV1('secretBindingsByConnectionId', id);
    for (const [slot, secretId] of Object.entries(bindings.account ?? {})) {
      refs.push({ path: appendSavedSecretReferencePathV1(`${connectionPath}.account`, slot), secretId });
    }
    for (const [machineId, slots] of Object.entries(bindings.byMachineId ?? {})) {
      const machinePath = appendSavedSecretReferencePathV1(`${connectionPath}.byMachineId`, machineId);
      for (const [slot, secretId] of Object.entries(slots)) refs.push({ path: appendSavedSecretReferencePathV1(machinePath, slot), secretId });
    }
  }
  return refs;
}
export function rewriteProviderConnectionsCatalogSavedSecretRefsV1(catalog: ProviderConnectionsCatalogV1, oldId: string, newId: string): ProviderConnectionsCatalogV1 {
  return { ...catalog, secretBindingsByConnectionId: Object.fromEntries(Object.entries(catalog.secretBindingsByConnectionId).map(([id, bindings]) => [id, {
    ...bindings,
    ...(bindings.account ? { account: Object.fromEntries(Object.entries(bindings.account).map(([slot, value]) => [slot, value === oldId ? newId : value])) } : {}),
    ...(bindings.byMachineId ? { byMachineId: Object.fromEntries(Object.entries(bindings.byMachineId).map(([machineId, slots]) => [machineId,
      Object.fromEntries(Object.entries(slots).map(([slot, value]) => [slot, value === oldId ? newId : value]))])) } : {}),
  }])) };
}
export function sealProviderConnectionsContentV1(input: Readonly<{
  catalog: ProviderConnectionsCatalogV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array;
}>): ProviderConnectionsContentV1 {
  const catalog = ProviderConnectionsCatalogV1Schema.parse(input.catalog);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: catalog };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: PROVIDER_CONNECTIONS_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: catalog, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
