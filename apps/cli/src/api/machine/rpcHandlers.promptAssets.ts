import {
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetDiscoverResponseV1,
  PromptAssetListTypesResponseV1,
  RPC_METHODS,
  type PromptAssetMutationResponseV1,
} from '@happier-dev/protocol';

import type { PromptAssetAdapter } from '@/prompts/assets/types';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { PROMPT_ASSET_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';

function invalidRequest(error: string): Exclude<PromptAssetMutationResponseV1, { ok: true }> {
  return { ok: false, errorCode: 'invalid_request', error };
}

function createPromptAssetRpcActionExecutor(
  registry: ReadonlyMap<string, PromptAssetAdapter>,
): RpcActionExecutor {
  return {
    execute: async (actionId, input) => {
      if (actionId === 'daemon.promptAssets.discover') {
        const parsed = PromptAssetDiscoverRequestSchema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        const adapter = registry.get(parsed.data.assetTypeId);
        if (!adapter) return { ok: true, result: invalidRequest('unsupported asset type') };

        return {
          ok: true,
          result: {
            ok: true,
            items: await adapter.discover(parsed.data),
          } satisfies PromptAssetDiscoverResponseV1,
        };
      }

      if (actionId === 'daemon.promptAssets.delete') {
        const parsed = PromptAssetDeleteRequestSchema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        const adapter = registry.get(parsed.data.assetTypeId);
        if (!adapter) return { ok: true, result: invalidRequest('unsupported asset type') };

        return {
          ok: true,
          result: await adapter.delete(parsed.data),
        };
      }

      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${actionId}`,
      };
    },
  };
}

export function registerMachinePromptAssetsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  adapterRegistry?: ReadonlyMap<string, PromptAssetAdapter>;
  actionExecutor?: RpcActionExecutor;
  deps?: Readonly<{
    homedir?: () => string;
    happierHomeDir?: () => string;
  }>;
}>): void {
  const registry = params.adapterRegistry ?? createPromptAssetAdapterRegistry({
    homedir: params.deps?.homedir,
    happierHomeDir: params.deps?.happierHomeDir,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES, async (): Promise<PromptAssetListTypesResponseV1> => {
    return {
      ok: true,
      types: [...registry.values()].map((adapter) => adapter.descriptor),
    };
  });

  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: params.actionExecutor ?? createPromptAssetRpcActionExecutor(registry),
    scopes: PROMPT_ASSET_RPC_SCOPES,
  });
}
