import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

describe('rpcHandlers.mcpServers (redaction)', () => {
  it('redacts sensitive text from test errors', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as any;

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager,
      deps: {
        readCredentials: async () => ({
          token: 'tok_test',
          encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
        }) as any,
        bootstrapAccountSettingsContext: async () => ({
          source: 'none',
          settings: accountSettingsParse({}),
          settingsVersion: 0,
          loadedAtMs: 0,
          whenRefreshed: null,
        }),
        probeMcpStdioServerTools: async () => {
          throw new Error('Authorization: Bearer abc/def+ghi==');
        },
      },
    } as any);

    const handler = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST);
    expect(handler).toBeTruthy();

    const out = (await handler!({
      t: 'draft',
      machineId: 'm1',
      directory: '/',
      server: {
        id: 'srv_1',
        name: 'fixture',
        transport: 'stdio',
        stdio: { command: process.execPath, args: ['-v'] },
        env: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      binding: null,
    })) as any;

    expect(out.ok).toBe(false);
    expect(String(out.error ?? '')).not.toContain('abc/def');
    expect(String(out.error ?? '')).toContain('[REDACTED]');
  });
});

