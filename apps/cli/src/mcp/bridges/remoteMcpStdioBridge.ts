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

import { readFile } from 'node:fs/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { removeConsumedMcpRuntimeConfigFile } from '@/mcp/runtime/isSafeTmpMcpConfigFilePath';
import { bindMcpStdioBridgeLifecycle } from '@/mcp/runtime/bindMcpStdioBridgeLifecycle';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';

const REMOTE_BRIDGE_CONFIG_PREFIX = 'happier-mcp-remote-bridge';
const MCP_BRIDGE_CONNECT_TIMEOUT_MS = 60_000;

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

  try {
    await withMcpTimeout(client.connect(transport), {
      timeoutMs: MCP_BRIDGE_CONNECT_TIMEOUT_MS,
      label: 'happier_mcp_remote_bridge_connect_timeout',
    });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
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
    await removeConsumedMcpRuntimeConfigFile(configPath, REMOTE_BRIDGE_CONFIG_PREFIX);
    config = RemoteBridgeConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    writeStderr(`[happier-mcp-remote-bridge] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const remoteClient = await connectRemoteClient(config);

  const server = new Server(
    { name: 'Happier MCP Remote Bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => await remoteClient.listTools(request.params));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    const pendingProgressNotifications: Promise<void>[] = [];
    const onprogress = typeof progressToken === 'string' || typeof progressToken === 'number'
      ? (progress: Readonly<{ progress: number; total?: number; message?: string }>) => {
        const notification = extra.sendNotification({
          method: 'notifications/progress',
          params: {
            ...progress,
            progressToken,
          },
        }).catch((err) => {
          writeStderr(`[happier-mcp-remote-bridge] Failed to forward progress: ${err instanceof Error ? err.message : String(err)}`);
        });
        pendingProgressNotifications.push(notification);
      }
      : undefined;

    const result = await callMcpToolWithResolvedTimeout({
      client: remoteClient,
      toolName: request.params.name,
      args: request.params.arguments,
      requestMetadata: request.params._meta,
      onprogress,
    });
    await Promise.all(pendingProgressNotifications);
    return result;
  });

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  bindMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    transport: stdio,
    closeServer: async () => await server.close(),
    closeUpstream: async () => await remoteClient.close(),
    onCloseError: (err) => {
      writeStderr(`[happier-mcp-remote-bridge] Failed to close bridge: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
}

if (process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE !== '1') {
  main().catch((err) => {
    writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
