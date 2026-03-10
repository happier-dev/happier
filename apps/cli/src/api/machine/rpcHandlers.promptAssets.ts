import {
  PromptAssetDeleteRequestSchema,
  PromptAssetDiscoverRequestSchema,
  PromptAssetDiscoverResponseV1,
  PromptAssetListTypesResponseV1,
  PromptAssetReadRequestSchema,
  PromptAssetReadResponseV1,
  PromptAssetWriteRequestSchema,
  RPC_METHODS,
  type PromptAssetMutationResponseV1,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';

function invalidRequest(error: string): Exclude<PromptAssetMutationResponseV1, { ok: true }> {
  return { ok: false, errorCode: 'invalid_request', error };
}

export function registerMachinePromptAssetsRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    homedir?: () => string;
    happierHomeDir?: () => string;
  }>;
}>): void {
  const registry = createPromptAssetAdapterRegistry({
    homedir: params.deps?.homedir,
    happierHomeDir: params.deps?.happierHomeDir,
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES, async (): Promise<PromptAssetListTypesResponseV1> => {
    return {
      ok: true,
      types: [...registry.values()].map((adapter) => adapter.descriptor),
    };
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER, async (raw: unknown): Promise<PromptAssetDiscoverResponseV1 | ReturnType<typeof invalidRequest>> => {
    const parsed = PromptAssetDiscoverRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request');

    const adapter = registry.get(parsed.data.assetTypeId);
    if (!adapter) return invalidRequest('unsupported asset type');

    return {
      ok: true,
      items: await adapter.discover(parsed.data),
    };
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_READ, async (raw: unknown): Promise<PromptAssetReadResponseV1> => {
    const parsed = PromptAssetReadRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request') as PromptAssetReadResponseV1;

    const adapter = registry.get(parsed.data.assetTypeId);
    if (!adapter) return invalidRequest('unsupported asset type') as PromptAssetReadResponseV1;

    return await adapter.read(parsed.data);
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_WRITE, async (raw: unknown): Promise<PromptAssetMutationResponseV1> => {
    const parsed = PromptAssetWriteRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request');

    const adapter = registry.get(parsed.data.assetTypeId);
    if (!adapter) return invalidRequest('unsupported asset type');

    if ('bundleBody' in parsed.data) {
      return await adapter.writeBundle(parsed.data);
    }

    return await adapter.writeDoc(parsed.data);
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE, async (raw: unknown): Promise<PromptAssetMutationResponseV1> => {
    const parsed = PromptAssetDeleteRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest('invalid_request');

    const adapter = registry.get(parsed.data.assetTypeId);
    if (!adapter) return invalidRequest('unsupported asset type');

    return await adapter.delete(parsed.data);
  });
}
