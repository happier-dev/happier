import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { logger } from '@/ui/logger';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { DownloadTransferSource } from '../targets/downloadTransferSource';

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
      logContext?: Record<string, unknown>;
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
  params.rpcHandlerManager.registerHandler(params.methods.init, async (data: unknown): Promise<TInitResponse> => {
    params.store.cleanupExpiredBestEffort();
    try {
      const resolved = await params.resolveInit(data);
      if (resolved.kind === 'rejected') {
        return resolved.response;
      }

      const session = await params.store.createDownloadSession({
        filePath: resolved.source.filePath,
        deleteFileOnClose: resolved.source.deleteFileOnClose,
        chunkSizeBytes: configuration.filesTransferChunkBytes,
        recipientPublicKeyBase64: resolved.recipientPublicKeyBase64,
      });

      if (resolved.logContext) {
        logger.debug('Transfer download init:', {
          downloadId: session.downloadId,
          sizeBytes: resolved.source.sizeBytes,
          chunkSizeBytes: session.chunkSizeBytes,
          ...resolved.logContext,
        });
      }

      return params.buildInitSuccessResponse({
        session,
        source: resolved.source,
      });
    } catch (error) {
      logger.debug('Failed to init download:', error);
      return params.buildInitErrorResponse(error);
    }
  });

  params.rpcHandlerManager.registerHandler<DownloadChunkRequest, DownloadChunkResponse>(params.methods.chunk, async (data) => {
    params.store.cleanupExpiredBestEffort();
    const downloadId = typeof data?.downloadId === 'string' ? data.downloadId : '';
    const index = typeof data?.index === 'number' ? data.index : Number(data?.index);
    if (!downloadId) return { success: false, error: 'Missing downloadId' };
    if (!Number.isFinite(index) || index < 0) return { success: false, error: 'Invalid index' };

    const session = params.store.getDownloadSession(downloadId);
    if (!session) return { success: false, error: 'Download session not found' };
    if (index !== session.nextIndex) return { success: false, error: 'Unexpected chunk index' };

    const remaining = session.sizeBytes - session.offset;
    const readSize = Math.max(0, Math.min(session.chunkSizeBytes, remaining));
    if (readSize === 0) {
      if (!session.recipientPublicKeyBase64) {
        return { success: true, contentBase64: '', isLast: true };
      }
      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId: downloadId,
        sequence: index,
        payload: Buffer.alloc(0),
        recipientPublicKeyBase64: session.recipientPublicKeyBase64,
      });
      return {
        success: true,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
        isLast: true,
      };
    }

    const buffer = Buffer.alloc(readSize);
    const readResult = await session.file.read(buffer, 0, readSize, session.offset);
    const bytesRead = readResult.bytesRead ?? 0;
    const slice = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

    session.offset += bytesRead;
    session.nextIndex += 1;
    params.store.refreshDownloadExpiry(downloadId);
    const isLast = session.offset >= session.sizeBytes;
    if (!session.recipientPublicKeyBase64) {
      return { success: true, contentBase64: slice.toString('base64'), isLast };
    }
    const encryptedChunk = createEncryptedTransferChunkEnvelope({
      transferId: downloadId,
      sequence: index,
      payload: slice,
      recipientPublicKeyBase64: session.recipientPublicKeyBase64,
    });
    return {
      success: true,
      payloadBase64: encryptedChunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      isLast,
    };
  });

  params.rpcHandlerManager.registerHandler<DownloadFinalizeRequest, DownloadFinalizeResponse>(
    params.methods.finalize,
    async (data) => {
      params.store.cleanupExpiredBestEffort();
      const downloadId = typeof data?.downloadId === 'string' ? data.downloadId : '';
      if (!downloadId) return { success: false, error: 'Missing downloadId' };
      await params.store.closeDownloadSession(downloadId);
      return { success: true };
    },
  );

  params.rpcHandlerManager.registerHandler<DownloadAbortRequest, DownloadAbortResponse>(
    params.methods.abort,
    async (data) => {
      params.store.cleanupExpiredBestEffort();
      const downloadId = typeof data?.downloadId === 'string' ? data.downloadId : '';
      if (!downloadId) return { success: false, error: 'Missing downloadId' };
      await params.store.closeDownloadSession(downloadId);
      return { success: true };
    },
  );
}
