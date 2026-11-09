import { z } from 'zod/mini';
import { McpServerCatalogEntryV1Schema, McpServerRuleV1Schema, McpServerPluginSettingsMapV1Schema,
  McpPluginItemMetadataV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { McpRemoteUrlV1Schema } from '@happier-dev/protocol/mcp/remoteUrlV1';
import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';

const PreparationId = z.uuid();
const Server = z.strictObject({
  id: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)),
  title: z.optional(z.nullable(z.string())),
  transport: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('stdio') }),
    z.strictObject({ kind: z.literal('http'), url: McpRemoteUrlV1Schema }),
    z.strictObject({ kind: z.literal('sse'), url: McpRemoteUrlV1Schema }),
  ]),
});

/** Closed same-installation runner/daemon carrier, not a public SDK epoch. */
export const RUNNER_PLUGIN_MCP_OPERATIONS = [
  z.strictObject({ kind: z.literal('mcp.plugin.prepare'), preparationId: PreparationId,
    directory: z.string().check(z.minLength(1)),
    catalog: z.strictObject({ bindings: z.array(McpServerRuleV1Schema), pluginServers: z.optional(McpServerPluginSettingsMapV1Schema) }) }),
  z.strictObject({ kind: z.literal('mcp.plugin.materialize'), preparationId: PreparationId, servers: z.array(Server) }),
  z.strictObject({ kind: z.literal('mcp.plugin.discover'), preparationId: PreparationId }),
  z.strictObject({ kind: z.literal('mcp.plugin.close'), preparationId: PreparationId }),
] as const;
export const RunnerPluginMcpOperationSchema = z.discriminatedUnion('kind', RUNNER_PLUGIN_MCP_OPERATIONS);
export type RunnerPluginMcpOperation = z.infer<typeof RunnerPluginMcpOperationSchema>;

export const RUNNER_PLUGIN_MCP_RESULTS = [
  z.strictObject({ kind: z.literal('mcp.plugin.prepared'), items: z.array(z.strictObject({
    itemId: McpPluginItemMetadataV1Schema.shape.id, name: z.string(), title: z.optional(z.string()),
    config: McpServerCatalogEntryV1Schema, rules: z.array(McpServerRuleV1Schema),
  })) }),
  z.strictObject({ kind: z.literal('mcp.plugin.discovered'), detectedServers: z.array(DetectedMcpServerV1Schema) }),
  z.strictObject({ kind: z.literal('mcp.plugin.materialized'), servers: z.array(Server) }),
  z.strictObject({ kind: z.literal('mcp.plugin.closed') }),
] as const;
export const RunnerPluginMcpResultSchema = z.discriminatedUnion('kind', RUNNER_PLUGIN_MCP_RESULTS);
export type RunnerPluginMcpResult = z.infer<typeof RunnerPluginMcpResultSchema>;
