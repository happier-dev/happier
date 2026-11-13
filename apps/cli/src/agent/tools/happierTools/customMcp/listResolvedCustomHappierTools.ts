import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';

import type { McpServerConfig } from '@/agent';
import { createCustomMcpClientTransport } from './createCustomMcpClientTransport';

export type ResolvedCustomHappierTool = Readonly<{
  source: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}>;

export type ResolvedCustomHappierToolWarning = Readonly<{
  source: string;
  error: string;
}>;

async function listServerTools(serverName: string, config: McpServerConfig, baseEnv: NodeJS.ProcessEnv, signal?: AbortSignal,
  prepareTransport?: PrepareMcpStdioTransport): Promise<ResolvedCustomHappierTool[]> {
  const transport = await createCustomMcpClientTransport(config, baseEnv, { signal, prepareTransport });
  const client = new Client({ name: 'happier-tools-list', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport, signal ? { signal } : undefined);
    const listed = await client.listTools(undefined, signal ? { signal } : undefined);
    return listed.tools.map((tool) => ({
        source: serverName,
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      }));
  } finally {
    try { await client.close(); } finally { await transport.close(); }
  }
}

export async function listResolvedCustomHappierTools(params: Readonly<{
  mcpServers: Record<string, McpServerConfig>;
  processEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  prepareTransport?: PrepareMcpStdioTransport;
}>): Promise<Readonly<{
  tools: ReadonlyArray<ResolvedCustomHappierTool>;
  warnings: ReadonlyArray<ResolvedCustomHappierToolWarning>;
}>> {
  const tools: ResolvedCustomHappierTool[] = [];
  const warnings: ResolvedCustomHappierToolWarning[] = [];
  for (const [serverName, config] of Object.entries(params.mcpServers)) {
    if (serverName === 'happier') continue;
    params.signal?.throwIfAborted();
    try {
      tools.push(...await listServerTools(serverName, config, params.processEnv ?? sessionProcessEnvironment(), params.signal, params.prepareTransport));
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof PluginError) throw error;
      warnings.push({
        source: serverName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { tools, warnings };
}
