import { configuration } from '@/configuration';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import {
    OS_USER_FILESYSTEM_ACCESS_POLICY,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import {
    isServerRoutedTransferOverSizeLimit,
    SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
} from '../policy/serverRoutedTransferPolicy';
import {
    finalizeWorkspaceFileUpload,
    type WorkspaceFileFinalizeOperations,
} from './finalizeWorkspaceFileUpload';
import type { UploadTransferTarget } from './uploadTransferTarget';

export type WorkspaceFileUploadTarget = UploadTransferTarget & Readonly<{
    destPath: string;
}>;

export type WorkspaceFinalizeFileOperationsFactory = (input: Readonly<{
    uploadId: string;
    tempPath: string;
    destPath: string;
    overwrite: boolean;
}>) => WorkspaceFileFinalizeOperations | null;

type WorkspaceFileUploadTargetResult =
    | Readonly<{ success: true; target: WorkspaceFileUploadTarget }>
    | Readonly<{ success: false; error: string }>;

function normalizeSizeBytes(value: unknown): number | null {
    const raw = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(raw)) return null;
    const sizeBytes = Math.floor(raw);
    if (sizeBytes < 0) return null;
    return sizeBytes;
}

export function resolveWorkspaceFileUploadTarget(input: Readonly<{
    workingDirectory: string;
    path: unknown;
    sizeBytes: unknown;
    overwrite: unknown;
    accessPolicy?: FilesystemAccessPolicy;
    additionalAllowedWriteDirs?: readonly string[];
    sessionRpcTransferMaxBytes?: number | null;
    finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): WorkspaceFileUploadTargetResult {
    const path = typeof input.path === 'string' ? input.path : '';
    const sizeBytes = normalizeSizeBytes(input.sizeBytes);
    const overwrite = Boolean(input.overwrite);

    if (!path) {
        return { success: false, error: 'Missing path' };
    }
    if (sizeBytes === null) {
        return { success: false, error: 'Invalid sizeBytes' };
    }
    if (isServerRoutedTransferOverSizeLimit(sizeBytes, input.sessionRpcTransferMaxBytes ?? null)) {
        return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
    }
    if (sizeBytes > configuration.filesUploadMaxFileBytes) {
        return { success: false, error: 'File exceeds upload size limit' };
    }

    const validation = validatePath(
        path,
        input.workingDirectory,
        input.additionalAllowedWriteDirs,
        input.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY,
    );
    if (!validation.valid || !validation.resolvedPath) {
        return { success: false, error: validation.error ?? 'Access denied' };
    }
    const destPath = validation.resolvedPath;

    return {
        success: true,
        target: {
            destPath,
            destDisplayPath: path,
            expectedSizeBytes: sizeBytes,
            overwrite,
            finalizeUpload: async ({ uploadId, tempPath, sizeBytes: finalizedSizeBytes }) =>
                await finalizeWorkspaceFileUpload({
                    tempPath,
                    destPath,
                    destDisplayPath: path,
                    overwrite,
                    sizeBytes: finalizedSizeBytes,
                    fileOperations: input.finalizeFileOperations?.({
                        uploadId,
                        tempPath,
                        destPath,
                        overwrite,
                    }) ?? null,
                }),
        },
    };
}
