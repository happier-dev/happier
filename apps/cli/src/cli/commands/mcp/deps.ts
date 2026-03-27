import { randomUUID } from 'node:crypto';

import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { readCredentials, type Credentials } from '@/persistence';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type McpCommandDeps = Readonly<{
  readCredentials: () => Promise<Credentials | null>;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  updateAccountSettingsV2WithRetry: typeof updateAccountSettingsV2WithRetry;
  ensureMachineIdForCredentials: typeof ensureMachineIdForCredentials;
  detectProviderMcpServers: typeof detectProviderMcpServers;
  probeMcpStdioServerTools: typeof probeMcpStdioServerTools;
  randomUUID: () => string;
  nowMs: () => number;
  createExternalMcpServer: typeof createExternalMcpServer;
  connectMcpStdio: (server: Pick<McpServer, 'connect'>) => Promise<void>;
}>;

export function resolveMcpCommandDeps(overrides?: Partial<McpCommandDeps>): McpCommandDeps {
  return {
    readCredentials: overrides?.readCredentials ?? readCredentials,
    bootstrapAccountSettingsContext: overrides?.bootstrapAccountSettingsContext ?? bootstrapAccountSettingsContext,
    updateAccountSettingsV2WithRetry: overrides?.updateAccountSettingsV2WithRetry ?? updateAccountSettingsV2WithRetry,
    ensureMachineIdForCredentials: overrides?.ensureMachineIdForCredentials ?? ensureMachineIdForCredentials,
    detectProviderMcpServers: overrides?.detectProviderMcpServers ?? detectProviderMcpServers,
    probeMcpStdioServerTools: overrides?.probeMcpStdioServerTools ?? probeMcpStdioServerTools,
    randomUUID: overrides?.randomUUID ?? randomUUID,
    nowMs: overrides?.nowMs ?? (() => Date.now()),
    createExternalMcpServer: overrides?.createExternalMcpServer ?? createExternalMcpServer,
    connectMcpStdio: overrides?.connectMcpStdio ?? (async (server) => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }),
  };
}
