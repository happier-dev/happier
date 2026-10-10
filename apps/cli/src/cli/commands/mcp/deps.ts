import { randomUUID } from 'node:crypto';

import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import type { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';

export type McpCommandDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  readStoredCredentials: () => Promise<StoredCredentials | null>;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  ensureMachineIdForCredentials: typeof ensureMachineIdForCredentials;
  detectProviderMcpServers: typeof detectProviderMcpServers;
  probeMcpStdioServerTools: typeof probeMcpStdioServerTools;
  randomUUID: () => string;
  nowMs: () => number;
  createExternalMcpServer?: typeof createExternalMcpServer;
  readDaemonPluginCatalog?: typeof readDaemonPluginCatalog;
  resolveLiveDaemonControlTargetForServer?: typeof resolveLiveDaemonControlTargetForServer;
  fetchServerFeaturesSnapshot?: typeof fetchServerFeaturesSnapshot;
  observeServerFeaturesSnapshot?: typeof observeServerFeaturesSnapshot;
  connectMcpStdio: (server: Pick<McpServer, 'connect'>) => Promise<void>;
}>;

export function resolveMcpCommandDeps(overrides?: Partial<McpCommandDeps>): McpCommandDeps {
  return {
    env: overrides?.env ?? process.env,
    readStoredCredentials: overrides?.readStoredCredentials ?? readStoredCredentials,
    bootstrapAccountSettingsContext: overrides?.bootstrapAccountSettingsContext ?? bootstrapAccountSettingsContext,
    ensureMachineIdForCredentials: overrides?.ensureMachineIdForCredentials ?? ensureMachineIdForCredentials,
    detectProviderMcpServers: overrides?.detectProviderMcpServers ?? detectProviderMcpServers,
    probeMcpStdioServerTools: overrides?.probeMcpStdioServerTools ?? probeMcpStdioServerTools,
    randomUUID: overrides?.randomUUID ?? randomUUID,
    nowMs: overrides?.nowMs ?? (() => Date.now()),
    createExternalMcpServer: overrides?.createExternalMcpServer,
    readDaemonPluginCatalog: overrides?.readDaemonPluginCatalog ?? readDaemonPluginCatalog,
    resolveLiveDaemonControlTargetForServer:
      overrides?.resolveLiveDaemonControlTargetForServer ?? resolveLiveDaemonControlTargetForServer,
    fetchServerFeaturesSnapshot: overrides?.fetchServerFeaturesSnapshot ?? fetchServerFeaturesSnapshot,
    observeServerFeaturesSnapshot:
      overrides?.observeServerFeaturesSnapshot ?? observeServerFeaturesSnapshot,
    connectMcpStdio: overrides?.connectMcpStdio ?? (async (server) => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }),
  };
}
