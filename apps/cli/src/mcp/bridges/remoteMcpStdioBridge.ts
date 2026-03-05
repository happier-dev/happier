/**
 * Remote MCP STDIO Bridge
 *
 * STDIO MCP server that proxies tools to a remote MCP server over:
 * - Streamable HTTP (`transport: http`)
 * - SSE (`transport: sse`)
 *
 * Bridge config is provided via env var `HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE`.
 *
 * SECURITY: never print secrets to stdout (stdout is reserved for MCP stdio).
 */

import { readFile, unlink } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';

const RemoteBridgeConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional().default({}),
});

type RemoteBridgeConfig = z.infer<typeof RemoteBridgeConfigSchema>;

function writeStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // ignore
  }
}

function parseArgsValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function connectRemoteClient(config: RemoteBridgeConfig): Promise<Client> {
  const client = new Client({ name: 'happier-remote-bridge', version: '1.0.0' }, { capabilities: {} });

  const url = new URL(config.url);
  const headers = { ...config.headers };

  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
      : new SSEClientTransport(url, {
        requestInit: { headers },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventSourceInit: { headers } as any,
      });

  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const configPath = typeof process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE === 'string'
    ? process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE
    : '';
  if (!configPath) {
    writeStderr('[happier-mcp-remote-bridge] Missing HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE');
    process.exit(2);
  }

  let config: RemoteBridgeConfig;
  try {
    const raw = await readFile(configPath, 'utf8');
    config = RemoteBridgeConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    writeStderr(`[happier-mcp-remote-bridge] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const remoteClient = await connectRemoteClient(config);

  // Best-effort: remove config file after connect to reduce secret exposure at rest.
  unlink(configPath).catch(() => {});

  const toolList = await remoteClient.listTools();
  const tools = Array.isArray((toolList as any)?.tools) ? ((toolList as any).tools as any[]) : [];

  const server = new McpServer({ name: 'Happier MCP Remote Bridge', version: '1.0.0' });

  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (!name) continue;

    server.registerTool(
      name,
      {
        description: typeof tool?.description === 'string' ? tool.description : undefined,
        title: typeof tool?.title === 'string' ? tool.title : undefined,
        // The SDK expects a Zod schema for input validation. Remote `listTools` returns JSON schema.
        // Prefer permissive validation here and let the remote server enforce its own schema.
        inputSchema: z.any(),
        _meta: tool?.inputSchema ? { remoteInputSchema: tool.inputSchema } : undefined,
      } as any,
      (async (argsOrExtra: unknown, extra?: unknown) => {
        const toolArgs = extra === undefined ? undefined : parseArgsValue(argsOrExtra);
        return await remoteClient.callTool({ name, arguments: toolArgs });
      }) as any,
    );
  }

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

main().catch((err) => {
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
