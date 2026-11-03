import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { McpOAuthClientRegistrationV1Schema } from '../oauth/mcpOAuthClientIdentityV1.js';
import { McpServerRuleV1Schema, McpServerCatalogEntryV1Schema, McpServerConfigOverrideV1Schema, McpServerToolPolicyV1Schema, McpServerToolSettingsPatchV1Schema, McpServerToolsSnapshotV1Schema, McpToolSettingV1Schema, McpToolSettingsV1Schema, McpPluginItemMetadataV1Schema } from './settingsV1.js';
import { McpServerPluginSettingsV1Schema } from './settingsV1.js';
import { ReachRulesChangeV1Schema } from '../../reach/reachRulesChangeV1.js';
import { McpServerCatalogSnapshotV1Schema } from './catalogSchemasV1.js';
import { McpServerCatalogV1Schema, McpServerCatalogDiagnosticV1Schema, McpServerCatalogRowMutationResponseV1Schema } from './catalogSchemasV1.js';
import { DaemonMcpServersTestAuthoringRequestSchema, DaemonMcpServersTestResponseSchema, DaemonMcpServersDetectRequestSchema, DaemonMcpServersDetectResponseSchema } from './daemonRpcV1.js';
import { DetectedMcpServerV1Schema } from './daemonRpcV1.js';
import { RegistryItemPointerV1Schema } from '../../registries/registryItemsV1.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
import { McpImportPreviewV1Schema, McpImportCommitV1Schema, McpImportValuesV1Schema, McpImportValueChoiceV1Schema } from './import/mcpServerImportV1.js';
export { MCP_SERVER_ACTION_IDS_V1, isMcpServerActionIdV1, type McpServerActionIdV1 } from './serverActionIdsV1.js';

const revision = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const catalogRevision = lazyZodSchema(() => z.union([revision, z.literal('absent')]));
const identity = lazyZodSchema(() => z.string().check(z.minLength(1)));
const createItem = lazyZodSchema(() => z.strictObject({ entry: McpServerCatalogEntryV1Schema,
  where: z.optional(ReachRulesChangeV1Schema) }));
const serverWrite = lazyZodSchema(() => z.strictObject({ expectedRevision: catalogRevision,
  entry: McpServerCatalogEntryV1Schema, configOverrides: z.optional(z.array(McpServerConfigOverrideV1Schema)) }));
const serverCreate = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(createItem, { expectedRevision: catalogRevision })),
  z.strictObject({ expectedRevision: catalogRevision, entries: z.array(createItem) }),
  z.strictObject({ expectedRevision: catalogRevision, from: z.strictObject({ registry: RegistryItemPointerV1Schema }),
    name: z.optional(z.string()), title: z.optional(z.string()), inputs: z.optional(z.record(z.string(), ValueRefV1Schema)),
    remote: z.optional(z.strictObject({ auth: z.strictObject({ kind: z.literal('oauth') }) })),
    where: z.optional(ReachRulesChangeV1Schema) }),
]));
const serverUpdate = lazyZodSchema(() => z.union([serverWrite,
  z.strictObject({ expectedRevision: catalogRevision, serverId: identity, from: z.strictObject({ registry: RegistryItemPointerV1Schema }),
    inputs: z.optional(z.record(z.string(), ValueRefV1Schema)) }),
]));
export const McpServerListEntryV1Schema = lazyZodSchema(() => {
  const { id, name, title, description, transport, createdAt, updatedAt } = McpServerCatalogEntryV1Schema.shape;
  return z.strictObject({ id, name, title, description, transport, createdAt, updatedAt });
});
const listCatalog = lazyZodSchema(() => z.strictObject({ v: McpServerCatalogV1Schema.shape.v,
  servers: z.array(z.union([McpServerListEntryV1Schema, McpPluginItemMetadataV1Schema])), bindings: z.array(McpServerRuleV1Schema),
  pluginItemsStatus: z.optional(z.enum(['ready', 'unavailable'])) }));
const listSnapshot = lazyZodSchema(() => z.discriminatedUnion('status', [
  McpServerCatalogSnapshotV1Schema._zod.def.options[0], McpServerCatalogSnapshotV1Schema._zod.def.options[1],
  z.extend(McpServerCatalogSnapshotV1Schema._zod.def.options[2], { catalog: listCatalog }),
  z.extend(McpServerCatalogSnapshotV1Schema._zod.def.options[3], { catalog: listCatalog }),
]));
const readResult = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('plugin'), server: McpPluginItemMetadataV1Schema, bindings: z.array(McpServerRuleV1Schema),
    settings: z.optional(McpServerPluginSettingsV1Schema), revision: catalogRevision }),
  McpServerCatalogSnapshotV1Schema,
  z.strictObject({ status: z.literal('present'), server: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerRuleV1Schema), revision: catalogRevision,
    installLink: z.optional(z.url()),
    authority: z.enum(['active', 'inactive']), complete: z.boolean(), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema) }),
  z.strictObject({ status: z.literal('not-found'), serverId: identity, revision: catalogRevision }),
]));

const toolsListResult = lazyZodSchema(() => z.strictObject({
  serverId: identity, revision: catalogRevision, snapshot: z.optional(McpServerToolsSnapshotV1Schema),
  settings: z.strictObject({ default: McpServerToolPolicyV1Schema.shape.default,
    tools: McpToolSettingsV1Schema }),
  tools: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolsSnapshotV1Schema.shape.tools._zod.def.element, {
    setting: z.union([McpToolSettingV1Schema, z.literal('inherit')]), source: z.enum(['tool', 'server_default']),
  }))),
  tokens: z.nullable(z.number().check(z.nonnegative())),
  perAgent: z.strictObject({ status: z.enum(['ready', 'unavailable']), machineId: z.optional(identity), agents: z.array(z.strictObject({
    agentId: identity, approval: z.nullable(z.enum(['native', 'host'])), off: z.nullable(z.enum(['hidden', 'blocked'])),
    loading: z.enum(['every_turn', 'on_demand']), tokens: z.nullable(z.number().check(z.nonnegative())),
  })) }),
}));

/** Semantic requests are closed and use the one catalog revision, never item-local versions. */
export const MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 = {
  'mcp.servers.list': lazyZodSchema(() => z.strictObject({})),
  'mcp.servers.read': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.tools.list': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.tools.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolSettingsPatchV1Schema, { serverId: identity }))),
  'mcp.servers.create': serverCreate,
  'mcp.servers.update': serverUpdate,
  'mcp.servers.duplicate': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.delete': lazyZodSchema(() => z.strictObject({ expectedRevision: catalogRevision,
    serverId: identity, removeBindings: z.boolean() })),
  'mcp.servers.test': DaemonMcpServersTestAuthoringRequestSchema,
  'mcp.found.list': lazyZodSchema(() => z.extend((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(DaemonMcpServersDetectRequestSchema), { machineId: z.optional(identity) })),
  'mcp.servers.import': lazyZodSchema(() => z.strictObject({ expectedRevision: z.optional(catalogRevision),
    source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('paste'), text: z.string() }),
      z.strictObject({ kind: z.literal('link'), url: z.string() })]), dryRun: z.boolean(),
    values: z.optional(McpImportValuesV1Schema), where: z.optional(ReachRulesChangeV1Schema) })),
  'mcp.found.adopt': lazyZodSchema(() => z.strictObject({ expectedRevision: z.optional(catalogRevision), machineId: identity,
    items: z.array(DetectedMcpServerV1Schema), where: z.optional(ReachRulesChangeV1Schema),
    values: z.optional(z.union([McpImportValuesV1Schema, z.record(z.string(), z.record(z.string(), McpImportValueChoiceV1Schema))])) })),
  'mcp.servers.signIn.start': lazyZodSchema(() => z.strictObject({ serverId: identity, stepUp: z.optional(z.boolean()),
    client: z.optional(McpOAuthClientRegistrationV1Schema) })),
} as const;
export const MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'mcp.servers.list': listSnapshot,
  'mcp.servers.read': readResult,
  'mcp.servers.tools.list': toolsListResult,
  'mcp.servers.tools.set': lazyZodSchema(() => z.strictObject({ revision,
    previous: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerToolSettingsPatchV1Schema, { tools: McpServerToolSettingsPatchV1Schema.shape.tools._zod.def.innerType })),
  })),
  'mcp.servers.create': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision, serverId: identity }),
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision, serverIds: z.array(identity) }),
  ])),
  'mcp.servers.update': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.duplicate': lazyZodSchema(() => z.strictObject({ serverId: identity })),
  'mcp.servers.delete': lazyZodSchema(() => z.union([McpServerCatalogRowMutationResponseV1Schema,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpServerCatalogRowMutationResponseV1Schema._zod.def.options[0], { signOut: z.union([
      z.strictObject({ status: z.literal('revoked'), remoteStatus: z.enum(['remoteRevoked', 'remoteUnsupported', 'remoteNotAttempted']) }),
      z.strictObject({ status: z.literal('not_connected') }),
      z.strictObject({ status: z.literal('pending') }),
    ]) })),
  ])),
  'mcp.servers.test': DaemonMcpServersTestResponseSchema,
  'mcp.found.list': DaemonMcpServersDetectResponseSchema,
  'mcp.servers.import': lazyZodSchema(() => z.union([McpImportPreviewV1Schema, McpImportCommitV1Schema])),
  'mcp.found.adopt': McpImportCommitV1Schema,
  'mcp.servers.signIn.start': lazyZodSchema(() => z.strictObject({ attemptId: identity, authorizationUrl: z.url(),
    expiresAtMs: z.number().check(z.int(), z.nonnegative()), machineId: identity,
    clientRegistration: z.optional(z.literal('not_needed')) })),
} as const;
