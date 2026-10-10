import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { beginActiveNotificationChannelCatalogRefresh, commitActiveNotificationChannelCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliNotificationChannelStore } from './notificationChannelStore';

/** A real daemon/bootstrap demand, admitted to the captured Account lifetime. */
export async function hydrateNotificationChannelCatalogForActiveAccount(input: Readonly<{
  credentials: StoredCredentials; signal?: AbortSignal; scopeKey?: string; lifetimeToken?: number;
}>): Promise<NotificationChannelCatalogSnapshotV1> {
  const scopeKey = input.scopeKey ?? resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = input.lifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken();
  const current = () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
    && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken;
  if (!current() || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  beginActiveNotificationChannelCatalogRefresh({ scopeKey, lifetimeToken });
  const catalog = await createCliNotificationChannelStore(input).readNotificationChannelCatalog(async ready => {
    if (current()) commitActiveNotificationChannelCatalog({ scopeKey, lifetimeToken, catalog: ready });
  });
  if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
  commitActiveNotificationChannelCatalog({ scopeKey, lifetimeToken, catalog });
  return catalog;
}

export async function refreshDemandedActiveNotificationChannelCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot?.scopeKey) return;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await hydrateNotificationChannelCatalogForActiveAccount({ ...input, credentials, scopeKey: snapshot.scopeKey, lifetimeToken });
}
