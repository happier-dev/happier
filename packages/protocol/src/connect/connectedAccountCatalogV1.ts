import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from './connectedAccountPurposeBindings.js';
import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import {
  parseStoredConnectedAccountCatalogContentV1, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogKeyV1, type ConnectedAccountCatalogRecordV1,
  type ConnectedAccountCatalogRowReadResponseV1, type ConnectedAccountCatalogRowMutationResponseV1,
} from './connectedAccountConfigurationRowsV1.js';

export const CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1 = {
  configurations: 'connectedAccountServiceConfigurationsV1', purposes: 'connectedAccountPurposeBindingsV1',
} as const;
export type ConnectedAccountCatalogUnavailableReasonV1 = 'account-not-found' | 'account-inconsistent' | 'account-mode-mismatch'
  | 'encryption-material-unavailable' | 'invalid-stored-content' | 'invalid-reference' | 'unauthorized' | 'forbidden' | 'unsupported'
  | 'unreachable' | 'scope-retired' | 'cancelled' | 'source-version-conflict' | 'authority-not-confirmed';
export type ConnectedAccountCatalogSourceCleanupV1 = Readonly<{ status: 'complete' }> | Readonly<{
  status: 'cleanup-pending'; reason: 'source-unavailable' | 'source-conflict' | 'history-incomplete' | 'cancelled';
}>;
export type ConnectedAccountCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'unavailable'; reason: ConnectedAccountCatalogUnavailableReasonV1 }>
  | Readonly<{ status: 'ready'; record: ConnectedAccountCatalogRecordV1; revision: number; cleanup?: ConnectedAccountCatalogSourceCleanupV1 }>;
export type ConnectedAccountCatalogSourceCutoverV1 = Readonly<{
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  initializeRecord(input: Readonly<{ record: ConnectedAccountCatalogRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number }>):
    Promise<ConnectedAccountCatalogRowMutationResponseV1>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<
    Readonly<{ status: 'applied'; settingsVersion: number }> | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }> | Readonly<{ status: 'rejected' }>>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[] }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
type LoadInput = Readonly<{
  key: ConnectedAccountCatalogKeyV1; mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  readRow(): Promise<ConnectedAccountCatalogRowReadResponseV1>;
  transfer?: ConnectedAccountCatalogSourceCutoverV1;
  onReadyBeforeCleanup?: (catalog: Extract<ConnectedAccountCatalogSnapshotV1, { status: 'ready' }>) => Promise<void>;
}>;

export function emptyConnectedAccountCatalogRecordV1(key: ConnectedAccountCatalogKeyV1): ConnectedAccountCatalogRecordV1 {
  return key === 'configurations' ? { key, value: { v: 1, entries: [] } } : { key, value: { v: 1, bindings: [] } };
}
const retainedPurposes = createStoredReadSchema(QualifiedConnectedAccountPurposeBindingsV1Schema);
/** Undeployed source is opened once for an admitted in-place cutover, never served as destination authority. */
export function readRetainedConnectedAccountCatalogRecordV1(raw: Readonly<Record<string, unknown>>, key: ConnectedAccountCatalogKeyV1) {
  if (!Object.hasOwn(raw, CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[key])) {
    return { status: 'ready' as const, record: emptyConnectedAccountCatalogRecordV1(key) };
  }
  let value = raw[CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[key]];
  if (key === 'purposes') {
    // Purpose selections have no direct SavedSecret slots; future carriers cannot be discarded by source normalization.
    if (listSavedSecretReferenceCarrierPathsV1(value).length > 0) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
    const earlier = retainedPurposes.safeParse(value);
    if (!earlier.success) return { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
    value = earlier.data;
  }
  const parsed = parseStoredConnectedAccountCatalogContentV1({ t: 'plain', v: { key, value } });
  return parsed?.t === 'plain' ? { status: 'ready' as const, record: parsed.v }
    : { status: 'unavailable' as const, reason: 'invalid-stored-content' as const };
}
export function removeTransferredConnectedAccountCatalogSourcesV1(raw: Readonly<Record<string, unknown>>,
  activeKeys: readonly ConnectedAccountCatalogKeyV1[]): Record<string, unknown> {
  const next = { ...raw };
  for (const key of activeKeys) delete next[CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[key]];
  return next;
}
async function readDestination(input: LoadInput): Promise<Exclude<ConnectedAccountCatalogSnapshotV1, { status: 'loading' }> | Readonly<{ status: 'absent' }>> {
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const row = await input.readRow();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (row.status === 'absent') return row;
  if (row.status === 'deleted') return { status: 'ready', record: emptyConnectedAccountCatalogRecordV1(input.key), revision: row.revision };
  if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
  const opened = openConnectedAccountCatalogContentV1({ ...input, content: row.content });
  return opened.status === 'opened' ? { status: 'ready', record: opened.record, revision: row.revision } : opened;
}
async function cleanupSource(input: LoadInput,
  source: Awaited<ReturnType<ConnectedAccountCatalogSourceCutoverV1['readSourceSnapshot']>>): Promise<ConnectedAccountCatalogSourceCleanupV1> {
  const transfer = input.transfer!;
  if (!transfer.replaceSource) return { status: 'cleanup-pending', reason: 'source-unavailable' };
  if (input.signal?.aborted) return { status: 'cleanup-pending', reason: 'cancelled' };
  const root = CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1[input.key];
  if (Object.hasOwn(source.raw, root)) {
    if (readRetainedConnectedAccountCatalogRecordV1(source.raw, input.key).status !== 'ready') {
      return { status: 'cleanup-pending', reason: 'source-unavailable' };
    }
    try {
      const result = await transfer.replaceSource({ raw: removeTransferredConnectedAccountCatalogSourcesV1(source.raw, [input.key]), expectedVersion: source.version });
      if (result.status !== 'applied') return { status: 'cleanup-pending', reason: result.status === 'conflict' ? 'source-conflict' : 'source-unavailable' };
    } catch { return { status: 'cleanup-pending', reason: input.signal?.aborted ? 'cancelled' : 'source-unavailable' }; }
  }
  if (input.signal?.aborted) return { status: 'cleanup-pending', reason: 'cancelled' };
  if (!transfer.normalizeHistory) return { status: 'cleanup-pending', reason: 'history-incomplete' };
  try {
    return (await transfer.normalizeHistory({ activeTransferredRoots: [root] })).status === 'complete'
      ? { status: 'complete' } : { status: 'cleanup-pending', reason: 'history-incomplete' };
  } catch { return { status: 'cleanup-pending', reason: 'history-incomplete' }; }
}
/** The sole-row CAS establishes irreversible authority; malformed or absent proof cannot produce an empty success. */
export async function loadConnectedAccountCatalogV1(input: LoadInput): Promise<ConnectedAccountCatalogSnapshotV1> {
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.mode === 'e2ee' && !input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  let destination = await readDestination(input);
  if (destination.status === 'unavailable') return destination;
  if (!input.transfer) return destination.status === 'absent' ? { status: 'unavailable', reason: 'authority-not-confirmed' } : destination;
  if (destination.status === 'ready') await input.onReadyBeforeCleanup?.(destination);
  let source: Awaited<ReturnType<ConnectedAccountCatalogSourceCutoverV1['readSourceSnapshot']>>;
  try { source = await input.transfer.readSourceSnapshot(); }
  catch { return destination.status === 'ready' ? { ...destination, cleanup: { status: 'cleanup-pending', reason: 'source-unavailable' } }
    : { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (destination.status === 'absent') {
    const sourceRecord = readRetainedConnectedAccountCatalogRecordV1(source.raw, input.key);
    if (sourceRecord.status !== 'ready') return sourceRecord;
    let receipt: ConnectedAccountCatalogRowMutationResponseV1 | undefined;
    try { receipt = await input.transfer.initializeRecord({ record: sourceRecord.record, expectedRevision: 'absent', sourceSettingsVersion: source.version }); }
    catch { /* Ambiguous transport outcome is decided by the actual row read below. */ }
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    destination = await readDestination(input);
    if (destination.status === 'unavailable') return destination;
    if (destination.status === 'absent') return { status: 'unavailable', reason: receipt?.status === 'settings-conflict'
      ? 'source-version-conflict' : receipt && receipt.status !== 'updated' && receipt.status !== 'conflict' ? receipt.status : 'authority-not-confirmed' };
    await input.onReadyBeforeCleanup?.(destination);
  }
  return { ...destination, cleanup: await cleanupSource(input, source) };
}
