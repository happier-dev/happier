import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

describe('rpcHandlers.mcpServers (preview)', () => {
  it('returns built-in, managed, and detected preview entries for the selected backend', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as any;

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => ({ encryption: { type: 'legacy', secret: 'secret' } } as any),
        bootstrapAccountSettingsContext: async () => ({
          settings: {
            mcpServersSettingsV1: {
              v: 1,
              strictMode: false,
              servers: [
                {
                  id: 'server-a',
                  name: 'playwright',
                  transport: 'stdio',
                  stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                  env: {},
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              bindings: [
                {
                  id: 'binding-a',
                  serverId: 'server-a',
                  enabled: true,
                  target: { t: 'machine', machineId: 'machine-1' },
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            },
            secrets: [],
          },
        } as any),
        detectProviderMcpServers: async () => ({
          servers: [
            {
              provider: 'codex',
              name: 'context7',
              transport: 'stdio',
              stdio: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
              envKeys: [],
              enabled: true,
              source: { kind: 'user', path: '/Users/test/.codex/config.toml' },
            },
          ],
          warnings: [],
        }),
      },
    });

    const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
    expect(handler).toBeTruthy();

    const out = (await handler!({
      machineId: 'machine-1',
      directory: '/repo',
      agentId: 'codex',
      selection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
      },
    })) as any;

    expect(out.ok).toBe(true);
    expect(out.builtIn).toEqual([
      expect.objectContaining({
        name: 'happier',
        sourceKind: 'builtIn',
      }),
    ]);
    expect(out.managed).toEqual([
      expect.objectContaining({
        serverId: 'server-a',
        name: 'playwright',
        sourceKind: 'managed',
        selected: true,
      }),
    ]);
    expect(out.detected).toEqual([
      expect.objectContaining({
        provider: 'codex',
        name: 'context7',
        sourceKind: 'detected',
      }),
    ]);
  });
});
