import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerRegistrar } from '../rpc/types';

export function registerMachineSpawnSessionNonceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  resolveSpawnSessionByNonce?: (spawnNonce: string, timeoutMs?: number) => Promise<SpawnSessionNonceResolution>;
}>): void {
  const resolve = async (input: { spawnNonce?: unknown; timeoutMs?: unknown }) => {
    const spawnNonce = typeof input?.spawnNonce === 'string' ? input.spawnNonce.trim() : '';
    if (!spawnNonce) return { status: 'not_found' as const };
    if (!params.resolveSpawnSessionByNonce) return { status: 'unsupported' as const };
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 0
      ? input.timeoutMs : undefined;
    return await params.resolveSpawnSessionByNonce(spawnNonce, timeoutMs);
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
