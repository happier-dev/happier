import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import {
    rebasePathRequestToMachineTarget,
    rebaseTransferRequestPathToMachineTarget,
} from '@/sync/runtime/sessionMachineRpcFallback';
import { createSessionFileTransferRpcCaller } from '@/sync/domains/transfers/runtime/sessionFileTransferRpcCaller';

import {
    type BulkTransferFileDestination,
    downloadBulkPayloadToFile,
} from './downloadBulkPayloadToFile';
import {
    type BulkTransferFailureResponse,
    type BulkTransferFileReader,
    uploadBulkPayloadFromFile,
} from './uploadBulkPayloadFromFile';

type SessionRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

type SessionFileDownloadInitResponse =
    | Readonly<{
        success: true;
        downloadId: string;
        chunkSizeBytes: number;
        sizeBytes: number;
        name: string;
    }>
    | SessionRpcFailure;

type SessionFileDownloadChunkResponse =
    | Readonly<{
        success: true;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        contentBase64?: string;
        isLast: boolean;
    }>
    | SessionRpcFailure;

type SessionFileDownloadFinalizeResponse =
    | Readonly<{ success: true }>
    | SessionRpcFailure;

type SessionFileUploadInitRequest = Readonly<{
    path: string;
    sizeBytes: number;
    overwrite?: boolean;
    sha256?: string;
}>;

type SessionFileUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | SessionRpcFailure;

type SessionFileUploadChunkResponse =
    | Readonly<{ success: true }>
    | SessionRpcFailure;

type SessionFileUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | SessionRpcFailure;

type SessionFileUploadAbortResponse =
    | Readonly<{ success: true }>
    | SessionRpcFailure;

export type SessionWriteFileRpcRequest = Readonly<{
    path: string;
    content: string;
    expectedHash?: string | null;
}>;

export type SessionWriteFileRpcResponse =
    | Readonly<{ success: true; hash: string }>
    | SessionRpcFailure;

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

export async function callDaemonSessionWriteFileRpc(params: Readonly<{
    sessionId: string;
    request: SessionWriteFileRpcRequest;
    contentSizeBytes: number;
}>): Promise<SessionWriteFileRpcResponse> {
    const transferClient = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
        sessionRpcTransferSizeBytes: params.contentSizeBytes,
    });

    return await transferClient.call<SessionWriteFileRpcResponse, SessionWriteFileRpcRequest>({
        request: params.request,
        machineMethod: RPC_METHODS.WRITE_FILE,
        sessionMethod: RPC_METHODS.WRITE_FILE,
        toMachineRequest: rebasePathRequestToMachineTarget,
    });
}

export async function uploadDaemonSessionFileFromReader(params: Readonly<{
    sessionId: string;
    fileReader: BulkTransferFileReader;
    request: SessionFileUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<SessionFileUploadFinalizeResponse | BulkTransferFailureResponse> {
    const transferClient = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
        sessionRpcTransferSizeBytes: params.fileReader.sizeBytes,
    });

    let previousUploadedBytes = 0;
    return await uploadBulkPayloadFromFile<SessionFileUploadFinalizeResponse>({
        fileReader: params.fileReader,
        init: async () =>
            await transferClient.call<
                SessionFileUploadInitResponse,
                SessionFileUploadInitRequest & { t: 'session_file_upload_v1' }
            >({
                request: {
                    ...params.request,
                    t: 'session_file_upload_v1',
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
                toMachineRequest: rebaseTransferRequestPathToMachineTarget,
            }),
        sendChunk: async (request) =>
            await transferClient.call<SessionFileUploadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            }),
        finalize: async (request) =>
            await transferClient.call<SessionFileUploadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await transferClient.call<SessionFileUploadAbortResponse, typeof request>({
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

export async function downloadDaemonSessionFileToDestination(params: Readonly<{
    sessionId: string;
    request: Readonly<{ path: string; asZip: boolean }>;
    destination: BulkTransferFileDestination;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | BulkTransferFailureResponse>) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<Readonly<{ ok: true; name: string; sizeBytes: number }> | Readonly<{ ok: false; error: string }>> {
    const transferClient = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
    });

    return await downloadBulkPayloadToFile({
        destination: params.destination,
        init: async (request) => {
            const init = await transferClient.call<
                SessionFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; asZip: boolean; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: params.request.path,
                    asZip: params.request.asZip,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
                toMachineRequest: rebaseTransferRequestPathToMachineTarget,
            });
            if (init.success === true && params.onInit) {
                const sideEffect = await params.onInit({ name: init.name, sizeBytes: init.sizeBytes });
                if (sideEffect && sideEffect.success === false) {
                    await transferClient.call<SessionFileDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                        request: {
                            downloadId: init.downloadId,
                        },
                        machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                        sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                    });
                    return sideEffect;
                }
            }
            return init;
        },
        readChunk: async (request) =>
            await transferClient.call<SessionFileDownloadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
            }),
        finalize: async (request) =>
            await transferClient.call<SessionFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await transferClient.call<SessionFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
            }),
        signal: params.signal ?? null,
        onProgress: params.onProgress
            ? (progress) =>
                params.onProgress?.({
                    downloadedBytes: progress.downloadedBytes,
                    totalBytes: progress.totalBytes,
                })
            : null,
    });
}

export async function downloadDaemonSessionFileToBase64(params: Readonly<{
    sessionId: string;
    path: string;
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<Readonly<{ ok: true; contentBase64: string }> | Readonly<{ ok: false; error: string; errorCode?: string }>> {
    const chunks: Uint8Array[] = [];
    let bufferedBytes = 0;

    const transferClient = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
    });

    try {
        const download = await downloadBulkPayloadToFile({
            destination: {
                writeBytes: async (bytes) => {
                    bufferedBytes += bytes.byteLength;
                    if (bufferedBytes > params.maxBytes) {
                        throw new Error('File exceeds the inline file read size limit');
                    }
                    chunks.push(new Uint8Array(bytes));
                },
                close: async () => {},
                cleanup: async () => {
                    bufferedBytes = 0;
                    chunks.length = 0;
                },
            },
            init: async (request) => {
                const init = await transferClient.call<
                    SessionFileDownloadInitResponse,
                    Readonly<{ t: 'session_file_download_v1'; path: string; recipientPublicKeyBase64: string }>
                >({
                    request: {
                        t: 'session_file_download_v1',
                        path: params.path,
                        recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                    },
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
                    sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
                    toMachineRequest: rebaseTransferRequestPathToMachineTarget,
                });
                if (init.success === true && init.sizeBytes > params.maxBytes) {
                    await transferClient.call<SessionFileDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                        request: {
                            downloadId: init.downloadId,
                        },
                        machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                        sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                    });
                    return {
                        success: false,
                        error: 'File exceeds the inline file read size limit',
                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                    };
                }
                return init;
            },
            readChunk: async (request) =>
                await transferClient.call<SessionFileDownloadChunkResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
                    sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
                }),
            finalize: async (request) =>
                await transferClient.call<SessionFileDownloadFinalizeResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
                    sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
                }),
            abort: async (request) =>
                await transferClient.call<SessionFileDownloadFinalizeResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                    sessionMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                }),
            signal: params.signal ?? null,
        });

        if (!download.ok) {
            return {
                ok: false,
                error: download.error,
            };
        }

        const bytes = concatChunks(chunks, bufferedBytes);
        return {
            ok: true,
            contentBase64: encodeBase64(bytes, 'base64'),
        };
    } catch (error) {
        bufferedBytes = 0;
        chunks.length = 0;
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
