import {
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  type AccountSettings,
  type ActionId,
  type ActionSurfaces,
} from '@happier-dev/protocol';

import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

export function createMcpActionEnablement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const actionsSettings = params.accountSettings?.actionsSettingsV1 ?? null;
  if (actionsSettings) {
    return (id) => isActionEnabledByActionsSettings(id, actionsSettings, {
      surface: params.surface,
      placement: null,
    });
  }

  return (id) => isActionEnabledByEnv(id, { surface: params.surface });
}

export function createMcpActionApprovalRequirement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const actionsSettings = params.accountSettings?.actionsSettingsV1 ?? null;
  if (actionsSettings) {
    return (id) => isApprovalRequiredByActionsSettings(id, actionsSettings, {
      surface: params.surface,
    });
  }

  return (id) => isActionApprovalRequiredByEnv(id, { surface: params.surface });
}
