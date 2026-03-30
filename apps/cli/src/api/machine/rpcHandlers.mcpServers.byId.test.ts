import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

describe('rpcHandlers.mcpServers (byId)', () => {
  it('tests a stored MCP server by id using effective bindings', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as any;

    const settings = accountSettingsParse({
      mcpServersSettingsV1: {
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 'srv_1',
            name: 'fixture',
            transport: 'stdio',
            stdio: { command: process.execPath, args: ['-v'] },
            env: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        bindings: [
          {
            id: 'bind_1',
            serverId: 'srv_1',
            enabled: true,
            target: { t: 'machine', machineId: 'm1' },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
    });

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => ({
          token: 'tok_test',
          encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
        }) as any,
        bootstrapAccountSettingsContext: async () => ({
          source: 'cache',
          settings,
          settingsVersion: 1,
          loadedAtMs: 0,
          whenRefreshed: null,
        }),
        probeMcpStdioServerTools: async () => [{ name: 'echo' }],
      },
    } as any);

    const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    expect(handler).toBeTruthy();

    const out = (await handler!({
      t: 'byId',
      machineId: 'm1',
      directory: '/',
      serverId: 'srv_1',
    })) as any;

    expect(out.ok).toBe(true);
    expect(out.toolNamesSample).toContain('echo');
  });
});

