import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';
import type { ScmBackendRegistry } from '@/scm/registry';
import { buildWorkspaceManifestEntry, type WorkspaceManifestEntry } from '@/scm/sourceController/workspaceExportPackaging/buildWorkspaceManifestEntry';
import { isIgnorableWorkspaceExportAccessError } from '@/scm/sourceController/workspaceExportFallbackEntries';

import { hashWorkspaceFile } from './hashWorkspaceFile';
import { resolveWorkspaceRelativePath } from './resolveWorkspaceRelativePath';
import {
    resolveWorkspaceManifestSafeFilterPolicy,
    shouldFilterWorkspaceManifestPath,
    type WorkspaceManifestSafeFilterPolicy,
} from './workspaceManifestSafeFilterPolicy';

export type ScannedWorkspaceFile = Readonly<{
    relativePath: string;
    filePath: string;
    digest: string;
    sizeBytes: number;
    executable: boolean;
    mtimeMs: number;
    inode?: number;
    device?: number;
}>;

export type WorkspaceManifestScannedFileMetadata = Readonly<{
    relativePath: string;
    filePath: string;
    sizeBytes: number;
    executable: boolean;
    mtimeMs: number;
    inode?: number;
    device?: number;
}>;

export async function scanWorkspaceManifest(params: Readonly<{
    workspaceRoot: string;
    safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
    scmRegistry?: ScmBackendRegistry;
    assertCanContinue?: () => void | Promise<void>;
    resolveCachedFileDigest?: (
        file: WorkspaceManifestScannedFileMetadata,
    ) => string | null | undefined | Promise<string | null | undefined>;
    onFileScanned?: (file: ScannedWorkspaceFile) => void | Promise<void>;
}>): Promise<WorkspaceManifest> {
    const workspaceRoot = resolve(params.workspaceRoot);
    const safeFilterPolicy = resolveWorkspaceManifestSafeFilterPolicy(params.safeFilterPolicy);
    const pendingDirectories = [workspaceRoot];
    const entries: WorkspaceManifestEntry[] = [];

    for (let pendingIndex = 0; pendingIndex < pendingDirectories.length; pendingIndex += 1) {
        await params.assertCanContinue?.();
        const directoryPath = pendingDirectories[pendingIndex];
        let directoryEntries;
        try {
            directoryEntries = await readdir(directoryPath, { withFileTypes: true });
        } catch (error) {
            if (isIgnorableWorkspaceExportAccessError(error)) {
                continue;
            }
            throw error;
        }
        directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

        for (const directoryEntry of directoryEntries) {
            await params.assertCanContinue?.();
            const candidatePath = join(directoryPath, directoryEntry.name);
            const resolvedPath = resolveWorkspaceRelativePath({
                workspaceRoot,
                candidatePath,
            });
            if (!resolvedPath.ok) {
                throw new Error(`Scanned workspace path escaped root: ${candidatePath}`);
            }

            if (await shouldFilterWorkspaceManifestPath(resolvedPath.relativePath, safeFilterPolicy, params.scmRegistry)) {
                continue;
            }

            let stats;
            try {
                stats = await lstat(candidatePath);
            } catch (error) {
                if (isIgnorableWorkspaceExportAccessError(error)) {
                    continue;
                }
                throw error;
            }
            if (stats.isDirectory()) {
                pendingDirectories.push(candidatePath);
                entries.push(buildWorkspaceManifestEntry({
                    relativePath: resolvedPath.relativePath,
                    stats,
                }));
                continue;
            }

            if (stats.isSymbolicLink()) {
                let symlinkTarget: string;
                try {
                    symlinkTarget = await readlink(candidatePath);
                } catch (error) {
                    if (isIgnorableWorkspaceExportAccessError(error)) {
                        continue;
                    }
                    throw error;
                }
                entries.push(buildWorkspaceManifestEntry({
                    relativePath: resolvedPath.relativePath,
                    stats,
                    symlinkTarget,
                }));
                continue;
            }

            if (stats.isFile()) {
                const scannedFileMetadata: WorkspaceManifestScannedFileMetadata = {
                    relativePath: resolvedPath.relativePath,
                    filePath: candidatePath,
                    sizeBytes: stats.size,
                    executable: (stats.mode & 0o111) !== 0,
                    mtimeMs: Math.max(0, Math.trunc(stats.mtimeMs)),
                    ...(typeof stats.ino === 'number' && Number.isInteger(stats.ino) && stats.ino >= 0
                        ? { inode: stats.ino }
                        : {}),
                    ...(typeof stats.dev === 'number' && Number.isInteger(stats.dev) && stats.dev >= 0
                        ? { device: stats.dev }
                        : {}),
                };
                let fileDigest: string;
                try {
                    await params.assertCanContinue?.();
                    const cachedDigest = await params.resolveCachedFileDigest?.(scannedFileMetadata);
                    fileDigest = cachedDigest ?? await hashWorkspaceFile({
                        filePath: candidatePath,
                        assertCanContinue: params.assertCanContinue,
                    });
                } catch (error) {
                    if (isIgnorableWorkspaceExportAccessError(error)) {
                        continue;
                    }
                    throw error;
                }
                const manifestEntry = buildWorkspaceManifestEntry({
                    relativePath: resolvedPath.relativePath,
                    stats,
                    fileDigest,
                }) as Extract<WorkspaceManifestEntry, { kind: 'file' }>;
                await params.onFileScanned?.({
                    ...scannedFileMetadata,
                    relativePath: manifestEntry.relativePath,
                    digest: manifestEntry.digest,
                });
                entries.push(manifestEntry);
            }
        }
    }

    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    return {
        entries,
    };
}
