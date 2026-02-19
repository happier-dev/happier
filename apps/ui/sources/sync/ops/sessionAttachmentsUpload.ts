import { encodeBase64 } from '@/encryption/base64';

import { apiSocket } from '../api/session/apiSocket';
import type { AttachmentsUploadFileSource } from '../domains/attachments/attachmentsUploadFileSource';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '../runtime/rpcErrors';

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
}>): Promise<SessionAttachmentsUploadFileResult> {
    let uploadId: string | null = null;

    try {
        let described = describeUploadSource(args.file);
        if (described.sizeBytes < 0 && args.file.kind === 'native') {
            try {
                const FileSystem: any = await import('expo-file-system');
                const file = new FileSystem.File(args.file.uri);
                const handle = file.open();
                try {
                    const fromHandle = typeof handle?.size === 'number' && Number.isFinite(handle.size) ? handle.size : null;
                    const fromFile = typeof file?.size === 'number' && Number.isFinite(file.size) ? file.size : null;
                    const resolved = fromHandle ?? fromFile;
                    if (resolved != null) {
                        described = { ...described, sizeBytes: resolved };
                    }
                } finally {
                    try { handle.close(); } catch { }
                }
            } catch {
                // Best-effort only; fall through to size validation below.
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

        uploadId = init.uploadId;
        const chunkSizeBytes = init.chunkSizeBytes;

        let index = 0;
        if (args.file.kind === 'web') {
            for (let offset = 0; offset < described.sizeBytes; offset += chunkSizeBytes) {
                const nextEnd = Math.min(described.sizeBytes, offset + chunkSizeBytes);
                const chunkBlob = args.file.file.slice(offset, nextEnd);
                const chunkBytes = new Uint8Array(await chunkBlob.arrayBuffer());
                const contentBase64 = encodeBase64(chunkBytes, 'base64');

                const chunkResponse = await apiSocket.sessionRPC<UploadChunkResponse, unknown>(args.sessionId, 'attachments.upload.chunk', {
                    uploadId,
                    index,
                    contentBase64,
                });
                const chunk = assertRpcResponseWithSuccess<UploadChunkResponse>(chunkResponse);
                if (!chunk.success) {
                    return { success: false, error: chunk.error };
                }
                index += 1;
            }
        } else {
            const FileSystem: any = await import('expo-file-system');
            const file = new FileSystem.File(args.file.uri);
            const handle = file.open();
            try {
                if (typeof handle.offset === 'number' || handle.offset === null) {
                    handle.offset = 0;
                }

                for (let offset = 0; offset < described.sizeBytes; offset += chunkSizeBytes) {
                    const length = Math.min(chunkSizeBytes, described.sizeBytes - offset);
                    const chunkBytes: Uint8Array = handle.readBytes(length);
                    if (chunkBytes.byteLength !== length) {
                        return { success: false, error: 'Failed to read attachment chunk' };
                    }
                    const contentBase64 = encodeBase64(chunkBytes, 'base64');

                    const chunkResponse = await apiSocket.sessionRPC<UploadChunkResponse, unknown>(args.sessionId, 'attachments.upload.chunk', {
                        uploadId,
                        index,
                        contentBase64,
                    });
                    const chunk = assertRpcResponseWithSuccess<UploadChunkResponse>(chunkResponse);
                    if (!chunk.success) {
                        return { success: false, error: chunk.error };
                    }
                    index += 1;
                }
            } finally {
                try { handle.close(); } catch { }
            }
        }

        const finalizeResponse = await apiSocket.sessionRPC<UploadFinalizeResponse, unknown>(args.sessionId, 'attachments.upload.finalize', {
            uploadId,
        });
        const finalized = assertRpcResponseWithSuccess<UploadFinalizeResponse>(finalizeResponse);
        if (!finalized.success) {
            return { success: false, error: finalized.error };
        }

        uploadId = null;
        return { success: true, path: finalized.path, sizeBytes: finalized.sizeBytes, sha256: finalized.sha256 };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    } finally {
        if (uploadId) {
            try {
                const abortResponse = await apiSocket.sessionRPC<UploadAbortResponse, unknown>(args.sessionId, 'attachments.upload.abort', { uploadId });
                const aborted = assertRpcResponseWithSuccess<UploadAbortResponse>(abortResponse);
                void aborted;
            } catch {
                // Best-effort only.
            }
        }
    }
}
