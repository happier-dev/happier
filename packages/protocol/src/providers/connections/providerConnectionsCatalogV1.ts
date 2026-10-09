import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema, composeProviderSettingsV1, splitProviderSettingsV1,
  listProviderConnectionsCatalogSavedSecretRefsV1, openProviderConnectionsContentV1, readRetainedProviderConnectionsCatalogV1,
  ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema, type ProviderConnectionsCatalogV1, type ProviderConnectionsCatalogSnapshotV1,
  type ProviderConnectionsCatalogRowReadResultV1, type ProviderConnectionsRowMutationResponseV1Schema,
} from './connectionRowsV1.js';
import type { ProviderConnectionV1 } from './v1.js';
import type { ProviderManualModelV1, SavedSecretSlotBindingsV1 } from '../settings/v1.js';
import { addProviderConnectionV1, addOrUpdateProviderManualModelV1, bindProviderConnectionSecretV1 } from '../settings/operationsV1.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import { parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

export { listProviderConnectionsCatalogSavedSecretRefsV1, rewriteProviderConnectionsCatalogSavedSecretRefsV1 } from './connectionRowsV1.js';
export { readRetainedProviderConnectionsCatalogV1 } from './connectionRowsV1.js';
export type ProviderConnectionsSourceTransferV1 = Readonly<{
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  initializeCatalog(input: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>):
    Promise<ReturnType<typeof ProviderConnectionsRowMutationResponseV1Schema.parse>>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[] }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
type LoadInput = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  readRow(): Promise<ProviderConnectionsCatalogRowReadResultV1>;
  transfer?: ProviderConnectionsSourceTransferV1;
  onReadyBeforeCleanup?: (catalog: Extract<ProviderConnectionsCatalogSnapshotV1, { status: 'ready' }>) => Promise<void>;
  hasPendingCleanup?: () => boolean;
}>;

/** A genuine non-Profile import carries domain facts, never source or credential bytes. */
export type ProviderConnectionImportCandidateV1 = Readonly<{
  connection: ProviderConnectionV1;
  secretBindings?: SavedSecretSlotBindingsV1;
  manualModels?: readonly ProviderManualModelV1[];
}>;
export type ProviderConnectionImportPreparationV1 =
  | Readonly<{ status: 'prepared'; connectionId: string; catalog: ProviderConnectionsCatalogV1; changed: boolean }>
  | Readonly<{ status: 'invalid' | 'conflict' }>;
type ReadyCatalog = Extract<ProviderConnectionsCatalogSnapshotV1, { status: 'ready' }>;
export type ProviderConnectionImportCommitResultV1 = Readonly<{ status: 'applied' | 'conflict' | 'cancelled' | 'outcome_unknown' }>
  | Readonly<{ status: 'refused'; reason: string }>;
export type ProviderConnectionImportIntentV1 = Readonly<{
  candidate: ProviderConnectionImportCandidateV1;
  isCurrent(): boolean;
  /** The captured transport/SavedSecret owner performs the one atomic row write. */
  commitCatalog(input: Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number }>): Promise<ProviderConnectionImportCommitResultV1>;
}>;
export type ProviderConnectionsCatalogImportResultV1 =
  | Readonly<{ status: 'applied' | 'unchanged'; connectionId: string; catalog: ReadyCatalog }>
  | Readonly<{ status: 'conflict' | 'invalid' | 'cancelled' | 'outcome_unknown' }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
export type ProviderConnectionsCatalogImportInputV1 = LoadInput & Readonly<{ importConnection: ProviderConnectionImportIntentV1 }>;

function importDescriptor(connection: ProviderConnectionV1) {
  const { displayName: _name, displayNameMode: _nameMode, revision: _revision,
    createdAt: _createdAt, updatedAt: _updatedAt, ...descriptor } = connection;
  return descriptor;
}

/** Merge only missing import facts through the incumbent creation/binding/model operations. */
export function prepareProviderConnectionImportV1(catalog: ProviderConnectionsCatalogV1,
  candidate: ProviderConnectionImportCandidateV1): ProviderConnectionImportPreparationV1 {
  const current = ProviderConnectionsCatalogV1Schema.safeParse(catalog);
  const incoming = ProviderConnectionsCatalogV1Schema.safeParse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [candidate.connection],
    secretBindingsByConnectionId: candidate.secretBindings ? { [candidate.connection.id]: candidate.secretBindings } : {},
    manualModelsByConnectionId: candidate.manualModels?.length ? { [candidate.connection.id]: candidate.manualModels } : {},
  });
  if (!current.success || !incoming.success) {
    return { status: 'invalid' };
  }
  const connection = incoming.data.connections[0]!;
  if (current.data.connectionTombstones.some(tombstone => tombstone.id === connection.id)) return { status: 'conflict' };
  const existing = current.data.connections.find(entry => entry.id === connection.id);
  if (existing && !sameStrictJsonValue(importDescriptor(existing), importDescriptor(connection))) return { status: 'conflict' };
  let settings = composeProviderSettingsV1(current.data, {});
  try {
    if (listProviderConnectionsCatalogSavedSecretRefsV1(incoming.data).some(reference => parseSavedSecretRefV1(reference.secretId).kind !== 'shared_resource')) {
      return { status: 'invalid' };
    }
    if (!existing) settings = addProviderConnectionV1(settings, connection);
    const bindings = readOwnRecordValue(incoming.data.secretBindingsByConnectionId, connection.id);
    const slots = [
      ...Object.entries(bindings?.account ?? {}).map(([slotId, savedSecretId]) => ({ machineId: null, slotId, savedSecretId })),
      ...Object.entries(bindings?.byMachineId ?? {}).flatMap(([machineId, machine]) =>
        Object.entries(machine).map(([slotId, savedSecretId]) => ({ machineId, slotId, savedSecretId }))),
    ];
    for (const slot of slots) {
      const currentBinding = readOwnRecordValue(settings.secretBindingsByConnectionId, connection.id);
      const previous = readOwnRecordValue(slot.machineId === null ? currentBinding?.account
        : readOwnRecordValue(currentBinding?.byMachineId, slot.machineId), slot.slotId);
      if (previous !== undefined && previous !== slot.savedSecretId) return { status: 'conflict' };
      if (previous === undefined) settings = bindProviderConnectionSecretV1({ settings, connectionId: connection.id, ...slot });
    }
    for (const model of readOwnRecordValue(incoming.data.manualModelsByConnectionId, connection.id) ?? []) {
      const previous = readOwnRecordValue(settings.manualModelsByConnectionId, connection.id)?.find(entry => entry.id === model.id);
      if (previous && model.name !== undefined && previous.name !== model.name) return { status: 'conflict' };
      if (!previous) settings = addOrUpdateProviderManualModelV1(settings, { connectionId: connection.id, model, addedAt: model.addedAt });
    }
    const next = splitProviderSettingsV1(settings).catalog;
    return { status: 'prepared', connectionId: connection.id, catalog: next, changed: !sameStrictJsonValue(current.data, next) };
  } catch { return { status: 'invalid' }; }
}

/** Preserve a snapshot's own preference before retiring its transferred entity source. */
export function removeTransferredProviderConnectionsSourceV1(raw: Readonly<Record<string, unknown>>):
  Readonly<{ status: 'ready'; raw: Readonly<Record<string, unknown>>; preferenceHandoffRequired: boolean }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }> {
  if (!Object.hasOwn(raw, 'providerSettingsV1')) return { status: 'ready', raw, preferenceHandoffRequired: false };
  const retained = readRetainedProviderConnectionsCatalogV1(raw);
  if (retained.status !== 'ready') return { status: 'unavailable', reason: 'invalid-stored-content' };
  const next = { ...raw };
  const hasPreference = Object.hasOwn(next, 'providerDefaultModelSelectionsByAgentTargetKeyV1');
  if (hasPreference) {
    if (!ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.safeParse(next.providerDefaultModelSelectionsByAgentTargetKeyV1).success) {
      return { status: 'unavailable', reason: 'invalid-stored-content' };
    }
  } else next.providerDefaultModelSelectionsByAgentTargetKeyV1 = retained.defaults;
  delete next.providerSettingsV1;
  return { status: 'ready', raw: next,
    preferenceHandoffRequired: !hasPreference && Object.keys(retained.defaults).length > 0 };
}

async function readCatalog(input: LoadInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.mode === 'e2ee' && input.material === null) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  let row: Awaited<ReturnType<LoadInput['readRow']>>;
  try { row = await input.readRow(); }
  catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (row.status === 'unavailable') return row;
  if (row.status === 'absent') return { status: 'unavailable', reason: 'authority-not-confirmed' };
  if (row.status === 'deleted') return { status: 'ready', revision: row.revision, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
  if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
  const opened = openProviderConnectionsContentV1({ ...input, content: row.content });
  return opened.status === 'opened' ? { status: 'ready', revision: row.revision, catalog: opened.catalog }
    : opened.status === 'partial' ? { ...opened, revision: row.revision } : opened;
}

/** Explicit imports and ordinary reads use the same admitted row authority. */
export function loadProviderConnectionsCatalogV1(input: ProviderConnectionsCatalogImportInputV1): Promise<ProviderConnectionsCatalogImportResultV1>;
export function loadProviderConnectionsCatalogV1(input: LoadInput): Promise<ProviderConnectionsCatalogSnapshotV1>;
export async function loadProviderConnectionsCatalogV1(input: LoadInput | ProviderConnectionsCatalogImportInputV1): Promise<
  ProviderConnectionsCatalogSnapshotV1 | ProviderConnectionsCatalogImportResultV1
> {
  if (!('importConnection' in input)) return loadTransferredCatalog(input);
  const intent = input.importConnection;
  const current = () => { try { return intent.isCurrent(); } catch { return false; } };
  if (input.signal?.aborted) return { status: 'cancelled' };
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  let deleted = false;
  const captured = await loadTransferredCatalog({ ...input, readRow: async () => {
    if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
    const row = await input.readRow();
    deleted ||= row.status === 'deleted';
    return row;
  } });
  if (input.signal?.aborted) return { status: 'cancelled' };
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  if (captured.status !== 'ready') return { status: 'unavailable', reason: captured.status === 'unavailable'
    ? captured.reason : 'catalog-not-ready' };
  if (deleted) return { status: 'conflict' };
  const prepared = prepareProviderConnectionImportV1(captured.catalog, intent.candidate);
  if (prepared.status !== 'prepared') return prepared;
  if (!prepared.changed) return { status: 'unchanged', connectionId: prepared.connectionId, catalog: captured };
  if (captured.revision === 'absent') return { status: 'unavailable', reason: 'authority-not-confirmed' };
  let receipt: ProviderConnectionImportCommitResultV1;
  try { receipt = await intent.commitCatalog({ catalog: prepared.catalog, expectedRevision: captured.revision }); }
  catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'commit-unavailable' }; }
  // The transaction owner alone classifies an issued write's missing ACK.
  if (receipt.status === 'outcome_unknown') return { status: 'outcome_unknown' };
  if (receipt.status === 'cancelled' || input.signal?.aborted) return { status: 'cancelled' };
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  if (receipt.status === 'refused') return { status: 'unavailable', reason: receipt.reason };
  if (receipt.status === 'conflict') return { status: 'conflict' };
  const winner = await readCatalog(input);
  if (input.signal?.aborted) return { status: 'cancelled' };
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  if (winner.status !== 'ready') return { status: 'unavailable', reason: winner.status === 'unavailable'
    ? winner.reason : 'catalog-not-ready' };
  const verified = prepareProviderConnectionImportV1(winner.catalog, intent.candidate);
  return verified.status === 'prepared' && !verified.changed
    ? { status: 'applied', connectionId: verified.connectionId, catalog: winner } : { status: 'conflict' };
}

/** The undeployed root is opened once into its sole row; no fallback or transfer control. */
async function loadTransferredCatalog(input: LoadInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  let catalog = await readCatalog(input);
  if (!input.transfer) return catalog;
  const transfer = input.transfer;
  let source: Awaited<ReturnType<ProviderConnectionsSourceTransferV1['readSourceSnapshot']>> | undefined;
  if (catalog.status === 'unavailable' && catalog.reason === 'authority-not-confirmed') {
    try { source = await transfer.readSourceSnapshot(); }
    catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    const retained = readRetainedProviderConnectionsCatalogV1(source.raw);
    if (retained.status !== 'ready') return retained.status === 'partial'
      ? { status: 'partial', revision: 'absent', catalog: retained.catalog, diagnostics: retained.diagnostics } : retained;
    const receipt = await transfer.initializeCatalog({ catalog: retained.catalog, expectedRevision: 'absent', sourceSettingsVersion: source.version });
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    if (receipt.status === 'settings-conflict') return { status: 'unavailable', reason: 'source-version-conflict' };
    // An ACK is not an opened authoritative snapshot. Read the actual concurrent winner.
    catalog = await readCatalog(input);
  }
  if (catalog.status !== 'ready') return catalog;
  try { source ??= await transfer.readSourceSnapshot(); }
  catch {
    await input.onReadyBeforeCleanup?.(catalog);
    return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const contraction = removeTransferredProviderConnectionsSourceV1(source.raw);
  if (contraction.status !== 'ready') {
    await input.onReadyBeforeCleanup?.(catalog);
    return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } };
  }
  const raw = contraction.raw;
  let sourceRemoved = false;
  if (contraction.preferenceHandoffRequired) {
    const pending = { status: 'partial' as const, revision: catalog.revision, catalog: catalog.catalog,
      diagnostics: [{ path: 'providerDefaultModelSelectionsByAgentTargetKeyV1', reason: 'source_preference_pending' }] };
    if (!transfer.replaceSource) return pending;
    const handoff = await transfer.replaceSource({ raw, expectedVersion: source.version });
    if (handoff.status !== 'applied') return pending;
    sourceRemoved = true;
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  await input.onReadyBeforeCleanup?.(catalog);
  if (input.hasPendingCleanup?.() || !transfer.replaceSource) return catalog;
  if (!sourceRemoved && Object.hasOwn(source.raw, 'providerSettingsV1')) {
    const removed = await transfer.replaceSource({ raw, expectedVersion: source.version });
    if (removed.status !== 'applied') return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'source-conflict' } };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (!transfer.normalizeHistory) return { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } };
  let history: Awaited<ReturnType<NonNullable<ProviderConnectionsSourceTransferV1['normalizeHistory']>>>;
  try { history = await transfer.normalizeHistory({ activeTransferredRoots: ['providerSettingsV1'] }); }
  catch {
    return input.signal?.aborted ? { status: 'unavailable', reason: 'cancelled' }
      : { ...catalog, cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } };
  }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  return { ...catalog, cleanup: history.status === 'complete' ? { status: 'complete' }
    : { status: 'cleanup-pending', reason: 'history-incomplete' } };
}
