import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';

import { createBufferedTransferDestination } from '../bulkTransferPipeline/createBufferedTransferDestination';
import { createWorkspaceFileTransferRpcCaller } from '../bulkTransferPipeline/workspaceFileTransferRpcCaller';
import {
    type BulkTransferFileDestination,
    downloadBulkPayloadToFile,
} from '../bulkTransferPipeline/downloadBulkPayloadToFile';
import {
    type BulkTransferFailureResponse,
    type BulkTransferFileReader,
    uploadBulkPayloadFromFile,
} from '../bulkTransferPipeline/uploadBulkPayloadFromFile';
import { downloadBulkPayloadViaDirectExportToDestination } from '../bulkTransferPipeline/directTransferExportDownload';
import { downloadBulkPayloadViaServerRelayToDestination } from '../bulkTransferPipeline/downloadBulkPayloadViaServerRelayToDestination';

type WorkspaceRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

type WorkspaceStatFileRequest = Readonly<{ path: string }>;

type WorkspaceStatFileResponse =
    | Readonly<{
        success: true;
        exists: boolean;
        kind?: 'file' | 'directory' | 'other';
        sizeBytes?: number;
      }>
    | WorkspaceRpcFailure;

type WorkspaceFileDownloadInitResponse =
    | Readonly<{
        success: true;
        downloadId: string;
        chunkSizeBytes: number;
        sizeBytes: number;
        name: string;
    }>
    | WorkspaceRpcFailure;

type WorkspaceFileDownloadChunkResponse =
    | Readonly<{
        success: true;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
        contentBase64?: string;
        isLast: boolean;
    }>
    | WorkspaceRpcFailure;

type WorkspaceFileDownloadFinalizeResponse =
    | Readonly<{ success: true }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadInitRequest = Readonly<{
    path: string;
    sizeBytes: number;
    overwrite?: boolean;
    sha256?: string;
}>;

type WorkspaceFileUploadInitResponse =
    | Readonly<{
        success: true;
        uploadId: string;
        chunkSizeBytes: number;
        recipientPublicKeyBase64: string;
    }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadChunkResponse =
    | Readonly<{ success: true }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadAbortResponse =
    | Readonly<{ success: true }>
    | WorkspaceRpcFailure;

export type WorkspaceWriteFileRpcRequest = Readonly<{
    path: string;
    content: string;
    expectedHash?: string | null;
}>;

export type WorkspaceWriteFileRpcResponse =
    | Readonly<{ success: true; hash: string }>
    | WorkspaceRpcFailure;

function resolveAbsoluteWorkspacePath(params: Readonly<{
    rootPath: string;
    requestPath: string;
}>): string {
    return resolveMachineAbsolutePath({
        rootPath: params.rootPath,
        requestPath: params.requestPath,
    });
}

export async function callDaemonWorkspaceStatFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    request: Readonly<{ path: string }>;
    timeoutMs?: number | null;
}>): Promise<WorkspaceStatFileResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await transferClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
        request: {
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, requestPath: params.request.path }),
        },
        machineMethod: RPC_METHODS.STAT_FILE,
        timeoutMs: params.timeoutMs ?? null,
    });
}

export async function callDaemonWorkspaceWriteFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    request: WorkspaceWriteFileRpcRequest;
    contentSizeBytes: number;
}>): Promise<WorkspaceWriteFileRpcResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        transferSizeBytes: params.contentSizeBytes,
    });

    return await transferClient.call<WorkspaceWriteFileRpcResponse, WorkspaceWriteFileRpcRequest>({
        request: {
            ...params.request,
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, requestPath: params.request.path }),
        },
        machineMethod: RPC_METHODS.WRITE_FILE,
    });
}

export async function uploadDaemonWorkspaceFileFromReader(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    fileReader: BulkTransferFileReader;
    request: WorkspaceFileUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<WorkspaceFileUploadFinalizeResponse | BulkTransferFailureResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        transferSizeBytes: params.fileReader.sizeBytes,
        workingDirectory: params.rootPath,
    });

    let previousUploadedBytes = 0;
    return await uploadBulkPayloadFromFile<WorkspaceFileUploadFinalizeResponse>({
        fileReader: params.fileReader,
        init: async () =>
            await transferClient.call<
                WorkspaceFileUploadInitResponse,
                WorkspaceFileUploadInitRequest & { t: 'session_file_upload_v1' }
            >({
                request: {
                    ...params.request,
                    t: 'session_file_upload_v1',
                    path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, requestPath: params.request.path }),
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            }),
        sendChunk: async (request) =>
            await transferClient.call<WorkspaceFileUploadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            }),
        finalize: async (request) =>
            await transferClient.call<WorkspaceFileUploadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await transferClient.call<WorkspaceFileUploadAbortResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT,
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

export async function downloadDaemonWorkspaceFileToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    request: Readonly<{ path: string; asZip: boolean }>;
    destination: BulkTransferFileDestination;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | BulkTransferFailureResponse>) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<Readonly<{ ok: true; name: string; sizeBytes: number }> | Readonly<{ ok: false; error: string }>> {
    let transferSizeBytes: number | null = null;
    const initTransferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, requestPath: params.request.path });

    if (!params.request.asZip) {
        const stat = await initTransferClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
            request: { path: absolutePath },
            machineMethod: RPC_METHODS.STAT_FILE,
        });
        if (stat.success !== true) {
            return { ok: false, error: stat.error };
        }
        if (!stat.exists) {
            return { ok: false, error: 'File does not exist' };
        }
        if (stat.kind && stat.kind !== 'file') {
            return { ok: false, error: 'Path is not a file' };
        }
        if (typeof stat.sizeBytes !== 'number' || !Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0) {
            return { ok: false, error: 'Unable to resolve file size' };
        }
        transferSizeBytes = Math.floor(stat.sizeBytes);
    }

    let bulkTransferClient = initTransferClient;
    if (transferSizeBytes !== null) {
        bulkTransferClient = createWorkspaceFileTransferRpcCaller({
            machineId: params.machineId,
            ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
            transferSizeBytes,
        });
    }

    const directExportResult = await downloadBulkPayloadViaDirectExportToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        request: {
            t: 'workspace_file_download_v1',
            workingDirectory: params.rootPath,
            path: absolutePath,
            asZip: params.request.asZip,
        },
        destination: params.destination,
        onInit: params.onInit ?? null,
        signal: params.signal ?? null,
        onProgress: params.onProgress ?? null,
    });
    if (directExportResult.ok) {
        return directExportResult;
    }

    const relayResult = await downloadBulkPayloadViaServerRelayToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        destination: params.destination,
        init: async (request) => {
            const init = await bulkTransferClient.call<
                WorkspaceFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; asZip: boolean; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: absolutePath,
                    asZip: params.request.asZip,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
            });

            if (init.success === true && params.request.asZip) {
                bulkTransferClient = createWorkspaceFileTransferRpcCaller({
                    machineId: params.machineId,
                    ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
                    transferSizeBytes: init.sizeBytes,
                });
            }

            return init;
        },
        finalize: async (request) =>
            await bulkTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
            }),
        onInit: params.onInit ?? null,
        signal: params.signal ?? null,
        onProgress: params.onProgress
            ? (progress) =>
                params.onProgress?.({
                    downloadedBytes: progress.downloadedBytes,
                    totalBytes: progress.totalBytes,
                })
            : null,
    });
    if (relayResult.ok) {
        return relayResult;
    }

    return await downloadBulkPayloadToFile({
        destination: params.destination,
        init: async (request) => {
            const init = await bulkTransferClient.call<
                WorkspaceFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; asZip: boolean; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: absolutePath,
                    asZip: params.request.asZip,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
            });

            if (init.success === true && params.request.asZip) {
                bulkTransferClient = createWorkspaceFileTransferRpcCaller({
                    machineId: params.machineId,
                    ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
                    transferSizeBytes: init.sizeBytes,
                });
            }

            if (init.success === true && params.onInit) {
                const sideEffect = await params.onInit({ name: init.name, sizeBytes: init.sizeBytes });
                if (sideEffect && sideEffect.success === false) {
                    await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                        request: {
                            downloadId: init.downloadId,
                        },
                        machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                    });
                    return sideEffect;
                }
            }
            return init;
        },
        readChunk: async (request) =>
            await bulkTransferClient.call<WorkspaceFileDownloadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
            }),
        finalize: async (request) =>
            await bulkTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
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

export async function downloadDaemonWorkspaceFileToBase64(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    path: string;
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<Readonly<{ ok: true; contentBase64: string }> | Readonly<{ ok: false; error: string; errorCode?: string }>> {
    const statClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });
    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, requestPath: params.path });
    const stat = await statClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
        request: { path: absolutePath },
        machineMethod: RPC_METHODS.STAT_FILE,
    });
    if (stat.success !== true) {
        return { ok: false, error: stat.error, ...(stat.errorCode ? { errorCode: stat.errorCode } : {}) };
    }
    if (!stat.exists) {
        return { ok: false, error: 'File does not exist', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }
    if (stat.kind && stat.kind !== 'file') {
        return { ok: false, error: 'Path is not a file', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }
    if (typeof stat.sizeBytes !== 'number' || !Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0) {
        return { ok: false, error: 'Unable to resolve file size', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }

    const fileSizeBytes = Math.floor(stat.sizeBytes);
    if (fileSizeBytes > params.maxBytes) {
        return {
            ok: false,
            error: 'File exceeds the inline file read size limit',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    const bufferedDestination = createBufferedTransferDestination(params.maxBytes);

    const directExportResult = await downloadBulkPayloadViaDirectExportToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        request: {
            t: 'workspace_file_download_v1',
            workingDirectory: params.rootPath,
            path: absolutePath,
            asZip: false,
        },
        destination: bufferedDestination.destination,
        onInit: async (init) => {
            if (init.sizeBytes > params.maxBytes) {
                return {
                    success: false as const,
                    error: 'File exceeds the inline file read size limit',
                };
            }
        },
        signal: params.signal ?? null,
    });
    if (directExportResult.ok) {
        return {
            ok: true,
            contentBase64: bufferedDestination.toBase64(),
        };
    }

    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        transferSizeBytes: fileSizeBytes,
    });

    const relayResult = await downloadBulkPayloadViaServerRelayToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        destination: bufferedDestination.destination,
        init: async (request) =>
            await transferClient.call<
                WorkspaceFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: absolutePath,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
            }),
        finalize: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
            }),
        abort: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
            }),
        onInit: async (init) => {
            if (init.sizeBytes > params.maxBytes) {
                return {
                    success: false as const,
                    error: 'File exceeds the inline file read size limit',
                };
            }
        },
        signal: params.signal ?? null,
    });
    if (relayResult.ok) {
        return {
            ok: true,
            contentBase64: bufferedDestination.toBase64(),
        };
    }

    try {
        const download = await downloadBulkPayloadToFile({
            destination: bufferedDestination.destination,
            init: async (request) => {
                const init = await transferClient.call<
                    WorkspaceFileDownloadInitResponse,
                    Readonly<{ t: 'session_file_download_v1'; path: string; recipientPublicKeyBase64: string }>
                >({
                    request: {
                        t: 'session_file_download_v1',
                        path: absolutePath,
                        recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                    },
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
                });
                if (init.success === true && init.sizeBytes > params.maxBytes) {
                    await transferClient.call<WorkspaceFileDownloadFinalizeResponse, Readonly<{ downloadId: string }>>({
                        request: {
                            downloadId: init.downloadId,
                        },
                        machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
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
                await transferClient.call<WorkspaceFileDownloadChunkResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
                }),
            finalize: async (request) =>
                await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
                }),
            abort: async (request) =>
                await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                    request,
                    machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
                }),
            signal: params.signal ?? null,
        });

        if (!download.ok) {
            return {
                ok: false,
                error: download.error,
            };
        }

        return {
            ok: true,
            contentBase64: bufferedDestination.toBase64(),
        };
    } catch (error) {
        bufferedDestination.reset();
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
