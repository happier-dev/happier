import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { dispatchMachineVitalsAlertNotificationAsync, type MachineVitalsAlertNotificationDispatchParamsV1 } from './dispatchMachineVitalsAlertNotification';

type ActiveAccountNotificationInput = Omit<MachineVitalsAlertNotificationDispatchParamsV1,
  'settings' | 'settingsSecretsReadKeys' | 'notificationChannelCatalog' | 'savedSecretMaterializer' | 'operationContext'> & Readonly<{
    credentials: StoredCredentials;
  }>;

/** The daemon's Account notification demand, shared by every vitals rule. */
export async function dispatchActiveAccountMachineVitalsAlertNotificationAsync(input: ActiveAccountNotificationInput) {
  const { credentials, isCurrent, ...delivery } = input;
  const snapshot = getActiveAccountSettingsSnapshot();
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  if (!snapshot || snapshot.scopeKey !== scopeKey) {
    throw new Error('machine_vitals_notification_account_unavailable');
  }
  const incumbent = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
  // The notification owner hydrates on demand and captures its ready catalog
  // and secret material together. That publication is not Account retirement.
  return dispatchMachineVitalsAlertNotificationAsync({ ...delivery,
    settings: snapshot.settings, settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
    isCurrent: async signal => isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent) && (!isCurrent || await isCurrent(signal)),
  });
}
