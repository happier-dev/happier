import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface, listPluginActionBackedTools } from './actionToolCatalog';
import type { ResolvedContributionRegistry } from '@/extensions/registry/types';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';

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
}>) {
  const surface = params?.surface ?? 'session_agent';
  return dedupeToolsByName([
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      { surface, isActionEnabled: (id) => isActionEnabledByEnv(id, { surface }), registry: params?.registry },
    ),
    ...listPluginActionBackedTools({ registry: params?.registry }).filter(
      (tool) => filterBuiltInToolsForSurface([tool], { surface, registry: params?.registry }).length === 1,
    ),
  ]);
}
