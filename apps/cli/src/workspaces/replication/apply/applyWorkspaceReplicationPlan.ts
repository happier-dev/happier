import { rm } from 'node:fs/promises';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import { applyWorkspaceSyncArtifacts } from '@/scm/sourceController/applyWorkspaceSyncArtifacts';
import { prepareWorkspaceSyncTargetPath } from '@/scm/sourceController/prepareWorkspaceSyncTargetPath';
import { materializeWorkspaceExportArtifactsWithSourceController } from '@/scm/sourceController/workspaceExportMaterialization';
import type {
    ScmSourceControllerWorkspaceTransferConflictPolicy,
    ScmSourceControllerWorkspaceTransferStrategy,
} from '@/scm/sourceController/workspaceTransfer';
import { createWorkspaceSyncArtifactsFromManifest } from '@/scm/sourceController/workspaceSyncArtifacts';

import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

import { createWorkspaceReplicationCasBackedImportArtifacts } from './createWorkspaceReplicationCasBackedImportArtifacts';

export async function applyWorkspaceReplicationPlan(params: Readonly<{
    activeServerDir: string;
    sourceOffer: WorkspaceReplicationSourceOffer;
    targetPath: string;
    strategy: ScmSourceControllerWorkspaceTransferStrategy;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    currentTargetManifest?: WorkspaceManifest;
    registry?: ScmBackendRegistry;
    assertCanContinue?: () => Promise<void>;
}>): Promise<Readonly<{ targetPath: string }>> {
    const casBackedImportArtifacts = createWorkspaceReplicationCasBackedImportArtifacts({
        activeServerDir: params.activeServerDir,
        sourceOffer: params.sourceOffer,
    });

    if (params.strategy === 'sync_changes') {
        if (!params.currentTargetManifest) {
            throw new Error('Missing currentTargetManifest for sync_changes');
        }
        const preparedTarget = await prepareWorkspaceSyncTargetPath({
            targetPath: params.targetPath,
            conflictPolicy: params.conflictPolicy,
            siblingCopySuffixBase: 'replication',
        });

        try {
            const syncArtifacts = createWorkspaceSyncArtifactsFromManifest({
                currentManifest: params.currentTargetManifest,
                nextManifest: params.sourceOffer.manifest,
                sourceControllerMetadata: params.sourceOffer.sourceControllerMetadata ?? null,
            });

            return await applyWorkspaceSyncArtifacts({
                targetPath: preparedTarget.resolvedTargetPath,
                syncArtifacts,
                blobProvider: casBackedImportArtifacts.blobProvider,
                registry: params.registry,
                assertCanContinue: params.assertCanContinue,
            });
        } catch (error) {
            if (preparedTarget.cleanupOnFailure) {
                await rm(preparedTarget.resolvedTargetPath, { recursive: true, force: true }).catch(() => undefined);
            }
            throw error;
        }
    }

    return await materializeWorkspaceExportArtifactsWithSourceController({
        workspaceExportArtifacts: casBackedImportArtifacts.workspaceExportArtifacts,
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        blobProvider: casBackedImportArtifacts.blobProvider,
        registry: params.registry,
        assertCanContinue: params.assertCanContinue,
        naming: {
            siblingCopySuffixBase: 'replication',
            backupDirectoryPrefix: 'workspace-replication-backup',
            stagingIdPrefix: 'workspace-replication',
        },
    });
}
