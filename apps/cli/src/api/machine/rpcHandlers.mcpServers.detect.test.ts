import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

describe('rpcHandlers.mcpServers (detect)', () => {
  it('detects Codex MCP servers from CODEX_HOME config.toml without returning secrets', async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-detect-'));
    try {
      process.env.CODEX_HOME = dir;
      await writeFile(
        join(dir, 'config.toml'),
        [
          '[mcp_servers.context7]',
          'command = "npx"',
          'args = ["-y","@context7/mcp"]',
          'enabled = true',
          '',
          '[mcp_servers.playwright]',
          'command = "node"',
          'args = ["server.js"]',
          'enabled = false',
          '',
        ].join('\n'),
        'utf8',
      );

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
          handlers.set(method, handler);
        },
      } as any;

      registerMachineMcpServersRpcHandlers({ rpcHandlerManager });

      const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT);
      expect(handler).toBeTruthy();

      const out = (await handler!({ machineId: 'm1', providers: ['codex'] })) as any;
      expect(out.ok).toBe(true);

      const servers = Array.isArray(out.servers) ? out.servers : [];
      expect(servers.length).toBeGreaterThan(0);

      const ctx7 = servers.find((s: any) => s.provider === 'codex' && s.name === 'context7');
      expect(ctx7).toBeTruthy();
      expect(ctx7.transport).toBe('stdio');
      expect(ctx7.stdio).toEqual({ command: 'npx', args: ['-y', '@context7/mcp'] });
      expect(ctx7.envKeys).toEqual([]);
      expect(ctx7.remote).toBeUndefined();
    } finally {
      if (typeof prevCodexHome === 'string') process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects Claude MCP servers from CLAUDE_CONFIG_DIR settings.json without returning secrets', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-claude-detect-'));
    try {
      process.env.CLAUDE_CONFIG_DIR = dir;
      await writeFile(
        join(dir, 'settings.json'),
        JSON.stringify(
          {
            mcpServers: {
              context7: {
                command: 'npx',
                args: ['-y', '@context7/mcp'],
                env: { API_KEY: 'supersecret' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
          handlers.set(method, handler);
        },
      } as any;

      registerMachineMcpServersRpcHandlers({ rpcHandlerManager });

      const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT);
      expect(handler).toBeTruthy();

      const out = (await handler!({ machineId: 'm1', providers: ['claude'] })) as any;
      expect(out.ok).toBe(true);

      const servers = Array.isArray(out.servers) ? out.servers : [];
      const ctx7 = servers.find((s: any) => s.provider === 'claude' && s.name === 'context7');
      expect(ctx7).toBeTruthy();
      expect(ctx7.transport).toBe('stdio');
      expect(ctx7.stdio).toEqual({ command: 'npx', args: ['-y', '@context7/mcp'] });
      expect(ctx7.envKeys).toEqual(['API_KEY']);
      expect(JSON.stringify(ctx7)).not.toContain('supersecret');
    } finally {
      if (typeof prevClaudeConfigDir === 'string') process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      else delete process.env.CLAUDE_CONFIG_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects OpenCode MCP servers from XDG_CONFIG_HOME config without returning secrets', async () => {
    const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-opencode-detect-'));
    try {
      process.env.XDG_CONFIG_HOME = dir;
      const cfgDir = join(dir, 'opencode');
      await mkdir(cfgDir, { recursive: true });
      await writeFile(
        join(cfgDir, 'opencode.json'),
        JSON.stringify(
          {
            mcpServers: {
              localtool: {
                command: 'node',
                args: ['server.js'],
                env: { TOKEN: 'supersecret' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
          handlers.set(method, handler);
        },
      } as any;

      registerMachineMcpServersRpcHandlers({ rpcHandlerManager });

      const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT);
      expect(handler).toBeTruthy();

      const out = (await handler!({ machineId: 'm1', providers: ['opencode'] })) as any;
      expect(out.ok).toBe(true);

      const servers = Array.isArray(out.servers) ? out.servers : [];
      const s = servers.find((entry: any) => entry.provider === 'opencode' && entry.name === 'localtool');
      expect(s).toBeTruthy();
      expect(s.transport).toBe('stdio');
      expect(s.stdio).toEqual({ command: 'node', args: ['server.js'] });
      expect(s.envKeys).toEqual(['TOKEN']);
      expect(JSON.stringify(s)).not.toContain('supersecret');
    } finally {
      if (typeof prevXdgConfigHome === 'string') process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
      else delete process.env.XDG_CONFIG_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
