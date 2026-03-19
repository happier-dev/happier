import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForMcpSurface } from './mcpActionToolCatalog';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';

export function listBuiltInHappierTools() {
  return [
    ...filterBuiltInToolsForMcpSurface(
      HAPPIER_BUILT_IN_TOOLS,
      (id) => isActionEnabledByEnv(id, { surface: 'mcp' }),
    ),
  ];
}
