import { listActionSpecs, type ActionId } from '@happier-dev/protocol';

import type { HappierBuiltInToolDefinition } from './types';

type ActionEnabledPredicate = (id: ActionId) => boolean;

const MCP_ACTION_TOOL_ENTRIES = Object.freeze(
  listActionSpecs()
    .filter((spec) => spec.surfaces.mcp === true)
    .map((spec) => ({
      id: spec.id as ActionId,
      toolName: String(spec.bindings?.mcpToolName ?? '').trim(),
    }))
    .filter((entry) => entry.toolName.length > 0),
);

const MCP_ACTION_TOOL_NAMES = new Set(MCP_ACTION_TOOL_ENTRIES.map((entry) => entry.toolName));

export function createMcpActionToolNameToIdMap(
  isActionEnabled: ActionEnabledPredicate = () => true,
): ReadonlyMap<string, ActionId> {
  return new Map(
    MCP_ACTION_TOOL_ENTRIES
      .filter((entry) => isActionEnabled(entry.id))
      .map((entry) => [entry.toolName, entry.id] as const),
  );
}

export function filterBuiltInToolsForMcpSurface(
  tools: readonly HappierBuiltInToolDefinition[],
  isActionEnabled: ActionEnabledPredicate = () => true,
): readonly HappierBuiltInToolDefinition[] {
  const enabledActionToolNames = new Set(createMcpActionToolNameToIdMap(isActionEnabled).keys());

  return tools.filter((tool) => {
    if (!MCP_ACTION_TOOL_NAMES.has(tool.name)) return true;
    return enabledActionToolNames.has(tool.name);
  });
}
