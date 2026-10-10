import type { RemoteHostCatalogSnapshotV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveRemoteHostCatalogRefresh, commitActiveRemoteHostCatalog, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliRemoteHostStore, createCliRemoteHostStoreForOperation } from './remoteHostStore';
export { readActiveRemoteHostCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** Domain hydration borrows the incumbent Account publication cut. Finite reads stay private. */
export async function refreshActiveRemoteHostCatalog(input: Readonly<{
  credentials: StoredCredentials; operationContext?: SavedSecretOperationContextV1; signal?: AbortSignal;
}>): Promise<RemoteHostCatalogSnapshotV1> {
  const operationContext = input.operationContext;
  if (operationContext) return runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl,
    () => createCliRemoteHostStoreForOperation({ operationContext, signal: input.signal }).readCatalog());
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  if (!beginActiveRemoteHostCatalogRefresh({ scopeKey, lifetimeToken })) return { status: 'unavailable', reason: 'scope-retired' };
  let catalog: RemoteHostCatalogSnapshotV1;
  try { catalog = await createCliRemoteHostStore(input).readCatalog(); }
  catch { catalog = { status: 'unavailable', reason: 'remote_host_catalog_unavailable' }; }
  if (!commitActiveRemoteHostCatalog({ scopeKey, lifetimeToken, catalog })) return { status: 'unavailable', reason: 'scope-retired' };
  return catalog;
}

export async function refreshDemandedActiveRemoteHostCatalog(signal?: AbortSignal): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.remoteHostCatalog) return;
  const credentials = await readStoredCredentials();
  if (!credentials || resolveAccountSettingsScopeKey(credentials) !== snapshot.scopeKey) return;
  await refreshActiveRemoteHostCatalog({ credentials, signal });
}
