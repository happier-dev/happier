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

/** Coalesce first demand and content-free row hints within the incumbent Account lifetime. */
export function refreshActiveConnectedAccountCatalog(input: Readonly<{
  credentials: StoredCredentials; key: ConnectedAccountCatalogKeyV1; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  authorizeRequest?: Parameters<typeof createCliConnectedAccountCatalogStore>[0]['authorizeRequest'];
}>, reobserve = false): Promise<ConnectedAccountCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = context?.readSnapshot()?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const workKey = `${scopeKey}:${lifetimeToken}:${input.key}`;
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
  work = (async () => {
    while (true) {
      if (!context) reloadAfterPending.delete(workKey);
      let catalog: ConnectedAccountCatalogSnapshotV1;
      try {
        catalog = await store.readCatalog(input.key, async ready => {
          if (context || !reloadAfterPending.has(workKey)) await publish(ready);
        });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        const reason: ConnectedAccountCatalogUnavailableReasonV1 = input.signal?.aborted ? 'cancelled'
          : code === 'scope-retired' || code === 'unauthorized' || code === 'forbidden' || code === 'unsupported'
            || code === 'account-mode-mismatch' ? code
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable'
            ? 'encryption-material-unavailable'
          : error instanceof Error && error.name === 'ZodError' ? 'invalid-stored-content' : 'unreachable';
        catalog = { status: 'unavailable', reason };
      }
      if (!context && reloadAfterPending.has(workKey)) continue;
      try {
        if (!await publish(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      } catch { return { status: 'unavailable', reason: 'scope-retired' }; }
      return catalog;
    }
  })().finally(() => {
    if (pending.get(workKey) === work) { pending.delete(workKey); reloadAfterPending.delete(workKey); }
  });
  if (!context) pending.set(workKey, work);
  return work;
}

export async function readActiveConnectedAccountCatalog(input: Parameters<typeof refreshActiveConnectedAccountCatalog>[0]) {
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const expectedScope = input.operationContext?.readSnapshot()?.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  if (!snapshot || snapshot.scopeKey !== expectedScope
    || input.operationContext && !await input.operationContext.isCurrent()
    || !input.operationContext && lifetime !== getActiveAccountSettingsSnapshotLifetimeToken()) {
    return { status: 'unavailable' as const, reason: 'scope-retired' as const };
  }
  const current = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  if (current?.scopeKey !== expectedScope) return { status: 'unavailable' as const, reason: 'scope-retired' as const };
  const catalog = readConnectedAccountCatalogFromSnapshot(current, input.key);
  return catalog.status === 'loading' ? refreshActiveConnectedAccountCatalog(input) : catalog;
}

/** Existing Account observer only refreshes domains already demanded by a live consumer. */
export async function refreshDemandedActiveConnectedAccountCatalogs(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  const keys: ConnectedAccountCatalogKeyV1[] = [
    ...(snapshot?.connectedConfigurationCatalog ? ['configurations' as const] : []),
    ...(snapshot?.connectedPurposeCatalog ? ['purposes' as const] : []),
  ];
  if (keys.length === 0) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await Promise.all(keys.map(key => refreshActiveConnectedAccountCatalog({ ...input, credentials, key }, true)));
}
