import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { McpServerRuleV1Schema, McpServerConfigOverrideFieldsV1Schema, ReachPlaceV1Schema,
  McpServerCatalogEntryTransportV1Schema, McpServerCatalogEntryV1Schema, McpServerToolsSnapshotV1Schema } from './settingsV1.js';
import { applyMcpServerConfigOverrideV1 } from './resolveMcpServerConfigForContextV1.js';

/**
 * The Agent a detected MCP server was discovered for. Detection identity is
 * Agent identity, so it stays open: any installed Agent — bundled or
 * externally contributed — can own an MCP discovery source.
 */
export const McpDetectedProviderV1Schema = AgentIdV1Schema;
export type McpDetectedProviderV1 = z.infer<typeof McpDetectedProviderV1Schema>;

export const DetectedMcpServerV1Schema = lazyZodSchema(() => z.looseObject({
    provider: McpDetectedProviderV1Schema,
    name: z.string().check(z.minLength(1)),
    transport: McpServerCatalogEntryTransportV1Schema,
    stdio: z.optional(z
      .object({
        command: z.string().check(z.minLength(1)),
        args: z.array(z.string()),
      })),
    remote: z.optional(z
      .object({
        url: z.string().check(z.minLength(1)),
        headers: z.array(z.string()),
      })),
    envKeys: z.array(z.string()),
    enabled: z.union([z.boolean(), z.null()]),
    // Older detection producers omit this presentation fact.
    loadedInHappierSessions: z.optional(z.boolean()),
    source: z.looseObject({
      kind: z.enum(['user', 'project']),
      path: z.string().check(z.minLength(1)),
    }),
  }).check(z.superRefine((value, ctx) => {
    if (value.transport === 'stdio') {
      if (!value.stdio) {
        ctx.addIssue({ code: 'custom', message: 'Missing stdio config', path: ['stdio'] });
      }
      if (value.remote) {
        ctx.addIssue({ code: 'custom', message: 'remote is not allowed for stdio servers', path: ['remote'] });
      }
      return;
    }
    if (value.stdio) {
      ctx.addIssue({ code: 'custom', message: 'stdio is not allowed for remote servers', path: ['stdio'] });
    }
    if (!value.remote) {
      ctx.addIssue({ code: 'custom', message: 'Missing remote config', path: ['remote'] });
    }
  })));

export type DetectedMcpServerV1 = z.infer<typeof DetectedMcpServerV1Schema>;

/**
 * `provider` is absent when the warning cannot be attributed to an Agent at
 * all — a discovery source that declares no resolvable Agent id, or a
 * detection request naming one. Such a source must stay visible as an
 * explicit incompleteness rather than collapsing into an empty result.
 */
export const DaemonMcpServersDetectWarningV1Schema = lazyZodSchema(() => z.looseObject({
  provider: z.optional(McpDetectedProviderV1Schema),
  code: z.enum(['read_failed', 'parse_failed', 'unsupported']),
  path: z.optional(z.string().check(z.minLength(1))),
  detail: z.optional(z.string().check(z.minLength(1))),
}));
export type DaemonMcpServersDetectWarningV1 = z.infer<typeof DaemonMcpServersDetectWarningV1Schema>;

export const DaemonMcpServersDetectRequestSchema = lazyZodSchema(() => z.looseObject({
    machineId: z.string().check(z.minLength(1)),
    directory: z.optional(z.string().check(z.minLength(1), z.maxLength(10_000))),
    providers: z.optional(z.array(McpDetectedProviderV1Schema)),
  }));

export type DaemonMcpServersDetectRequest = z.infer<typeof DaemonMcpServersDetectRequestSchema>;

export const DaemonMcpServersDetectErrorCodeSchema = lazyZodSchema(() => z.enum(['invalid_request', 'internal_error']));

export const DaemonMcpServersDetectResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    servers: z.array(DetectedMcpServerV1Schema),
    warnings: z.optional(z.array(DaemonMcpServersDetectWarningV1Schema)),
  }),
  z.looseObject({
    ok: z.literal(false),
    errorCode: DaemonMcpServersDetectErrorCodeSchema,
    error: z.string().check(z.minLength(1)),
  }),
]));
export type DaemonMcpServersDetectResponse = z.infer<typeof DaemonMcpServersDetectResponseSchema>;

export const DaemonMcpServersTestErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'missing_credentials',
  'server_not_found',
  'binding_not_found',
  'server_disabled',
  'materialization_failed',
  'mcp_connect_failed',
  'mcp_list_tools_failed',
]));
export type DaemonMcpServersTestErrorCode = z.infer<typeof DaemonMcpServersTestErrorCodeSchema>;

/** Current callers test saved servers; unsaved drafts are released RPC ingress only. */
export const DaemonMcpServersTestAuthoringRequestSchema = lazyZodSchema(() => z.strictObject({
  t: z.literal('byId'),
  machineId: z.string().check(z.minLength(1)),
  directory: z.string().check(z.minLength(1), z.maxLength(10_000)),
  serverId: z.string().check(z.minLength(1)),
  bindingId: z.optional(z.string().check(z.minLength(1))),
}));

const normalizedDraftTestRequest = lazyZodSchema(() => z.looseObject({
  t: z.literal('draft'),
  machineId: z.string().check(z.minLength(1)),
  directory: z.string().check(z.minLength(1), z.maxLength(10_000)),
  server: McpServerCatalogEntryV1Schema,
  binding: z.nullish(McpServerRuleV1Schema),
}));
// Exact 0.2 RPC ingress; current Actions and catalog rows never author this field.
// Released producer: ui-web-v0.2.17-preview.19 (b8d1c449c46ab4dfa8637db36b66f643d149e66d),
// McpServerTestPanel.tsx:136–141; protocol mcpServers/daemonRpcV1.ts:98–107.
// Remove when support for released 0.2 clients testing against an upgraded daemon ends.
const retainedDraftTestRequest = lazyZodSchema(() => z.extend(normalizedDraftTestRequest, {
  binding: z.nullish((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(McpServerRuleV1Schema, { agentId: true }), {
    target: z.union([ReachPlaceV1Schema._zod.def.options[0], ReachPlaceV1Schema._zod.def.options[1], ReachPlaceV1Schema._zod.def.options[3]]),
    overrides: z.optional(McpServerConfigOverrideFieldsV1Schema),
  }))),
}));
export const DaemonMcpServersTestRequestSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('t' in raw) || raw.t !== 'draft'
    || !('binding' in raw) || !raw.binding || typeof raw.binding !== 'object' || !('overrides' in raw.binding)) return raw;
  const retained = retainedDraftTestRequest.safeParse(raw);
  if (!retained.success || !retained.data.binding) return raw;
  const { overrides, ...binding } = retained.data.binding;
  // Draft Test supplies exactly one binding. Folding its configuration preserves
  // the predecessor winner's effect; the sole reach owner still checks its place.
  return { ...retained.data, server: applyMcpServerConfigOverrideV1(retained.data.server, overrides), binding };
}), z.discriminatedUnion('t', [normalizedDraftTestRequest, z.looseObject(DaemonMcpServersTestAuthoringRequestSchema.shape)])));
export type DaemonMcpServersTestRequest = z.infer<typeof DaemonMcpServersTestRequestSchema>;

export const DaemonMcpServersTestResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    toolCount: z.number().check(z.int(), z.minimum(0)),
    toolNamesSample: z.optional(z.array(z.string())),
    durationMs: z.number().check(z.int(), z.minimum(0)),
    tools: z.optional(McpServerToolsSnapshotV1Schema.shape.tools),
    protocolVersion: McpServerToolsSnapshotV1Schema.shape.protocolVersion,
    serverInfo: McpServerToolsSnapshotV1Schema.shape.serverInfo,
    instructions: McpServerToolsSnapshotV1Schema.shape.instructions,
    stderrTail: z.optional(z.string()),
  }),
  z.looseObject({
    ok: z.literal(false),
    errorCode: DaemonMcpServersTestErrorCodeSchema,
    error: z.string().check(z.minLength(1)),
    durationMs: z.number().check(z.int(), z.minimum(0)),
    runtimeMissing: z.optional(z.string().check(z.minLength(1))),
    stderrTail: z.optional(z.string()),
  }),
]));
export type DaemonMcpServersTestResponse = z.infer<typeof DaemonMcpServersTestResponseSchema>;
