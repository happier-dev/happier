import { access, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { resolveWorkspaceStagingMarkerFilePath, type WorkspaceStagingRoot } from './createWorkspaceStagingRoot';

const workspaceStagingBlobDigestSchema = z.string().regex(/^(sha256):([a-f0-9]{64})$/);

export type StagedWorkspaceFileBlob = Readonly<{
    digest: string;
    filePath: string;
}>;

export function resolveStagedWorkspaceFileBlobPath(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    digest: string;
}>): string {
    const [algorithm, hash] = workspaceStagingBlobDigestSchema.parse(params.digest).split(':', 2);

    return join(params.stagingRoot.blobsDirectory, algorithm, `${hash}.blob`);
}

export async function stageWorkspaceFileBlob(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    digest: string;
    content: Uint8Array;
}>): Promise<StagedWorkspaceFileBlob> {
    const filePath = resolveStagedWorkspaceFileBlobPath(params);
    const markerFilePath = resolveWorkspaceStagingMarkerFilePath({ rootDirectory: params.stagingRoot.rootDirectory });
    const temporaryFilePath = `${filePath}.${process.pid}.tmp`;

    try {
        await access(markerFilePath);
    } catch {
        throw new Error(`Workspace staging root marker is missing for ${params.stagingRoot.rootDirectory}`);
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporaryFilePath, params.content, { mode: 0o600 });
    await rename(temporaryFilePath, filePath);

    return {
        digest: params.digest,
        filePath,
    };
}

export async function stageWorkspaceFileBlobFromFile(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    digest: string;
    sourceFilePath: string;
}>): Promise<StagedWorkspaceFileBlob> {
    const filePath = resolveStagedWorkspaceFileBlobPath(params);
    const markerFilePath = resolveWorkspaceStagingMarkerFilePath({ rootDirectory: params.stagingRoot.rootDirectory });
    const temporaryFilePath = `${filePath}.${process.pid}.tmp`;

    try {
        await access(markerFilePath);
    } catch {
        throw new Error(`Workspace staging root marker is missing for ${params.stagingRoot.rootDirectory}`);
    }

    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(params.sourceFilePath, temporaryFilePath);
    await rename(temporaryFilePath, filePath);

    return {
        digest: params.digest,
        filePath,
    };
}
