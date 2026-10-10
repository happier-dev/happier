import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_SIGN_IN_PREPARE_RPC_METHOD, AGENT_SIGN_IN_STATUS_RPC_METHOD } from '@happier-dev/protocol/daemon/agentSignIn';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import * as machineRpcModule from './rpcHandlers';

describe('rpcHandlers bundle stability', () => {
  it('does not dynamically import fork-chain replay hydration (avoids dev rebuild breakage)', async () => {
    const rpcHandlersPath = fileURLToPath(new URL('./rpcHandlers.ts', import.meta.url));
    const text = await readFile(rpcHandlersPath, 'utf8');

    expect(text).not.toMatch(/import\([^)]*hydrateReplayDialogFromForkChain/);
  });

  it('can import the machine rpc handler module without stale backend leaf paths', async () => {
    expect(typeof machineRpcModule.registerMachineRpcHandlers).toBe('function');
  });

  it('preserves native sign-in and terminal operations in ordinary daemon composition', async () => {
    const { registerMachineRpcHandlers } = machineRpcModule;
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-sign-in', encryptionMode: 'plain' });
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: manager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'session-sign-in' }),
        stopSession: async () => true,
        requestShutdown: () => undefined,
      },
    });
    try {
      expect(manager.hasHandler(AGENT_SIGN_IN_STATUS_RPC_METHOD)).toBe(true);
      expect(manager.hasHandler(AGENT_SIGN_IN_PREPARE_RPC_METHOD)).toBe(true);
      expect(manager.hasHandler(RPC_METHODS.DAEMON_TERMINAL_LIST)).toBe(true);
      await expect(manager.handleRequest({
        method: `machine-sign-in:${AGENT_SIGN_IN_STATUS_RPC_METHOD}`,
        params: { agentId: 'missing-fixture-agent' },
      })).resolves.toMatchObject({ status: 'unknown' });
    } finally {
      await registration.dispose();
    }
  });
});
