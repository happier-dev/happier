import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { DirectTransferImportOpenRequest } from '@/machines/transfer/directTransferImportSession';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

type DirectTransferImportPrepareResponse = Readonly<
  | {
      success: true;
      uploadId: string;
      destDisplayPath: string;
      expectedSizeBytes: number;
      chunkSizeBytes: number;
      recipientPublicKeyBase64: string;
      expiresAt: number;
      endpointCandidates: readonly TransferEndpointCandidate[];
    }
  | {
      success: false;
      error: string;
    }
>;

type DirectTransferImportAbortResponse = Readonly<
  | { success: true; aborted?: boolean }
  | { success: false; error: string }
>;

const DIRECT_TRANSFER_IMPORT_UPLOAD_ID_MAX_CHARS = 256;

export function registerMachineDirectTransferImportRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  prepareImportSession: (input: DirectTransferImportOpenRequest) => Promise<Readonly<{
    uploadId: string;
    destDisplayPath: string;
    expectedSizeBytes: number;
    chunkSizeBytes: number;
    recipientPublicKeyBase64: string;
    expiresAt: number;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>>;
  abortImportSession: (
    input: Readonly<{ uploadId: string }>,
  ) => Promise<void | Readonly<{ aborted: boolean }>>;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE, async (data: unknown) => {
    const request = data as DirectTransferImportOpenRequest | null;
    if (!request || typeof request !== 'object') {
      return { success: false, error: 'Invalid direct transfer import request' } satisfies DirectTransferImportPrepareResponse;
    }

    try {
      const prepared = await params.prepareImportSession(request);
      return {
        success: true,
        ...prepared,
      } satisfies DirectTransferImportPrepareResponse;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Direct transfer import prepare failed',
      } satisfies DirectTransferImportPrepareResponse;
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT, async (data: unknown) => {
    const uploadId = data && typeof data === 'object' && !Array.isArray(data)
      && typeof (data as { uploadId?: unknown }).uploadId === 'string'
      ? (data as { uploadId: string }).uploadId.trim()
      : '';
    if (!uploadId || uploadId.length > DIRECT_TRANSFER_IMPORT_UPLOAD_ID_MAX_CHARS) {
      return {
        success: false,
        error: 'Invalid direct transfer import abort request',
      } satisfies DirectTransferImportAbortResponse;
    }

    try {
      const result = await params.abortImportSession({ uploadId });
      return {
        success: true,
        ...(result ? { aborted: result.aborted } : {}),
      } satisfies DirectTransferImportAbortResponse;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Direct transfer import abort failed',
      } satisfies DirectTransferImportAbortResponse;
    }
  });
}
