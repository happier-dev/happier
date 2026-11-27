import {
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  type AccountSettings,
  type ActionId,
  type ActionSurfaces,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const EMPTY_ACTIONS_SETTINGS: ActionsSettingsV1 = Object.freeze({
  v: 1,
  actions: {},
}) as ActionsSettingsV1;

export type McpActionSettingsProvider = Readonly<{
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

export function createMcpActionSettingsProvider(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
}> = {}): McpActionSettingsProvider {
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
        return accountSettings.actionsSettingsV1 ?? EMPTY_ACTIONS_SETTINGS;
      }
      return readActionsSettingsFromEnv() as ActionsSettingsV1;
    },
  };
}

export function createMcpActionEnablement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  actionSettingsProvider?: McpActionSettingsProvider | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const provider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  return (id) =>
    isActionEnabledByActionsSettings(id, provider.getActionsSettings(), {
      surface: params.surface,
      placement: null,
    });
}

export function createMcpActionApprovalRequirement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  actionSettingsProvider?: McpActionSettingsProvider | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId, defaultRequired?: boolean) => boolean {
  const provider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  return (id, defaultRequired) =>
    isApprovalRequiredByActionsSettings(id, provider.getActionsSettings(), {
      surface: params.surface,
    }, defaultRequired);
}
