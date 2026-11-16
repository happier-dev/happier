import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { RpcHandler } from '@/api/rpc/types';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { createMcpOwnerRpcContext, MCP_TEST_HOME_ID } from './mcpServers.testkit';

describe('rpcHandlers.mcpServers (redaction)', () => {
  it('redacts sensitive text from test errors', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => {
        handlers.set(method, async raw => handler(raw, createMcpOwnerRpcContext()));
      },
    };

    registerMachineMcpServersRpcHandlers({
      // The transport boundary only records handlers; production admission and redaction remain real.
      rpcHandlerManager: rpcHandlerManager as unknown as RpcHandlerManager,
      deps: {
        hostHomeServerIdentityId: MCP_TEST_HOME_ID,
        readCredentials: async () => ({
          token: 'tok_test',
          encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
        }),
        bootstrapAccountSettingsContext: async () => ({
          source: 'none',
          settings: accountSettingsParse({}),
          settingsVersion: 0,
          loadedAtMs: 0,
          settingsSecretsReadKeys: [],
          whenRefreshed: null,
        }),
        probeMcpStdioServerTools: async () => {
          throw new Error('Authorization: Bearer abc/def+ghi==');
        },
      },
    });

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

