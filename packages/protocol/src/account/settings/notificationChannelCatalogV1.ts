import { deriveSettingsSecretsKeySetV1, decryptSecretValueWithKeysV1 } from '../../crypto/settingsSecretStringsV1.js';
import type { AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { deriveSavedSecretImportResourceIdV1 } from './savedSecretMutationOwner.js';
import { formatSharedSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { SavedSecretResourceContentV1Schema } from './savedSecretResourceContentSchemaV1.js';
import { hasConfiguredSecretStringValue } from './notificationChannels.js';
import { readLegacyNotificationChannelInventoryV1, openNotificationChannelCatalogContentV1, isCompleteLegacyNotificationChannelSourceV1,
  type NotificationChannelRecordV1, type NotificationChannelCatalogRecordV1,
  type NotificationChannelCatalogDiagnosticV1, type NotificationChannelCatalogSnapshotV1,
  type NotificationChannelCatalogUnavailableReasonV1,
  type NotificationChannelCatalogReadResponseV1, type NotificationChannelCatalogMutationResponseV1Schema } from './notificationChannelRecordV1.js';

export type NotificationChannelSigningSecretPreparationV1 = Readonly<{
  resourceId: string; value: string; displayName: string; kind: 'other';
}>;
export type NotificationChannelSourcePreparationV1 = Readonly<{ status: 'ready'; record: NotificationChannelCatalogRecordV1;
  signingSecrets: readonly NotificationChannelSigningSecretPreparationV1[] }>
  | Readonly<{ status: 'partial'; record: NotificationChannelCatalogRecordV1; diagnostics: readonly NotificationChannelCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' }>;

/** Exact predecessor bytes move once; neither plaintext nor ciphertext becomes a row credential. */
export function prepareLegacyNotificationChannelCatalogV1(input: Readonly<{
  accountId: string; raw: Readonly<Record<string, unknown>>;
  settingsSecretsReadKeys: readonly (Uint8Array | null | undefined)[];
}>): NotificationChannelSourcePreparationV1 {
  const source = readLegacyNotificationChannelInventoryV1(input.raw);
  if (source.status === 'unavailable') return source;
  const diagnostics: NotificationChannelCatalogDiagnosticV1[] = source.status === 'partial' ? [...source.diagnostics] : [];
  const signingSecrets: NotificationChannelSigningSecretPreparationV1[] = [];
  const channels: NotificationChannelRecordV1[] = source.channels.map(channel => {
    if (channel.kind === 'expo_push') return channel;
    const { signingSecret, ...record } = channel;
    if (!hasConfiguredSecretStringValue(signingSecret)) return { ...record, signingSecretRef: null };
    const resourceId = deriveSavedSecretImportResourceIdV1({ accountId: input.accountId,
      source: { kind: 'notification-channel-signing-secret', channelId: channel.id } });
    const value = decryptSecretValueWithKeysV1(signingSecret, input.settingsSecretsReadKeys);
    const content = value === null ? null : SavedSecretResourceContentV1Schema.safeParse({
      v: 1, name: 'Webhook signing secret', kind: 'other', value,
    });
    if (!content?.success) diagnostics.push({ channelId: channel.id, reason: 'secret-unavailable' });
    else signingSecrets.push({ resourceId, value: content.data.value, displayName: content.data.name, kind: 'other' });
    return { ...record, signingSecretRef: formatSharedSavedSecretRefV1(resourceId) };
  });
  const record = { v: 1 as const, channels };
  return diagnostics.length ? { status: 'partial', record, diagnostics } : { status: 'ready', record, signingSecrets };
}

type SourceSettingsMutationResult = Readonly<{ status: 'applied'; settingsVersion: number }>
  | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
  | Readonly<{ status: 'outcomeUnknown'; lastKnownSettingsVersion: number }>
  | Readonly<{ status: 'rejected' }>;

export type NotificationChannelSourceTransferV1 = Readonly<{
  accountId: string;
  readSourceSnapshot(): Promise<Readonly<{ raw: Readonly<Record<string, unknown>>; version: number }>>;
  /** A composite Resource receipt has no row cursor; destination authority is always read back. */
  initializeRecord(input: Readonly<{ record: NotificationChannelCatalogRecordV1; expectedRevision: 'absent'; sourceSettingsVersion: number;
    signingSecrets: readonly NotificationChannelSigningSecretPreparationV1[] }>): Promise<
    ReturnType<typeof NotificationChannelCatalogMutationResponseV1Schema.parse>
    | Extract<SourceSettingsMutationResult, { status: 'applied' }>>;
  /** The SavedSecret owner proves owned, usable deterministic resources with the exact current source material. */
  admitSourceCleanup?(prepared: Extract<NotificationChannelSourcePreparationV1, { status: 'ready' }>): Promise<boolean>;
  replaceSource?(input: Readonly<{ raw: Readonly<Record<string, unknown>>; expectedVersion: number }>): Promise<SourceSettingsMutationResult>;
  normalizeHistory?(input: Readonly<{ activeTransferredRoots: readonly string[];
    activePrivateCatalogRevisions: Readonly<{ notificationChannels: number }> }>): Promise<
    Readonly<{ status: 'complete' }> | Readonly<{ status: 'cleanup-pending'; versions: readonly number[] }>>;
}>;
type LoadInput = Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; signal?: AbortSignal;
  settingsSecretsReadKeys?: readonly (Uint8Array | null | undefined)[];
  readRow(): Promise<NotificationChannelCatalogReadResponseV1>;
  transfer?: NotificationChannelSourceTransferV1;
  onReadyBeforeCleanup?: (catalog: Extract<NotificationChannelCatalogSnapshotV1, { status: 'ready' }>) => Promise<void>;
  hasPendingCleanup?: () => boolean;
}>;
type ReadCatalog = NotificationChannelCatalogSnapshotV1 | Readonly<{ status: 'absent' }>;
function readFailureReason(error: unknown, signal?: AbortSignal): NotificationChannelCatalogUnavailableReasonV1 {
  if (signal?.aborted) return 'cancelled';
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  switch (code) {
    case 'unauthorized': case 'forbidden': case 'unsupported': case 'scope-retired':
    case 'account-mode-mismatch': case 'encryption-material-unavailable': case 'invalid-stored-content':
      return code;
    default: return 'unreachable';
  }
}
async function readCatalog(input: LoadInput): Promise<ReadCatalog> {
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  if (input.mode === 'e2ee' && input.material === null) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  const row = await input.readRow();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (row.status === 'absent') return row;
  if (row.status === 'deleted') return { status: 'ready', channels: [], revision: row.revision, diagnostics: [] };
  if (row.status !== 'present') return { status: 'unavailable', reason: row.status };
  const opened = openNotificationChannelCatalogContentV1({ ...input, content: row.content });
  if (opened.status === 'unavailable') return opened;
  return opened.status === 'partial'
    ? { status: 'partial', channels: opened.record.channels, revision: row.revision, diagnostics: opened.diagnostics }
    : { status: 'ready', channels: opened.record.channels, revision: row.revision, diagnostics: [] };
}

/** The sole small-row CAS establishes authority; presence or deletion never derives a replacement push row. */
export async function loadNotificationChannelCatalogV1(input: LoadInput): Promise<NotificationChannelCatalogSnapshotV1> {
  try {
    let catalog = await readCatalog(input);
    const transfer = input.transfer;
    if (catalog.status !== 'absent' && catalog.status !== 'ready' || !transfer) {
      return catalog.status === 'absent' ? { status: 'unavailable', reason: 'authority-not-confirmed' } : catalog;
    }
    if (catalog.status === 'ready') {
      await input.onReadyBeforeCleanup?.(catalog);
      if (input.hasPendingCleanup?.()) return catalog;
    }
    let source: Awaited<ReturnType<NotificationChannelSourceTransferV1['readSourceSnapshot']>>;
    try { source = await transfer.readSourceSnapshot(); }
    catch { return catalog.status === 'ready' ? { ...catalog, cleanup: { status: 'cleanup-pending' } }
      : { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'unreachable' }; }
    if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    const prepared = prepareLegacyNotificationChannelCatalogV1({ accountId: transfer.accountId, raw: source.raw,
      settingsSecretsReadKeys: input.settingsSecretsReadKeys ?? (input.material ? deriveSettingsSecretsKeySetV1(input.material).readKeys : []) });
    if (catalog.status === 'absent') {
      if (prepared.status === 'unavailable') return prepared;
      if (prepared.status === 'partial') return { status: 'partial', channels: prepared.record.channels,
        revision: 'absent', diagnostics: prepared.diagnostics };
      let sourceConflict = false;
      try {
        const receipt = await transfer.initializeRecord({ record: prepared.record, signingSecrets: prepared.signingSecrets,
          expectedRevision: 'absent', sourceSettingsVersion: source.version });
        sourceConflict = receipt.status === 'settings-conflict';
      } catch { /* Unknown outcomes are read back, never blindly replayed. */ }
      catalog = await readCatalog(input);
      if (catalog.status === 'absent') return { status: 'unavailable', reason: sourceConflict ? 'source-version-conflict' : 'authority-not-confirmed' };
      if (catalog.status !== 'ready') return catalog;
      await input.onReadyBeforeCleanup?.(catalog);
      if (input.hasPendingCleanup?.()) return catalog;
    }
    if (prepared.status !== 'ready' || !isCompleteLegacyNotificationChannelSourceV1(source.raw)
      || !transfer.replaceSource || !transfer.normalizeHistory) {
      return { ...catalog, cleanup: { status: 'cleanup-pending' } };
    }
    try {
      if (prepared.signingSecrets.length && (!transfer.admitSourceCleanup || !await transfer.admitSourceCleanup(prepared))) {
        return { ...catalog, cleanup: { status: 'cleanup-pending' } };
      }
      const raw = { ...source.raw };
      if (Object.hasOwn(raw, 'notificationChannelsV1')) {
        delete raw.notificationChannelsV1;
        const receipt = await transfer.replaceSource({ raw, expectedVersion: source.version });
        if (receipt.status !== 'applied') return { ...catalog, cleanup: { status: 'cleanup-pending' } };
      }
      if (input.signal?.aborted) return { ...catalog, cleanup: { status: 'cleanup-pending' } };
      const history = await transfer.normalizeHistory({ activeTransferredRoots: ['notificationChannelsV1'],
        activePrivateCatalogRevisions: { notificationChannels: catalog.revision } });
      return { ...catalog, cleanup: { status: history.status } };
    } catch { return { ...catalog, cleanup: { status: 'cleanup-pending' } }; }
  } catch (error) {
    return { status: 'unavailable', reason: readFailureReason(error, input.signal) };
  }
}
