import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { DownloadTransferSource } from '../targets/downloadTransferSource';
import {
  abortDownloadTransferSession,
  createTransferSessionLifecycle,
  finalizeDownloadTransferSession,
  openDownloadTransferSession,
  readDownloadTransferChunk,
} from '../core/transferSessionLifecycle';
import {
  buildTransferLifecycleDiagnosticFields,
  classifyTransferFailureForLog,
  type TransferLifecycleDiagnosticContext,
} from './transferLifecycleDiagnostics';

type DownloadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getDownloadSession']>>;

type DownloadChunkRequest = Readonly<{ downloadId: string; index: number }>;

type DownloadChunkResponse =
  | Readonly<{ success: true; contentBase64: string; isLast: boolean }>
  | Readonly<{ success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }>
  | Readonly<{ success: false; error: string }>;

type DownloadFinalizeRequest = Readonly<{ downloadId: string }>;
type DownloadFinalizeResponse = Readonly<{ success: true } | { success: false; error: string }>;

type DownloadAbortRequest = Readonly<{ downloadId: string }>;
type DownloadAbortResponse = Readonly<{ success: true } | { success: false; error: string }>;

type ResolvedDownloadInit<TInitResponse> =
  | Readonly<{ kind: 'rejected'; response: TInitResponse }>
  | Readonly<{
      kind: 'accepted';
      source: DownloadTransferSource;
      recipientPublicKeyBase64?: string;
      diagnosticContext: TransferLifecycleDiagnosticContext;
    }>;

export function registerDownloadTransferLifecycleHandlers<TInitResponse>(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  store: TransferSessionStore;
  methods: Readonly<{
    init: string;
    chunk: string;
    finalize: string;
    abort: string;
  }>;
  resolveInit: (data: unknown) => Promise<ResolvedDownloadInit<TInitResponse>> | ResolvedDownloadInit<TInitResponse>;
  buildInitSuccessResponse: (input: Readonly<{
    session: DownloadSessionHandle;
    source: DownloadTransferSource;
  }>) => TInitResponse;
  buildInitErrorResponse: (error: unknown) => TInitResponse;
}>): void {
  const lifecycle = createTransferSessionLifecycle({
    store: params.store,
    chunkSizeBytes: configuration.filesTransferChunkBytes,
  });

  params.rpcHandlerManager.registerHandler(params.methods.init, async (data: unknown): Promise<TInitResponse> => {
    try {
      const resolved = await params.resolveInit(data);
      if (resolved.kind === 'rejected') {
        return resolved.response;
      }

      const session = await openDownloadTransferSession({
        lifecycle,
        source: resolved.source,
        recipientPublicKeyBase64: resolved.recipientPublicKeyBase64,
      });

      logger.debug('[TRANSFER] download lifecycle', {
        code: 'transfer_download_initialized',
        sizeBytes: resolved.source.sizeBytes,
        chunkSizeBytes: session.chunkSizeBytes,
        ...buildTransferLifecycleDiagnosticFields(resolved.diagnosticContext),
      });

      return params.buildInitSuccessResponse({
        session,
        source: resolved.source,
      });
    } catch (error) {
      logger.debug('[TRANSFER] download lifecycle', {
        code: 'transfer_download_init_failed',
        failureClass: classifyTransferFailureForLog(error),
      });
      return params.buildInitErrorResponse(error);
    }
  });

  params.rpcHandlerManager.registerHandler<DownloadChunkRequest, DownloadChunkResponse>(params.methods.chunk, async (data) => {
    return await readDownloadTransferChunk({
      lifecycle,
      downloadId: typeof data?.downloadId === 'string' ? data.downloadId : '',
      index: typeof data?.index === 'number' ? data.index : Number(data?.index),
    });
  });

  params.rpcHandlerManager.registerHandler<DownloadFinalizeRequest, DownloadFinalizeResponse>(
    params.methods.finalize,
    async (data) => {
      const downloadId = typeof data?.downloadId === 'string' ? data.downloadId : '';
      if (!downloadId) return { success: false, error: 'Missing downloadId' };
      await finalizeDownloadTransferSession({ lifecycle, downloadId });
      return { success: true };
    },
  );

  params.rpcHandlerManager.registerHandler<DownloadAbortRequest, DownloadAbortResponse>(
    params.methods.abort,
    async (data) => {
      const downloadId = typeof data?.downloadId === 'string' ? data.downloadId : '';
      if (!downloadId) return { success: false, error: 'Missing downloadId' };
      await abortDownloadTransferSession({ lifecycle, downloadId });
      return { success: true };
    },
  );
}
