import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { SESSION_TOOLS_SEARCH_ACTION_ID_V1, SESSION_TOOLS_DESCRIBE_ACTION_ID_V1, SESSION_TOOLS_CALL_ACTION_ID_V1 } from '../actionIds.js';
import { ActionFailureCauseV1Schema } from '../actionExecutionResult.js';
import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from './definition.js';

const identity = lazyZodSchema(() => z.string().check(z.minLength(1)));
const toolSummary = lazyZodSchema(() => z.strictObject({
  id: identity, source: identity, tool: identity, description: z.optional(z.string()),
}));
const toolWarning = lazyZodSchema(() => z.strictObject({ source: identity, error: z.string() }));
export const SessionToolsSearchInputV1Schema = lazyZodSchema(() => z.strictObject({
  query: z.optional(z.string().check(z.trim())),
  limit: z.optional(z.number().check(z.int(), z.positive())),
}));
export const SessionToolsSearchOutputV1Schema = lazyZodSchema(() => z.strictObject({
  tools: z.array(toolSummary),
  warnings: z.optional(z.array(toolWarning)),
}));

export const SessionToolsDescribeInputV1Schema = lazyZodSchema(() => z.strictObject({ source: identity, tool: identity }));
export const SessionToolsDescribeOutputV1Schema = lazyZodSchema(() => z.strictObject({
  ...toolSummary.shape,
  inputSchema: z.record(z.string(), StrictJsonValueSchema),
  signature: z.string(),
}));

export const SessionToolsCallInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionToolsDescribeInputV1Schema.shape,
  args: z.optional(z.record(z.string(), StrictJsonValueSchema)),
}));
export const SessionToolsCallOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: StrictJsonValueSchema }),
  z.strictObject({ ok: z.literal(false), errorCode: identity, refusalCause: z.optional(ActionFailureCauseV1Schema) }),
]));

const common = {
  requiredAuthority: 'account_automation', executionPlacement: 'session', placements: [],
  approval: { result: 'none' }, safety: 'safe', sideEffectClass: 'read',
  surfaces: { ui: false, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  toolExposure: { agent: 'direct', mcp: 'direct' },
} as const;

export const SESSION_TOOLS_ACTION_SPECS_V1 = lazyActionSpecArray(() => [
  { ...common, id: SESSION_TOOLS_SEARCH_ACTION_ID_V1, title: 'Search session tools',
    description: 'Find available Happier Actions and configured MCP tools.',
    bindings: { mcpToolName: 'tools_search' },
    inputSchema: SessionToolsSearchInputV1Schema, outputSchema: SessionToolsSearchOutputV1Schema,
  },
  { ...common, id: SESSION_TOOLS_DESCRIBE_ACTION_ID_V1, title: 'Describe a session tool',
    description: 'Read the input schema and call signature for one tool.',
    bindings: { mcpToolName: 'tools_describe' },
    inputSchema: SessionToolsDescribeInputV1Schema, outputSchema: SessionToolsDescribeOutputV1Schema,
  },
  { ...common, id: SESSION_TOOLS_CALL_ACTION_ID_V1, title: 'Call a session tool',
    description: 'Invoke one tool under its own permission and approval policy.',
    bindings: { mcpToolName: 'tools_call' },
    inputSchema: SessionToolsCallInputV1Schema, outputSchema: SessionToolsCallOutputV1Schema,
  },
] as const satisfies readonly PreNormalizedActionSpec[]);
