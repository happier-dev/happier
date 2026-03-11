import { apiSocket } from '../api/session/apiSocket';
import type { AttachmentsUploadFileSource } from '../domains/attachments/attachmentsUploadFileSource';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '../runtime/rpcErrors';
import { uploadInChunks, type ChunkUploadProgress } from '../domains/files/transfers/chunkTransferClient';

export type AttachmentsUploadLocation = 'workspace' | 'os_temp';
export type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentsUploadConfig = Readonly<{
    uploadLocation: AttachmentsUploadLocation;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: VcsIgnoreStrategy;
    vcsIgnoreWritesEnabled: boolean;
    maxFileBytes: number;
    uploadTtlMs: number;
    chunkSizeBytes: number;
}>;

export type AttachmentsUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

type ConfigureResponse = Readonly<{ success: true } | { success: false; error: string }>;

type UploadInitResponse =
    | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number }>
    | Readonly<{ success: false; error: string }>;

type UploadChunkResponse = Readonly<{ success: true } | { success: false; error: string }>;

type UploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; error: string }>;

type UploadAbortResponse = Readonly<{ success: true } | { success: false; error: string }>;

export type SessionAttachmentsUploadFileResult =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

function describeUploadSource(source: AttachmentsUploadFileSource): Readonly<{
    name: string;
    sizeBytes: number;
    mimeType?: string;
}> {
    if (source.kind === 'web') {
        return {
            name: source.file.name,
            sizeBytes: source.file.size,
            mimeType: source.file.type || undefined,
        };
    }

    return {
        name: source.name,
        sizeBytes: typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) ? source.sizeBytes : -1,
        mimeType: source.mimeType ? String(source.mimeType) : undefined,
    };
}

export async function sessionAttachmentsUploadFile(args: Readonly<{
    sessionId: string;
    file: AttachmentsUploadFileSource;
    messageLocalId: string;
    config: AttachmentsUploadConfig;
    onProgress?: (progress: AttachmentsUploadProgress) => void;
}>): Promise<SessionAttachmentsUploadFileResult> {
    let nativeHandle: any = null;
    try {
        let described = describeUploadSource(args.file);
        if (args.file.kind === 'native') {
            try {
                const FileSystem: any = await import('expo-file-system');
                const file = new FileSystem.File(args.file.uri);
                nativeHandle = file.open();
                const fromHandle = typeof nativeHandle?.size === 'number' && Number.isFinite(nativeHandle.size) ? nativeHandle.size : null;
                const fromFile = typeof file?.size === 'number' && Number.isFinite(file.size) ? file.size : null;
                const resolved = fromHandle ?? fromFile;
                if (described.sizeBytes < 0 && resolved != null) {
                    described = { ...described, sizeBytes: resolved };
                }
            } catch {
                nativeHandle = null;
                if (described.sizeBytes < 0) {
                    // Best-effort only; fall through to size validation below.
                }
            }
        }

        if (described.sizeBytes < 0) {
            return { success: false, error: 'Unknown attachment size' };
        }
        if (described.sizeBytes > args.config.maxFileBytes) {
            return { success: false, error: 'File exceeds maximum allowed size' };
        }

        const configureResponse = await apiSocket.sessionRPC<ConfigureResponse, unknown>(args.sessionId, 'attachments.configure', {
            uploadLocation: args.config.uploadLocation,
            workspaceRelativeDir: args.config.workspaceRelativeDir,
            vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
            vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
            maxFileBytes: args.config.maxFileBytes,
            uploadTtlMs: args.config.uploadTtlMs,
            chunkSizeBytes: args.config.chunkSizeBytes,
        });
        const configured = assertRpcResponseWithSuccess<ConfigureResponse>(configureResponse);
        if (!configured.success) {
            return { success: false, error: configured.error };
        }

        const initResponse = await apiSocket.sessionRPC<UploadInitResponse, unknown>(args.sessionId, 'attachments.upload.init', {
            name: described.name,
            sizeBytes: described.sizeBytes,
            mimeType: described.mimeType,
            messageLocalId: args.messageLocalId,
        });
        const init = assertRpcResponseWithSuccess<UploadInitResponse>(initResponse);
        if (!init.success) {
            return { success: false, error: init.error };
        }

        const emitProgress = (progress: ChunkUploadProgress) => {
            if (!args.onProgress) return;
            try {
                args.onProgress(progress);
            } catch {
                // ignore
            }
        };

        const readBytes = async (offset: number, length: number): Promise<Uint8Array> => {
            if (args.file.kind === 'web') {
                const nextEnd = Math.min(described.sizeBytes, offset + length);
                const chunkBlob = args.file.file.slice(offset, nextEnd);
                return new Uint8Array(await chunkBlob.arrayBuffer());
            }

            if (!nativeHandle) {
                throw new Error('Failed to open native attachment file');
            }
            if (typeof nativeHandle.offset === 'number' || nativeHandle.offset === null) {
                nativeHandle.offset = offset;
            }
            return nativeHandle.readBytes(length);
        };

        const finalize = await uploadInChunks<UploadInitResponse, UploadChunkResponse, UploadFinalizeResponse>({
            totalBytes: described.sizeBytes,
            readBytes,
            init: async () => init,
            sendChunk: async ({ uploadId, index, contentBase64 }) => {
                const chunkResponse = await apiSocket.sessionRPC<UploadChunkResponse, unknown>(args.sessionId, 'attachments.upload.chunk', {
                    uploadId,
                    index,
                    contentBase64,
                });
                return assertRpcResponseWithSuccess<UploadChunkResponse>(chunkResponse);
            },
            finalize: async ({ uploadId }) => {
                const finalizeResponse = await apiSocket.sessionRPC<UploadFinalizeResponse, unknown>(args.sessionId, 'attachments.upload.finalize', {
                    uploadId,
                });
                return assertRpcResponseWithSuccess<UploadFinalizeResponse>(finalizeResponse);
            },
            abort: async ({ uploadId }) => {
                const abortResponse = await apiSocket.sessionRPC<UploadAbortResponse, unknown>(args.sessionId, 'attachments.upload.abort', { uploadId });
                return assertRpcResponseWithSuccess<UploadAbortResponse>(abortResponse);
            },
            onProgress: emitProgress,
        });

        if (!finalize.success) {
            return { success: false, error: finalize.error };
        }

        return { success: true, path: finalize.path, sizeBytes: finalize.sizeBytes, sha256: finalize.sha256 };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    } finally {
        if (nativeHandle) {
            try { nativeHandle.close(); } catch { }
        }
    }
}
