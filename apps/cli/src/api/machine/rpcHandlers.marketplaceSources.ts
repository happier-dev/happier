import {
  MarketplaceSourceRegistryV1Schema,
  type MarketplaceSourceRegistryV1,
} from '@happier-dev/protocol';
import {
  HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD,
  HostPrivatePluginInstallDecisionV1Schema,
} from '@happier-dev/protocol/marketplace/internal';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { decideDaemonPluginChange } from '@/daemon/controlClient';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

export function registerMachineMarketplaceSourcesRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    happyHomeDir?: string;
    decidePluginChange?: typeof decideDaemonPluginChange;
  }>;
}>): void {
  const store = createMarketplaceSourceRegistryStore({
    happyHomeDir: params.deps?.happyHomeDir,
  });
  const index = createMarketplaceIndexService({ happyHomeDir: params.deps?.happyHomeDir });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET, async (): Promise<MarketplaceSourceRegistryV1> => {
    return await store.read();
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET, async (raw: unknown): Promise<MarketplaceSourceRegistryV1 | ReturnType<typeof invalidRequest>> => {
    const parsed = MarketplaceSourceRegistryV1Schema.safeParse(raw);
    if (!parsed.success) {
      return invalidRequest('invalid_request');
    }

    try {
      await store.write(parsed.data);
      return parsed.data;
    } catch {
      return invalidRequest('invalid_request');
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY, async (raw: unknown) => {
    try {
      return await index.query(raw);
    } catch {
      return invalidRequest('invalid_request');
    }
  });

  params.rpcHandlerManager.registerHandler(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, async (raw: unknown) => {
    const parsed = HostPrivatePluginInstallDecisionV1Schema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request');

    const decidePluginChange = params.deps?.decidePluginChange ?? decideDaemonPluginChange;
    if (parsed.data.decision === 'cancel') {
      return await decidePluginChange({
        pendingChangeId: parsed.data.pendingChangeId,
        decision: 'cancel',
      });
    }
    return await decidePluginChange({
      pendingChangeId: parsed.data.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: parsed.data.actorEvidence,
      optionalSelections: parsed.data.optionalSelections,
    });
  });
}
