import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface } from './actionToolCatalog';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';

export function listBuiltInHappierTools(params?: Readonly<{ surface?: 'mcp' | 'cli' }>) {
  const surface = params?.surface ?? 'mcp';
  return [
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      { surface, isActionEnabled: (id) => isActionEnabledByEnv(id, { surface }) },
    ),
  ];
}
