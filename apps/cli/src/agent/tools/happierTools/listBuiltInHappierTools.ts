import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface, listPluginActionBackedTools } from './actionToolCatalog';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import type { ActionId, ActionsSettingsV1 } from '@happier-dev/protocol';

export type BuiltInHappierToolsSurface = 'mcp' | 'cli' | 'session_agent';

function dedupeToolsByName<T extends Readonly<{ name: string }>>(tools: readonly T[]): readonly T[] {
  const deduped = new Map<string, T>();
  for (const tool of tools) {
    if (deduped.has(tool.name)) {
      continue;
    }
    deduped.set(tool.name, tool);
  }
  return [...deduped.values()];
}

export function listBuiltInHappierTools(params?: Readonly<{
  surface?: BuiltInHappierToolsSurface;
  registry?: ResolvedContributionRegistry;
  isActionEnabled?: (id: ActionId) => boolean;
  actionsSettings?: ActionsSettingsV1 | null;
}>) {
  const surface = params?.surface ?? 'session_agent';
  const shouldReadEnvSettings = !params?.isActionEnabled && !Object.prototype.hasOwnProperty.call(params ?? {}, 'actionsSettings');
  const actionsSettings = params?.actionsSettings ?? (shouldReadEnvSettings ? readActionsSettingsFromEnv() as ActionsSettingsV1 : null);
  const isActionEnabled = params?.isActionEnabled ?? ((id: ActionId) => isActionEnabledByEnv(id, { surface }));
  return dedupeToolsByName([
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      { surface, isActionEnabled, actionsSettings, registry: params?.registry },
    ),
    ...listPluginActionBackedTools({ registry: params?.registry }).filter(
      (tool) => filterBuiltInToolsForSurface([tool], { surface, isActionEnabled, actionsSettings, registry: params?.registry }).length === 1,
    ),
  ]);
}
