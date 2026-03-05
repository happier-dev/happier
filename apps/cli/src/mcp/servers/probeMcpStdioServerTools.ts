import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpServerConfig } from '@/agent';

type ToolInfo = Readonly<{ name: string }>;

function resolveEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return await promise;
  let timeout: NodeJS.Timeout | null = null;
  try {
    const timer = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(label)), Math.floor(ms));
    });
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    await withTimeout(client.connect(transport), params.connectTimeoutMs ?? 15_000, 'mcp_connect_timeout');
    const tools = await withTimeout(client.listTools(), params.listToolsTimeoutMs ?? 15_000, 'mcp_list_tools_timeout');
    const list = Array.isArray((tools as any)?.tools) ? (((tools as any).tools as any[]) ?? []) : [];
    return list
      .map((tool) => (typeof tool?.name === 'string' ? { name: tool.name } : null))
      .filter((tool): tool is ToolInfo => Boolean(tool));
  } finally {
    await client.close().catch(() => {});
  }
}

