import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

export type WorkspaceManifest = Readonly<{
    entries: readonly WorkspaceManifestEntry[];
}>;

export async function scanWorkspaceManifest(params: Readonly<{
    workspaceRoot: string;
    safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
    scmRegistry?: ScmBackendRegistry;
}>): Promise<WorkspaceManifest> {
    const workspaceRoot = resolve(params.workspaceRoot);
    const safeFilterPolicy = resolveWorkspaceManifestSafeFilterPolicy(params.safeFilterPolicy);
    const pendingDirectories = [workspaceRoot];
    const entries: WorkspaceManifestEntry[] = [];

    for (let pendingIndex = 0; pendingIndex < pendingDirectories.length; pendingIndex += 1) {
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
                let fileDigest: string;
                try {
                    fileDigest = await hashWorkspaceFile({ filePath: candidatePath });
                } catch (error) {
                    if (isIgnorableWorkspaceExportAccessError(error)) {
                        continue;
                    }
                    throw error;
                }
                entries.push(buildWorkspaceManifestEntry({
                    relativePath: resolvedPath.relativePath,
                    stats,
                    fileDigest,
                }));
            }
        }
    }

    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    return {
        entries,
    };
}
