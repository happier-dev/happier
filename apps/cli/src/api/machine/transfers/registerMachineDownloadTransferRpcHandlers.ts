import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { registerDownloadTransferLifecycleHandlers } from '@/transfers/rpc/registerDownloadTransferLifecycleHandlers';
import type { DownloadTransferSource } from '@/transfers/targets/downloadTransferSource';

export type MachineDownloadTransferInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string }>;

type ResolvedMachineDownloadSource = Readonly<{
  source: DownloadTransferSource;
  logContext?: Record<string, unknown>;
}>;

type RejectedMachineDownloadSource = Readonly<{
  success: false;
  error: string;
}>;

function isRejectedMachineDownloadSource(
  value: ResolvedMachineDownloadSource | RejectedMachineDownloadSource,
): value is RejectedMachineDownloadSource {
  return 'success' in value && value.success === false;
}

export function registerMachineDownloadTransferRpcHandlers<TRequest>(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  methods: Readonly<{
    init: string;
    chunk: string;
    finalize: string;
    abort: string;
  }>;
  parseRequest: (data: unknown) => TRequest | null;
  resolveSource: (request: TRequest) => Promise<ResolvedMachineDownloadSource | RejectedMachineDownloadSource>;
  initFailureMessage: string;
  store?: TransferSessionStore;
}>): TransferSessionStore {
  const store = params.store ?? new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerDownloadTransferLifecycleHandlers<MachineDownloadTransferInitResponse>({
    rpcHandlerManager: params.rpcHandlerManager,
    store,
    methods: params.methods,
    resolveInit: async (data) => {
      const requestData = data && typeof data === 'object' ? { ...(data as Record<string, unknown>) } : null;
      const recipientPublicKeyBase64 = typeof requestData?.recipientPublicKeyBase64 === 'string'
        ? requestData.recipientPublicKeyBase64.trim()
        : '';
      if (!recipientPublicKeyBase64) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Missing recipientPublicKeyBase64' },
        };
      }
      if (requestData) {
        delete requestData.recipientPublicKeyBase64;
      }
      const request = params.parseRequest(requestData);
      if (!request) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'invalid_request' },
        };
      }

      const source = await params.resolveSource(request);
      if (isRejectedMachineDownloadSource(source)) {
        return {
          kind: 'rejected',
          response: source,
        };
      }

      return {
        kind: 'accepted',
        source: source.source,
        recipientPublicKeyBase64,
        logContext: source.logContext,
      };
    },
    buildInitSuccessResponse: ({ session, source }) => ({
      success: true,
      downloadId: session.downloadId,
      chunkSizeBytes: session.chunkSizeBytes,
      sizeBytes: source.sizeBytes,
      name: source.name,
    }),
    buildInitErrorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : params.initFailureMessage,
    }),
  });

  return store;
}
