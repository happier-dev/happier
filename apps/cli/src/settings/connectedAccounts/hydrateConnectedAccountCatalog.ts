import { $ZodError } from 'zod/v4/core';
import { isRetryableAccountEncryptionCurrentnessError } from '@/api/client/accountEncryptionCurrentness';
import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ConnectedAccountCatalogSnapshotV1, ConnectedAccountCatalogUnavailableReasonV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveConnectedAccountCatalogRefresh, commitActiveConnectedAccountCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  readConnectedAccountCatalogFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliConnectedAccountCatalogStore } from './connectedAccountCatalogStore';

const pending = new Map<string, Promise<ConnectedAccountCatalogSnapshotV1>>();
const reloadAfterPending = new Set<string>();

type ConnectedAccountCatalogRefreshInput = Readonly<{
  credentials: StoredCredentials; key: ConnectedAccountCatalogKeyV1; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  authorizeRequest?: Parameters<typeof createCliConnectedAccountCatalogStore>[0]['authorizeRequest'];
  readMode?: 'admitted';
}>;

type ConnectedAccountCatalogReadyObserver = (
  catalog: Extract<ConnectedAccountCatalogSnapshotV1, { status: 'ready' }>,
) => void;

/** One classification for catalog transport/opening failures, including admission bootstrap. */
export function readConnectedAccountCatalogUnavailableReason(error: unknown, signal?: AbortSignal): ConnectedAccountCatalogUnavailableReasonV1 {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return signal?.aborted ? 'cancelled'
    : code === 'scope-retired' || code === 'unauthorized' || code === 'forbidden' || code === 'unsupported'
      || code === 'account-mode-mismatch' || code === 'database_transaction_conflict_exhausted' ? code
    : isRetryableAccountEncryptionCurrentnessError(error) ? 'unreachable'
    : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable'
      ? 'encryption-material-unavailable'
    : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable';
}

/** Coalesce first demand and content-free row hints within the incumbent Account lifetime. */
export function refreshActiveConnectedAccountCatalog(
  input: ConnectedAccountCatalogRefreshInput,
  reobserve = false,
): Promise<ConnectedAccountCatalogSnapshotV1> {
  return refreshConnectedAccountCatalog(input, reobserve);
}

function refreshConnectedAccountCatalog(
  input: ConnectedAccountCatalogRefreshInput,
  reobserve: boolean,
  onReady?: ConnectedAccountCatalogReadyObserver,
): Promise<ConnectedAccountCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = context?.readSnapshot()?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const workKey = `${scopeKey}:${lifetimeToken}:${input.key}:${input.readMode ?? 'transfer'}`;
  const store = createCliConnectedAccountCatalogStore(input);
  const publish = async (catalog: ConnectedAccountCatalogSnapshotV1) => {
    store.assertCurrent();
    return context ? context.commitConnectedAccountCatalog({ key: input.key, catalog })
      : commitActiveConnectedAccountCatalog({ scopeKey, lifetimeToken, key: input.key, catalog });
  };
  if (!context) {
    const existing = pending.get(workKey);
    if (existing) {
      if (reobserve) {
        reloadAfterPending.add(workKey);
        beginActiveConnectedAccountCatalogRefresh({ scopeKey, lifetimeToken, key: input.key });
      }
      return existing;
    }
    if (!beginActiveConnectedAccountCatalogRefresh({ scopeKey, lifetimeToken, key: input.key })) {
      return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
    }
  }
  let work!: Promise<ConnectedAccountCatalogSnapshotV1>;
  work = (async (): Promise<ConnectedAccountCatalogSnapshotV1> => {
    while (true) {
      if (!context) reloadAfterPending.delete(workKey);
      let catalog: ConnectedAccountCatalogSnapshotV1;
      try {
        // Read-only Action roots consume admitted rows without source transfer
        // or history cleanup, retaining this owner's currentness/publication.
        const readTransferCatalog = () => store.readCatalog(input.key, async ready => {
          if (context || !reloadAfterPending.has(workKey)) {
            if (await publish(ready)) onReady?.(ready);
          }
        });
        catalog = input.readMode === 'admitted' ? await store.readAdmittedCatalog(input.key) : await readTransferCatalog();
        // Only the exact durable destination's absence requires activation.
        // A transient loading facet from a concurrent read is not that proof.
        if (input.readMode === 'admitted' && catalog.status === 'unavailable' && catalog.reason === 'authority-not-confirmed') {
          catalog = await readTransferCatalog();
        }
      } catch (error) {
        catalog = { status: 'unavailable', reason: readConnectedAccountCatalogUnavailableReason(error, input.signal) };
      }
      if (!context && reloadAfterPending.has(workKey)) continue;
      try {
        if (!await publish(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      } catch { return { status: 'unavailable', reason: 'scope-retired' }; }
      // Publication preserves identity for an unchanged row; consumers qualify
      // their observation against that canonical snapshot, not the parsed copy.
      const snapshot = context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
      return snapshot ? readConnectedAccountCatalogFromSnapshot(snapshot, input.key)
        : { status: 'unavailable', reason: 'scope-retired' };
    }
  })().finally(() => {
    if (pending.get(workKey) === work) { pending.delete(workKey); reloadAfterPending.delete(workKey); }
  });
  if (!context) pending.set(workKey, work);
  return work;
}

/**
 * Session admission needs the freshly reobserved authoritative row, not the
 * row owner's legacy-source/history maintenance. The same catalog load keeps
 * running that cleanup under its captured Account lifetime after publishing
 * the admitted row; no second reader or defaulting decision is introduced.
 */
export function refreshConnectedAccountCatalogForAdmission(
  input: ConnectedAccountCatalogRefreshInput & Readonly<{ operationContext: SavedSecretOperationContextV1 }>,
): Promise<ConnectedAccountCatalogSnapshotV1> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (catalog: ConnectedAccountCatalogSnapshotV1) => {
      if (settled) return;
      settled = true;
      resolve(catalog);
    };
    const cleanup = refreshConnectedAccountCatalog(input, true, settle);
    void cleanup.then(settle, () => settle({ status: 'unavailable', reason: 'unreachable' }));
  });
}

export async function readActiveConnectedAccountCatalog(input: Parameters<typeof refreshActiveConnectedAccountCatalog>[0]) {
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const expectedScope = input.operationContext?.readSnapshot()?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  if (!snapshot || snapshot.scopeKey !== expectedScope
    || input.operationContext && !await input.operationContext.isCurrent(input.signal)
    || !input.operationContext && lifetime !== getActiveAccountSettingsSnapshotLifetimeToken()) {
    return { status: 'unavailable' as const, reason: 'scope-retired' as const };
  }
  const current = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (current?.scopeKey !== expectedScope) return { status: 'unavailable' as const, reason: 'scope-retired' as const };
  // Explicit Actions can follow another client's write before its Account
  // change hint reaches this daemon (or a captured invocation snapshot).
  // Reobserve an active destination without repeating source/history maintenance;
  // only a durably absent destination needs the same activation owner.
  return refreshActiveConnectedAccountCatalog({ ...input, readMode: 'admitted' }, true);
}

/** Existing Account observer only refreshes domains already demanded by a live consumer. */
export async function refreshDemandedActiveConnectedAccountCatalogs(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  const keys: ConnectedAccountCatalogKeyV1[] = [
    ...(snapshot?.connectedConfigurationCatalog ? ['configurations' as const] : []),
    ...(snapshot?.connectedPurposeCatalog ? ['purposes' as const] : []),
  ];
  if (!snapshot || keys.length === 0) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await Promise.all(keys.map(key => refreshActiveConnectedAccountCatalog({ ...input, credentials, key, readMode: 'admitted' }, true)));
}
