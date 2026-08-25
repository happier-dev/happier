import {
  ActionsSettingsV1Schema,
  type AccountSettings,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';
import { readActionsSettingsFromEnv } from './actionsSettings';

const EMPTY_ACTIONS_SETTINGS: ActionsSettingsV1 = Object.freeze({
  v: 1,
  actions: {},
}) as ActionsSettingsV1;

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

function normalizeActionsSettings(value: unknown): ActionsSettingsV1 {
  const parsed = ActionsSettingsV1Schema.safeParse(value);
  return parsed.success ? parsed.data as ActionsSettingsV1 : EMPTY_ACTIONS_SETTINGS;
}

/**
 * Reads the live Account settings snapshot when one is available. Environment
 * settings remain only a fallback for contexts without an Account snapshot.
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
      if (accountSettings) {
        return normalizeActionsSettings(accountSettings.actionsSettingsV1 ?? EMPTY_ACTIONS_SETTINGS);
      }
      return readActionsSettingsFromEnv() as ActionsSettingsV1;
    },
  };
}
