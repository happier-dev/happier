import { randomUUID } from 'node:crypto';
import { access, rename, rm } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

import type { ScmBackendRegistry } from '../registry';
import { cleanupWorkspaceStaging } from './workspaceExportStaging/cleanupWorkspaceStaging';
import {
    createWorkspaceStagingRoot,
    type WorkspaceStagingRoot,
} from './workspaceExportStaging/createWorkspaceStagingRoot';
import { promoteStagedWorkspace } from './workspaceExportStaging/promoteStagedWorkspace';
import {
    stageWorkspaceEntries,
    type WorkspaceExportBlobProvider,
} from './workspaceExportStaging/stageWorkspaceEntries';
import {
    assertWorkspaceMaterializationSymlinkTarget,
    resolveContainedWorkspaceMaterializationPath,
} from './workspaceMaterializationSafety';
import { resolveWorkspaceMaterializationTargetPath } from './workspaceMaterializationTargetPath';

import {
    assertPortableWorkspaceEntriesWithSourceController,
    reconcilePostMaterializationWithSourceController,
} from '../sourceController';
import type { ScmSourceControllerWorkspaceExportArtifacts } from './workspaceExportArtifacts';
import type { ScmSourceControllerWorkspaceTransferConflictPolicy } from './workspaceTransfer';

export type WorkspaceExportMaterializationNaming = Readonly<{
    siblingCopySuffixBase: string;
    backupDirectoryPrefix: string;
    stagingIdPrefix: string;
}>;

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function resolveWorkspaceExportMaterializationTargetPath(params: Readonly<{
    targetPath: string;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    naming: WorkspaceExportMaterializationNaming;
}>): Promise<string> {
    return await resolveWorkspaceMaterializationTargetPath(params);
}

async function promoteMaterializedWorkspace(params: Readonly<{
    stagingRoot: WorkspaceStagingRoot;
    targetWorkspaceDirectory: string;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    expectedManifest: ScmSourceControllerWorkspaceExportArtifacts['manifest'];
    naming: WorkspaceExportMaterializationNaming;
}>): Promise<string | undefined> {
    if (params.conflictPolicy !== 'replace_existing' || !(await pathExists(params.targetWorkspaceDirectory))) {
        await promoteStagedWorkspace({
            stagingRoot: params.stagingRoot,
            targetWorkspaceDirectory: params.targetWorkspaceDirectory,
            expectedManifest: params.expectedManifest,
        });
        return undefined;
    }

    const backupDirectory = join(
        dirname(params.targetWorkspaceDirectory),
        `${params.naming.backupDirectoryPrefix}.${randomUUID()}`,
    );
    await rename(params.targetWorkspaceDirectory, backupDirectory);

    try {
        await promoteStagedWorkspace({
            stagingRoot: params.stagingRoot,
            targetWorkspaceDirectory: params.targetWorkspaceDirectory,
            expectedManifest: params.expectedManifest,
        });
        return backupDirectory;
    } catch (error) {
        if (!(await pathExists(params.targetWorkspaceDirectory)) && (await pathExists(backupDirectory))) {
            await rename(backupDirectory, params.targetWorkspaceDirectory);
        }
        throw error;
    }
}

export async function materializeWorkspaceExportArtifactsWithSourceController(params: Readonly<{
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
    targetPath: string;
    conflictPolicy: ScmSourceControllerWorkspaceTransferConflictPolicy;
    blobProvider: WorkspaceExportBlobProvider;
    registry?: ScmBackendRegistry;
    sourcePath?: string;
    naming: WorkspaceExportMaterializationNaming;
    assertCanContinue?: () => Promise<void>;
}>): Promise<Readonly<{ targetPath: string }>> {
    const targetPath = await resolveWorkspaceExportMaterializationTargetPath({
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        naming: params.naming,
    });
    await assertPortableWorkspaceEntriesWithSourceController({
        entries: params.workspaceExportArtifacts.manifest.entries,
        registry: params.registry,
    });

    const stagingRoot = await createWorkspaceStagingRoot({
        parentDirectory: dirname(targetPath),
        stagingId: `${params.naming.stagingIdPrefix}-${randomUUID()}`,
    });

    let previousTargetPath: string | undefined;
    let didPromoteTarget = false;
    try {
        for (const entry of params.workspaceExportArtifacts.manifest.entries) {
            const materializedEntryPath = resolveContainedWorkspaceMaterializationPath({
                workspaceRoot: stagingRoot.workspaceDirectory,
                candidatePath: entry.relativePath,
                errorMessage: `Workspace transfer path escapes target: ${entry.relativePath}`,
            });
            if (entry.kind !== 'symlink') continue;
            assertWorkspaceMaterializationSymlinkTarget({
                workspaceRoot: stagingRoot.workspaceDirectory,
                linkPath: materializedEntryPath,
                target: entry.target,
            });
        }

        const staged = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: params.workspaceExportArtifacts.manifest,
            blobProvider: params.blobProvider,
            assertCanContinue: params.assertCanContinue,
        });
        if (!staged.verification.isVerified) {
            throw new Error(`Workspace transfer integrity check failed for ${targetPath}`);
        }

        await params.assertCanContinue?.();

        previousTargetPath = await promoteMaterializedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory: targetPath,
            conflictPolicy: params.conflictPolicy,
            expectedManifest: params.workspaceExportArtifacts.manifest,
            naming: params.naming,
        });
        didPromoteTarget = true;

        await params.assertCanContinue?.();
        await reconcilePostMaterializationWithSourceController({
            targetPath,
            previousTargetPath,
            sourcePath: params.sourcePath,
            sourceControllerMetadata: params.workspaceExportArtifacts.sourceControllerMetadata,
            registry: params.registry,
        });
        await params.assertCanContinue?.();
        if (previousTargetPath) {
            await rm(previousTargetPath, { recursive: true, force: true });
        }
    } catch (error) {
        if (didPromoteTarget) {
            if (previousTargetPath) {
                await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
                if (await pathExists(previousTargetPath)) {
                    await rename(previousTargetPath, targetPath).catch(() => undefined);
                }
            } else {
                await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
            }
        }
        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);
        throw error;
    }

    await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);

    return { targetPath };
}
