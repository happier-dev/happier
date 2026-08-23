import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';

import { uploadBulkPayloadFromFileWithCarrierFallbacks } from '../plumbing/uploadBulkPayloadFromFileWithCarrierFallbacks';
import type { TransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';
import { downloadBulkPayloadViaDirectExportToDestination } from '../plumbing/directTransferExportDownload';
import { downloadBulkPayloadViaServerRelayToDestination } from '../plumbing/downloadBulkPayloadViaServerRelayToDestination';

import { createBufferedTransferDestination } from '../carriers/createBufferedTransferDestination';
import { downloadBulkPayloadViaMachineRpcToDestination } from '../carriers/downloadBulkPayloadViaMachineRpcToDestination';
import { createWorkspaceFileTransferRpcCaller } from './workspaceFileTransferRpcCaller';

type WorkspaceRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFileReader = Readonly<{
    sizeBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}>;
type TransferFileDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup?: (() => Promise<void>) | null;
}>;

type WorkspaceStatFileRequest = Readonly<{ path: string }>;

type WorkspaceStatFileResponse =
    | Readonly<{
        success: true;
        exists: boolean;
        kind?: 'file' | 'directory' | 'other';
        sizeBytes?: number;
        modifiedMs?: number;
        /** Status-change time; the byte-sensitive half of a file revision. */
        changedMs?: number;
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

export type WorkspaceFileUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadAbortResponse =
    | Readonly<{ success: true }>
    | WorkspaceRpcFailure;

const WORKSPACE_FILE_DOWNLOAD_RPC_METHODS = {
    init: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    chunk: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    finalize: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
    abort: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
} as const;

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
    agentRootPath?: string | null;
    requestPath: string;
}>): string {
    return resolveMachineAbsolutePath({
        rootPath: params.rootPath,
        agentRootPath: params.agentRootPath,
        requestPath: params.requestPath,
    });
}

export async function callDaemonWorkspaceStatFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: Readonly<{ path: string }>;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
}>): Promise<WorkspaceStatFileResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await transferClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
        request: {
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path }),
        },
        machineMethod: RPC_METHODS.STAT_FILE,
        timeoutMs: params.timeoutMs ?? null,
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

export async function callDaemonWorkspaceWriteFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: WorkspaceWriteFileRpcRequest;
}>): Promise<WorkspaceWriteFileRpcResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await transferClient.call<WorkspaceWriteFileRpcResponse, WorkspaceWriteFileRpcRequest>({
        request: {
            ...params.request,
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path }),
        },
        machineMethod: RPC_METHODS.WRITE_FILE,
    });
}

export async function uploadDaemonWorkspaceFileFromReader(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    fileReader: TransferFileReader;
    request: WorkspaceFileUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    WorkspaceFileUploadFinalizeResponse
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<WorkspaceFileUploadFinalizeResponse>
> {
    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path });
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await uploadBulkPayloadFromFileWithCarrierFallbacks<WorkspaceFileUploadFinalizeResponse>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        fileReader: params.fileReader,
        directImportRequest: {
            t: 'session_file_upload_v1',
            workingDirectory: params.rootPath,
            path: absolutePath,
            sizeBytes: params.fileReader.sizeBytes,
            overwrite: params.request.overwrite === true,
            ...(typeof params.request.sha256 === 'string' ? { sha256: params.request.sha256 } : {}),
        },
        relay: {
            init: async () => await transferClient.call<
                WorkspaceFileUploadInitResponse,
                WorkspaceFileUploadInitRequest & Readonly<{ t: 'session_file_upload_v1' }>
            >({
                request: {
                    ...params.request,
                    t: 'session_file_upload_v1',
                    path: absolutePath,
                },
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            }),
            sendChunk: async (request) => await transferClient.call<WorkspaceFileUploadChunkResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
            }),
            finalize: async (request) => await transferClient.call<WorkspaceFileUploadFinalizeResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
            }),
            abort: async (request) => await transferClient.call<WorkspaceFileUploadAbortResponse, typeof request>({
                request,
                machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
            }),
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}

export async function downloadDaemonWorkspaceFileToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: Readonly<{ path: string; asZip: boolean }>;
    destination: TransferFileDestination;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | TransferFailureResponse>) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<Readonly<{ ok: true; name: string; sizeBytes: number }> | Readonly<{ ok: false; error: string }>> {
    if (typeof params.destination.cleanup !== 'function') {
        return {
            ok: false,
            error: 'Workspace file download destination cleanup is required for retry-safe transfers',
        };
    }

    const initTransferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path });

    if (!params.request.asZip) {
        const stat = await initTransferClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
            request: { path: absolutePath },
            machineMethod: RPC_METHODS.STAT_FILE,
            signal: params.signal ?? null,
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
        cleanupOnFailure: false,
        onInit: params.onInit ?? null,
        signal: params.signal ?? null,
        onProgress: params.onProgress ?? null,
    });
    if (directExportResult.ok) {
        return directExportResult;
    }
    if (params.signal?.aborted) {
        await params.destination.cleanup();
        return { ok: false, error: 'Download canceled' };
    }
    await params.destination.cleanup();

    const relayResult = await downloadBulkPayloadViaServerRelayToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        destination: params.destination,
        cleanupOnFailure: false,
        init: async (request) => {
            return await initTransferClient.call<
                WorkspaceFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; asZip: boolean; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: absolutePath,
                    asZip: params.request.asZip,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.init,
            });
        },
        finalize: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.finalize,
            }),
        abort: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.abort,
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
    if (params.signal?.aborted) {
        await params.destination.cleanup();
        return { ok: false, error: 'Download canceled' };
    }
    await params.destination.cleanup();
    return await downloadBulkPayloadViaMachineRpcToDestination({
        destination: params.destination,
        init: async (request) => {
            return await initTransferClient.call<
                WorkspaceFileDownloadInitResponse,
                Readonly<{ t: 'session_file_download_v1'; path: string; asZip: boolean; recipientPublicKeyBase64: string }>
            >({
                request: {
                    t: 'session_file_download_v1',
                    path: absolutePath,
                    asZip: params.request.asZip,
                    recipientPublicKeyBase64: request.recipientPublicKeyBase64,
                },
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.init,
            });
        },
        readChunk: async (request) =>
            await initTransferClient.call<
                Readonly<{
                    success: true;
                    payloadBase64?: string;
                    encryptedDataKeyEnvelopeBase64?: string;
                    contentBase64?: string;
                    isLast: boolean;
                }> | WorkspaceRpcFailure,
                typeof request
            >({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.chunk,
            }),
        finalize: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.finalize,
            }),
        abort: async (request) =>
            await initTransferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.abort,
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
}

export async function downloadDaemonWorkspaceFileToBase64(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    path: string;
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<Readonly<{ ok: true; contentBase64: string }> | Readonly<{ ok: false; error: string; errorCode?: string }>> {
    const statClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });
    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.path });
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

    const createInlineBufferedDestination = () => createBufferedTransferDestination(params.maxBytes);

    const directBufferedDestination = createInlineBufferedDestination();
    const directExportResult = await downloadBulkPayloadViaDirectExportToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        request: {
            t: 'workspace_file_download_v1',
            workingDirectory: params.rootPath,
            path: absolutePath,
            asZip: false,
        },
        destination: directBufferedDestination.destination,
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
            contentBase64: directBufferedDestination.toBase64(),
        };
    }

    const transferClient = statClient;
    const relayBufferedDestination = createInlineBufferedDestination();

    const relayResult = await downloadBulkPayloadViaServerRelayToDestination({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        destination: relayBufferedDestination.destination,
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
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.init,
            }),
        finalize: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.finalize,
            }),
        abort: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.abort,
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
            contentBase64: relayBufferedDestination.toBase64(),
        };
    }

    const bulkBufferedDestination = createInlineBufferedDestination();
    const bulkDownload = await downloadBulkPayloadViaMachineRpcToDestination({
        destination: bulkBufferedDestination.destination,
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
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.init,
            }),
        readChunk: async (request) =>
            await transferClient.call<
                Readonly<{
                    success: true;
                    payloadBase64?: string;
                    encryptedDataKeyEnvelopeBase64?: string;
                    contentBase64?: string;
                    isLast: boolean;
                }> | WorkspaceRpcFailure,
                typeof request
            >({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.chunk,
            }),
        finalize: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.finalize,
            }),
        abort: async (request) =>
            await transferClient.call<WorkspaceFileDownloadFinalizeResponse, typeof request>({
                request,
                machineMethod: WORKSPACE_FILE_DOWNLOAD_RPC_METHODS.abort,
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

    if (!bulkDownload.ok) {
        return {
            ok: false,
            error: bulkDownload.error,
            ...(bulkDownload.errorCode ? { errorCode: bulkDownload.errorCode } : { errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }),
        };
    }

    return {
        ok: true,
        contentBase64: bulkBufferedDestination.toBase64(),
    };
}
