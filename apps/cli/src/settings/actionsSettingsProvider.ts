import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { AccountSettings, ActionsSettingsV1 } from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';
import { resolveActionsSettingsWithEnvironmentOverride } from './actionsSettings';

/** Narrow host-reviewed policy accepted by ordinary and restricted runtime constructors. */
export type RuntimeActionSettingsProvider = Readonly<{
  getActionsSettings: () => ActionsSettingsV1;
  getAccountSettings?: () => AccountSettings | null;
}>;

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
 * Credential-scoped runtimes consume only their bound Account policy. Unscoped
 * ordinary CLI consumers retain the explicit environment override, then the
 * live/injected Account snapshot and defaults.
 */
export function createActionSettingsProvider(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  /** Credential-derived Account scope for long-lived runtime policy. */
  scopeKey?: string | null;
}> = {}): ActionSettingsProvider {
  const initialSnapshot = getActiveAccountSettingsSnapshot();
  const scopeKey = params.scopeKey ?? null;
  let boundSettings = scopeKey && initialSnapshot?.scopeKey === scopeKey
    ? initialSnapshot.settings
    : params.accountSettings ?? null;
  const getAccountSettings = (): AccountSettings | null => {
    const current = getActiveAccountSettingsSnapshot();
    // A different active Account cannot retarget an already constructed runtime.
    // Unscoped snapshots cannot prove correspondence with a later publication.
    if (scopeKey) {
      if (current?.scopeKey === scopeKey) boundSettings = current.settings;
      return boundSettings;
    }
    return readAccountSettingsSafely(params.getAccountSettings)
      ?? current?.settings
      ?? params.accountSettings
      ?? null;
  };
  return {
    getAccountSettings,
    getActionsSettings: () => {
      const accountSettings = getAccountSettings();
      return scopeKey
        ? normalizeActionsSettingsV1(accountSettings?.actionsSettingsV1)
        : resolveActionsSettingsWithEnvironmentOverride(accountSettings ?? {});
    },
  };
}
