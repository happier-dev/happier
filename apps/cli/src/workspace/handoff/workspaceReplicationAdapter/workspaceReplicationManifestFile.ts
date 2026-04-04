import type { WorkspaceManifest } from '@happier-dev/protocol';

import {
    readWorkspaceReplicationManifestFromFile as readWorkspaceReplicationManifestFromFileImpl,
    writeWorkspaceReplicationManifestToFile as writeWorkspaceReplicationManifestToFileImpl,
} from '@/workspaces/replication/transport/workspaceReplicationManifestTransferV1';

export async function readWorkspaceReplicationManifestFromFile(input: Readonly<{
    transferId: string;
    filePath: string;
    sizeBytes?: number;
}>): Promise<WorkspaceManifest> {
    return await readWorkspaceReplicationManifestFromFileImpl({
        transferId: input.transferId,
        filePath: input.filePath,
        ...(typeof input.sizeBytes === 'number' ? { sizeBytes: input.sizeBytes } : {}),
    });
}

export async function writeWorkspaceReplicationManifestToFile(input: Readonly<{
    filePath: string;
    manifest: Parameters<typeof writeWorkspaceReplicationManifestToFileImpl>[0]['manifest'];
}>): Promise<Awaited<ReturnType<typeof writeWorkspaceReplicationManifestToFileImpl>>> {
    return await writeWorkspaceReplicationManifestToFileImpl({
        filePath: input.filePath,
        manifest: input.manifest,
    });
}
