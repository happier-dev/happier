import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmWorkspaceIntegrationWorkspaceExportArtifacts } from '@/scm/workspace/workspaceExportArtifacts';
import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from '@/scm/workspace/workspaceTransfer';
import {
    createWorkspaceReplicationSourceOfferFromManifest,
    type WorkspaceReplicationSourceOffer,
} from '@/workspaces/replication/transport/createWorkspaceReplicationSourceOffer';

export type SessionHandoffWorkspaceReplicationMetadata = Readonly<{
    sourceRootPath: string;
    manifest: WorkspaceManifest;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
}>;

function cloneWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
    return {
        entries: manifest.entries.map((entry) => ({ ...entry })),
        ...(manifest.fingerprint ? { fingerprint: manifest.fingerprint } : {}),
    };
}

export function createSessionHandoffWorkspaceReplicationMetadata(input: Readonly<{
    sourceRootPath: string;
    workspaceExportArtifacts?: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
}>): SessionHandoffWorkspaceReplicationMetadata | undefined {
    if (!input.workspaceExportArtifacts) {
        return undefined;
    }

    return {
        sourceRootPath: input.sourceRootPath,
        manifest: cloneWorkspaceManifest(input.workspaceExportArtifacts.manifest),
        ...(input.workspaceExportArtifacts.workspaceIntegrationMetadata
            ? { workspaceIntegrationMetadata: input.workspaceExportArtifacts.workspaceIntegrationMetadata }
            : {}),
    };
}

export async function buildSessionHandoffWorkspaceReplicationSourceOffer(input: Readonly<{
    activeServerDir: string;
    sourceMachineId: string;
    targetMachineId: string;
    targetPath: string;
    metadata: SessionHandoffWorkspaceReplicationMetadata;
}>): Promise<WorkspaceReplicationSourceOffer> {
    return await createWorkspaceReplicationSourceOfferFromManifest({
        activeServerDir: input.activeServerDir,
        source: {
            machineId: input.sourceMachineId,
            rootPath: input.metadata.sourceRootPath,
        },
        target: {
            machineId: input.targetMachineId,
            rootPath: input.targetPath,
        },
        mode: 'one_way_safe',
        manifest: input.metadata.manifest,
        ...(input.metadata.workspaceIntegrationMetadata
            ? { workspaceIntegrationMetadata: input.metadata.workspaceIntegrationMetadata }
            : {}),
    });
}
