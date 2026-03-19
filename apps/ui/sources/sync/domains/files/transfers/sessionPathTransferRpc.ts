import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { downloadInChunks, type ChunkDownloadProgress } from '@/sync/domains/files/transfers/chunkTransferClient';
import { mergeTransferChunks } from '@/sync/domains/transfers/runtime/mergeTransferChunks';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { createTransferRecipientKeyPair } from './transferChunkEncryption';

import {
    rebaseTransferRequestPathToMachineTarget,
} from '@/sync/runtime/sessionMachineRpcFallback';
import {
    createSessionFileTransferRpcCaller,
} from '@/sync/domains/transfers/runtime/sessionFileTransferRpcCaller';

type FilesUploadInitRequest = Readonly<{
    path: string;
    sizeBytes: number;
    overwrite?: boolean;
    sha256?: string;
}>;

export type FilesUploadInitResponse =
    | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type SessionFilesUploadTransferClient = Readonly<{
    init: (request: FilesUploadInitRequest) => Promise<FilesUploadInitResponse>;
    chunk: (request: FilesUploadChunkRequest) => Promise<FilesUploadChunkResponse>;
    finalize: (request: FilesUploadFinalizeRequest) => Promise<FilesUploadFinalizeResponse>;
    abort: (request: FilesUploadAbortRequest) => Promise<FilesUploadAbortResponse>;
}>;

export function createSessionFilesUploadTransferClient(params: Readonly<{
    sessionId: string;
    sizeBytes: number;
}>): SessionFilesUploadTransferClient {
    const rpcCaller = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
        sessionRpcTransferSizeBytes: params.sizeBytes,
    });

    return {
        init: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_UPLOAD_INIT,
            sessionMethod: RPC_METHODS.FILES_UPLOAD_INIT,
            toMachineRequest: rebaseTransferRequestPathToMachineTarget,
        }),
        chunk: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_UPLOAD_CHUNK,
            sessionMethod: RPC_METHODS.FILES_UPLOAD_CHUNK,
        }),
        finalize: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_UPLOAD_FINALIZE,
            sessionMethod: RPC_METHODS.FILES_UPLOAD_FINALIZE,
        }),
        abort: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_UPLOAD_ABORT,
            sessionMethod: RPC_METHODS.FILES_UPLOAD_ABORT,
        }),
    };
}

type FilesUploadChunkRequest = Readonly<{
    uploadId: string;
    index: number;
    payloadBase64: string;
    encryptedDataKeyEnvelopeBase64: string;
}>;

export type FilesUploadChunkResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type FilesUploadFinalizeRequest = Readonly<{ uploadId: string }>;

export type FilesUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type FilesUploadAbortRequest = Readonly<{ uploadId: string }>;

export type FilesUploadAbortResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type FilesDownloadInitRequest = Readonly<{
    path: string;
    asZip?: boolean;
    recipientPublicKeyBase64?: string;
}>;

export type FilesDownloadInitResponse =
    | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type SessionFilesDownloadTransferClient = Readonly<{
    init: (request: FilesDownloadInitRequest) => Promise<FilesDownloadInitResponse>;
    chunk: (request: FilesDownloadChunkRequest) => Promise<FilesDownloadChunkResponse>;
    finalize: (request: FilesDownloadFinalizeRequest) => Promise<FilesDownloadFinalizeResponse>;
    abort: (request: FilesDownloadAbortRequest) => Promise<FilesDownloadAbortResponse>;
}>;

function createServerScopedSessionTransferMethodCaller(params: Readonly<{
    sessionId: string;
    serverId: string | undefined;
}>): <TResponse extends { success: boolean }, TRequest>(method: string, payload: TRequest) => Promise<TResponse> {
    return async <TResponse extends { success: boolean }, TRequest>(method: string, payload: TRequest): Promise<TResponse> =>
        await assertRpcResponseWithSuccess<TResponse>(await sessionRpcWithServerScope({
            sessionId: params.sessionId,
            serverId: params.serverId,
            method,
            payload,
        }));
}

export function createSessionFilesDownloadTransferClient(params: Readonly<{
    sessionId: string;
    forceSessionRpcServerId?: string;
}>): SessionFilesDownloadTransferClient {
    if (Object.prototype.hasOwnProperty.call(params, 'forceSessionRpcServerId')) {
        const callServerScopedTransferMethod = createServerScopedSessionTransferMethodCaller({
            sessionId: params.sessionId,
            serverId: params.forceSessionRpcServerId,
        });
        return {
            init: async (request) => await callServerScopedTransferMethod(RPC_METHODS.FILES_DOWNLOAD_INIT, request),
            chunk: async (request) => await callServerScopedTransferMethod(RPC_METHODS.FILES_DOWNLOAD_CHUNK, request),
            finalize: async (request) => await callServerScopedTransferMethod(RPC_METHODS.FILES_DOWNLOAD_FINALIZE, request),
            abort: async (request) => await callServerScopedTransferMethod(RPC_METHODS.FILES_DOWNLOAD_ABORT, request),
        };
    }

    const rpcCaller = createSessionFileTransferRpcCaller({
        sessionId: params.sessionId,
    });

    return {
        init: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_DOWNLOAD_INIT,
            sessionMethod: RPC_METHODS.FILES_DOWNLOAD_INIT,
            toMachineRequest: rebaseTransferRequestPathToMachineTarget,
        }),
        chunk: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_DOWNLOAD_CHUNK,
            sessionMethod: RPC_METHODS.FILES_DOWNLOAD_CHUNK,
        }),
        finalize: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_DOWNLOAD_FINALIZE,
            sessionMethod: RPC_METHODS.FILES_DOWNLOAD_FINALIZE,
        }),
        abort: async (request) => await rpcCaller.call({
            request,
            machineMethod: RPC_METHODS.FILES_DOWNLOAD_ABORT,
            sessionMethod: RPC_METHODS.FILES_DOWNLOAD_ABORT,
        }),
    };
}

type FilesDownloadChunkRequest = Readonly<{ downloadId: string; index: number }>;

export type FilesDownloadChunkResponse =
    | Readonly<{ success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type FilesDownloadFinalizeRequest = Readonly<{ downloadId: string }>;

export type FilesDownloadFinalizeResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

type FilesDownloadAbortRequest = Readonly<{ downloadId: string }>;

export type FilesDownloadAbortResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function downloadSessionPathViaTransfer(params: Readonly<{
    sessionId: string;
    path: string;
    asZip?: boolean;
    forceSessionRpcServerId?: string;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    onInit?: ((input: Readonly<{ name: string; sizeBytes: number }>) => Promise<void> | void) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: ChunkDownloadProgress) => void) | null;
}>): Promise<
    | Readonly<{ success: true; name: string; sizeBytes: number }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
> {
    const client = params.forceSessionRpcServerId === undefined
        ? createSessionFilesDownloadTransferClient({
            sessionId: params.sessionId,
        })
        : createSessionFilesDownloadTransferClient({
            sessionId: params.sessionId,
            forceSessionRpcServerId: params.forceSessionRpcServerId,
        });
    const recipientKeyPair = createTransferRecipientKeyPair();
    const init = await client.init({
        path: params.path,
        asZip: params.asZip,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    if (!init.success) {
        return init;
    }
    try {
        await params.onInit?.({
            name: init.name,
            sizeBytes: init.sizeBytes,
        });
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Download init failed',
        };
    }

    const download = await downloadInChunks<FilesDownloadInitResponse, FilesDownloadChunkResponse, FilesDownloadFinalizeResponse>({
        init: async () => init,
        readChunk: async (request) => await client.chunk(request),
        finalize: async (request) => await client.finalize(request),
        abort: async (request) => await client.abort(request),
        recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        writeBytes: params.writeBytes,
        signal: params.signal ?? null,
        onProgress: params.onProgress ?? null,
    });

    if (!download.ok) {
        return {
            success: false,
            error: download.error,
        };
    }

    return {
        success: true,
        name: init.name,
        sizeBytes: download.sizeBytes,
    };
}

export async function downloadSessionPathToBytesViaTransfer(params: Readonly<{
    sessionId: string;
    path: string;
    asZip?: boolean;
    forceSessionRpcServerId?: string;
}>): Promise<
    | Readonly<{ success: true; bytes: Uint8Array; sizeBytes: number }>
    | Readonly<{ success: false; error: string; errorCode?: string }>
> {
    const chunks: Uint8Array[] = [];
    const download = await downloadSessionPathViaTransfer({
        sessionId: params.sessionId,
        path: params.path,
        asZip: params.asZip,
        forceSessionRpcServerId: params.forceSessionRpcServerId,
        writeBytes: async (bytes) => {
            chunks.push(bytes);
        },
    });

    return download.success
        ? {
            success: true,
            bytes: mergeTransferChunks(chunks),
            sizeBytes: download.sizeBytes,
        }
        : download;
}
