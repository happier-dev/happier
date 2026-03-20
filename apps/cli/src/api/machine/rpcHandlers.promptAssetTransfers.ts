import {
  PromptAssetMutationResponseV1Schema,
  PromptAssetReadRequestSchema,
  RPC_METHODS,
  type PromptAssetMutationResponseV1,
  type PromptAssetReadRequest,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { PromptAssetAdapter } from '@/promptAssets/types';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { registerUploadTransferLifecycleHandlers } from '@/transfers/rpc/registerUploadTransferLifecycleHandlers';
import { resolvePromptAssetDownloadSource } from '@/transfers/targets/resolvePromptAssetDownloadSource';
import { resolvePromptAssetUploadTarget } from '@/transfers/targets/resolvePromptAssetUploadTarget';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineDownloadTransferRpcHandlers } from './transfers/registerMachineDownloadTransferRpcHandlers';

type PromptAssetUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
  | Readonly<{ success: false; error: string }>;

type PromptAssetUploadFinalizeResponse =
  | Readonly<{ success: true; response: PromptAssetMutationResponseV1 }>
  | Readonly<{ success: false; error: string }>;

export function registerMachinePromptAssetTransferRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  adapterRegistry: ReadonlyMap<string, PromptAssetAdapter>;
}>): void {
  const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerMachineDownloadTransferRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    store,
    methods: {
      init: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
    },
    parseRequest: (data) => {
      const parsed = PromptAssetReadRequestSchema.safeParse(data);
      return parsed.success ? (parsed.data as PromptAssetReadRequest) : null;
    },
    resolveSource: async (request) => {
      const source = await resolvePromptAssetDownloadSource({
        adapterRegistry: params.adapterRegistry,
        request,
      });
      if (!source.success) {
        return source;
      }

      return {
        source: source.source,
        logContext: {
          assetTypeId: request.assetTypeId,
          scope: request.scope,
        },
      };
    },
    initFailureMessage: 'Prompt asset download init failed',
  });

  registerUploadTransferLifecycleHandlers<
    PromptAssetUploadInitResponse,
    PromptAssetUploadFinalizeResponse,
    PromptAssetMutationResponseV1
  >({
    rpcHandlerManager: params.rpcHandlerManager,
    store,
    methods: {
      init: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as { sizeBytes?: unknown } | null;
      const target = resolvePromptAssetUploadTarget({
        adapterRegistry: params.adapterRegistry,
        sizeBytes: request?.sizeBytes,
      });
      if (!target.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: target.error },
        };
      }

      return {
        kind: 'accepted',
        target: target.target,
        logContext: {
          transferKind: 'prompt_asset_upload',
        },
      };
    },
    buildInitSuccessResponse: ({ session }) => ({
      success: true,
      uploadId: session.uploadId,
      chunkSizeBytes: session.chunkSizeBytes,
      recipientPublicKeyBase64: session.recipientPublicKeyBase64 ?? '',
    }),
    buildFinalizeMissingUploadIdResponse: () => ({ success: false, error: 'Missing uploadId' }),
    buildFinalizeMissingSessionResponse: () => ({ success: false, error: 'Upload session not found' }),
    buildFinalizeSizeMismatchResponse: () => ({ success: false, error: 'Upload size mismatch' }),
    buildFinalizeHashMismatchResponse: () => ({ success: false, error: 'Upload hash mismatch' }),
    buildFinalizeErrorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Prompt asset upload finalize failed',
    }),
    buildFinalizeFailureResponse: (error) => ({ success: false, error }),
    buildFinalizeSuccessResponse: ({ finalized }) => ({
      success: true,
      response: PromptAssetMutationResponseV1Schema.parse(finalized.result),
    }),
    enableChunkEncryption: true,
  });
}
