import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

describe('rpcHandlers.mcpServers (test)', () => {
  it('lists tools for a draft stdio server on a machine', async () => {
    const baseDir = join(process.cwd(), '.project', 'tmp');
    await mkdir(baseDir, { recursive: true });
    const root = await mkdtemp(join(baseDir, 'happier-mcp-test-rpc-'));
    try {
      const serverPath = join(root, 'fixture.mjs');
      await writeFile(
        serverPath,
        [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
          "import { z } from 'zod';",
          '',
          "const server = new McpServer({ name: 'Fixture', version: '1.0.0' });",
          "server.registerTool('echo', { title: 'Echo', inputSchema: z.object({ text: z.string() }) }, async (args) => {",
          "  return { content: [{ type: 'text', text: String(args?.text ?? '') }] };",
          '});',
          'await server.connect(new StdioServerTransport());',
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

      const credentials = {
        token: 'tok_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
      };

      registerMachineMcpServersRpcHandlers({
        rpcHandlerManager,
        deps: {
          readCredentials: async () => credentials as any,
          bootstrapAccountSettingsContext: async () => ({
            source: 'none',
            settings: accountSettingsParse({}),
            settingsVersion: 0,
            loadedAtMs: 0,
            whenRefreshed: null,
          }),
        },
      } as any);

      const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
      expect(handler).toBeTruthy();

      const out = (await handler!({
        t: 'draft',
        machineId: 'm1',
        directory: root,
        server: {
          id: 'srv_1',
          name: 'fixture',
          transport: 'stdio',
          stdio: { command: process.execPath, args: [serverPath] },
          env: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        binding: null,
      })) as any;

      expect(out.ok).toBe(true);
      expect(out.toolCount).toBeGreaterThan(0);
      expect(out.toolNamesSample).toContain('echo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
