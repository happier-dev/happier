import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { projectStoredMcpServerCatalogV1, openMcpServerCatalogContentV1,
  type McpServerCatalogV1, type McpServerCatalogDiagnosticV1, type McpServerCatalogRowReadResponseV1,
  type McpServerCatalogRowMutationResponseV1, McpServerCatalogV1Schema, McpServerCatalogDiagnosticV1Schema } from './serverRowsV1.js';
import { McpServerCatalogEntryV1Schema, McpServerBindingV1Schema, type McpServersSettingsV1 } from './settingsV1.js';

export { listMcpServerCatalogSavedSecretRefsV1, rewriteMcpServerCatalogSavedSecretRefsV1,
  remapMcpServerCatalogSavedSecretReferencesV1 } from './serverRowsV1.js';

export const McpServerCatalogMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('server-create'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-update'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-upsert'), entry: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-duplicate'), serverId: z.string().min(1),
    entry: McpServerCatalogEntryV1Schema, bindings: z.array(McpServerBindingV1Schema).default([]) }).strict(),
  z.object({ kind: z.literal('server-remove'), serverId: z.string().min(1), removeBindings: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('binding-create'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-update'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-upsert'), binding: McpServerBindingV1Schema }).strict(),
  z.object({ kind: z.literal('binding-remove'), bindingId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('binding-enabled'), bindingId: z.string().min(1), enabled: z.boolean() }).strict(),
]));
export type McpServerCatalogMutationV1 = z.infer<typeof McpServerCatalogMutationV1Schema>;

/** Definitions and their bindings share one validation and one durable row CAS. */
export function applyMcpServerCatalogMutationV1(catalog: McpServerCatalogV1, rawChange: McpServerCatalogMutationV1): McpServerCatalogV1 {
  McpServerCatalogV1Schema.parse(catalog);
  const change = McpServerCatalogMutationV1Schema.parse(rawChange);
  if (change.kind === 'server-remove') {
    if (catalog.bindings.some(binding => binding.serverId === change.serverId) && !change.removeBindings) {
      throw new Error('Server is referenced by bindings; confirm removal of those bindings');
    }
    if (!catalog.servers.some(entry => entry.id === change.serverId)) return catalog;
    return { ...catalog, servers: catalog.servers.filter(entry => entry.id !== change.serverId),
      bindings: catalog.bindings.filter(binding => binding.serverId !== change.serverId) };
  }
  if (change.kind === 'binding-remove') {
    if (!catalog.bindings.some(binding => binding.id === change.bindingId)) return catalog;
    return { ...catalog, bindings: catalog.bindings.filter(binding => binding.id !== change.bindingId) };
  }
  if (change.kind === 'binding-enabled') {
    if (!catalog.bindings.some(binding => binding.id === change.bindingId)) throw new Error(`Binding not found: ${change.bindingId}`);
    return { ...catalog, bindings: catalog.bindings.map(binding => binding.id === change.bindingId ? { ...binding, enabled: change.enabled } : binding) };
  }
  if ('binding' in change) {
    const exists = catalog.bindings.some(binding => binding.id === change.binding.id);
    if (change.kind === 'binding-create' && exists) throw new Error(`Duplicate binding id: ${change.binding.id}`);
    if (change.kind === 'binding-update' && !exists) throw new Error(`Binding not found: ${change.binding.id}`);
    return McpServerCatalogV1Schema.parse({ ...catalog, bindings: exists
      ? catalog.bindings.map(binding => binding.id === change.binding.id ? change.binding : binding)
      : [...catalog.bindings, change.binding] });
  }
  const exists = catalog.servers.some(entry => entry.id === change.entry.id);
  if (change.kind === 'server-create' && exists) throw new Error(`Duplicate server id: ${change.entry.id}`);
  if (change.kind === 'server-update' && !exists) throw new Error(`Server not found: ${change.entry.id}`);
  if (change.kind === 'server-duplicate') {
    if (!catalog.servers.some(entry => entry.id === change.serverId)) throw new Error(`Server not found: ${change.serverId}`);
    if (exists || change.serverId === change.entry.id) throw new Error(`Duplicate server id: ${change.entry.id}`);
  }
  for (const binding of change.bindings) {
    if (binding.serverId !== change.entry.id) throw new Error(`Binding serverId mismatch: ${binding.serverId}`);
  }
  return McpServerCatalogV1Schema.parse({ ...catalog,
    servers: exists ? catalog.servers.map(entry => entry.id === change.entry.id ? change.entry : entry) : [...catalog.servers, change.entry],
    bindings: [...catalog.bindings.filter(binding => binding.serverId !== change.entry.id), ...change.bindings],
  });
}

export type McpServerCatalogUnavailableReasonV1 = 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch'
  | 'encryption-material-unavailable' | 'invalid-stored-content' | 'invalid-reference' | 'unauthorized' | 'forbidden'
  | 'unsupported' | 'unreachable' | 'scope-retired' | 'cancelled' | 'source-version-conflict' | 'authority-not-confirmed';
export type McpServerCatalogSourceCleanupV1 = Readonly<{ status: 'complete' }> | Readonly<{
  status: 'cleanup-pending'; reason: 'source-unavailable' | 'source-conflict' | 'history-incomplete' | 'cancelled';
}>;
type OpenedCatalog = Readonly<{ catalog: McpServerCatalogV1; revision: number | 'absent'; authority: 'active' | 'inactive';
  diagnostics: readonly McpServerCatalogDiagnosticV1[]; cleanup?: McpServerCatalogSourceCleanupV1 }>;
export type McpServerCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: McpServerCatalogUnavailableReasonV1 }>
  | (OpenedCatalog & Readonly<{ status: 'ready' }>) | (OpenedCatalog & Readonly<{ status: 'partial' }>);
/** The same readiness contract crosses UI, CLI and typed Actions. */
export const McpServerCatalogSnapshotV1Schema = lazyZodSchema(() => {
  const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const opened = z.object({ catalog: McpServerCatalogV1Schema, revision: z.union([revision, z.literal('absent')]),
    authority: z.enum(['active', 'inactive']), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema),
    cleanup: z.discriminatedUnion('status', [
      z.object({ status: z.literal('complete') }).strict(),
      z.object({ status: z.literal('cleanup-pending'),
        reason: z.enum(['source-unavailable', 'source-conflict', 'history-incomplete', 'cancelled']) }).strict(),
    ]).optional(),
  }).strict();
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('loading') }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum([
      'account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'encryption-material-unavailable',
      'invalid-stored-content', 'invalid-reference', 'unauthorized', 'forbidden', 'unsupported', 'unreachable',
      'scope-retired', 'cancelled', 'source-version-conflict', 'authority-not-confirmed',
    ]) }).strict(),
    opened.extend({ status: z.literal('ready') }).strict(),
    opened.extend({ status: z.literal('partial') }).strict(),
  ]);
});
export type McpServerCatalogSourceTransferV1 = Readonly<{
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  initializeCatalog(input: Readonly<{ catalog: McpServerCatalogV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>):
    Promise<McpServerCatalogRowMutationResponseV1>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[] }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
type LoadInput = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  readRow(): Promise<McpServerCatalogRowReadResponseV1>;
  transfer?: McpServerCatalogSourceTransferV1;
  onReadyBeforeCleanup?: (catalog: Extract<McpServerCatalogSnapshotV1, { catalog: unknown }>) => Promise<void>;
  hasPendingCleanup?: () => boolean;
}>;
export function emptyMcpServerCatalogV1(): McpServerCatalogV1 { return { v: 1, servers: [], bindings: [] }; }

function retainedSource(raw: Readonly<Record<string, unknown>>) {
  const root = raw.mcpServersSettingsV1;
  if (root === undefined) return { status: 'opened' as const, catalog: emptyMcpServerCatalogV1(), strictMode: false };
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  const record = root as Record<string, unknown>;
  if (record.strictMode !== undefined && typeof record.strictMode !== 'boolean') return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
  const opened = projectStoredMcpServerCatalogV1({ ...record, v: record.v ?? 1, servers: record.servers ?? [], bindings: record.bindings ?? [] });
  return opened.status === 'opened' ? { ...opened, strictMode: record.strictMode === true } : opened;
}

async function readDestination(input: LoadInput): Promise<McpServerCatalogSnapshotV1 | Readonly<{ status: 'absent' }>> {
  if (input.mode === 'e2ee' && !input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  let row: McpServerCatalogRowReadResponseV1;
  try { row = await input.readRow(); }
  catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
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
    if (input.hasPendingCleanup?.()) return catalog;
  }
  let source: Awaited<ReturnType<McpServerCatalogSourceTransferV1['readSourceSnapshot']>>;
  try { source = await transfer.readSourceSnapshot(); }
  catch {
    return catalog.status === 'ready' ? { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } }
      : { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (catalog.status === 'absent') {
    let retained = retainedSource(source.raw);
    if (retained.status === 'unavailable') return retained;
    if (retained.status === 'partial') return { ...retained, status: 'partial', revision: 'absent', authority: 'inactive' };
    if (source.raw.mcpServersStrictMode !== undefined && typeof source.raw.mcpServersStrictMode !== 'boolean') {
      return { status: 'unavailable', reason: 'invalid-stored-content' };
    }
    if (Object.hasOwn(source.raw, 'mcpServersSettingsV1') && source.raw.mcpServersStrictMode === undefined) {
      if (!transfer.replaceSource) return { status: 'ready', catalog: retained.catalog, authority: 'inactive', revision: 'absent', diagnostics: [] };
      let result: Awaited<ReturnType<NonNullable<McpServerCatalogSourceTransferV1['replaceSource']>>>;
      try { result = await transfer.replaceSource({ raw: { ...source.raw, mcpServersStrictMode: retained.strictMode }, expectedVersion: source.version }); }
      catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
      if (result.status !== 'applied') return { status: 'unavailable', reason: result.status === 'conflict' ? 'source-version-conflict' : 'authority-not-confirmed' };
      try { source = await transfer.readSourceSnapshot(); }
      catch { return { status: 'unavailable', reason: 'unreachable' }; }
      retained = retainedSource(source.raw);
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
    if (input.hasPendingCleanup?.()) return catalog;
  }
  if (!transfer.replaceSource) return catalog;
  if (Object.hasOwn(source.raw, 'mcpServersSettingsV1') && retainedSource(source.raw).status !== 'opened') {
    return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
  }
  const raw = { ...source.raw };
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
  return { status: 'ready', settings: { ...snapshot.catalog, strictMode: input.strictMode } };
}
