import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionFileTransferRpcCaller } from './sessionFileTransferRpcCaller';

import type { BulkTransferFailureResponse, BulkTransferFileReader } from './uploadBulkPayloadFromFile';
import { uploadBulkPayloadFromFile } from './uploadBulkPayloadFromFile';

type SessionRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

export type SessionAttachmentsUploadInitRequest = Readonly<{
    messageLocalId: string;
    fileName: string;
    sizeBytes: number;
    uploadLocation: 'workspace' | 'os_temp';
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: 'git_info_exclude' | 'gitignore' | 'none';
    vcsIgnoreWritesEnabled: boolean;
}>;

type SessionAttachmentsUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | SessionRpcFailure;

type SessionAttachmentsUploadChunkResponse =
    | Readonly<{ success: true }>
    | SessionRpcFailure;

export type SessionAttachmentsUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | SessionRpcFailure;

type SessionAttachmentsUploadAbortResponse =
    | Readonly<{ success: true }>
    | SessionRpcFailure;

export async function uploadDaemonSessionAttachmentFromReader(params: Readonly<{
    sessionId: string;
    fileReader: BulkTransferFileReader;
    request: SessionAttachmentsUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<SessionAttachmentsUploadFinalizeResponse | BulkTransferFailureResponse> {
    const transferClient = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
        sessionRpcTransferSizeBytes: params.fileReader.sizeBytes,
    });

    let previousUploadedBytes = 0;

    return await uploadBulkPayloadFromFile<SessionAttachmentsUploadFinalizeResponse>({
        fileReader: params.fileReader,
        init: async () =>
            await transferClient.call<
                SessionAttachmentsUploadInitResponse,
                SessionAttachmentsUploadInitRequest & { t: 'session_attachment_upload_v1' }
            >({
                request: {
                    ...params.request,
                    t: 'session_attachment_upload_v1',
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            }),
        sendChunk: async (request) =>
            await transferClient.call<SessionAttachmentsUploadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            }),
        finalize: async (request) =>
            await transferClient.call<SessionAttachmentsUploadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await transferClient.call<SessionAttachmentsUploadAbortResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT,
            }),
        onProgress: params.onProgress
            ? (progress) => {
                const delta = progress.uploadedBytes - previousUploadedBytes;
                previousUploadedBytes = progress.uploadedBytes;
                if (delta <= 0) return;
                params.onProgress?.({
                    uploadedBytes: progress.uploadedBytes,
                    totalBytes: progress.totalBytes,
                });
            }
            : null,
        signal: params.signal ?? null,
    });
}
