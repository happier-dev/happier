import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '../rpc/types';

export function registerMachineSpawnSessionNonceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<SpawnSessionNonceResolution>;
}>): void {
  const resolve = async (input: { spawnNonce?: unknown }) => {
    const spawnNonce = typeof input?.spawnNonce === 'string' ? input.spawnNonce.trim() : '';
    if (!spawnNonce) return { status: 'not_found' as const };
    if (!params.resolveSpawnSessionByNonce) return { status: 'unsupported' as const };
    return await params.resolveSpawnSessionByNonce(spawnNonce);
  };

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    resolve,
  );
  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
    resolve,
  );
}
