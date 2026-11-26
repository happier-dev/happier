import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
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

import '../../configureZodLocale';
import { readFile } from 'node:fs/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RemoteMcpAuthenticationRequiredError } from './remoteMcpAuthenticationFailure';
import {
  addRemoteMcpRedactionValues, connectRemoteMcpClient, createRemoteMcpOutputRedaction,
  RemoteBridgeConfigSchema, type RemoteBridgeConfig,
} from './connectRemoteMcpClient';
import {
  ErrorCode, CallToolRequestSchema, CallToolResultSchema, InitializeResultSchema, JSONRPCMessageSchema,
  JSONRPCNotificationSchema, JSONRPCResultResponseSchema,
  ListToolsRequestSchema, ListToolsResultSchema, ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { runMcpStdioBridgeLifecycle } from '@/mcp/runtime/runMcpStdioBridgeLifecycle';
import { forwardHappierBridgeTool } from './registerHappierBridgeTools';
import { projectMcpToolInputJsonSchema } from '@/mcp/server/projectMcpToolInputJsonSchema';

// Keep already-issued values protected through late responses and credential
// rotations; this lease ends with this single bridge process, not a request.
const outputRedaction = createRemoteMcpOutputRedaction();

// Borrow the SDK field validators unchanged; the bridge owns only these native Mini containers.
const BridgeOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ...JSONRPCResultResponseSchema.shape, result: z.union([InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema]) }),
  z.strictObject({ ...JSONRPCNotificationSchema.shape, ...ProgressNotificationSchema.shape }),
  JSONRPCMessageSchema,
]));

function writeStderr(line: string): void {
  try {
    const safeLine = outputRedaction.redact(line);
    process.stderr.write(safeLine.endsWith('\n') ? safeLine : `${safeLine}\n`);
  } catch {
    // ignore
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
    config = RemoteBridgeConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    writeStderr(`[happier-mcp-remote-bridge] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  addRemoteMcpRedactionValues(outputRedaction, config);
  let remoteClient: Client;
  try { remoteClient = await connectRemoteMcpClient(config, outputRedaction); }
  catch (error) {
    if (!(error instanceof RemoteMcpAuthenticationRequiredError)) throw error;
    // The Agent-facing stdio client needs the challenge as an initialize result,
    // rather than a child exit or stderr heuristic. stdin buffers until start.
    const stdio = new StdioServerTransport();
    try {
      await new Promise<void>((resolve, reject) => {
        stdio.onclose = resolve;
        stdio.onerror = reject;
        stdio.onmessage = message => {
          if (!('method' in message) || message.method !== 'initialize' || !('id' in message)) return;
          void stdio.send({ jsonrpc: '2.0', id: message.id, error: {
            code: ErrorCode.InternalError, message: error.message, data: error.data,
          } }).then(resolve, reject);
        };
        void stdio.start().catch(reject);
      });
    } finally { await stdio.close(); }
    return;
  }
  const serverInfo = remoteClient.getServerVersion();
  if (!serverInfo) {
    await remoteClient.close();
    throw new Error('Remote MCP server did not provide its identity.');
  }
  const instructions = remoteClient.getInstructions();
  const server = new Server(serverInfo, { capabilities: { tools: {} }, ...(instructions === undefined ? {} : { instructions }) });
  // Discovery has its own MCP request lifetime. Keeping it out of initialize
  // avoids charging upstream connection and every tool page to one handshake.
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const page = await remoteClient.listTools(request.params, { signal: extra.signal });
    return { ...page, tools: page.tools.map(tool => ({ ...tool,
      inputSchema: projectMcpToolInputJsonSchema(tool.inputSchema),
    })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => CallToolResultSchema.parse(
    await forwardHappierBridgeTool(request.params.name, request.params.arguments, {
      signal: extra.signal, _meta: request.params._meta,
      sendNotification: notification => extra.sendNotification(notification),
    }, (name, args, options) => callMcpToolWithResolvedTimeout({
      client: remoteClient, toolName: name, args,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
      ...(options?.onprogress === undefined ? {} : { onprogress: options.onprogress }),
    })),
  ));
  const requestedSignal = await runMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    start: async () => {
      const stdio = new StdioServerTransport();
      // One actual Agent-facing output boundary covers tool metadata, results,
      // protocol errors and progress without choosing or filtering any tools.
      const send = stdio.send.bind(stdio);
      stdio.send = async (message) => await send(JSONRPCMessageSchema.parse(
        outputRedaction.project(message, BridgeOutputSchema),
      ));
      await server.connect(stdio);
      return { transport: stdio, upstream: remoteClient };
    },
    closeServer: async () => await server.close(),
    closeUpstream: async () => await remoteClient.close(),
  });
  if (requestedSignal === 'SIGINT') process.exitCode = 130;
  if (requestedSignal === 'SIGTERM') process.exitCode = 143;
}

main().catch((err) => {
  const detail = err instanceof CredentialRequestRedirectError
    ? `${err.code} (HTTP ${err.status}, retryable=false)`
    : err instanceof Error ? err.message : String(err);
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${detail}`);
  process.exit(1);
}).finally(() => outputRedaction.close());
