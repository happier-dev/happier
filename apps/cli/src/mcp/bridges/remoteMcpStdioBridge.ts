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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { removeConsumedMcpRuntimeConfigFile } from '@/mcp/runtime/isSafeTmpMcpConfigFilePath';
import { registerHappierBridgeTools } from './registerHappierBridgeTools';

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

  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
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
  const server = new McpServer({ name: 'Happier MCP Remote Bridge', version: '1.0.0' });
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let shutdownStarted = false;
  let requestedSignal: NodeJS.Signals | null = null;
  const requestShutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    resolveShutdown();
  };
  const onStdinEnd = () => requestShutdown();
  const onStdinError = () => requestShutdown();
  const onSigint = () => {
    requestedSignal = 'SIGINT';
    requestShutdown();
  };
  const onSigterm = () => {
    requestedSignal = 'SIGTERM';
    requestShutdown();
  };
  process.stdin.once('end', onStdinEnd);
  process.stdin.once('error', onStdinError);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  remoteClient.onclose = requestShutdown;

  try {
    const toolList = await remoteClient.listTools();
    registerHappierBridgeTools(server, {
      tools: toolList.tools,
      callHttpTool: async (name, args, options) =>
        await callMcpToolWithResolvedTimeout({
          client: remoteClient,
          toolName: name,
          args,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
    });

    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      requestShutdown();
    }
    await shutdownRequested;
  } finally {
    process.stdin.off('end', onStdinEnd);
    process.stdin.off('error', onStdinError);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    const cleanup = await Promise.allSettled([
      server.close(),
      remoteClient.close(),
    ]);
    const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Remote MCP bridge cleanup failed');
    }
  }
  if (requestedSignal === 'SIGINT') process.exitCode = 130;
  if (requestedSignal === 'SIGTERM') process.exitCode = 143;
}

main().catch((err) => {
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
