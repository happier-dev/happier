import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { beginActiveNotificationChannelCatalogRefresh, commitActiveNotificationChannelCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliNotificationChannelStore } from './notificationChannelStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

/** The invocation holder, not the process-global Account, owns runner delivery. */
export async function hydrateNotificationChannelCatalogForOperation(input: Readonly<{
  operationContext: SavedSecretOperationContextV1; signal?: AbortSignal; assertCurrent?(): Promise<void>;
  cleanupActiveSource?: false;
}>): Promise<NotificationChannelCatalogSnapshotV1> {
  const operation = input.operationContext;
  const commit = async (catalog: NotificationChannelCatalogSnapshotV1) => {
    input.signal?.throwIfAborted();
    await input.assertCurrent?.();
    const snapshot = operation.readSnapshot();
    if (!snapshot || !await operation.isCurrent(input.signal)
      || !await operation.commitNotificationChannelCatalog({ expectedSettingsVersion: snapshot.settingsVersion, catalog, signal: input.signal })) {
      throw Object.assign(new Error('Notification Account retired'), { code: 'scope-retired' });
    }
    input.signal?.throwIfAborted();
  };
  const catalog = await createCliNotificationChannelStore({ credentials: operation.credentials,
    operationContext: operation, signal: input.signal }).readNotificationChannelCatalog(commit,
    { cleanupActiveSource: input.cleanupActiveSource });
  try { await commit(catalog); }
  catch { return { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled' : 'scope-retired' }; }
  return catalog;
}

/** A real daemon/bootstrap demand, admitted to the captured Account lifetime. */
export async function hydrateNotificationChannelCatalogForActiveAccount(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; scopeKey?: string; lifetimeToken?: number; maintainSource?: false;
  cleanupActiveSource?: false;
}>): Promise<NotificationChannelCatalogSnapshotV1> {
  const scopeKey = input.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = input.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  beginActiveNotificationChannelCatalogRefresh({ scopeKey, lifetimeToken });
  const catalog = await createCliNotificationChannelStore(input).readNotificationChannelCatalog(async ready => {
    if (current()) commitActiveNotificationChannelCatalog({ scopeKey, lifetimeToken, catalog: ready });
  }, { maintainSource: input.maintainSource, cleanupActiveSource: input.cleanupActiveSource });
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  commitActiveNotificationChannelCatalog({ scopeKey, lifetimeToken, catalog });
  return catalog;
}

export async function refreshDemandedActiveNotificationChannelCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey || snapshot.notificationChannelCatalog === undefined) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await hydrateNotificationChannelCatalogForActiveAccount({ ...input, credentials, scopeKey: snapshot.scopeKey, lifetimeToken,
    ...((snapshot.notificationChannelCatalog.status === 'ready' || snapshot.notificationChannelCatalog.status === 'partial')
      && typeof snapshot.notificationChannelCatalog.revision === 'number'
      ? { maintainSource: false } : {}) });
}
