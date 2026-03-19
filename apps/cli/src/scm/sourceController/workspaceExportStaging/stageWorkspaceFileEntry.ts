import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hashWorkspaceFile } from '../workspaceExportPackaging/hashWorkspaceFile';
import { resolveWorkspaceRelativePath } from '../workspaceExportPackaging/resolveWorkspaceRelativePath';

import { type WorkspaceStagingRoot } from './createWorkspaceStagingRoot';
import { stageWorkspaceFileBlob, type StagedWorkspaceFileBlob } from './stageWorkspaceFileBlob';

export type StagedWorkspaceFileEntry = Readonly<{
    relativePath: string;
    filePath: string;
    digest: string;
    executable: boolean;
    blob: StagedWorkspaceFileBlob;
}>;

export async function stageWorkspaceFileEntry(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    relativePath: string;
    digest: string;
    content: Uint8Array;
    executable: boolean;
}>): Promise<StagedWorkspaceFileEntry> {
    const stagedBlob = await stageWorkspaceFileBlob({
        stagingRoot: params.stagingRoot,
        digest: params.digest,
        content: params.content,
    });
    const stagedBlobDigest = await hashWorkspaceFile({ filePath: stagedBlob.filePath });
    if (stagedBlobDigest !== params.digest) {
        throw new Error(`Staged workspace file blob digest mismatch for ${params.relativePath}`);
    }

    const resolvedPath = resolveWorkspaceRelativePath({
        workspaceRoot: params.stagingRoot.workspaceDirectory,
        candidatePath: params.relativePath,
    });
    if (!resolvedPath.ok || resolvedPath.relativePath.length === 0) {
        throw new Error('Workspace staging file path must stay within the workspace root');
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
    await copyFile(stagedBlob.filePath, filePath);
    await chmod(filePath, params.executable ? 0o755 : 0o644);

    return {
        relativePath: resolvedPath.relativePath,
        filePath,
        digest: params.digest,
        executable: params.executable,
        blob: stagedBlob,
    };
}
