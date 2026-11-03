import { McpServerCatalogMutationV1Schema, unavailableReasonSchema } from "./catalogSchemasV1.js";
import type { McpServerCatalogMutationV1, McpServerCatalogSnapshotV1, McpServerCatalogUnavailableReasonV1,
  McpServerCatalogScopeV1, McpServerCatalogMutationResponseV1 } from "./catalogSchemasV1.js";
export { McpServerCatalogMutationV1Schema, McpServerCatalogSnapshotV1Schema } from "./catalogSchemasV1.js";
export type { McpServerCatalogMutationV1, McpServerCatalogSnapshotV1, McpServerCatalogUnavailableReasonV1, McpServerCatalogSourceCleanupV1,
  McpServerCatalogScopeV1, McpServerCatalogMutationResponseV1 } from "./catalogSchemasV1.js";
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { projectStoredMcpServerCatalogV1, openMcpServerCatalogContentV1, type McpServerCatalogV1, type McpServerCatalogRowReadResponseV1, type McpServerCatalogRowMutationResponseV1, McpServerCatalogV1Schema } from './serverRowsV1.js';
import { isMcpPluginItemIdV1, McpServerCatalogEntryV1Schema, type McpServersSettingsV1 } from './settingsV1.js';
import { applyReachRulesChangeV1, resolveCreateReachV1, type ReachRulesWriteContextV1 } from '../../reach/reachRulesChangeV1.js';
export type McpServerCatalogWriteContextV1 = ReachRulesWriteContextV1 & Readonly<{ pluginItemIds?: readonly string[] }>;

export { listMcpServerCatalogSavedSecretRefsV1, rewriteMcpServerCatalogSavedSecretRefsV1,
  remapMcpServerCatalogSavedSecretReferencesV1 } from './serverRowsV1.js';


/** Catalog-authored imports and copies share one collision-free name vocabulary. */
export function uniqueMcpServerNameV1(baseName: string, servers: readonly Readonly<{ name: string }>[]): string {
  const names = new Set(servers.map(server => server.name));
  let name = baseName;
  for (let index = 2; names.has(name) || !McpServerCatalogEntryV1Schema.shape.name.safeParse(name).success; index += 1) name = `${baseName}_${index}`;
  return name;
}


/** Definitions and their bindings share one validation and one durable row CAS. */
export function applyMcpServerCatalogMutationV1(catalog: McpServerCatalogV1, rawChange: McpServerCatalogMutationV1,
  ctx?: McpServerCatalogWriteContextV1): McpServerCatalogV1 {
  McpServerCatalogV1Schema.parse(catalog);
  const change = McpServerCatalogMutationV1Schema.parse(rawChange);
  const admittedPluginItem = (id: string) => isMcpPluginItemIdV1(id) && ctx?.pluginItemIds?.includes(id) === true;
  if (change.kind === 'plugin-defaults') {
    if (!ctx) throw new Error('Plugin defaults require the catalog write context');
    const rules = [...new Set(change.serverIds)].flatMap(serverId => {
      if (!admittedPluginItem(serverId)) throw new Error(`Plugin server not found: ${serverId}`);
      if (catalog.bindings.some(rule => rule.serverId === serverId)) return [];
      const created = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'rpc' },
        ctx: { nowMs: ctx.nowMs, newId: () => `plugin-default:${serverId.slice('plugin:'.length)}` } });
      if (!created.ok) throw new Error(created.code);
      return created.rules.map(rule => ({ ...rule, serverId }));
    });
    return rules.length ? McpServerCatalogV1Schema.parse({ ...catalog, bindings: [...catalog.bindings, ...rules] }) : catalog;
  }
  if (change.kind === 'server-create-batch') {
    for (const { entry, rules } of change.entries) {
      if (entry.id.startsWith('plugin:')) throw new Error('Plugin MCP item ids are reserved');
      for (const binding of rules) {
        if (binding.serverId !== entry.id) throw new Error(`Binding serverId mismatch: ${binding.serverId}`);
      }
    }
    return McpServerCatalogV1Schema.parse({ ...catalog,
      servers: [...catalog.servers, ...change.entries.map(item => item.entry)],
      bindings: [...catalog.bindings, ...change.entries.flatMap(item => item.rules)],
    });
  }
  if (change.kind === 'server-remove') {
    if (catalog.bindings.some(binding => binding.serverId === change.serverId) && !change.removeBindings) {
      throw new Error('Server is referenced by bindings; confirm removal of those bindings');
    }
    if (!catalog.servers.some(entry => entry.id === change.serverId)) return catalog;
    return { ...catalog, servers: catalog.servers.filter(entry => entry.id !== change.serverId),
      bindings: catalog.bindings.filter(binding => binding.serverId !== change.serverId) };
  }
  if (change.kind === 'rules-change') {
    if (!ctx) throw new Error('Rules changes require the catalog write context');
    const serverIds = [...new Set(change.serverIds)];
    if (change.change.kind === 'replace' && serverIds.length !== 1) throw new Error('replace_needs_one_item');
    const ids = new Set(serverIds);
    const next = serverIds.flatMap(serverId => {
      if (!catalog.servers.some(server => server.id === serverId) && !admittedPluginItem(serverId)) throw new Error(`Server not found: ${serverId}`);
      return applyReachRulesChangeV1(catalog.bindings.filter(rule => rule.serverId === serverId), change.change, ctx).map(rule => ({ ...rule, serverId }));
    });
    return McpServerCatalogV1Schema.parse({ ...catalog, bindings: [...catalog.bindings.filter(rule => !ids.has(rule.serverId)), ...next] });
  }
  if (change.kind === 'tools-snapshot') {
    const server = catalog.servers.find(entry => entry.id === change.serverId && !isMcpPluginItemIdV1(entry.id));
    if (!server && !admittedPluginItem(change.serverId)) throw new Error(`Server not found: ${change.serverId}`);
    if (server) return applyMcpServerCatalogMutationV1(catalog, { kind: 'server-update', entry: { ...server, toolsSnapshot: change.snapshot } }, ctx);
    return McpServerCatalogV1Schema.parse({ ...catalog, pluginServers: { ...catalog.pluginServers,
      [change.serverId]: { ...catalog.pluginServers?.[change.serverId], toolsSnapshot: change.snapshot },
    } });
  }
  if (change.kind === 'tools-change') {
    const server = catalog.servers.find(entry => entry.id === change.serverId && !entry.id.startsWith('plugin:'));
    if (!server && !admittedPluginItem(change.serverId)) throw new Error(`Server not found: ${change.serverId}`);
    const settings = server ?? catalog.pluginServers?.[change.serverId];
    const overrides = new Map(Object.entries(settings?.tools?.overrides ?? {}));
    for (const [name, setting] of Object.entries(change.settings.tools ?? {})) {
      if (setting === 'inherit') overrides.delete(name);
      else overrides.set(name, setting);
    }
    const tools = { default: change.settings.default ?? settings?.tools?.default ?? 'ask', overrides: Object.fromEntries(overrides) };
    if (!server) return McpServerCatalogV1Schema.parse({ ...catalog,
      pluginServers: { ...catalog.pluginServers, [change.serverId]: { ...settings, tools } } });
    return McpServerCatalogV1Schema.parse({ ...catalog,
      servers: catalog.servers.map(entry => entry.id === server.id ? { ...entry, tools,
        updatedAt: Math.max(ctx?.nowMs ?? entry.updatedAt + 1, entry.updatedAt + 1) } : entry),
    });
  }
  const exists = catalog.servers.some(entry => entry.id === change.entry.id);
  if ((change.kind === 'server-create' || change.kind === 'server-duplicate') && change.entry.id.startsWith('plugin:')) {
    throw new Error('Plugin MCP item ids are reserved');
  }
  if (change.kind === 'server-create' && exists) throw new Error(`Duplicate server id: ${change.entry.id}`);
  if ((change.kind === 'server-update' || change.kind === 'server-upsert') && !exists) throw new Error(`Server not found: ${change.entry.id}`);
  if (change.kind === 'server-duplicate') {
    if (!catalog.servers.some(entry => entry.id === change.serverId)) throw new Error(`Server not found: ${change.serverId}`);
    if (exists || change.serverId === change.entry.id) throw new Error(`Duplicate server id: ${change.entry.id}`);
  }
  const rules = 'rules' in change ? change.rules : [];
  for (const binding of rules) {
    if (binding.serverId !== change.entry.id) throw new Error(`Binding serverId mismatch: ${binding.serverId}`);
  }
  return McpServerCatalogV1Schema.parse({ ...catalog,
    servers: exists ? catalog.servers.map(entry => entry.id === change.entry.id ? { ...change.entry,
      updatedAt: Math.max(change.entry.updatedAt, ctx?.nowMs ?? 0, entry.updatedAt + 1) } : entry) : [...catalog.servers, change.entry],
    bindings: [...catalog.bindings, ...rules],
  });
}

/** Capture, comparison and acknowledgement all belong to the same row mutation. */
export async function commitMcpServerCatalogMutationV1(input: Readonly<{
  catalog: McpServerCatalogV1; revision: number; change: McpServerCatalogMutationV1; scope: McpServerCatalogScopeV1 | null;
  ctx?: McpServerCatalogWriteContextV1;
  writeCatalog(value: Readonly<{ catalog: McpServerCatalogV1; expectedRevision: number }>): Promise<McpServerCatalogRowMutationResponseV1>;
}>): Promise<McpServerCatalogMutationResponseV1> {
  let catalog: McpServerCatalogV1;
  let change: McpServerCatalogMutationV1;
  try {
    change = McpServerCatalogMutationV1Schema.parse(input.change);
    catalog = applyMcpServerCatalogMutationV1(input.catalog, change, input.ctx);
  } catch (error) {
    throw Object.assign(new Error('MCP catalog mutation is invalid'), { code: 'invalid-mutation', cause: error });
  }
  const rulesFor = (value: McpServerCatalogV1, serverId: string) => value.bindings.filter(rule => rule.serverId === serverId).map(({ serverId: _serverId, ...rule }) => rule);
  const items = change.kind === 'rules-change' ? [...new Set(change.serverIds)].map(serverId => ({ serverId,
    rules: rulesFor(catalog, serverId), previous: rulesFor(input.catalog, serverId) })) : undefined;
  const result = await input.writeCatalog({ catalog, expectedRevision: input.revision });
  return result.status === 'updated' && items ? { ...result, items } : result;
}

/** The same readiness contract crosses UI, CLI and typed Actions. */
export type McpServerCatalogSourceTransferV1 = Readonly<{
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  initializeCatalog(input: Readonly<{ catalog: McpServerCatalogV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>):
    Promise<McpServerCatalogRowMutationResponseV1>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'invalid'; reason: 'invalidPreparedMutation' }>>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[] }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
type LoadInput = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  readRow(): Promise<McpServerCatalogRowReadResponseV1>;
  transfer?: McpServerCatalogSourceTransferV1;
  onReadyBeforeCleanup?: (catalog: Extract<McpServerCatalogSnapshotV1, { catalog: unknown }>) => Promise<void>;
  hasPendingCleanup?: () => boolean;
  /** Finite reads activate absent destinations but leave retained-source maintenance to hydration. */
  maintainSource?: false;
}>;
export function emptyMcpServerCatalogV1(): McpServerCatalogV1 { return { v: 1, servers: [], bindings: [] }; }

export function readRetainedMcpServerCatalogSourceV1(raw: Readonly<Record<string, unknown>>) {
  const root = raw.mcpServersSettingsV1;
  if (root === undefined) return { status: 'opened' as const, catalog: emptyMcpServerCatalogV1(), strictMode: false };
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  const record = root as Record<string, unknown>;
  if (record.v !== 1) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  if (record.strictMode !== undefined && typeof record.strictMode !== 'boolean') return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  const opened = projectStoredMcpServerCatalogV1({ ...record,
    servers: record.servers === undefined ? [] : record.servers,
    bindings: record.bindings === undefined ? [] : record.bindings }, 'retained-source');
  return opened.status === 'opened' ? { ...opened, strictMode: record.strictMode === true } : opened;
}

/** Retain the source root until destination proof; policy belongs to this same document. */
export function extractRetainedMcpServerCatalogPolicyV1(raw: Readonly<Record<string, unknown>>):
  Readonly<{ status: 'ready'; raw: Readonly<Record<string, unknown>> }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }> {
  if (raw.mcpServersStrictMode !== undefined && typeof raw.mcpServersStrictMode !== 'boolean') {
    return { status: 'unavailable', reason: 'invalid-stored-content' };
  }
  if (!Object.hasOwn(raw, 'mcpServersSettingsV1')) return { status: 'ready', raw };
  const source = readRetainedMcpServerCatalogSourceV1(raw);
  if (source.status !== 'opened') return { status: 'unavailable', reason: 'invalid-stored-content' };
  return { status: 'ready', raw: raw.mcpServersStrictMode === undefined
    ? { ...raw, mcpServersStrictMode: source.strictMode } : raw };
}

function transportFailureReason(error: unknown, signal?: AbortSignal): McpServerCatalogUnavailableReasonV1 {
  if (signal?.aborted) return 'cancelled';
  const reason = error !== null && typeof error === 'object' && 'code' in error
    ? unavailableReasonSchema.safeParse(error.code) : undefined;
  return reason?.success ? reason.data : 'unreachable';
}

async function readDestination(input: LoadInput): Promise<McpServerCatalogSnapshotV1 | Readonly<{ status: 'absent' }>> {
  if (input.mode === 'e2ee' && !input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  let row: McpServerCatalogRowReadResponseV1;
  try { row = await input.readRow(); }
  catch (error) { return { status: 'unavailable', reason: transportFailureReason(error, input.signal) }; }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (row.status === 'absent') return row;
  if (row.status === 'deleted') return { status: 'ready', catalog: emptyMcpServerCatalogV1(), revision: row.revision, authority: 'active', diagnostics: [] };
  if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
  const opened = openMcpServerCatalogContentV1({ ...input, content: row.content });
  if (opened.status === 'unavailable') return opened;
  return { status: opened.status === 'opened' ? 'ready' : 'partial', catalog: opened.catalog,
    revision: row.revision, authority: 'active', diagnostics: opened.status === 'partial' ? opened.diagnostics : [] };
}

/** Sole-row presence/deletion is authority; legacy source is only consulted while absent. */
export async function loadMcpServerCatalogV1(input: LoadInput): Promise<McpServerCatalogSnapshotV1> {
  let catalog = await readDestination(input);
  if (catalog.status === 'loading' || catalog.status === 'unavailable' || catalog.status === 'partial') return catalog;
  const transfer = input.transfer;
  if (catalog.status === 'ready' && (!transfer || catalog.authority !== 'active')) return catalog;
  if (catalog.status === 'absent' && !transfer) return { status: 'unavailable', reason: 'authority-not-confirmed' };
  if (!transfer) return { status: 'unavailable', reason: 'authority-not-confirmed' };
  if (catalog.status === 'ready') {
    await input.onReadyBeforeCleanup?.(catalog);
    if (input.maintainSource === false || input.hasPendingCleanup?.()) return catalog;
  }
  let source: Awaited<ReturnType<McpServerCatalogSourceTransferV1['readSourceSnapshot']>>;
  try { source = await transfer.readSourceSnapshot(); }
  catch {
    return catalog.status === 'ready' ? { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } }
      : { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (catalog.status === 'absent') {
    let retained = readRetainedMcpServerCatalogSourceV1(source.raw);
    if (retained.status === 'unavailable') return retained;
    if (retained.status === 'partial') return { ...retained, status: 'partial', revision: 'absent', authority: 'inactive' };
    const policy = extractRetainedMcpServerCatalogPolicyV1(source.raw);
    if (policy.status === 'unavailable') return policy;
    if (Object.hasOwn(source.raw, 'mcpServersSettingsV1') && source.raw.mcpServersStrictMode === undefined) {
      if (!transfer.replaceSource) return { status: 'ready', catalog: retained.catalog, authority: 'inactive', revision: 'absent', diagnostics: [] };
      let result: Awaited<ReturnType<NonNullable<McpServerCatalogSourceTransferV1['replaceSource']>>>;
      try { result = await transfer.replaceSource({ raw: policy.raw, expectedVersion: source.version }); }
      catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
      if (result.status !== 'applied') return { status: 'unavailable', reason: result.status === 'conflict' ? 'source-version-conflict' : 'authority-not-confirmed' };
      try { source = await transfer.readSourceSnapshot(); }
      catch { return { status: 'unavailable', reason: 'unreachable' }; }
      retained = readRetainedMcpServerCatalogSourceV1(source.raw);
      if (retained.status === 'unavailable') return retained;
      if (retained.status === 'partial') return { ...retained, status: 'partial', revision: 'absent', authority: 'inactive' };
      if (typeof source.raw.mcpServersStrictMode !== 'boolean') return { status: 'unavailable', reason: 'source-version-conflict' };
    }
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    let receipt: McpServerCatalogRowMutationResponseV1 | undefined;
    try { receipt = await transfer.initializeCatalog({ catalog: retained.catalog, expectedRevision: 'absent', sourceSettingsVersion: source.version }); }
    catch { /* A lost receipt needs actual authority readback, not another initialization. */ }
    catalog = await readDestination(input);
    if (catalog.status === 'absent') return { status: 'unavailable', reason: receipt?.status === 'settings-conflict' ? 'source-version-conflict' : 'authority-not-confirmed' };
    if (catalog.status !== 'ready') return catalog;
    await input.onReadyBeforeCleanup?.(catalog);
    if (input.maintainSource === false || input.hasPendingCleanup?.()) return catalog;
  }
  if (!transfer.replaceSource) return catalog;
  const policy = extractRetainedMcpServerCatalogPolicyV1(source.raw);
  if (policy.status === 'unavailable') {
    return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
  }
  const raw = { ...policy.raw };
  delete raw.mcpServersSettingsV1;
  if (input.signal?.aborted) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'cancelled' } };
  if (Object.hasOwn(source.raw, 'mcpServersSettingsV1')) {
    try {
      const result = await transfer.replaceSource({ raw, expectedVersion: source.version });
      if (result.status !== 'applied') return { ...catalog, cleanup: { status: 'cleanup-pending', reason: result.status === 'conflict' ? 'source-conflict' : 'source-unavailable' } };
    } catch { return { ...catalog, cleanup: { status: 'cleanup-pending', reason: input.signal?.aborted ? 'cancelled' : 'source-unavailable' } }; }
  }
  // This runs after source cleanup so its newly-created previous snapshot is
  // sanitized too. The shared history owner rechecks typed destination proof.
  if (!transfer.normalizeHistory) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } };
  try {
    const result = await transfer.normalizeHistory({ activeTransferredRoots: ['mcpServersSettingsV1'] });
    return { ...catalog, cleanup: result.status === 'complete' ? { status: 'complete' }
      : { status: 'cleanup-pending', reason: 'history-incomplete' } };
  } catch { return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } }; }
}

/** Runtime policy stays in the incumbent MCP decision owner, separate from entities. */
export function readMcpServersFromCatalogSnapshotV1(input: Readonly<{ snapshot: McpServerCatalogSnapshotV1; strictMode: boolean }>):
  Readonly<{ status: 'ready'; settings: McpServersSettingsV1 }> | Readonly<{ status: 'unavailable'; reason: McpServerCatalogUnavailableReasonV1 | 'loading' }> {
  const snapshot = input.snapshot;
  if (snapshot.status === 'loading') return { status: 'unavailable', reason: 'loading' };
  if (snapshot.status === 'unavailable') return snapshot;
  if (snapshot.status === 'partial') return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (snapshot.authority !== 'active') return { status: 'unavailable', reason: 'authority-not-confirmed' };
  return { status: 'ready', settings: { ...snapshot.catalog, strictMode: input.strictMode } };
}
