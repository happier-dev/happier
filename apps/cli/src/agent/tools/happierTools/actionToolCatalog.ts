import { listActionSpecs, type ActionId } from '@happier-dev/protocol';

import type { HappierBuiltInToolDefinition } from './types';

type ActionEnabledPredicate = (id: ActionId) => boolean;
type HappierBuiltInToolSurface = 'mcp' | 'cli' | 'session_agent';

const ACTION_TOOL_ENTRIES = Object.freeze(
  listActionSpecs()
    .map((spec) => ({
      id: spec.id as ActionId,
      toolName: String(spec.bindings?.mcpToolName ?? '').trim(),
      surfaces: spec.surfaces,
    }))
    .filter((entry) => entry.toolName.length > 0),
);

const ACTION_TOOL_NAMES = new Set(ACTION_TOOL_ENTRIES.map((entry) => entry.toolName));
const ACTION_SURFACES_BY_ID = new Map(
  listActionSpecs().map((spec) => [spec.id as ActionId, spec.surfaces] as const),
);

export function isActionAvailableOnToolSurface(params: Readonly<{
  actionId: ActionId;
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
}>): boolean {
  const surface = params.surface ?? 'session_agent';
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  const surfaces = ACTION_SURFACES_BY_ID.get(params.actionId);
  if (!surfaces) {
    return false;
  }
  return surfaces[surface] === true && isActionEnabled(params.actionId);
}

export function createActionToolNameToIdMap(params?: Readonly<{
  surface?: HappierBuiltInToolSurface;
  isActionEnabled?: ActionEnabledPredicate;
}>): ReadonlyMap<string, ActionId> {
  const surface = params?.surface ?? 'session_agent';

  return new Map(
    ACTION_TOOL_ENTRIES
      .filter((entry) => isActionAvailableOnToolSurface({
        actionId: entry.id,
        surface,
        isActionEnabled: params?.isActionEnabled,
      }))
      .map((entry) => [entry.toolName, entry.id] as const),
  );
}

export function filterBuiltInToolsForSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  params?: Readonly<{
    surface?: HappierBuiltInToolSurface;
    isActionEnabled?: ActionEnabledPredicate;
  }>,
): readonly HappierBuiltInToolDefinition[] {
  const enabledActionToolNames = new Set(createActionToolNameToIdMap(params).keys());

  return tools.filter((tool) => {
    if (!ACTION_TOOL_NAMES.has(tool.name)) return true;
    return enabledActionToolNames.has(tool.name);
  });
}
