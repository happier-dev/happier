import {
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  type AccountSettings,
  type ActionId,
  type ActionSurfaces,
} from '@happier-dev/protocol';

import {
  createActionSettingsProvider,
  type ActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';

/** @deprecated Use the settings-owned ActionSettingsProvider outside MCP. */
export type McpActionSettingsProvider = ActionSettingsProvider;

/** @deprecated Use createActionSettingsProvider outside MCP. */
export const createMcpActionSettingsProvider = createActionSettingsProvider;

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
}>): (id: ActionId) => boolean {
  const provider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  return (id) =>
    isApprovalRequiredByActionsSettings(id, provider.getActionsSettings(), {
      surface: params.surface,
    });
}
