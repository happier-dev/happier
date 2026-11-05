import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { AccountSettings, ActionsSettingsV1 } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';

import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides, readAccountRoleOverridesFromSnapshot, type ActiveAccountSettingsSnapshot } from './accountSettings/activeAccountSettingsSnapshot';
import { readActionsSettingsOverrideFromEnv } from './actionsSettings';

/** Narrow host-reviewed policy accepted by ordinary and restricted runtime constructors. */
export type RuntimeActionSettingsProvider = Readonly<{
  getActionsSettings: () => ActionsSettingsV1;
  getAccountSettings?: () => AccountSettings | null;
  getAccountRoleOverrides?: () => AccountRoleOverridesReadV1;
}>;

export type ActionSettingsProvider = Readonly<{
  getAccountSettings: () => AccountSettings | null;
  getActionsSettings: () => ActionsSettingsV1;
  getAccountRoleOverrides: () => AccountRoleOverridesReadV1;
}>;

/** Invocation-owned policy follows its retained Account reader, never the focused host Account. */
export function createSnapshotActionSettingsProvider(readSnapshot: () => ActiveAccountSettingsSnapshot): ActionSettingsProvider {
  return {
    getActionsSettings: () => readSnapshot().settings.actionsSettingsV1,
    getAccountSettings: () => readSnapshot().settings,
    getAccountRoleOverrides: () => readAccountRoleOverridesFromSnapshot(readSnapshot()),
  };
}

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
  /** Session ingress retains host policy rather than standalone CLI environment policy. */
  allowEnvironmentOverride?: boolean;
}> = {}): ActionSettingsProvider {
  const initialSnapshot = getActiveAccountSettingsSnapshot();
  const scopeKey = params.scopeKey ?? null;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  let boundSettings = scopeKey && initialSnapshot?.scopeKey === scopeKey && initialSnapshot.source !== 'none'
    ? initialSnapshot.settings
    : params.accountSettings ?? null;
  const getAccountSettings = (): AccountSettings | null => {
    const current = getActiveAccountSettingsSnapshot();
    // A different active Account cannot retarget an already constructed runtime.
    // Unscoped snapshots cannot prove correspondence with a later publication.
    if (scopeKey) {
      // A private invocation's admitted getter is its bound authority. A retired
      // getter must not fall back to a focused Account or cached preferences.
      if (params.getAccountSettings) return readAccountSettingsSafely(params.getAccountSettings);
      if (current?.scopeKey === scopeKey) boundSettings = current.source === 'none' ? null : current.settings;
      return boundSettings;
    }
    return readAccountSettingsSafely(params.getAccountSettings)
      ?? (current && current.source !== 'none' ? current.settings : null)
      ?? params.accountSettings
      ?? null;
  };
  return {
    getAccountSettings,
    getAccountRoleOverrides: () => {
      const current = getActiveAccountSettingsSnapshot();
      const roleScope = scopeKey ?? current?.scopeKey;
      if (!roleScope) return { status: 'unavailable', reason: 'source-unavailable' };
      return readActiveAccountRoleOverrides({ scopeKey: roleScope,
        lifetimeToken: scopeKey ? lifetimeToken : getActiveAccountSettingsSnapshotLifetimeToken() });
    },
    getActionsSettings: () => {
      const accountSettings = getAccountSettings();
      // AccountSettings was admitted by the Account source. Re-read its current
      // projection without re-parsing and rebuilding the whole policy per check.
      const override = !scopeKey && params.allowEnvironmentOverride !== false
        ? readActionsSettingsOverrideFromEnv() : null;
      return override ?? accountSettings?.actionsSettingsV1 ?? normalizeActionsSettingsV1(undefined);
    },
  };
}
