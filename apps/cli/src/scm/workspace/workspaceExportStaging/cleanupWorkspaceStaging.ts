import { access, rm } from 'node:fs/promises';

import { resolveWorkspaceStagingMarkerFilePath } from './createWorkspaceStagingRoot';

export async function cleanupWorkspaceStaging(params: Readonly<{ rootDirectory: string }>): Promise<void> {
    const markerFilePath = resolveWorkspaceStagingMarkerFilePath({ rootDirectory: params.rootDirectory });

    try {
        await access(markerFilePath);
    } catch {
        throw new Error(`Workspace staging root marker is missing for ${params.rootDirectory}`);
    }

    await rm(params.rootDirectory, { recursive: true, force: true });
}
