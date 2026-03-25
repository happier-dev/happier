import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { openLocalUploadSourceReader, resolveLocalUploadSourceSizeBytes } from '@/sync/domains/files/transfers/localUploadSourceReader';
import { uploadDaemonSessionAttachmentFromReader } from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

export type AttachmentsUploadLocation = 'workspace' | 'os_temp';
export type VcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentsUploadConfig = Readonly<{
    uploadLocation: AttachmentsUploadLocation;
    workspaceRelativeDir: string;
    vcsIgnoreStrategy: VcsIgnoreStrategy;
    vcsIgnoreWritesEnabled: boolean;
    maxFileBytes: number;
}>;

export type AttachmentsUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

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
    try {
        let described = describeUploadSource(args.file);
        const resolvedSizeBytes = await resolveLocalUploadSourceSizeBytes(args.file);
        if (resolvedSizeBytes != null) {
            described = { ...described, sizeBytes: resolvedSizeBytes };
        }

        if (described.sizeBytes < 0) {
            return { success: false, error: 'Unknown attachment size' };
        }
        if (described.sizeBytes > args.config.maxFileBytes) {
            return { success: false, error: 'File exceeds maximum allowed size' };
        }

        const reader = await openLocalUploadSourceReader(args.file);
        const bulkUpload = await uploadDaemonSessionAttachmentFromReader({
            sessionId: args.sessionId,
            fileReader: {
                sizeBytes: described.sizeBytes,
                readBytes: async (offset, length) => await reader.readBytes(offset, length),
                close: async () => await reader.close(),
            },
            request: {
                messageLocalId: args.messageLocalId,
                fileName: described.name,
                sizeBytes: described.sizeBytes,
                uploadLocation: args.config.uploadLocation,
                workspaceRelativeDir: args.config.workspaceRelativeDir,
                vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
                vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
            },
            onProgress: args.onProgress
                ? (progress) => {
                    try {
                        args.onProgress?.(progress);
                    } catch {
                        // ignore
                    }
                }
                : null,
        });

        if (bulkUpload.success !== true) {
            return { success: false, error: bulkUpload.error ?? 'Upload failed', errorCode: bulkUpload.errorCode };
        }

        return { success: true, path: bulkUpload.path, sizeBytes: bulkUpload.sizeBytes, sha256: bulkUpload.sha256 };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}
