import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import {
  filterBuiltInToolsForSurface,
  listPluginActionBackedTools,
  resolveActionToolCatalogAvailability,
} from './actionToolCatalog';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import type { ActionId, ActionsSettingsV1 } from '@happier-dev/protocol';

export type BuiltInHappierToolsSurface = 'mcp' | 'cli' | 'agent';

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
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  isActionEnabled?: (id: ActionId) => boolean;
  actionsSettings?: ActionsSettingsV1 | null;
  requiredDirectActionIds?: readonly ActionId[];
}>) {
  const surface = params?.surface ?? 'agent';
  const shouldReadEnvSettings = !params?.isActionEnabled && !Object.prototype.hasOwnProperty.call(params ?? {}, 'actionsSettings');
  const actionsSettings = params?.actionsSettings ?? (shouldReadEnvSettings ? readActionsSettingsFromEnv() as ActionsSettingsV1 : null);
  const isActionEnabled = params?.isActionEnabled ?? ((id: ActionId) => isActionEnabledByEnv(id, { surface }));
  const requiredDirectActionIds = new Set(params?.requiredDirectActionIds ?? []);
  const explicitlyDiscoverableOnly = (actionId: ActionId): boolean => (
    actionsSettings?.actions?.[actionId]?.toolExposureModes?.agent === 'discoverable_only'
  );
  const requiredTools = surface === 'agent'
    ? HAPPIER_BUILT_IN_TOOLS.filter((tool) => {
        const actionId = tool.actionId as ActionId | undefined;
        if (!actionId || !requiredDirectActionIds.has(actionId) || explicitlyDiscoverableOnly(actionId)) {
          return false;
        }
        return resolveActionToolCatalogAvailability({
          actionId,
          surface,
          isActionEnabled,
          actionsSettings,
          registry: params?.registry,
          pluginToolCatalog: params?.pluginToolCatalog,
        }).available;
      })
    : [];
  return dedupeToolsByName([
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      {
        surface,
        isActionEnabled,
        actionsSettings,
        registry: params?.registry,
        pluginToolCatalog: params?.pluginToolCatalog,
      },
    ),
    ...listPluginActionBackedTools({
      registry: params?.registry,
      pluginToolCatalog: params?.pluginToolCatalog,
    }).filter(
      (tool) => filterBuiltInToolsForSurface([tool], {
        surface,
        isActionEnabled,
        actionsSettings,
        registry: params?.registry,
        pluginToolCatalog: params?.pluginToolCatalog,
      }).length === 1,
    ),
    ...requiredTools,
  ]);
}
