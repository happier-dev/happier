import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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

import { projectPath } from '@/projectPath';

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function startTestMcpHttpServer(): Promise<{ url: string; stop: () => void }> {
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'test-mcp', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      {
        description: 'Echo',
        inputSchema: z.object({ text: z.string() }).passthrough(),
      } as any,
      async (args: any) => ({
        content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
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
        { description: 'Echo', inputSchema: z.object({ text: z.string() }).passthrough() } as any,
        async (args: any) => ({
          content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
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
      const configPath = join(tmp, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: httpServer.url,
          headers: { 'X-Test': randomUUID() },
        }),
        { mode: 0o600 },
      );

      const bridgeEntrypoint = join(projectPath(), 'dist', 'mcp', 'bridges', 'remoteMcpStdioBridge.mjs');

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bridgeEntrypoint],
        env: {
          ...resolveEnvRecord(),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools();
      const names = (tools.tools ?? []).map((t: any) => String(t.name));
      expect(names).toContain('echo');

      const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');

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

      const bridgeEntrypoint = join(projectPath(), 'dist', 'mcp', 'bridges', 'remoteMcpStdioBridge.mjs');

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bridgeEntrypoint],
        env: {
          ...resolveEnvRecord(),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test-sse', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');

      await client.close();
    } finally {
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('removes the config file when startup fails before the remote connect succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: 'http://127.0.0.1:9',
          headers: { Authorization: 'Bearer SHOULD_NOT_PERSIST' },
        }),
        { mode: 0o600 },
      );

      const bridgeEntrypoint = join(projectPath(), 'dist', 'mcp', 'bridges', 'remoteMcpStdioBridge.mjs');
      const child = spawn(process.execPath, [bridgeEntrypoint], {
        env: {
          ...resolveEnvRecord(),
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
