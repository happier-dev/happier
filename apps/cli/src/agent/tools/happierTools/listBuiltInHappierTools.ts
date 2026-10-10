import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import {
  filterBuiltInToolsForSurface,
  listPluginActionBackedTools,
  createActionToolNameToIdMap,
} from './actionToolCatalog';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { isActionEnabledByEnv, readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { SESSION_RUN_PROMPT_READ_ACTION_IDS_V1, SessionRunPromptReadActionIdV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { ActionId, ActionsSettingsV1, FeatureId, SessionRunPromptReadActionIdV1 } from '@happier-dev/protocol';
import type { HappierBuiltInToolDefinition } from './types';

export type BuiltInHappierToolsSurface = 'mcp' | 'cli' | 'agent';

export type HappierToolInventory = Readonly<{
  tools: readonly HappierBuiltInToolDefinition[];
  actionToolNameToId: ReadonlyMap<string, string>;
}>;

/** Both consumers use the same admitted projection, rather than filtering it again. */
export function createHappierToolInventory(params: Parameters<typeof listBuiltInHappierTools>[0]): HappierToolInventory {
  return { tools: listBuiltInHappierTools(params), actionToolNameToId: createActionToolNameToIdMap(params) };
}

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

/**
 * Projects the Session read capabilities from the exact admitted tool snapshot
 * handed to the Agent. This is descriptive prompt context only: every actual
 * call still passes through the incumbent Action policy and authority owners.
 */
export function listAdmittedSessionRunReadActionIds(
  tools: readonly HappierBuiltInToolDefinition[],
): readonly SessionRunPromptReadActionIdV1[] {
  const admitted = new Set<SessionRunPromptReadActionIdV1>();
  for (const tool of tools) {
    const parsed = SessionRunPromptReadActionIdV1Schema.safeParse(tool.actionId);
    if (parsed.success) admitted.add(parsed.data);
  }
  return Object.freeze(SESSION_RUN_PROMPT_READ_ACTION_IDS_V1.filter((actionId) => admitted.has(actionId)));
}

export function listBuiltInHappierTools(params?: Readonly<{
  surface?: BuiltInHappierToolsSurface;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  isActionEnabled?: (id: ActionId) => boolean;
  /** Exact Home feature decision for Session-scoped native tool advertisement. */
  isServerFeatureEnabled?: (id: FeatureId) => boolean;
  actionsSettings?: ActionsSettingsV1 | null;
  /** Undefined preserves Account-host exposure; Session hosts provide their choice. */
  sessionMemoryEnabled?: boolean;
  requiredDirectActionIds?: readonly ActionId[];
}>) {
  const surface = params?.surface ?? 'agent';
  const shouldReadEnvSettings = !params?.isActionEnabled && !Object.prototype.hasOwnProperty.call(params ?? {}, 'actionsSettings');
  const actionsSettings = params?.actionsSettings ?? (shouldReadEnvSettings ? readActionsSettingsFromEnv() as ActionsSettingsV1 : null);
  const isEnabledByPolicy = params?.isActionEnabled ?? ((id: ActionId) => isActionEnabledByEnv(id, { surface }));
  const isActionEnabled = (id: ActionId): boolean => {
    if (!isEnabledByPolicy(id)) return false;
    if (params?.isServerFeatureEnabled === undefined) return true;
    const requiredFeatureId = getActionRequiredServerFeatureId(id);
    if (requiredFeatureId === null) return true;
    try {
      return params.isServerFeatureEnabled(requiredFeatureId) === true;
    } catch {
      return false;
    }
  };
  return dedupeToolsByName([
    ...filterBuiltInToolsForSurface(
      HAPPIER_BUILT_IN_TOOLS,
      {
        surface,
        isActionEnabled,
        actionsSettings,
        sessionMemoryEnabled: params?.sessionMemoryEnabled,
        requiredDirectActionIds: params?.requiredDirectActionIds,
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
        sessionMemoryEnabled: params?.sessionMemoryEnabled,
        requiredDirectActionIds: params?.requiredDirectActionIds,
        registry: params?.registry,
        pluginToolCatalog: params?.pluginToolCatalog,
      }).length === 1,
    ),
  ]);
}
