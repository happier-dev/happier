import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

describe('rpcHandlers (mcp servers)', () => {
  it('registers daemon.mcpServers.* handlers', () => {
    const registered = new Map<string, unknown>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: unknown) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW)).toBe(true);
  });
});
