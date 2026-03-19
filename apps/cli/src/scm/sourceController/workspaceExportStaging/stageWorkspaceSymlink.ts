import { access, lstat, mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveWorkspaceRelativePath } from '../workspaceExportPackaging/resolveWorkspaceRelativePath';

import { resolveWorkspaceStagingMarkerFilePath, type WorkspaceStagingRoot } from './createWorkspaceStagingRoot';

export type StagedWorkspaceSymlink = Readonly<{
    relativePath: string;
    filePath: string;
    target: string;
}>;

export async function stageWorkspaceSymlink(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    relativePath: string;
    target: string;
}>): Promise<StagedWorkspaceSymlink> {
    const markerFilePath = resolveWorkspaceStagingMarkerFilePath({ rootDirectory: params.stagingRoot.rootDirectory });

    try {
        await access(markerFilePath);
    } catch {
        throw new Error(`Workspace staging root marker is missing for ${params.stagingRoot.rootDirectory}`);
    }

    const resolvedPath = resolveWorkspaceRelativePath({
        workspaceRoot: params.stagingRoot.workspaceDirectory,
        candidatePath: params.relativePath,
    });
    if (!resolvedPath.ok || resolvedPath.relativePath.length === 0) {
        throw new Error('Workspace staging symlink path must stay within the workspace root');
    }

    const target = params.target.trim();
    if (target.length === 0) {
        throw new Error('Workspace staging symlink target must not be empty');
    }

    const filePath = join(params.stagingRoot.workspaceDirectory, resolvedPath.relativePath);

    try {
        await lstat(filePath);
        throw new Error(`Staged workspace path already exists: ${resolvedPath.relativePath}`);
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
    }

    await mkdir(dirname(filePath), { recursive: true });
    await symlink(target, filePath);

    return {
        relativePath: resolvedPath.relativePath,
        filePath,
        target,
    };
}
