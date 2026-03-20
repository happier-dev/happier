import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { randomUUID } from '@/platform/randomUUID';
import { apiSocket } from '@/sync/api/session/apiSocket';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { type ChunkUploadProgress } from '@/sync/domains/files/transfers/chunkTransferClient';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/domains/files/transfers/localUploadSourceReader';
import { uploadLocalSourceToSessionPath } from '@/sync/domains/files/transfers/uploadLocalSourceToSessionPath';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
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

type ConfigureResponse =
    | Readonly<{ success: true; uploadLocation: AttachmentsUploadLocation; uploadBasePath: string }>
    | Readonly<{ success: false; error: string }>;

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

function sanitizeFileName(value: string): string {
    const raw = String(value ?? '');
    const base = raw.split(/[/\\]/g).pop() ?? '';
    const trimmed = base.trim() || 'file';
    const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
    const collapsed = safe.replace(/_+/g, '_');
    const finalName = collapsed === '.' || collapsed === '..' ? 'file' : collapsed;
    return finalName.length > 200 ? finalName.slice(-200) : finalName;
}

function joinRelativePath(...segments: ReadonlyArray<string>): string {
    return segments
        .map((segment) => String(segment ?? '').replace(/\\/g, '/'))
        .filter((segment) => segment.length > 0)
        .join('/');
}

function buildAttachmentUploadPath(args: Readonly<{
    uploadBasePath: string;
    messageLocalId: string;
    fileName: string;
}>): string {
    const prefix = randomUUID().slice(0, 8);
    return joinRelativePath(
        args.uploadBasePath,
        args.messageLocalId,
        `${prefix}-${sanitizeFileName(args.fileName)}`,
    );
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

        const configureResponse = await apiSocket.sessionRPC<ConfigureResponse, unknown>(
            args.sessionId,
            RPC_METHODS.ATTACHMENTS_CONFIGURE,
            {
                uploadLocation: args.config.uploadLocation,
                workspaceRelativeDir: args.config.workspaceRelativeDir,
                vcsIgnoreStrategy: args.config.vcsIgnoreStrategy,
                vcsIgnoreWritesEnabled: args.config.vcsIgnoreWritesEnabled,
            },
        );
        const configured = assertRpcResponseWithSuccess<ConfigureResponse>(configureResponse);
        if (!configured.success) {
            return { success: false, error: configured.error };
        }

        const uploadPath = buildAttachmentUploadPath({
            uploadBasePath: configured.uploadBasePath,
            messageLocalId: args.messageLocalId,
            fileName: described.name,
        });

        const emitProgress = (progress: ChunkUploadProgress) => {
            if (!args.onProgress) return;
            try {
                args.onProgress(progress);
            } catch {
                // ignore
            }
        };

        const finalize = await uploadLocalSourceToSessionPath({
            sessionId: args.sessionId,
            source: args.file,
            targetPath: uploadPath,
            sizeBytes: described.sizeBytes,
            overwrite: false,
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
    }
}
