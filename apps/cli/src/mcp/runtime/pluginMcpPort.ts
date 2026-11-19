import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol';
import type { ResolvedSessionMcpServer } from '../runtimeTypes';

/** One daemon-owned registry lease and its Session attachments. Selection and
 * native tool policy remain with the runner's existing resolution owners. */
export type PluginMcpPreparation = Readonly<{
  preparationId: string;
  items: readonly McpPluginItemV1[];
  discoverNativeServers(): Promise<readonly DetectedMcpServerV1[]>;
  materialize(servers: readonly ResolvedSessionMcpServer[]): Promise<readonly ResolvedSessionMcpServer[]>;
  dispose(): Promise<void>;
}>;

export type PluginMcpPort = Readonly<{
  prepare(input: Readonly<{
    catalog: McpServerCatalogV1;
    directory: string;
    signal?: AbortSignal;
  }>): Promise<PluginMcpPreparation>;
}>;
