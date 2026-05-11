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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { isSafeTmpMcpConfigFilePath } from '@/mcp/runtime/isSafeTmpMcpConfigFilePath';

const REMOTE_BRIDGE_CONFIG_PREFIX = 'happier-mcp-remote-bridge';

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
    if (isSafeTmpMcpConfigFilePath(configPath, REMOTE_BRIDGE_CONFIG_PREFIX)) {
      await unlink(configPath).catch(() => {});
    }
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
    const onprogress = typeof progressToken === 'string' || typeof progressToken === 'number'
      ? (progress: Readonly<{ progress: number; total?: number; message?: string }>) => {
        void extra.sendNotification({
          method: 'notifications/progress',
          params: {
            ...progress,
            progressToken,
          },
        }).catch((err) => {
          writeStderr(`[happier-mcp-remote-bridge] Failed to forward progress: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      : undefined;

    return await callMcpToolWithResolvedTimeout({
      client: remoteClient,
      toolName: request.params.name,
      args: request.params.arguments,
      requestMetadata: request.params._meta,
      onprogress,
    });
  });

  let didCloseRemoteClient = false;
  const closeRemoteClientOnce = async (): Promise<void> => {
    if (didCloseRemoteClient) return;
    didCloseRemoteClient = true;
    await remoteClient.close().catch(() => {});
  };

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  const previousOnClose = stdio.onclose;
  stdio.onclose = () => {
    previousOnClose?.();
    void closeRemoteClientOnce();
  };
  process.stdin.once('end', () => {
    void server.close().catch((err) => {
      writeStderr(`[happier-mcp-remote-bridge] Failed to close stdio server: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

main().catch((err) => {
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
