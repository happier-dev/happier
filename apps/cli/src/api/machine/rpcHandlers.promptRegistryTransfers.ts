import {
  PromptRegistryFetchItemRequestV1Schema,
  RPC_METHODS,
  type PromptRegistryFetchItemRequestV1,
} from '@happier-dev/protocol';

import type { PromptRegistryRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { type TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { resolvePromptRegistryItemDownloadSource } from '@/transfers/targets/resolvePromptRegistryItemDownloadSource';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineDownloadTransferRpcHandlers } from './transfers/registerMachineDownloadTransferRpcHandlers';

export type MachinePromptRegistryTransferRpcRegistration = Readonly<{
  transferSessionStore: TransferSessionStore;
  downloadStore: TransferSessionStore;
  dispose: () => Promise<void>;
}>;

export function registerMachinePromptRegistryTransferRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  registry: PromptRegistryRegistry;
}>): MachinePromptRegistryTransferRpcRegistration {
  const downloadRegistration = registerMachineDownloadTransferRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    methods: {
      init: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
    },
    parseRequest: (data) => {
      const parsed = PromptRegistryFetchItemRequestV1Schema.safeParse(data);
      return parsed.success ? (parsed.data as PromptRegistryFetchItemRequestV1) : null;
    },
    resolveSource: async (request) => {
      const source = await resolvePromptRegistryItemDownloadSource({
        registry: params.registry,
        request,
      });
      if (!source.success) {
        return source;
      }

      return {
        source: source.source,
        diagnosticContext: {
          transferKind: 'prompt_registry',
        },
      };
    },
    initFailureMessage: 'Prompt registry download init failed',
  });

  return {
    transferSessionStore: downloadRegistration.transferSessionStore,
    downloadStore: downloadRegistration.transferSessionStore,
    dispose: downloadRegistration.dispose,
  };
}
