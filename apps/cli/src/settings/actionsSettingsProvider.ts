import {
  type AccountSettings,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';
import { resolveActionsSettingsWithEnvironmentOverride } from './actionsSettings';

export type ActionSettingsProvider = Readonly<{
  getAccountSettings: () => AccountSettings | null;
  getActionsSettings: () => ActionsSettingsV1;
}>;

function readAccountSettingsSafely(getAccountSettings?: (() => AccountSettings | null) | null): AccountSettings | null {
  if (!getAccountSettings) return null;
  try {
    return getAccountSettings() ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves one precedence order for every CLI consumer: an explicit environment
 * override, then the live Account snapshot, then the injected snapshot/defaults.
 */
export function createActionSettingsProvider(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
}> = {}): ActionSettingsProvider {
  return {
    getAccountSettings: () =>
      readAccountSettingsSafely(params.getAccountSettings)
        ?? getActiveAccountSettingsSnapshot()?.settings
        ?? params.accountSettings
        ?? null,
    getActionsSettings: () => {
      const accountSettings =
        readAccountSettingsSafely(params.getAccountSettings)
          ?? getActiveAccountSettingsSnapshot()?.settings
          ?? params.accountSettings
          ?? null;
      return resolveActionsSettingsWithEnvironmentOverride(accountSettings ?? {});
    },
  };
}
