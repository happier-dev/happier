import { z } from 'zod';
import { ExecutionRunIntentSchema, getActionSpec, listActionSpecs, type ActionId } from '@happier-dev/protocol';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';

export type HappierMcpToolDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
}>;

const optionalSessionId = z.string().min(1).optional();

const execution_run_start_schema = z.object({
  sessionId: optionalSessionId,
  intent: ExecutionRunIntentSchema,
  backendId: z.string().min(1),
  instructions: z.string().optional(),
  permissionMode: z.string().min(1).optional(),
  retentionPolicy: z.enum(['ephemeral', 'resumable']).optional(),
  runClass: z.enum(['bounded', 'long_lived']).optional(),
  ioMode: z.enum(['request_response', 'streaming']).optional(),
}).passthrough();

const action_spec_get_schema = z.object({ id: z.string().min(1) }).passthrough();
const empty_schema = z.object({}).passthrough();

function buildMcpActionTools(): readonly HappierMcpToolDefinition[] {
  const tools: HappierMcpToolDefinition[] = [];

  // ActionSpec-driven tools (single source of truth).
  for (const spec of listActionSpecs()) {
    if (spec.surfaces.mcp !== true) continue;
    const name = String(spec.bindings?.mcpToolName ?? '').trim();
    if (!name) continue;
    if (!isActionEnabledByEnv(spec.id as ActionId)) continue;

    tools.push({
      name,
      title: spec.title,
      description: spec.description ?? spec.title,
      inputSchema: spec.inputSchema,
    });
  }

  return Object.freeze(tools);
}

const MANUAL_MCP_TOOLS: readonly HappierMcpToolDefinition[] = Object.freeze([
  {
    name: 'change_title',
    title: 'Change Chat Title',
    description: 'Change the title of the current chat session',
    inputSchema: { title: z.string().describe('The new title for the chat session') },
  },
  {
    name: 'action_spec_list',
    title: 'List Action Specs',
    description: 'List Happier action specs as JSON-safe objects (inputSchemas omitted)',
    inputSchema: empty_schema,
  },
  {
    name: 'action_spec_get',
    title: 'Get Action Spec',
    description: 'Get a single Happier action spec by id as JSON-safe object (inputSchema omitted)',
    inputSchema: action_spec_get_schema,
  },
  {
    name: 'execution_run_start',
    title: 'Start Execution Run',
    description: 'Start an execution run (review/plan/delegate/voice agent) in this session',
    inputSchema: execution_run_start_schema,
  },
]);

export const HAPPIER_MCP_TOOLS: readonly HappierMcpToolDefinition[] = Object.freeze([
  ...MANUAL_MCP_TOOLS,
  ...buildMcpActionTools(),
] as const);

export const HAPPIER_MCP_TOOL_NAMES = Object.freeze(HAPPIER_MCP_TOOLS.map((t) => t.name));
