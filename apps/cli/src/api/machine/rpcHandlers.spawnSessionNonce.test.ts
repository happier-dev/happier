import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineSpawnSessionNonceRpcHandlers } from './rpcHandlers.spawnSessionNonce';

describe('registerMachineSpawnSessionNonceRpcHandlers', () => {
  it('delegates the current and remote-dev predecessor names to one resolver', async () => {
    const registered = new Map<string, RpcHandler>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        registered.set(method, handler);
      },
    };
    const resolveSpawnSessionByNonce = vi.fn(async () => ({
      status: 'success' as const,
      sessionId: 'session-1',
    }));
    registerMachineSpawnSessionNonceRpcHandlers({
      rpcHandlerManager,
      resolveSpawnSessionByNonce,
    });

    const current = registered.get(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE);
    const predecessor = registered.get(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE);
    expect(current).toBeDefined();
    expect(predecessor).toBeDefined();

    await expect(current?.({ spawnNonce: ' current ' })).resolves.toEqual({
      status: 'success',
      sessionId: 'session-1',
    });
    await expect(predecessor?.({ spawnNonce: ' predecessor ' })).resolves.toEqual({
      status: 'success',
      sessionId: 'session-1',
    });
    expect(resolveSpawnSessionByNonce.mock.calls).toEqual([
      ['current'],
      ['predecessor'],
    ]);
  });
});
