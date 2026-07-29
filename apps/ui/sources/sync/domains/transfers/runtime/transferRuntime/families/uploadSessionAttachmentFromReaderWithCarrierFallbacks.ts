import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type {
    SessionAttachmentsUploadFinalizeResponse,
    SessionAttachmentsUploadInitRequest,
    TransferFileReader,
} from './sessionAttachmentTransfers';
import { createWorkspaceFileTransferRpcCaller } from './workspaceFileTransferRpcCaller';
import { uploadBulkPayloadFromFileWithCarrierFallbacks } from '../plumbing/uploadBulkPayloadFromFileWithCarrierFallbacks';
import type { TransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';

type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
type SessionUploadRequest = SessionAttachmentsUploadInitRequest & Readonly<{
    t: 'session_attachment_upload_v1';
    workingDirectory: string;
}>;
type SessionUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | TransferFailureResponse;
type SessionUploadChunkResponse = Readonly<{ success: true }> | TransferFailureResponse;
type SessionUploadAbortResponse = Readonly<{ success: true }> | TransferFailureResponse;

export async function uploadSessionAttachmentFromReaderWithCarrierFallbacks(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    fileReader: TransferFileReader;
    request: SessionUploadRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    SessionAttachmentsUploadFinalizeResponse
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>
> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await uploadBulkPayloadFromFileWithCarrierFallbacks<SessionAttachmentsUploadFinalizeResponse>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        fileReader: params.fileReader,
        directImportRequest: params.request,
        relay: {
            init: async () => await transferClient.call<SessionUploadInitResponse, SessionAttachmentsUploadInitRequest & Readonly<{
                t: 'session_attachment_upload_v1';
            }>>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                request: {
                    t: 'session_attachment_upload_v1',
                    messageLocalId: params.request.messageLocalId,
                    fileName: params.request.fileName,
                    sizeBytes: params.request.sizeBytes,
                    uploadLocation: params.request.uploadLocation,
                    workspaceRootPath: params.request.workspaceRootPath,
                    workspaceRelativeDir: params.request.workspaceRelativeDir,
                    vcsIgnoreStrategy: params.request.vcsIgnoreStrategy,
                    vcsIgnoreWritesEnabled: params.request.vcsIgnoreWritesEnabled,
                },
            }),
            sendChunk: async (request) => await transferClient.call<SessionUploadChunkResponse, typeof request>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
                request,
            }),
            finalize: async (request) => await transferClient.call<SessionAttachmentsUploadFinalizeResponse, typeof request>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
                request,
            }),
            abort: async (request) => await transferClient.call<SessionUploadAbortResponse, typeof request>({
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
                request,
            }),
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}
