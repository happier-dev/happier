import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';

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

async function waitForJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Readonly<{ id?: unknown }>;
          if (message.id === id) {
            cleanup();
            resolve();
            return;
          }
        } catch {
          // Keep reading until a complete JSON-RPC response arrives.
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Bridge exited before JSON-RPC response ${id}: ${code ?? signal ?? 'unknown'}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 3_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for remote MCP bridge process to exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function startTestMcpHttpServer(): Promise<{ url: string; stop: () => void }> {
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'test-mcp', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      {
        description: 'Echo',
        inputSchema: z.object({ text: z.string() }).passthrough(),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      } as any,
      async (args: any) => ({
        content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
        structuredContent: { echoed: String(args?.text ?? '') },
        isError: false as const,
      }),
    );

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
  const transportsBySessionId = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/sse') {
      const mcp = new McpServer({ name: 'test-mcp-sse', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo',
          inputSchema: z.object({ text: z.string() }).passthrough(),
          outputSchema: z.object({ echoed: z.string() }),
          annotations: { readOnlyHint: true },
          _meta: { 'acme.example/source': 'sse-integration-test' },
        } as any,
        async (args: any) => ({
          content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
          structuredContent: { echoed: String(args?.text ?? '') },
          isError: false as const,
        }),
      );

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
      await entry.transport.handlePostMessage(req as any, res);
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

      const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      const names = (tools.tools ?? []).map((t: any) => String(t.name));
      expect(names).toContain('echo');
      expect(tools.tools.find((tool) => tool.name === 'echo')?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();
    } finally {
      httpServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports SSE transport via stdio bridge', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
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

      const client = new Client({ name: 'bridge-test-sse', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'sse-integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();
    } finally {
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('closes the remote SSE client and exits when the controlling stdio stream ends', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
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
      child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-eof-test', version: '1.0.0' },
        },
      })}\n`);
      await waitForJsonRpcResponse(child, 1);

      child.stdin.end();

      await expect(waitForChildExit(child)).resolves.toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
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
