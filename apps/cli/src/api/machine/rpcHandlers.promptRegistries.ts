import {
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1,
  PromptRegistryListAdaptersResponseV1,
  PromptRegistryListSourcesRequestV1Schema,
  PromptRegistryListSourcesResponseV1,
  PromptRegistryScanSourceRequestV1Schema,
  PromptRegistryScanSourceResponseV1,
  RPC_METHODS,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { PromptAssetAdapter } from '@/prompts/assets/types';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry, type PromptRegistryRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { PROMPT_REGISTRY_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';

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
    execute: async (actionId, input) => {
      if (actionId === 'daemon.promptRegistry.scanSource') {
        const parsed = PromptRegistryScanSourceRequestV1Schema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        try {
          const items = await params.registry.scanSource({
            sourceId: parsed.data.sourceId,
            configuredSources: parsed.data.configuredSources,
            query: parsed.data.query ?? null,
          });

          return { ok: true, result: { ok: true, items } satisfies PromptRegistryScanSourceResponseV1 };
        } catch (error) {
          return { ok: true, result: internalError(error) };
        }
      }

      if (actionId === 'daemon.promptRegistry.install') {
        const parsed = PromptRegistryInstallRequestV1Schema.safeParse(input);
        if (!parsed.success) return { ok: true, result: invalidRequest('invalid_request') };

        const adapter = params.assetRegistry.get(parsed.data.installTarget.assetTypeId);
        if (!adapter) {
          return { ok: true, result: invalidRequest('unsupported asset type') };
        }
        if (adapter.descriptor.libraryKind !== 'bundle') {
          return { ok: true, result: invalidRequest('registry installs require a bundle-capable prompt asset type') };
        }
        if (adapter.descriptor.capabilities.supportsCatalogInstall !== true) {
          return { ok: true, result: invalidRequest('prompt asset type does not support registry installs') };
        }
        if (adapter.descriptor.supportsScope[parsed.data.installTarget.scope] !== true) {
          return { ok: true, result: invalidRequest('prompt asset type does not support the selected scope') };
        }

        try {
          const fetched = await params.registry.fetchItem({
            sourceId: parsed.data.sourceId,
            itemId: parsed.data.itemId,
            configuredSources: parsed.data.configuredSources,
          });
          if (!fetched.ok) {
            return {
              ok: true,
              result: {
                ok: false,
                errorCode: fetched.errorCode === 'not_found' ? 'not_found' : fetched.errorCode === 'unsupported' ? 'unsupported' : 'invalid_request',
                error: fetched.error,
              },
            };
          }

          return {
            ok: true,
            result: await adapter.writeBundle({
              assetTypeId: parsed.data.installTarget.assetTypeId,
              scope: parsed.data.installTarget.scope,
              directory: parsed.data.installTarget.scope === 'project'
                ? (parsed.data.installTarget.directory ?? null)
                : null,
              targetName: parsed.data.installTarget.targetName,
              title: fetched.item.title,
              bundleSchemaId: fetched.item.bundleSchemaId,
              bundleBody: fetched.item.bundleBody,
              installMode: parsed.data.installTarget.installMode,
              previewOnly: parsed.data.previewOnly,
              expectedDigest: parsed.data.expectedDigest,
            }),
          };
        } catch (error) {
          return { ok: true, result: internalError(error) as PromptRegistryInstallResponseV1 };
        }
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
