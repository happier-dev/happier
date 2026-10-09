import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import { McpServerBindingV1Schema, McpServerCatalogEntryV1Schema } from './settingsV1.js';
import { McpServerCatalogCreateBatchV1Schema, McpServerCatalogSnapshotV1Schema,
  type McpServerCatalogSnapshotV1, type McpServerCatalogMutationV1 } from './catalogSchemasV1.js';
import { McpServerCatalogV1Schema, McpServerCatalogDiagnosticV1Schema, McpServerCatalogRowMutationResponseV1Schema,
  McpServerCatalogMutationResponseV1Schema, McpServerCatalogScopeV1Schema,
  type McpServerCatalogMutationResponseV1 } from './catalogSchemasV1.js';
import { DaemonMcpServersTestRequestSchema, DaemonMcpServersTestResponseSchema,
  DaemonMcpServersDetectRequestSchema, DaemonMcpServersDetectResponseSchema } from './daemonRpcV1.js';
import type { McpServerActionIdV1 } from './serverActionIdsV1.js';
export { MCP_SERVER_ACTION_IDS_V1, isMcpServerActionIdV1, type McpServerActionIdV1 } from './serverActionIdsV1.js';

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const catalogRevision = lazyZodSchema(() => z.union([revision, z.literal('absent')]));
const identity = lazyZodSchema(() => z.string().min(1));
const serverWrite = lazyZodSchema(() => z.object({ expectedRevision: catalogRevision,
  entry: McpServerCatalogEntryV1Schema, bindings: z.array(McpServerBindingV1Schema) }).strict());
const serverCreate = lazyZodSchema(() => z.union([serverWrite,
  McpServerCatalogCreateBatchV1Schema.omit({ kind: true }).extend({ expectedRevision: catalogRevision }).strict(),
]));
const bindingWrite = lazyZodSchema(() => z.object({ expectedRevision: catalogRevision, binding: McpServerBindingV1Schema }).strict());
const bindingAddress = lazyZodSchema(() => z.object({ expectedRevision: catalogRevision, bindingId: identity }).strict());
const bindingEnabled = lazyZodSchema(() => bindingAddress.extend({ captureBefore: z.boolean().optional(),
  expectedEnabled: z.boolean().optional(), expectedScope: McpServerCatalogScopeV1Schema.optional() }).strict());
const serverListEntry = lazyZodSchema(() => {
  const { id, name, title, description, transport, createdAt, updatedAt } = McpServerCatalogEntryV1Schema.shape;
  return z.object({ id, name, title, description, transport, createdAt, updatedAt }).strict();
});
const bindingListEntry = lazyZodSchema(() => McpServerBindingV1Schema.omit({ overrides: true }).strict());
const listCatalog = lazyZodSchema(() => z.object({ v: McpServerCatalogV1Schema.shape.v,
  servers: z.array(serverListEntry), bindings: z.array(bindingListEntry) }).strict());
const listSnapshot = lazyZodSchema(() => z.discriminatedUnion('status', [
  McpServerCatalogSnapshotV1Schema.options[0], McpServerCatalogSnapshotV1Schema.options[1],
  McpServerCatalogSnapshotV1Schema.options[2].extend({ catalog: listCatalog }),
  McpServerCatalogSnapshotV1Schema.options[3].extend({ catalog: listCatalog }),
]));
const readResult = lazyZodSchema(() => z.union([
  McpServerCatalogSnapshotV1Schema,
  z.object({ status: z.literal('present'), server: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerBindingV1Schema), revision: catalogRevision,
    authority: z.enum(['active', 'inactive']), complete: z.boolean(), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema) }).strict(),
  z.object({ status: z.literal('not-found'), serverId: identity, revision: catalogRevision }).strict(),
]));

/** Semantic requests are closed and use the one catalog revision, never item-local versions. */
export const MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 = {
  'mcp.servers.list': lazyZodSchema(() => z.object({}).strict()),
  'mcp.servers.read': lazyZodSchema(() => z.object({ serverId: identity }).strict()),
  'mcp.servers.create': serverCreate,
  'mcp.servers.update': serverWrite,
  'mcp.servers.duplicate': lazyZodSchema(() => serverWrite.extend({ serverId: identity }).strict()),
  'mcp.servers.delete': lazyZodSchema(() => z.object({ expectedRevision: catalogRevision,
    serverId: identity, removeBindings: z.boolean() }).strict()),
  'mcp.bindings.add': bindingWrite,
  'mcp.bindings.edit': bindingWrite,
  'mcp.bindings.enable': bindingEnabled,
  'mcp.bindings.disable': bindingEnabled,
  'mcp.bindings.remove': bindingAddress,
  'mcp.servers.test': lazyZodSchema(() => z.union([
    DaemonMcpServersTestRequestSchema.options[0].strict(), DaemonMcpServersTestRequestSchema.options[1].strict(),
  ])),
  'mcp.servers.probe': lazyZodSchema(() => DaemonMcpServersDetectRequestSchema.strict()),
} as const;
export const MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'mcp.servers.list': listSnapshot,
  'mcp.servers.read': readResult,
  'mcp.servers.create': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.update': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.duplicate': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.delete': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.bindings.add': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.bindings.edit': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.bindings.enable': McpServerCatalogMutationResponseV1Schema,
  'mcp.bindings.disable': McpServerCatalogMutationResponseV1Schema,
  'mcp.bindings.remove': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.test': DaemonMcpServersTestResponseSchema,
  'mcp.servers.probe': DaemonMcpServersDetectResponseSchema,
} as const;
export type McpServerActionRequestV1 = Readonly<{ actionId: McpServerActionIdV1; input: unknown; context: ActionExecutorContext }>;
export type McpServerActionPortsV1 = Readonly<{
  readCatalog(context: ActionExecutorContext): Promise<McpServerCatalogSnapshotV1>;
  mutate(change: McpServerCatalogMutationV1, expectedRevision: number | 'absent', context: ActionExecutorContext): Promise<McpServerCatalogMutationResponseV1>;
  machine(request: Readonly<{ actionId: 'mcp.servers.test' | 'mcp.servers.probe'; input: unknown;
    machineId: string; context: ActionExecutorContext }>): Promise<unknown>;
}>;

const catalogFailureCodes = new Set<string>([
  ...McpServerCatalogSnapshotV1Schema.options[1].shape.reason.options,
  'invalid-mutation', 'reference-conflict', 'outcome_unknown', 'server_scope_mismatch',
  'not_authenticated', 'permission_denied', 'admission_unavailable', 'invalid_action_output',
  'machine_unreachable', 'mcp_catalog_unavailable',
]);

/** Domain/transport causes can contain literal credentials; expose only owned refusal codes. */
export function projectMcpServerActionFailureV1(cause: unknown): ActionExecuteFailure {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const aborted = cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError';
  const errorCode = code === 'action_account_scope_changed' ? 'scope-retired' : aborted ? 'cancelled'
    : typeof code === 'string' && catalogFailureCodes.has(code) ? code : 'mcp_catalog_operation_failed';
  return { ok: false, errorCode, error: errorCode };
}

/** The shared Action adapter selects semantic operations; catalog decisions stay at its owner. */
export function createMcpServerActionExecuteV1(ports: McpServerActionPortsV1) {
  return async ({ actionId, input, context }: McpServerActionRequestV1): Promise<ActionExecuteResult> => {
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    let result: unknown;
    switch (actionId) {
      case 'mcp.servers.list': {
        const snapshot = await ports.readCatalog(context);
        // Configuration stays private to the domain owner and explicit read.
        // Lists disclose metadata without guessing which literals are secrets.
        result = snapshot.status === 'ready' || snapshot.status === 'partial'
          ? { ...snapshot, catalog: { v: snapshot.catalog.v,
            servers: snapshot.catalog.servers.map(entry => serverListEntry.strip().parse(entry)),
            bindings: snapshot.catalog.bindings.map(entry => bindingListEntry.strip().parse(entry)),
          } } : snapshot;
        break;
      }
      case 'mcp.servers.read': {
        const { serverId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status === 'loading' || snapshot.status === 'unavailable') { result = snapshot; break; }
        const server = snapshot.catalog.servers.find(entry => entry.id === serverId);
        result = server ? { status: 'present', server, bindings: snapshot.catalog.bindings.filter(binding => binding.serverId === serverId),
          revision: snapshot.revision, authority: snapshot.authority, complete: snapshot.status === 'ready', diagnostics: snapshot.diagnostics }
          : snapshot.status === 'partial' || snapshot.authority !== 'active' ? snapshot
            : { status: 'not-found', serverId, revision: snapshot.revision };
        break;
      }
      case 'mcp.servers.create': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate('entries' in change
          ? { kind: 'server-create-batch', entries: change.entries }
          : { kind: 'server-create', ...change }, expectedRevision, context);
        break;
      }
      case 'mcp.servers.update': {
        const { expectedRevision, entry, bindings } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'server-update', entry, bindings }, expectedRevision, context);
        break;
      }
      case 'mcp.servers.duplicate': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'server-duplicate', ...change }, expectedRevision, context); break;
      }
      case 'mcp.servers.delete': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'server-remove', ...change }, expectedRevision, context); break;
      }
      case 'mcp.bindings.add': case 'mcp.bindings.edit': {
        const { expectedRevision, binding } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: actionId === 'mcp.bindings.add' ? 'binding-create' : 'binding-update', binding }, expectedRevision, context); break;
      }
      case 'mcp.bindings.enable': case 'mcp.bindings.disable': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'binding-enabled', ...change, enabled: actionId === 'mcp.bindings.enable' }, expectedRevision, context); break;
      }
      case 'mcp.bindings.remove': {
        const { expectedRevision, bindingId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'binding-remove', bindingId }, expectedRevision, context); break;
      }
      case 'mcp.servers.test': case 'mcp.servers.probe': {
        const payload = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.machine({ actionId, input: payload, machineId: payload.machineId, context }); break;
      }
    }
    return { ok: true, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result) };
  };
}
