import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';

const rememberInputSchema: ListToolsResult['tools'][number]['inputSchema'] = {
  type: 'object',
  description: 'Remember input',
  properties: {
    content: { type: 'string', description: 'Content to remember', minLength: 3 },
    context: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    metadata: {
      type: 'object',
      properties: { source: { type: 'string' } },
      required: ['source'],
      additionalProperties: false,
    },
  },
  required: ['content'],
  additionalProperties: true,
};

const remoteTools: ListToolsResult['tools'] = [
  {
    name: 'echo',
    description: 'Echo',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: true,
    },
  },
  {
    name: 'remember',
    description: 'Remember',
    inputSchema: rememberInputSchema,
  },
];

function createRemoteTestMcpServer(name: string): Server {
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: remoteTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    if (request.params.name === 'echo') {
      return { content: [{ type: 'text' as const, text: String(args.text ?? '') }], isError: false as const };
    }
    if (request.params.name === 'remember') {
      const progressToken = request.params._meta?.progressToken;
      if (typeof progressToken === 'string' || typeof progressToken === 'number') {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: 1,
            total: 2,
            message: String(request.params._meta?.requestTrace ?? 'missing-trace'),
          },
        });
      }
      return { content: [{ type: 'text' as const, text: `${String(args.content ?? '')}:${String(request.params._meta?.requestTrace ?? '')}` }], isError: false as const };
    }
    return { content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }], isError: true as const };
  });

  return server;
}

function expectRememberSchemaPreserved(inputSchema: unknown): void {
  expect(inputSchema).toMatchObject({
    type: 'object',
    description: 'Remember input',
    required: ['content'],
    additionalProperties: true,
    properties: {
      content: { type: 'string', description: 'Content to remember', minLength: 3 },
      context: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      metadata: {
        type: 'object',
        properties: { source: { type: 'string' } },
        required: ['source'],
        additionalProperties: false,
      },
    },
  });
}

function readFirstTextContent(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const first = content[0];
  if (!first || typeof first !== 'object') return '';
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function resolveRemoteBridgeInvocation(): Promise<{
  command: string;
  args: string[];
  env?: Record<string, string>;
}> {
  return resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
    preferSourceEntrypoint: true,
  });
}

async function startTestMcpHttpServer(): Promise<{ url: string; stop: () => void }> {
  const server = createServer(async (req, res) => {
    const mcp = createRemoteTestMcpServer('test-mcp');

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.once('close', () => {
      transport.close().catch(() => {});
      Promise.resolve(mcp.close()).catch(() => {});
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${addr.port}`));
    });
  });

  return { url: baseUrl.toString(), stop: () => server.close() };
}

async function startTestMcpSseServer(): Promise<{ url: string; stop: () => void }> {
  const transportsBySessionId = new Map<string, { transport: SSEServerTransport; mcp: Server }>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/sse') {
      const mcp = createRemoteTestMcpServer('test-mcp-sse');

      const transport = new SSEServerTransport('/message', res);
      transportsBySessionId.set(transport.sessionId, { transport, mcp });

      res.once('close', () => {
        transportsBySessionId.delete(transport.sessionId);
        transport.close().catch(() => {});
        Promise.resolve(mcp.close()).catch(() => {});
      });

      await mcp.connect(transport);
      return;
    }

    if (req.method === 'POST' && pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const entry = transportsBySessionId.get(sessionId) ?? null;
      if (!entry) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await entry.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end();
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${addr.port}`));
    });
  });

  return { url: new URL('/sse', baseUrl).toString(), stop: () => server.close() };
}

describe('remoteMcpStdioBridge', () => {
  it('proxies listTools/callTool over streamable http via stdio', async () => {
    const httpServer = await startTestMcpHttpServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    let client: Client | null = null;
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: httpServer.url,
          headers: { 'X-Test': randomUUID() },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools();
      const names = (tools.tools ?? []).map((t) => String(t.name));
      expect(names).toContain('echo');
      expect(names).toContain('remember');

      const rememberTool = (tools.tools ?? []).find((t) => t.name === 'remember');
      expectRememberSchemaPreserved(rememberTool?.inputSchema);

      const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      const text = readFirstTextContent(res);
      expect(text).toBe('hi');

      const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];
      const rememberRes = await client.callTool(
        { name: 'remember', arguments: { content: 'store this', tags: ['workflow'], metadata: { source: 'test' } }, _meta: { requestTrace: 'trace-http' } },
        undefined,
        { onprogress: (progress) => progressEvents.push(progress) },
      );
      const rememberText = readFirstTextContent(rememberRes);
      expect(rememberText).toBe('store this:trace-http');
      expect(progressEvents).toEqual([{ progress: 1, total: 2, message: 'trace-http' }]);

      const closeStartedAt = Date.now();
      await client.close();
      client = null;
      expect(Date.now() - closeStartedAt).toBeLessThan(1_500);

    } finally {
      await client?.close().catch(() => {});
      httpServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports SSE transport via stdio bridge', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    let client: Client | null = null;
    try {
      const configPath = join(tmp, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'sse',
          url: sseServer.url,
          headers: {},
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      client = new Client({ name: 'bridge-test-sse', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools();
      const rememberTool = (tools.tools ?? []).find((t) => t.name === 'remember');
      expectRememberSchemaPreserved(rememberTool?.inputSchema);

      const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      const text = readFirstTextContent(res);
      expect(text).toBe('hi');

      const rememberRes = await client.callTool({ name: 'remember', arguments: { content: 'store this', tags: ['workflow'], metadata: { source: 'test' } }, _meta: { requestTrace: 'trace-sse' } });
      const rememberText = readFirstTextContent(rememberRes);
      expect(rememberText).toBe('store this:trace-sse');

    } finally {
      await client?.close().catch(() => {});
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('removes the config file when startup fails before the remote connect succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: 'http://127.0.0.1:9',
          headers: { Authorization: 'Bearer SHOULD_NOT_PERSIST' },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();
      const child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      await expect(access(configPath)).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
