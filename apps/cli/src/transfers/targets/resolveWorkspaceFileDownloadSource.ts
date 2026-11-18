import { randomUUID } from 'crypto';
import { mkdir, open, rm, stat } from 'fs/promises';
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

import type { DownloadTransferSource } from '@happier-dev/transfers/node';
import { buildZipArchive } from '../download/buildZipArchive';
import { currentWorkspaceSource, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { copyWorkspaceTree, WorkspaceTreeCopyLimitError } from '@/workspaces/source/copyWorkspaceTree';
import {
    isServerRoutedTransferOverSizeLimit,
    SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
} from '../policy/serverRoutedTransferPolicy';

export type WorkspaceFileDownloadSource = DownloadTransferSource;

type WorkspaceFileDownloadSourceResult =
    | Readonly<{ success: true; source: WorkspaceFileDownloadSource }>
    | Readonly<{ success: false; error: string; errorCode?: 'not_found' }>;

function createTempDownloadZipPath(): string {
    return join(tmpdir(), 'happier', 'file-zips', `${randomUUID()}.zip`);
}

async function stageWorkspaceFileForDownload(workspace: WorkspaceSource, path: string): Promise<string> {
    const stagedPath = join(tmpdir(), 'happier', 'file-downloads', randomUUID());
    await mkdir(join(tmpdir(), 'happier', 'file-downloads'), { recursive: true });
    const input = await workspace.open(path);
    const output = await open(stagedPath, 'wx', 0o600);
    try {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        for (let position = 0; ;) {
            const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            await output.write(chunk.subarray(0, bytesRead));
            position += bytesRead;
        }
        return stagedPath;
    } catch (error) {
        await rm(stagedPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        await Promise.all([input.close(), output.close()]);
    }
}

export async function resolveWorkspaceFileDownloadSource(input: Readonly<{
    workingDirectory: string;
    path: unknown;
    asZip: unknown;
    accessPolicy?: FilesystemAccessPolicy;
    additionalAllowedReadDirs?: readonly string[];
    additionalAllowedReadFiles?: readonly ExactAllowedReadFile[];
    sessionRpcTransferMaxBytes?: number | null;
    /** Publication narrows an otherwise OS-user-scoped read to the proven Session root. */
    confinedToWorkingDirectory?: boolean;
}>): Promise<WorkspaceFileDownloadSourceResult> {
    const path = typeof input.path === 'string' ? input.path : '';
    const asZip = Boolean(input.asZip);
    if (!path) {
        return { success: false, error: 'Missing path' };
    }

    const directoryValidation = validatePath(
        path,
        input.workingDirectory,
        input.confinedToWorkingDirectory ? [] : input.additionalAllowedReadDirs,
        input.confinedToWorkingDirectory ? { kind: 'restrictedRoots', roots: [input.workingDirectory] }
            : input.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY,
    );
    let resolvedPath: string;
    if (directoryValidation.valid && directoryValidation.resolvedPath) {
        resolvedPath = directoryValidation.resolvedPath;
    } else {
        const exactFileValidation = authorizeExactAllowedReadFile({
            targetPath: path,
            workingDirectory: input.workingDirectory,
            allowedFiles: input.confinedToWorkingDirectory ? [] : input.additionalAllowedReadFiles,
        });
        if (!exactFileValidation.valid) {
            return {
                success: false,
                error: exactFileValidation.error ?? directoryValidation.error ?? 'Access denied',
            };
        }
        resolvedPath = exactFileValidation.resolvedPath;
    }

    const workspace = currentWorkspaceSource();
    if (!asZip) {
        let sourceStats: Awaited<ReturnType<WorkspaceSource['stat']>>;
        try {
            sourceStats = await workspace.stat(resolvedPath);
        } catch (error) {
            // Only this source observation establishes absence; staging/sink failures do not.
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return { success: false, error: 'Source file not found', errorCode: 'not_found' };
            }
            throw error;
        }
        if (!sourceStats.isFile()) {
            return { success: false, error: 'Download is only supported for files' };
        }
        if (isServerRoutedTransferOverSizeLimit(sourceStats.size, input.sessionRpcTransferMaxBytes ?? null)) {
            return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
        }
        if (sourceStats.size > configuration.filesDownloadMaxFileBytes) {
            return { success: false, error: 'File exceeds download size limit' };
        }

        if (workspace.kind !== 'local') {
            // Transfer custody reads a host file: stage the target's bytes in host temp space.
            const stagedPath = await stageWorkspaceFileForDownload(workspace, resolvedPath);
            return { success: true, source: { filePath: stagedPath, deleteFileOnClose: true,
                sizeBytes: (await stat(stagedPath)).size, name: basename(resolvedPath) } };
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
    // A target folder is first copied into host staging through the port (same exclusions and
    // limits), then archived by the same ZIP owner as a local folder.
    let archiveSource = resolvedPath;
    let stagingRoot: string | null = null;
    if (workspace.kind !== 'local') {
        stagingRoot = join(tmpdir(), 'happier', 'file-zip-staging', randomUUID());
        archiveSource = join(stagingRoot, basename(resolvedPath));
        try {
            await copyWorkspaceTree({ from: { source: workspace, path: resolvedPath }, to: { source: localWorkspaceSource, path: archiveSource },
                limits: { excludedTopLevelDirs: configuration.filesZipExcludedTopLevelDirs,
                    maxEntryCount: configuration.filesZipMaxEntryCount, maxTotalBytes: configuration.filesZipMaxTotalBytes } });
        } catch (error) {
            await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
            if (error instanceof WorkspaceTreeCopyLimitError) return { success: false, error: 'Folder exceeds download size limit' };
            throw error;
        }
    }

    const zipPath = createTempDownloadZipPath();
    try {
        await buildZipArchive({
            sourcePath: archiveSource,
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
    } finally {
        if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
