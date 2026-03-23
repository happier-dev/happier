import { access, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWorkspaceRelativePath } from '../workspaceExportPackaging/resolveWorkspaceRelativePath';

import { resolveWorkspaceStagingMarkerFilePath, type WorkspaceStagingRoot } from './createWorkspaceStagingRoot';

export type StagedWorkspaceDirectory = Readonly<{
    relativePath: string;
    directoryPath: string;
}>;

export async function stageWorkspaceDirectory(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    relativePath: string;
}>): Promise<StagedWorkspaceDirectory> {
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
        throw new Error('Workspace staging directory path must stay within the workspace root');
    }

    const directoryPath = join(params.stagingRoot.workspaceDirectory, resolvedPath.relativePath);

    try {
        const existingEntry = await lstat(directoryPath);
        if (!existingEntry.isDirectory()) {
            throw new Error(`Staged workspace path is not a directory: ${resolvedPath.relativePath}`);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await mkdir(directoryPath, { recursive: true });
        } else {
            throw error;
        }
    }

    return {
        relativePath: resolvedPath.relativePath,
        directoryPath,
    };
}
