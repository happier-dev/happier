import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { lazyActionSpecArray } from '@happier-dev/protocol/actions/lazyActionSpecValue';

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
      actionId: spec.id,
      inputSchema: spec.surfaceBindings?.mcp?.inputSchema ?? spec.inputSchema,
      ...(spec.examples ? { examples: spec.examples } : {}),
      ...(spec.contextualDefaults ? { contextualDefaults: spec.contextualDefaults } : {}),
      ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
      annotations: {
        ...(spec.sideEffectClass === 'read' ? { readOnlyHint: true } : {}),
        destructiveHint: spec.safety === 'danger',
      },
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
    description: 'Execute a Happier Action. Pass one envelope: {"actionId":"<id>","input":{<Action input fields>}}. Get the Action inputSchema with action_spec_get; its fields go directly inside input. For example: {"actionId":"discussion.post","input":{"discussionId":"<id>","content":{"v":1,"parts":[{"t":"text","text":"My reply"}]}}}. Do not put another {actionId,input} envelope inside input. For a named Action tool, pass only its Action input fields, without the envelope.',
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

// Built on first read with the Action catalog's own lazy owner: building it at
// module evaluation built the whole Action catalog in every importing process.
export const HAPPIER_BUILT_IN_TOOLS: readonly HappierBuiltInToolDefinition[] = lazyActionSpecArray(() => dedupeToolsByName([
  ...MANUAL_TOOLS,
  ...buildActionBackedTools(),
] as const));

export const HAPPIER_BUILT_IN_TOOL_NAMES: readonly string[] = lazyActionSpecArray(() => Object.freeze(HAPPIER_BUILT_IN_TOOLS.map((tool) => tool.name)));
