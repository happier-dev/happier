import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpServerConfig } from '@/agent';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';

type ToolInfo = Readonly<{ name: string }>;

function resolveEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function probeMcpStdioServerTools(params: Readonly<{
  config: McpServerConfig;
  baseEnv?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  listToolsTimeoutMs?: number;
}>): Promise<ReadonlyArray<ToolInfo>> {
  const baseEnv = params.baseEnv ?? process.env;
  const env = params.config.env ? { ...resolveEnvRecord(baseEnv), ...params.config.env } : resolveEnvRecord(baseEnv);

  const transport = new StdioClientTransport({
    command: params.config.command,
    args: params.config.args ?? [],
    env,
  });

  const client = new Client({ name: 'happier-mcp-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await withMcpTimeout(client.connect(transport), {
      timeoutMs: params.connectTimeoutMs ?? 15_000,
      label: 'mcp_connect_timeout',
    });
    const tools = await withMcpTimeout(client.listTools(), {
      timeoutMs: params.listToolsTimeoutMs ?? 15_000,
      label: 'mcp_list_tools_timeout',
    });
    const list = Array.isArray((tools as any)?.tools) ? (((tools as any).tools as any[]) ?? []) : [];
    return list
      .map((tool) => (typeof tool?.name === 'string' ? { name: tool.name } : null))
      .filter((tool): tool is ToolInfo => Boolean(tool));
  } finally {
    await client.close().catch(() => {});
  }
}
