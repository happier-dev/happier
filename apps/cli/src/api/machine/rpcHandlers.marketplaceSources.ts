import { MarketplaceSourceRegistryV1Schema, type MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

export function registerMachineMarketplaceSourcesRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    happyHomeDir?: string;
  }>;
}>): void {
  const store = createMarketplaceSourceRegistryStore({
    happyHomeDir: params.deps?.happyHomeDir,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET, async (): Promise<MarketplaceSourceRegistryV1> => {
    return await store.read();
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET, async (raw: unknown): Promise<MarketplaceSourceRegistryV1 | ReturnType<typeof invalidRequest>> => {
    const parsed = MarketplaceSourceRegistryV1Schema.safeParse(raw);
    if (!parsed.success) {
      return invalidRequest('invalid_request');
    }

    await store.write(parsed.data);
    return parsed.data;
  });
}
