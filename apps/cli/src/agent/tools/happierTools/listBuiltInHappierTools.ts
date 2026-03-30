import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface } from './actionToolCatalog';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';

export type BuiltInHappierToolsSurface = 'mcp' | 'cli' | 'session_agent';

export function listBuiltInHappierTools(params?: Readonly<{ surface?: BuiltInHappierToolsSurface }>) {
  const surface = params?.surface ?? 'session_agent';
  return [
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      { surface, isActionEnabled: (id) => isActionEnabledByEnv(id, { surface }) },
    ),
  ];
}
