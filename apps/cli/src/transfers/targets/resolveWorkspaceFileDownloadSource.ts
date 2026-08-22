import { randomUUID } from 'crypto';
import { rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { configuration } from '@/configuration';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import {
    OS_USER_FILESYSTEM_ACCESS_POLICY,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import {
    authorizeExactAllowedReadFile,
    type ExactAllowedReadFile,
} from '@/rpc/handlers/fileSystem/accessPolicy/exactAllowedReadFile';

import type { DownloadTransferSource } from './downloadTransferSource';
import { buildZipArchive } from '../download/buildZipArchive';
import {
    isServerRoutedTransferOverSizeLimit,
    SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
} from '../policy/serverRoutedTransferPolicy';

export type WorkspaceFileDownloadSource = DownloadTransferSource;

type WorkspaceFileDownloadSourceResult =
    | Readonly<{ success: true; source: WorkspaceFileDownloadSource }>
    | Readonly<{ success: false; error: string }>;

function createTempDownloadZipPath(): string {
    return join(tmpdir(), 'happier', 'file-zips', `${randomUUID()}.zip`);
}

export async function resolveWorkspaceFileDownloadSource(input: Readonly<{
    workingDirectory: string;
    path: unknown;
    asZip: unknown;
    accessPolicy?: FilesystemAccessPolicy;
    additionalAllowedReadDirs?: readonly string[];
    additionalAllowedReadFiles?: readonly ExactAllowedReadFile[];
    sessionRpcTransferMaxBytes?: number | null;
}>): Promise<WorkspaceFileDownloadSourceResult> {
    const path = typeof input.path === 'string' ? input.path : '';
    const asZip = Boolean(input.asZip);
    if (!path) {
        return { success: false, error: 'Missing path' };
    }

    const directoryValidation = validatePath(
        path,
        input.workingDirectory,
        input.additionalAllowedReadDirs,
        input.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY,
    );
    let resolvedPath: string;
    if (directoryValidation.valid && directoryValidation.resolvedPath) {
        resolvedPath = directoryValidation.resolvedPath;
    } else {
        const exactFileValidation = authorizeExactAllowedReadFile({
            targetPath: path,
            workingDirectory: input.workingDirectory,
            allowedFiles: input.additionalAllowedReadFiles,
        });
        if (!exactFileValidation.valid) {
            return {
                success: false,
                error: exactFileValidation.error ?? directoryValidation.error ?? 'Access denied',
            };
        }
        resolvedPath = exactFileValidation.resolvedPath;
    }

    if (!asZip) {
        const sourceStats = await stat(resolvedPath);
        if (!sourceStats.isFile()) {
            return { success: false, error: 'Download is only supported for files' };
        }
        if (isServerRoutedTransferOverSizeLimit(sourceStats.size, input.sessionRpcTransferMaxBytes ?? null)) {
            return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
        }
        if (sourceStats.size > configuration.filesDownloadMaxFileBytes) {
            return { success: false, error: 'File exceeds download size limit' };
        }

        return {
            success: true,
            source: {
                filePath: resolvedPath,
                deleteFileOnClose: false,
                sizeBytes: sourceStats.size,
                name: basename(resolvedPath),
            },
        };
    }

    const zipPath = createTempDownloadZipPath();
    try {
        await buildZipArchive({
            sourcePath: resolvedPath,
            zipPath,
            excludedTopLevelDirs: configuration.filesZipExcludedTopLevelDirs,
            maxEntryCount: configuration.filesZipMaxEntryCount,
            maxTotalBytes: configuration.filesZipMaxTotalBytes,
            maxOutputBytes: configuration.filesDownloadMaxFileBytes,
        });

        const zipStats = await stat(zipPath);
        if (isServerRoutedTransferOverSizeLimit(zipStats.size, input.sessionRpcTransferMaxBytes ?? null)) {
            await rm(zipPath, { force: true });
            return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
        }
        if (zipStats.size > configuration.filesDownloadMaxFileBytes) {
            await rm(zipPath, { force: true });
            return { success: false, error: 'Zip exceeds download size limit' };
        }

        return {
            success: true,
            source: {
                filePath: zipPath,
                deleteFileOnClose: true,
                sizeBytes: zipStats.size,
                name: `${basename(resolvedPath)}.zip`,
            },
        };
    } catch (error) {
        await rm(zipPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
