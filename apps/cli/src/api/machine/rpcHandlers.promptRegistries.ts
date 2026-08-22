import {
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryListAdaptersResponseV1,
  PromptRegistryListSourcesRequestV1Schema,
  PromptRegistryListSourcesResponseV1,
  PromptRegistryScanSourceRequestV1Schema,
  RPC_METHODS,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry, type PromptRegistryRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { PROMPT_REGISTRY_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { installPromptRegistryItem, scanPromptRegistrySource } from '@/prompts/registries/actions';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

function internalError(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return invalidRequest(error.message);
  }
  return invalidRequest('internal_error');
}

function createPromptRegistryRpcActionExecutor(params: Readonly<{
  registry: PromptRegistryRegistry;
  assetRegistry: ReadonlyMap<string, PromptAssetAdapter>;
}>): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      if (actionId === 'daemon.promptRegistry.scanSource') {
        const parsed = PromptRegistryScanSourceRequestV1Schema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        return {
          ok: true,
          result: await scanPromptRegistrySource({ registry: params.registry, request: parsed.data }),
        };
      }

      if (actionId === 'daemon.promptRegistry.install') {
        const parsed = PromptRegistryInstallRequestV1Schema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        return {
          ok: true,
          result: await installPromptRegistryItem({
            registry: params.registry,
            assetRegistry: params.assetRegistry,
            request: parsed.data,
            ...(context?.signal ? { signal: context.signal } : {}),
          }),
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

export function registerMachinePromptRegistriesRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  registry?: PromptRegistryRegistry;
  assetRegistry?: ReadonlyMap<string, PromptAssetAdapter>;
  actionExecutor?: RpcActionExecutor;
  deps?: Readonly<{
    homedir?: () => string;
    happierHomeDir?: () => string;
  }>;
}>): void {
  const registry = params.registry ?? createPromptRegistryAdapterRegistry();
  const assetRegistry = params.assetRegistry ?? createPromptAssetAdapterRegistry({
    homedir: params.deps?.homedir,
    happierHomeDir: params.deps?.happierHomeDir,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS, async (): Promise<PromptRegistryListAdaptersResponseV1> => {
    return {
      ok: true,
      adapters: [...registry.adapters.values()].map((adapter) => adapter.descriptor),
    };
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES, async (raw: unknown): Promise<PromptRegistryListSourcesResponseV1> => {
    const parsed = PromptRegistryListSourcesRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request');

    try {
      const sources = await registry.listSources(parsed.data.configuredSources);
      return {
        ok: true,
        sources: sources.map((source) => source.descriptor),
      };
    } catch (error) {
      return internalError(error);
    }
  });

  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: params.actionExecutor ?? createPromptRegistryRpcActionExecutor({ registry, assetRegistry }),
    scopes: PROMPT_REGISTRY_RPC_SCOPES,
  });
}
