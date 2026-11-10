import { lazyZodSchema } from '../../lazyZodSchema.js';
import * as z from '../../zodRuntimePolicy.js';
import { McpServerCatalogV1Schema, StoredMcpServerCatalogContentV1Schema } from "./catalogSchemasV1.js";
import type { McpServerCatalogV1, McpServerCatalogContentV1, StoredMcpServerCatalogContentV1, McpServerCatalogDiagnosticV1, McpServerCatalogOpenResultV1 } from "./catalogSchemasV1.js";
export { McpServerCatalogV1Schema, StoredMcpServerCatalogV1Schema, McpServerCatalogContentV1Schema, StoredMcpServerCatalogContentV1Schema, McpServerCatalogMigrationContentV1Schema, McpServerCatalogDiagnosticV1Schema, McpServerCatalogRowFailureV1Schema, McpServerCatalogRowReadResponseV1Schema, McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema, AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema, AccountEncryptionMigrateMcpServerCatalogResultV1Schema } from "./catalogSchemasV1.js";
export type { McpServerCatalogV1, McpServerCatalogContentV1, StoredMcpServerCatalogContentV1, McpServerCatalogDiagnosticV1, McpServerCatalogOpenResultV1, McpServerCatalogRowReadResponseV1, McpServerCatalogRowMutationV1, McpServerCatalogRowMutationResponseV1, AccountEncryptionMigrateMcpServerCatalogDirectiveV1, AccountEncryptionMigrateMcpServerCatalogResultV1 } from "./catalogSchemasV1.js";
import tweetnacl from 'tweetnacl';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema, sameStrictJsonValue, type JsonValue } from '../../json/strictJsonValue.js';
import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { appendSavedSecretReferencePathV1, listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { McpServerCatalogEntryV1Schema, McpServerRuleV1Schema, McpServerConfigOverrideFieldsV1Schema, McpServerPluginSettingsMapV1Schema, isMcpPluginItemIdV1,
  type McpServerCatalogEntryV1, type McpServerRuleV1 } from './settingsV1.js';
import { listValueRefSavedSecretRefsV1, remapValueRefSavedSecretReferencesV1, type ValueRefV1 } from '../../valueRefs/valueRefV1.js';
import { normalizeReachRulesV1 } from '../../reach/reachRulesChangeV1.js';
import { splitRetainedMcpServerConfigurationV1 } from './splitRetainedMcpServerConfigurationV1.js';

export const MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 = '@happier/account/mcp/v1/catalog' as const;
export const MCP_SERVER_CATALOG_ROWS_ROUTE_V1 = '/v1/account/entity-rows/mcp' as const;
export const MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1 = 'account_mcp_catalog' as const;

export function assertMcpServerCatalogContentForModeV1(content: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }>, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted'
    && !isAccountScopedBlobCiphertextForKind({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1, ciphertext: content.c }))) {
    throw new Error('account-mode-mismatch');
  }
}

const storedServer = createStoredReadSchema(McpServerCatalogEntryV1Schema);
const storedBinding = createStoredReadSchema(McpServerRuleV1Schema);
const storedPluginServers = createStoredReadSchema(McpServerPluginSettingsMapV1Schema);
// Only the provenance-owned 0.2 source reader admits configuration on a rule.
const retainedBinding = createStoredReadSchema(lazyZodSchema(() => z.extend(McpServerRuleV1Schema, { overrides: z.optional(McpServerConfigOverrideFieldsV1Schema) })));

/** Malformed independent entries remain diagnostic; they never authorize activation. */
export function projectStoredMcpServerCatalogV1(value: unknown,
  authority: 'active' | 'retained-source' = 'active'): McpServerCatalogOpenResultV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.servers) || !Array.isArray(raw.bindings)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const diagnostics: McpServerCatalogDiagnosticV1[] = [];
  const candidates: Array<{ entry: McpServerCatalogEntryV1; index: number }> = [];
  raw.servers.forEach((entry, index) => {
    const parsed = storedServer.safeParse(entry);
    if (parsed.success) candidates.push({ entry: parsed.data, index });
    else diagnostics.push({ path: `servers[${index}]`, reason: 'invalid-stored-content' });
  });
  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  candidates.forEach(({ entry }) => {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  });
  const servers: McpServerCatalogEntryV1[] = [];
  for (const candidate of candidates) {
    if (idCounts.get(candidate.entry.id) !== 1 || nameCounts.get(candidate.entry.name) !== 1) {
      diagnostics.push({ path: `servers[${candidate.index}]`, reason: 'invalid-stored-content' });
    } else servers.push(candidate.entry);
  }
  const serverIds = new Set(servers.map(server => server.id));
  const parsedBindings = raw.bindings.map((binding, index) => ({ parsed: (authority === 'retained-source' ? retainedBinding : storedBinding).safeParse(binding), index }));
  const bindingIdCounts = new Map<string, number>();
  parsedBindings.forEach(({ parsed }) => {
    if (parsed.success) bindingIdCounts.set(parsed.data.id, (bindingIdCounts.get(parsed.data.id) ?? 0) + 1);
  });
  const bindings: Array<McpServerRuleV1 & { overrides?: import('./settingsV1.js').McpServerConfigOverrideFieldsV1 }> = [];
  for (const { parsed, index } of parsedBindings) {
    if (!parsed.success || (!serverIds.has(parsed.data.serverId) && !isMcpPluginItemIdV1(parsed.data.serverId)) || bindingIdCounts.get(parsed.data.id) !== 1) {
      diagnostics.push({ path: `bindings[${index}]`, reason: 'invalid-stored-content' });
    } else bindings.push(parsed.data);
  }
  const normalizedBindings = [...new Set(bindings.map(rule => rule.serverId))].flatMap(serverId => normalizeReachRulesV1(bindings.filter(rule => rule.serverId === serverId)));
  const pluginServers = raw.pluginServers === undefined ? null : storedPluginServers.safeParse(raw.pluginServers);
  if (pluginServers && !pluginServers.success) diagnostics.push({ path: 'pluginServers', reason: 'invalid-stored-content' });
  const catalog: McpServerCatalogV1 = { v: 1, ...(authority === 'retained-source'
    ? splitRetainedMcpServerConfigurationV1(servers, normalizedBindings) : { servers, bindings: normalizedBindings }),
    ...(pluginServers?.success ? { pluginServers: pluginServers.data } : {}),
  };
  if (authority === 'active') for (const reference of listMcpServerCatalogSavedSecretRefsV1(catalog)) {
    try {
      const referenceKind = parseSavedSecretRefV1(reference.secretId).kind;
      if (referenceKind === 'shared_resource' || referenceKind === 'personal') continue;
    } catch { /* A recognizable but invalid reference cannot authorize runtime or census. */ }
    diagnostics.push({ path: reference.path, reason: 'unclassified-reference' });
  }
  const admittedPaths = new Set(listMcpServerCatalogSavedSecretRefsV1(catalog).map(ref => ref.path));
  // Projection changes indices when malformed neighbors are removed. Recognize
  // admitted references in their original positions before comparing carriers.
  candidates.forEach(({ entry, index }) => {
    for (const ref of listMcpServerCatalogSavedSecretRefsV1({ v: 1, servers: [entry], bindings: [] })) {
      admittedPaths.add(ref.path.replace(/^servers\[0\]/u, `servers[${index}]`));
    }
  });
  parsedBindings.forEach(({ parsed, index }) => {
    if (authority === 'retained-source' && parsed.success) {
      for (const path of listSavedSecretReferenceCarrierPathsV1(parsed.data, { initialPath: `bindings[${index}]` })) admittedPaths.add(path);
    }
    if (parsed.success) for (const ref of listMcpServerCatalogSavedSecretRefsV1({ v: 1, servers: [], bindings: [parsed.data] })) {
      admittedPaths.add(ref.path.replace(/^bindings\[0\]/u, `bindings[${index}]`));
    }
  });
  // Tool names are arbitrary dictionary keys, not credential field names.
  // Only validated enum-valued override leaves get this classification;
  // unknown policy fields still go through the original carrier sweep.
  const toolPolicyPaths = new Set(candidates.flatMap(({ entry, index }) =>
    listSavedSecretReferenceCarrierPathsV1(entry.tools?.overrides, { initialPath: `servers[${index}].tools.overrides` })));
  if (pluginServers?.success) for (const [itemId, settings] of Object.entries(pluginServers.data)) {
    for (const path of listSavedSecretReferenceCarrierPathsV1(settings.tools?.overrides, {
      initialPath: `${appendSavedSecretReferencePathV1('pluginServers', itemId)}.tools.overrides`,
    })) toolPolicyPaths.add(path);
  }
  for (const path of listSavedSecretReferenceCarrierPathsV1(raw)) {
    if (toolPolicyPaths.has(path)) continue;
    if (authority === 'active' && /^bindings\[\d+\]\.overrides(?:\.|\[|$)/u.test(path)) continue;
    if (!admittedPaths.has(path)) diagnostics.push({ path, reason: 'unclassified-reference' });
  }
  return diagnostics.length ? { status: 'partial', catalog, diagnostics } : { status: 'opened', catalog };
}

export type McpServerCatalogMigrationSourceV1 = Readonly<{ content: StoredMcpServerCatalogContentV1; payload: JsonValue }>;
type McpServerCatalogOpenInputV1 = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown; admission?: 'migration';
}>;

export function openMcpServerCatalogContentV1(input: McpServerCatalogOpenInputV1 & Readonly<{ admission: 'migration' }>):
  Exclude<McpServerCatalogOpenResultV1, { status: 'opened' }> | Readonly<{
    status: 'opened'; catalog: McpServerCatalogV1; migrationSource: McpServerCatalogMigrationSourceV1;
  }>;
export function openMcpServerCatalogContentV1(input: McpServerCatalogOpenInputV1): McpServerCatalogOpenResultV1;
export function openMcpServerCatalogContentV1(input: McpServerCatalogOpenInputV1): McpServerCatalogOpenResultV1
  | Readonly<{ status: 'opened'; catalog: McpServerCatalogV1; migrationSource: McpServerCatalogMigrationSourceV1 }> {
  const content = StoredMcpServerCatalogContentV1Schema.safeParse(input.content);
  if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertMcpServerCatalogContentForModeV1(content.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let value: unknown;
  if (content.data.t === 'plain') value = content.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    value = openAccountScopedBlobCiphertext({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1,
      material: input.material, ciphertext: content.data.c })?.value;
  }
  const projection = projectStoredMcpServerCatalogV1(value);
  if (projection.status === 'unavailable') return projection;
  const envelopeDiagnostics = listMcpServerCatalogEnvelopeSavedSecretDiagnosticsV1(content.data);
  if (envelopeDiagnostics.length) return { status: 'partial', catalog: projection.catalog,
    diagnostics: [...(projection.status === 'partial' ? projection.diagnostics : []), ...envelopeDiagnostics] };
  if (input.admission !== 'migration' || projection.status !== 'opened') return projection;
  const payload = StrictJsonValueSchema.safeParse(value);
  return payload.success ? { ...projection, migrationSource: { content: content.data, payload: payload.data } }
    : { status: 'unavailable', reason: 'invalid-stored-content' };
}

/** Envelope metadata is retained, but recognizable references cannot acquire authority through it. */
export function listMcpServerCatalogEnvelopeSavedSecretDiagnosticsV1(content: StoredMcpServerCatalogContentV1): readonly McpServerCatalogDiagnosticV1[] {
  return listSavedSecretReferenceCarrierPathsV1(content, { initialPath: 'content' })
    .filter(path => content.t !== 'plain' || !(path === 'content.v' || path.startsWith('content.v.') || path.startsWith('content.v[')))
    .map(path => ({ path: path.slice('content.'.length), reason: 'unclassified-reference' as const }));
}

/** Conversion source and target use the same complete retained-envelope admission. */
export function parseMcpServerCatalogMigrationContentV1(value: unknown): StoredMcpServerCatalogContentV1 | null {
  const content = StoredMcpServerCatalogContentV1Schema.safeParse(value);
  if (!content.success || listMcpServerCatalogEnvelopeSavedSecretDiagnosticsV1(content.data).length) return null;
  try { assertMcpServerCatalogContentForModeV1(content.data, content.data.t === 'plain' ? 'plain' : 'e2ee'); }
  catch { return null; }
  return content.data.t === 'encrypted'
    || openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: content.data, admission: 'migration' }).status === 'opened'
    ? content.data : null;
}

/** Reseal complete original JSON only; the ordinary writer below remains strict. */
export function sealMcpServerCatalogMigrationContentV1(input: Readonly<{
  source: McpServerCatalogMigrationSourceV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): StoredMcpServerCatalogContentV1 {
  const source = parseMcpServerCatalogMigrationContentV1(input.source.content);
  const payload = StrictJsonValueSchema.parse(input.source.payload);
  if (!source || projectStoredMcpServerCatalogV1(payload).status !== 'opened'
    || source.t === 'plain' && !sameStrictJsonValue(source.v, payload)) throw new Error('invalid-stored-content');
  const metadata = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 't' && key !== (source.t === 'plain' ? 'v' : 'c')));
  if (Object.hasOwn(metadata, input.mode === 'plain' ? 'v' : 'c')) throw new Error('invalid-stored-content');
  let converted: unknown;
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    converted = { ...metadata, t: 'plain', v: payload };
  } else {
    if (!input.material) throw new Error('encryption-material-unavailable');
    converted = { ...metadata, t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1, material: input.material, payload,
      randomBytes: input.randomBytes ?? tweetnacl.randomBytes,
    }) };
  }
  const content = parseMcpServerCatalogMigrationContentV1(converted);
  if (!content) throw new Error('invalid-stored-content');
  return content;
}

export function sealMcpServerCatalogContentV1(input: Readonly<{
  catalog: McpServerCatalogV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null;
  randomBytes?: (length: number) => Uint8Array;
}>): McpServerCatalogContentV1 {
  const catalog = McpServerCatalogV1Schema.parse(input.catalog);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: catalog };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: MCP_SERVER_CATALOG_ACCOUNT_CIPHER_KIND_V1,
    material: input.material, payload: catalog, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}

export function listMcpServerCatalogSavedSecretRefsV1(catalog: McpServerCatalogV1): readonly Readonly<{ path: string; secretId: string }>[] {
  const refs: Array<{ path: string; secretId: string }> = [];
  const visitRef = (value: ValueRefV1, path: string) => {
    for (const ref of listValueRefSavedSecretRefsV1(value)) refs.push({
      path: ref.path ? `${path}.${ref.path}` : path, secretId: ref.secretId,
    });
  };
  const visit = (values: Readonly<Record<string, ValueRefV1 | null>> | undefined, path: string) => {
    for (const [key, value] of Object.entries(values ?? {})) if (value !== null) {
      visitRef(value, appendSavedSecretReferencePathV1(path, key));
    }
  };
  catalog.servers.forEach((entry, index) => {
    visit(entry.env, `servers[${index}].env`); visit(entry.remote?.headers, `servers[${index}].remote.headers`);
    if (entry.remote?.urlTemplate) visitRef(entry.remote.urlTemplate, `servers[${index}].remote.urlTemplate`);
    entry.configOverrides?.forEach((override, overrideIndex) => {
      visit(override.envPatch, `servers[${index}].configOverrides[${overrideIndex}].envPatch`);
      visit(override.remote?.headersPatch, `servers[${index}].configOverrides[${overrideIndex}].remote.headersPatch`);
    });
  });
  return refs;
}

export function remapMcpServerCatalogSavedSecretReferencesV1(catalog: McpServerCatalogV1, mapping: Readonly<Record<string, string>>): McpServerCatalogV1 {
  const rewrite = <T extends ValueRefV1 | null>(value: T): T | ValueRefV1 => value === null
    ? value : remapValueRefSavedSecretReferencesV1(value, mapping);
  const values = <T extends ValueRefV1 | null>(input: Readonly<Record<string, T>>): Record<string, T | ValueRefV1> =>
    Object.fromEntries(Object.entries(input).map(([key, value]) => [key, rewrite(value)]));
  return McpServerCatalogV1Schema.parse({ ...catalog,
    servers: catalog.servers.map(entry => ({ ...entry, env: values(entry.env),
      ...(entry.remote ? { remote: { ...entry.remote, headers: values(entry.remote.headers),
        ...(entry.remote.urlTemplate ? { urlTemplate: rewrite(entry.remote.urlTemplate) } : {}),
      } } : {}),
      ...(entry.configOverrides ? { configOverrides: entry.configOverrides.map(override => ({ ...override,
        ...(override.envPatch ? { envPatch: values(override.envPatch) } : {}),
        ...(override.remote ? { remote: { ...override.remote,
          ...(override.remote.headersPatch ? { headersPatch: values(override.remote.headersPatch) } : {}) } } : {}),
      })) } : {}),
    })),
  });
}
export function rewriteMcpServerCatalogSavedSecretRefsV1(catalog: McpServerCatalogV1, from: string, to: string): McpServerCatalogV1 {
  return remapMcpServerCatalogSavedSecretReferencesV1(catalog, { [from]: to });
}
