import { z } from 'zod/mini';
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import type { AccountSettingsHistoryLegacyRoleArtifactTransferV1 } from '../../account/settings/accountSettingsApiV2.js';
import { LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1 } from '../../account/settings/rolesV1Migration.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PromptStackEntryV1StoredSchema, PromptLibraryStackUpdateInputV1Schema, PromptLibraryStackUpdateResultV1Schema, applyPromptStackIntentV1, type PromptStackEntryV1 } from './promptStacksV1.js';
import type { ArtifactFolderActionPortV1 } from './promptFolderActionsV1.js';
import type { RegistrySourcesMutationV1, RegistrySourcesMutationResultV1 } from '../../registries/registrySourcesMutationV1.js';
import { readStackSkillIdsV1, convertStackSkillEntriesV1, migrateStackSkillRulesV1, unconsumedStackSkillEntriesV1 } from './skills/convertStackSkillEntriesV1.js';
import { isPromptStackSystemAppendPlacementV1 } from './promptPlacementV1.js';
import { PromptLibraryCatalogKeyV1Schema, StoredPromptLibraryRecordV1Schema, openPromptLibraryContentV1,
  type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1, type PromptLibraryRowsListResponseV1Schema,
  type PromptLibraryRowMutationResponseV1Schema } from './promptLibraryRowsV1.js';

export type PromptLibraryCatalogUnavailableReasonV1 = 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch'
  | 'encryption-material-unavailable' | 'invalid-stored-content' | 'unauthorized' | 'forbidden' | 'unsupported'
  | 'unreachable' | 'database_transaction_conflict_exhausted' | 'scope-retired' | 'cancelled' | 'source-version-conflict' | 'authority-not-confirmed';
export type PromptLibraryCatalogRowV1 = Readonly<{ record: PromptLibraryRecordV1; revision: number }>;
export type PromptLibraryCatalogDiagnosticV1 = Readonly<{ key: PromptLibraryCatalogKeyV1; revision: number | 'absent';
  reason: 'invalid-stored-content' | 'unreachable' | 'cancelled' | 'source-version-conflict' | 'authority-not-confirmed' }>;
export type PromptLibrarySourceCleanupV1 = Readonly<{ status: 'complete' }> | Readonly<{
  status: 'cleanup-pending'; reason: 'source-unavailable' | 'source-conflict' | 'history-incomplete' | 'artifacts-unavailable' | 'cancelled';
}>;
export type PromptLibraryCatalogSnapshotV1 =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: PromptLibraryCatalogUnavailableReasonV1 }>
  | Readonly<{ status: 'ready' | 'partial'; rows: readonly PromptLibraryCatalogRowV1[];
      tombstones: readonly Readonly<{ key: PromptLibraryCatalogKeyV1; revision: number }>[];
      diagnostics: readonly PromptLibraryCatalogDiagnosticV1[]; cleanup?: PromptLibrarySourceCleanupV1 }>;

export type PromptLibrarySourceTransferV1 = Readonly<{
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  initializeRecord(input: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>):
    Promise<ReturnType<typeof PromptLibraryRowMutationResponseV1Schema.parse>>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'invalid'; reason: 'invalidPreparedMutation' }>>;
  /** The existing Role owner retains documents; this catalog never translates guidance. */
  retainLegacyRoleArtifacts?(raw: Readonly<Record<string, unknown>>): Promise<readonly AccountSettingsHistoryLegacyRoleArtifactTransferV1[]>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[];
    legacyRoleArtifactTransfers?: readonly AccountSettingsHistoryLegacyRoleArtifactTransferV1[] }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;

type PromptLibraryLoadInputV1 = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  readRows(): Promise<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>>;
  transfer?: PromptLibrarySourceTransferV1;
  nowMs?: () => number;
  skillMigration?: Readonly<{
    readArtifact: Parameters<typeof readStackSkillIdsV1>[1]['readArtifact'];
    writeRecord(input: Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number }>):
      Promise<ReturnType<typeof PromptLibraryRowMutationResponseV1Schema.parse>>;
  }>;
  /** Readable destination authority precedes optional source/history maintenance. */
  onReadyBeforeCleanup?: (catalog: Extract<PromptLibraryCatalogSnapshotV1, { rows: unknown }>) => Promise<void>;
  /** An incumbent captured-lifetime cleanup may already own this maintenance. */
  hasPendingCleanup?: () => boolean;
  /** Finite reads still activate/migrate destinations, but leave retained-source cleanup to hydration. */
  maintainSource?: false;
}>;

async function readCatalog(input: PromptLibraryLoadInputV1): Promise<PromptLibraryCatalogSnapshotV1> {
  if (input.mode === 'e2ee' && !input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const response = await input.readRows();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (response.status !== 'listed') return { status: 'unavailable', reason: response.status };
  const rows: PromptLibraryCatalogRowV1[] = [];
  const tombstones: Array<{ key: PromptLibraryCatalogKeyV1; revision: number }> = [];
  const diagnostics: PromptLibraryCatalogDiagnosticV1[] = [];
  const seen = new Set<PromptLibraryCatalogKeyV1>();
  for (const row of response.rows) {
    if (seen.has(row.key)) return { status: 'unavailable', reason: 'invalid-stored-content' };
    seen.add(row.key);
    if (row.content === null) { tombstones.push({ key: row.key, revision: row.revision }); continue; }
    const opened = openPromptLibraryContentV1({ ...input, key: row.key, content: row.content });
    if (opened.status === 'opened') rows.push({ record: opened.record, revision: row.revision });
    else if (opened.reason === 'invalid-stored-content') diagnostics.push({ key: row.key, revision: row.revision, reason: opened.reason });
    else return opened;
  }
  return { status: diagnostics.length ? 'partial' : 'ready', rows, tombstones, diagnostics };
}

/** Fixed small domains activate in their sole-row CAS; presence or deletion can never reseed. */
export async function loadPromptLibraryCatalogV1(input: PromptLibraryLoadInputV1): Promise<PromptLibraryCatalogSnapshotV1> {
  let catalog = await readCatalog(input);
  if (catalog.status !== 'ready' && catalog.status !== 'partial') return catalog;
  if (!input.transfer) return migrateStackSkills(input, catalog);
  const transfer = input.transfer;
  const occupied = new Set([...catalog.rows.map(row => row.record.key), ...catalog.tombstones.map(row => row.key),
    ...catalog.diagnostics.map(row => row.key)]);
  const missing = PromptLibraryCatalogKeyV1Schema.options.filter(key => !occupied.has(key));
  if (missing.length === 0) {
    catalog = await migrateStackSkills(input, catalog);
    if (catalog.status !== 'ready' && catalog.status !== 'partial') return catalog;
    if (input.maintainSource === false) {
      await input.onReadyBeforeCleanup?.(catalog);
      return catalog;
    }
  }
  // Complete destination authority needs no retained source to be readable.
  // Publish it before optional Settings/history maintenance can block a demand.
  const publishedBeforeSource = missing.length === 0 && input.onReadyBeforeCleanup !== undefined;
  if (publishedBeforeSource) {
    await input.onReadyBeforeCleanup!(catalog);
    if (input.hasPendingCleanup?.()) return catalog;
  }
  let source: Awaited<ReturnType<PromptLibrarySourceTransferV1['readSourceSnapshot']>>;
  try { source = await transfer.readSourceSnapshot(); }
  catch {
    return { ...catalog, status: missing.length || catalog.status === 'partial' ? 'partial' : 'ready',
      diagnostics: [...catalog.diagnostics, ...missing.map(key => ({ key, revision: 'absent' as const,
        reason: input.signal?.aborted ? 'cancelled' as const : 'unreachable' as const }))],
      cleanup: { status: 'cleanup-pending', reason: input.signal?.aborted ? 'cancelled' : 'source-unavailable' } };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const malformed: PromptLibraryCatalogDiagnosticV1[] = [];
  const attempted: PromptLibraryCatalogKeyV1[] = [];
  const failures = new Map<PromptLibraryCatalogKeyV1, PromptLibraryCatalogDiagnosticV1['reason']>();
  for (const key of missing) {
    const retained = readRetainedPromptLibraryRecordV1(source.raw, key);
    if (retained.status !== 'ready') { malformed.push({ key, revision: 'absent', reason: retained.reason }); continue; }
    attempted.push(key);
    let receipt: Awaited<ReturnType<PromptLibrarySourceTransferV1['initializeRecord']>>;
    try { receipt = await transfer.initializeRecord({ record: retained.record, expectedRevision: 'absent', sourceSettingsVersion: source.version }); }
    catch {
      failures.set(key, input.signal?.aborted ? 'cancelled' : 'unreachable');
      continue;
    }
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (receipt.status === 'settings-conflict') failures.set(key, 'source-version-conflict');
  }
  if (attempted.length) {
    // A receipt is not readable authority. Admit the actual resulting census, including concurrent winners.
    catalog = await readCatalog(input);
    if (catalog.status !== 'ready' && catalog.status !== 'partial') return catalog;
    const confirmed = new Set([...catalog.rows.map(row => row.record.key), ...catalog.tombstones.map(row => row.key),
      ...catalog.diagnostics.map(row => row.key)]);
    const unconfirmed = attempted.filter(key => !confirmed.has(key));
    if (unconfirmed.length) catalog = { ...catalog, status: 'partial', diagnostics: [...catalog.diagnostics,
      ...unconfirmed.map(key => ({ key, revision: 'absent' as const,
        reason: failures.get(key) ?? 'authority-not-confirmed' as const }))] };
  }
  if (malformed.length) catalog = { ...catalog, status: 'partial', diagnostics: [...catalog.diagnostics, ...malformed] };
  if (missing.length) catalog = await migrateStackSkills(input, catalog);
  if (catalog.status !== 'ready' && catalog.status !== 'partial') return catalog;
  if (input.maintainSource === false) {
    await input.onReadyBeforeCleanup?.(catalog);
    return catalog;
  }
  if (!transfer.replaceSource) return catalog;
  if (!publishedBeforeSource) await input.onReadyBeforeCleanup?.(catalog);
  if (input.hasPendingCleanup?.()) return catalog;
  return { ...catalog, cleanup: await cleanupSource(input, catalog, source) };
}

/** Account adds rules while its kept rows retain entry identities; Voice has no destination. */
async function migrateStackSkills(input: PromptLibraryLoadInputV1,
  initial: Extract<PromptLibraryCatalogSnapshotV1, { rows: unknown }>): Promise<PromptLibraryCatalogSnapshotV1> {
  const migration = input.skillMigration;
  if (!migration) return initial;
  let catalog: PromptLibraryCatalogSnapshotV1 = initial;
  let codingMigrationDiagnostic: PromptLibraryCatalogDiagnosticV1 | undefined;
  const source = initial.rows.find(row => row.record.key === 'coding');
  if (source?.record.key === 'coding' && source.record.value.entries.some(entry =>
    entry.ref.kind === 'bundle' && isPromptStackSystemAppendPlacementV1(entry.placement))) {
    const destination = readPromptLibraryCatalogRecordV1({ catalog: initial, key: 'skill-rules' });
    const unavailable = (): PromptLibraryCatalogSnapshotV1 => {
      codingMigrationDiagnostic = { key: 'coding', revision: source.revision,
        reason: input.signal?.aborted ? 'cancelled' : 'unreachable' };
      return { ...initial, status: 'partial', diagnostics: [...initial.diagnostics, codingMigrationDiagnostic] };
    };
    if (destination.status !== 'ready' || destination.record.key !== 'skill-rules' || destination.revision === 'absent') catalog = unavailable();
    else {
      const entries = unconsumedStackSkillEntriesV1(source.record.value.entries, { kind: 'account' }, destination.record.value.consumedLegacyEntryIds);
      const classified = await readStackSkillIdsV1(entries, migration);
      if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
      if (classified.status !== 'ready') catalog = unavailable();
      else {
        const value = migrateStackSkillRulesV1(destination.record.value, entries,
          { kind: 'account' }, { ...classified, nowMs: (input.nowMs ?? Date.now)() });
        if (value !== destination.record.value) {
          try {
            const receipt = await migration.writeRecord({ record: { key: 'skill-rules', value },
              expectedRevision: destination.revision });
            catalog = receipt.status === 'updated' ? await readCatalog(input) : unavailable();
          } catch { catalog = unavailable(); }
        }
      }
    }
  }
  if (catalog.status !== 'ready' && catalog.status !== 'partial') return catalog;
  const result = await dropVoiceStackSkills(input, catalog);
  if (!codingMigrationDiagnostic || (result.status !== 'ready' && result.status !== 'partial')) return result;
  // A successful independent Voice CAS rereads rows, not the failed coding migration.
  return { ...result, status: 'partial', diagnostics: [...result.diagnostics.filter(item => item.key !== 'coding'), codingMigrationDiagnostic] };
}

/** D32 has no destination identity: drop voice skills through the existing load/transfer CAS. */
async function dropVoiceStackSkills(input: PromptLibraryLoadInputV1, initial: Extract<PromptLibraryCatalogSnapshotV1, { rows: unknown }>): Promise<PromptLibraryCatalogSnapshotV1> {
  const migration = input.skillMigration;
  if (!migration) return initial;
  const source = initial.rows.find(row => row.record.key === 'voice');
  if (!source || source.record.key !== 'voice') return initial;
  const entries = source.record.value.entries;
  if (!entries.some(entry => entry.ref.kind === 'bundle' && isPromptStackSystemAppendPlacementV1(entry.placement))) return initial;
  const read = await readStackSkillIdsV1(entries, migration);
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const unavailable = (): PromptLibraryCatalogSnapshotV1 => ({ ...initial, status: 'partial',
    diagnostics: [...initial.diagnostics, { key: 'voice', revision: source.revision,
      reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }] });
  if (read.status !== 'ready') return unavailable();
  const converted = convertStackSkillEntriesV1(entries, { kind: 'voice' }, read);
  if (converted.remainingEntries.length === entries.length) return initial;
  try {
    const receipt = await migration.writeRecord({ record: { key: 'voice', value: { ...source.record.value, entries: converted.remainingEntries } }, expectedRevision: source.revision });
    return receipt.status === 'updated' ? readCatalog(input) : initial;
  } catch {
    return unavailable();
  }
}

async function cleanupSource(input: PromptLibraryLoadInputV1, catalog: Extract<PromptLibraryCatalogSnapshotV1, { rows: unknown }>,
  source: Awaited<ReturnType<PromptLibrarySourceTransferV1['readSourceSnapshot']>>): Promise<PromptLibrarySourceCleanupV1> {
  const transfer = input.transfer!;
  const active = new Set([...catalog.rows.map(row => row.record.key), ...catalog.tombstones.map(row => row.key)]);
  const raw = { ...source.raw };
  let pending: PromptLibrarySourceCleanupV1 | null = null;
  let legacyRoleArtifactTransfers: readonly AccountSettingsHistoryLegacyRoleArtifactTransferV1[] | undefined;
  const retiredRoots: string[] = [];
  for (const key of active) {
    if (key === 'coding' || key === 'voice') continue;
    const root = PROMPT_LIBRARY_RETAINED_ROOTS_V1[key];
    if (root === null) continue;
    if (!Object.hasOwn(raw, root)) { retiredRoots.push(root); continue; }
    if (readRetainedPromptLibraryRecordV1(raw, key).status !== 'ready') {
      pending = { status: 'cleanup-pending', reason: 'source-unavailable' }; continue;
    }
    delete raw[root]; retiredRoots.push(root);
  }
  if (Object.hasOwn(raw, 'promptStacksV1')) {
    const parsed = retainedStacks.safeParse(raw.promptStacksV1);
    if (!parsed.success) pending = { status: 'cleanup-pending', reason: 'source-unavailable' };
    else {
      // Profiles own their private stack transfer. Preserve even an explicit empty Profile source arm.
      const next = removeTransferredPromptLibrarySourcesV1(raw, [...active].filter(key => key === 'coding' || key === 'voice'));
      if (!Object.hasOwn(next, 'promptStacksV1')) { delete raw.promptStacksV1; retiredRoots.push('promptStacksV1'); }
      else raw.promptStacksV1 = next.promptStacksV1;
    }
  } else if (active.has('coding') && active.has('voice')) retiredRoots.push('promptStacksV1');
  if (transfer.retainLegacyRoleArtifacts) {
      try {
        legacyRoleArtifactTransfers = await transfer.retainLegacyRoleArtifacts(source.raw);
        delete raw.executionRunsGuidanceEntries; delete raw.executionRunsGuidanceEnabled;
        retiredRoots.push(...LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1);
      } catch { pending = { status: 'cleanup-pending', reason: 'artifacts-unavailable' }; }
  } else if (LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1.some(root => Object.hasOwn(raw, root))) {
    pending = { status: 'cleanup-pending', reason: 'artifacts-unavailable' };
  }
  if (input.signal?.aborted) return { status: 'cleanup-pending', reason: 'cancelled' };
  if (JSON.stringify(raw) !== JSON.stringify(source.raw)) {
    try {
      const response = await transfer.replaceSource!({ raw, expectedVersion: source.version });
      if (response.status !== 'applied') return { status: 'cleanup-pending',
        reason: response.status === 'conflict' ? 'source-conflict' : 'source-unavailable' };
    } catch { return { status: 'cleanup-pending', reason: input.signal?.aborted ? 'cancelled' : 'source-unavailable' }; }
  }
  if (transfer.normalizeHistory) {
    try {
      const history = await transfer.normalizeHistory({ activeTransferredRoots: retiredRoots,
        ...(legacyRoleArtifactTransfers === undefined ? {} : { legacyRoleArtifactTransfers }) });
      if (history.status !== 'complete') return { status: 'cleanup-pending', reason: 'history-incomplete' };
    } catch { return { status: 'cleanup-pending', reason: 'history-incomplete' }; }
  } else if (retiredRoots.length && !pending) pending = { status: 'cleanup-pending', reason: 'history-incomplete' };
  return pending ?? { status: 'complete' };
}

export const PROMPT_LIBRARY_RETAINED_ROOTS_V1 = {
  coding: 'promptStacksV1', voice: 'promptStacksV1', folders: 'promptFoldersV1', invocations: 'promptInvocationsV1',
  'external-links': 'promptExternalLinksV1', 'registry-sources': 'promptRegistrySourcesV1', contexts: 'contextSelectionsV1',
  'role-overrides': 'rolesV1', 'skill-rules': null, 'skill-usage': null,
} as const satisfies Readonly<Record<PromptLibraryCatalogKeyV1, string | null>>;

/** Exact source contraction shared by live cleanup and the canonical history owner. */
export function removeTransferredPromptLibrarySourcesV1(source: Readonly<Record<string, unknown>>,
  activeKeys: readonly PromptLibraryCatalogKeyV1[]): Record<string, unknown> {
  const active = new Set(activeKeys);
  const raw = { ...source };
  for (const key of active) {
    const root = PROMPT_LIBRARY_RETAINED_ROOTS_V1[key];
    if (key !== 'coding' && key !== 'voice' && root !== null) delete raw[root];
  }
  const stack = raw.promptStacksV1;
  if (!stack || typeof stack !== 'object' || Array.isArray(stack) || !('surfaces' in stack)) return raw;
  const originalSurfaces = stack.surfaces;
  if (!originalSurfaces || typeof originalSurfaces !== 'object' || Array.isArray(originalSurfaces)) return raw;
  const surfaces: Record<string, unknown> = { ...originalSurfaces };
  if (active.has('coding')) delete surfaces.coding;
  if (active.has('voice')) delete surfaces.voice;
  if (active.has('coding') && active.has('voice') && !Object.hasOwn(surfaces, 'profilesById')) delete raw.promptStacksV1;
  else raw.promptStacksV1 = { ...stack, surfaces };
  return raw;
}

// This read-only predecessor projection has no collection-wide catch: malformed
// retained entries must keep destination activation incomplete.
const retainedStacks = createStoredReadSchema(z.strictObject({ v: z.literal(1), surfaces: z.strictObject({
  coding: z._default(z.array(PromptStackEntryV1StoredSchema), []), voice: z._default(z.array(PromptStackEntryV1StoredSchema), []),
  profilesById: z._default(z.record(z.string(), z.array(PromptStackEntryV1StoredSchema)), {}),
}) }));

export function emptyPromptLibraryRecordV1(key: PromptLibraryCatalogKeyV1, nowMs = Date.now()): PromptLibraryRecordV1 {
  switch (key) {
    case 'coding': case 'voice': return { key, value: { v: 1, scope: { kind: key }, entries: [] } };
    case 'folders': return { key, value: { v: 1, folders: [] } };
    case 'invocations': return { key, value: { v: 1, entries: [] } };
    case 'external-links': return { key, value: { v: 1, links: [] } };
    case 'registry-sources': return { key, value: { v: 2, sources: [], disabledSourceIds: [] } };
    case 'contexts': return { key, value: { v: 1, selectionsByKey: {} } };
    case 'role-overrides': return { key, value: { v: 1, overrides: {} } };
    case 'skill-usage': return { key, value: { v: 1, lastUsedAt: {} } };
    case 'skill-rules': return { key, value: { v: 1, rules: [] } };
  }
}

export function readRetainedPromptLibraryRecordV1(raw: Readonly<Record<string, unknown>>, key: PromptLibraryCatalogKeyV1):
  Readonly<{ status: 'ready'; record: PromptLibraryRecordV1 }> | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }> {
  const root = PROMPT_LIBRARY_RETAINED_ROOTS_V1[key];
  const source = root === null ? undefined : raw[root];
  if (source === undefined) return { status: 'ready', record: emptyPromptLibraryRecordV1(key) };
  let value: unknown = source;
  if (key === 'coding' || key === 'voice') {
    const stacks = retainedStacks.safeParse(source);
    if (!stacks.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
    value = { v: 1, scope: { kind: key }, entries: stacks.data.surfaces[key] };
  } else if (key === 'role-overrides') {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return { status: 'unavailable', reason: 'invalid-stored-content' };
    value = { ...source, v: 1 };
  }
  const parsed = StoredPromptLibraryRecordV1Schema.safeParse({ key, value });
  return parsed.success ? { status: 'ready', record: parsed.data } : { status: 'unavailable', reason: 'invalid-stored-content' };
}

export function readRetainedPromptLibraryInventoryV1(raw: Readonly<Record<string, unknown>>) {
  const records: PromptLibraryRecordV1[] = [];
  const diagnostics: Array<{ key: PromptLibraryCatalogKeyV1; reason: 'invalid-stored-content' }> = [];
  for (const key of PromptLibraryCatalogKeyV1Schema.options) {
    const read = readRetainedPromptLibraryRecordV1(raw, key);
    if (read.status === 'ready') records.push(read.record);
    else diagnostics.push({ key, reason: read.reason });
  }
  const stacks = raw.promptStacksV1 === undefined ? null : retainedStacks.safeParse(raw.promptStacksV1);
  const profileStacksById: Readonly<Record<string, readonly PromptStackEntryV1[]>> = stacks?.success ? stacks.data.surfaces.profilesById : {};
  return { status: diagnostics.length ? 'partial' as const : 'ready' as const, records, profileStacksById, diagnostics };
}

/** Presence and versioned deletion are irreversible authority; only absence reads retained source. */
export function readPromptLibraryCatalogRecordV1(input: Readonly<{
  catalog: PromptLibraryCatalogSnapshotV1; key: PromptLibraryCatalogKeyV1; rawSettings?: Readonly<Record<string, unknown>>;
}>): Readonly<{ status: 'ready'; record: PromptLibraryRecordV1; revision: number | 'absent'; authority: 'active' | 'inactive' }>
  | Readonly<{ status: 'unavailable'; reason: PromptLibraryCatalogUnavailableReasonV1 | 'loading' }> {
  const { catalog, key } = input;
  if (catalog.status === 'loading') return { status: 'unavailable', reason: 'loading' };
  if (catalog.status === 'unavailable') return catalog;
  const diagnostic = catalog.diagnostics.find(diagnostic => diagnostic.key === key);
  if (diagnostic) return { status: 'unavailable', reason: diagnostic.reason };
  const row = catalog.rows.find(row => row.record.key === key);
  if (row) return { status: 'ready', ...row, authority: 'active' };
  const deleted = catalog.tombstones.find(row => row.key === key);
  if (deleted) return { status: 'ready', record: key === 'skill-rules'
    ? { key, value: { v: 1, rules: [] } } : emptyPromptLibraryRecordV1(key), revision: deleted.revision, authority: 'active' };
  if (!input.rawSettings) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const retained = readRetainedPromptLibraryRecordV1(input.rawSettings, key);
  return retained.status === 'ready' ? { ...retained, revision: 'absent', authority: 'inactive' } : retained;
}

export type PromptLibraryStackActionPortV1 = Pick<ArtifactFolderActionPortV1,
  'serverId' | 'matchesServerId' | 'assertCurrent' | 'readCatalog' | 'writeRecord'>;

/** Registry edits share the incumbent Account catalog and its single-row revision CAS. */
export async function updatePromptLibraryRegistrySourcesV1(port: PromptLibraryStackActionPortV1,
  mutation: RegistrySourcesMutationV1, signal?: AbortSignal): Promise<RegistrySourcesMutationResultV1> {
  signal?.throwIfAborted(); port.assertCurrent();
  const projection = await port.readCatalog(signal, 'registry-sources');
  signal?.throwIfAborted(); port.assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({...projection,key:'registry-sources'});
  if(read.status !== 'ready') return read;
  if(read.record.key !== 'registry-sources') return {status:'unavailable',reason:'invalid-stored-content'};
  if(read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) return {status:'unavailable',reason:'source-currentness-unavailable'};
  const value = { ...read.record.value, sources:[...read.record.value.sources], disabledSourceIds:[...read.record.value.disabledSourceIds] };
  if(mutation.kind === 'create') {
    if(!value.sources.some(source=>source.id===mutation.source.id || source.url===mutation.source.url)) value.sources.push(mutation.source);
    else return {status:'updated',revision:read.revision === 'absent' ? 0 : read.revision};
  } else if(mutation.kind === 'setBuiltInEnabled') {
    value.disabledSourceIds=value.disabledSourceIds.filter(id=>id !== mutation.sourceId);
    if(!mutation.enabled) value.disabledSourceIds.push(mutation.sourceId);
  } else {
    const index=value.sources.findIndex(source=>source.id === mutation.sourceId);
    if(index<0) return {status:'invalid',reason:'not_found'};
    if(mutation.kind === 'delete') value.sources.splice(index,1);
    else if(mutation.kind === 'setToken') {
      const source=value.sources[index]!;
      const {token,npmRegistryProfileId,...rest}=source;
      value.sources[index]={...rest,
        ...((mutation.token === undefined ? token : mutation.token) ? {token:(mutation.token === undefined ? token : mutation.token)!}:{}),
        ...((mutation.npmRegistryProfileId === undefined ? npmRegistryProfileId : mutation.npmRegistryProfileId)
          ? {npmRegistryProfileId:(mutation.npmRegistryProfileId === undefined ? npmRegistryProfileId : mutation.npmRegistryProfileId)!}:{}),
      };
    }
    else value.sources[index]={...value.sources[index]!,...(mutation.title !== undefined ? {title:mutation.title} : {}),...(mutation.enabled !== undefined ? {enabled:mutation.enabled} : {})};
  }
  signal?.throwIfAborted(); port.assertCurrent();
  const result=await port.writeRecord({record:{key:'registry-sources',value},expectedRevision:read.revision,
    ...(read.authority==='inactive'?{sourceSettingsVersion:projection.sourceSettingsVersion}:{})},signal);
  return result.status==='updated'||result.status==='conflict' ? result : {status:'unavailable',reason:result.status};
}

/** The existing catalog authority supplies source admission and sole-row CAS, not a new stack store. */
export async function updatePromptLibraryStackV1(port: PromptLibraryStackActionPortV1,
  input: z.infer<typeof PromptLibraryStackUpdateInputV1Schema>, signal?: AbortSignal,
): Promise<z.infer<typeof PromptLibraryStackUpdateResultV1Schema>> {
  const assertCurrent = () => { signal?.throwIfAborted(); port.assertCurrent(); };
  assertCurrent();
  const projection = await port.readCatalog(signal);
  assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: input.surface });
  if (read.status !== 'ready') return read;
  if (read.record.key !== 'coding' && read.record.key !== 'voice') return { status: 'unavailable', reason: 'invalid-stored-content' };
  if (read.revision !== input.expectedRevision) return { status: 'conflict', revision: read.revision === 'absent' ? -1 : read.revision };
  if (read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) {
    return { status: 'unavailable', reason: 'source-currentness-unavailable' };
  }
  const applied = applyPromptStackIntentV1({ promptStack: read.record.value.entries }, input.intent);
  if (!applied.ok) return { status: 'invalid', reason: applied.errorCode };
  assertCurrent();
  const result = await port.writeRecord({ record: { key: input.surface, value: { ...read.record.value, entries: [...applied.row.promptStack] } },
    expectedRevision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}),
  }, signal);
  // An acknowledged write stays true after the original lifetime retires; never rebase or replay it.
  if (result.status === 'updated') return { status: 'updated', revision: result.revision };
  if (result.status === 'conflict') return result;
  return { status: 'unavailable', reason: result.status };
}
