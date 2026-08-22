import { listActionSpecs } from '@happier-dev/protocol';

import type { HappierBuiltInToolDefinition } from './types';
import {
  actionExecuteToolInputSchema,
  changeTitleToolInputSchema,
} from './manualToolContracts';

function buildActionBackedTools(): readonly HappierBuiltInToolDefinition[] {
  const tools: HappierBuiltInToolDefinition[] = [];

  for (const spec of listActionSpecs()) {
    const name = String(spec.bindings?.mcpToolName ?? '').trim();
    if (!name) continue;

    tools.push({
      name,
      title: spec.title,
      description: spec.description ?? spec.title,
      inputSchema: spec.inputSchema,
    });
  }

  return Object.freeze(tools);
}

const MANUAL_TOOLS: readonly HappierBuiltInToolDefinition[] = Object.freeze([
  {
    name: 'change_title',
    title: 'Change Chat Title',
    description: 'Change the title of the current chat session',
    inputSchema: changeTitleToolInputSchema,
  },
  {
    name: 'action_execute',
    title: 'Execute Action',
    description: 'Execute a Happier action by action id with structured input',
    inputSchema: actionExecuteToolInputSchema,
  },
]);

function dedupeToolsByName(
  tools: readonly HappierBuiltInToolDefinition[],
): readonly HappierBuiltInToolDefinition[] {
  const deduped = new Map<string, HappierBuiltInToolDefinition>();
  for (const tool of tools) {
    deduped.set(tool.name, tool);
  }
  return Object.freeze([...deduped.values()]);
}

export const HAPPIER_BUILT_IN_TOOLS: readonly HappierBuiltInToolDefinition[] = dedupeToolsByName([
  ...MANUAL_TOOLS,
  ...buildActionBackedTools(),
] as const);

export const HAPPIER_BUILT_IN_TOOL_NAMES = Object.freeze(HAPPIER_BUILT_IN_TOOLS.map((tool) => tool.name));
