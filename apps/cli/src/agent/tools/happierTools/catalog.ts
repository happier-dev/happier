import { z } from 'zod';
import { BackendTargetRefSchema, ExecutionRunIntentSchema, listActionSpecs } from '@happier-dev/protocol';

import type { HappierBuiltInToolDefinition } from './types';

const execution_run_start_schema = z.object({
  sessionId: z.string().min(1).optional(),
  intent: ExecutionRunIntentSchema,
  backendTarget: BackendTargetRefSchema.optional(),
  backendId: z.string().min(1).optional(),
  instructions: z.string().optional(),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough().superRefine((value, ctx) => {
  const hasBackendTarget = typeof value.backendTarget !== 'undefined';
  const backendId = typeof value.backendId === 'string' ? value.backendId.trim() : '';
  if (!hasBackendTarget && !backendId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backendTarget'],
      message: 'backendTarget is required (or provide legacy backendId)',
    });
  }
});

const action_execute_schema = z.object({
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();

function buildActionBackedTools(): readonly HappierBuiltInToolDefinition[] {
  const tools: HappierBuiltInToolDefinition[] = [];

  for (const spec of listActionSpecs()) {
    if (spec.surfaces.mcp !== true) continue;
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
    inputSchema: { title: z.string().describe('The new title for the chat session') },
  },
  {
    name: 'action_execute',
    title: 'Execute Action',
    description: 'Execute a Happier action by action id with structured input',
    inputSchema: action_execute_schema,
  },
  {
    name: 'execution_run_start',
    title: 'Start Execution Run',
    description: 'Start an execution run (review/plan/delegate/voice agent) in this session',
    inputSchema: execution_run_start_schema,
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
