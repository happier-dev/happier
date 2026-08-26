import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface } from './actionToolCatalog';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import type { ActionId, ActionsSettingsV1 } from '@happier-dev/protocol';

export type BuiltInHappierToolsSurface = 'mcp' | 'cli' | 'session_agent';

export function listBuiltInHappierTools(params?: Readonly<{
  surface?: BuiltInHappierToolsSurface;
  isActionEnabled?: (id: ActionId) => boolean;
  actionsSettings?: ActionsSettingsV1 | null;
  requiredDirectActionIds?: readonly ActionId[];
}>) {
  const surface = params?.surface ?? 'session_agent';
  const actionsSettings = params?.actionsSettings ?? readActionsSettingsFromEnv();
  const isActionEnabled = params?.isActionEnabled ?? ((id: ActionId) => isActionEnabledByEnv(id, { surface }));
  return [
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      {
        surface,
        isActionEnabled,
        actionsSettings,
        requiredDirectActionIds: params?.requiredDirectActionIds,
      },
    ),
  ];
}
