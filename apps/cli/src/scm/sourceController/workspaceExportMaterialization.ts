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
import { stageWorkspaceEntries } from './workspaceExportStaging/stageWorkspaceEntries';
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
    registry?: ScmBackendRegistry;
    sourcePath?: string;
    naming: WorkspaceExportMaterializationNaming;
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
            blobContentsByDigest: params.workspaceExportArtifacts.blobContentsByDigest,
        });
        if (!staged.verification.isVerified) {
            throw new Error(`Workspace transfer integrity check failed for ${targetPath}`);
        }

        const previousTargetPath = await promoteMaterializedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory: targetPath,
            conflictPolicy: params.conflictPolicy,
            expectedManifest: params.workspaceExportArtifacts.manifest,
            naming: params.naming,
        });
        await reconcilePostMaterializationWithSourceController({
            targetPath,
            previousTargetPath,
            sourcePath: params.sourcePath,
            sourceControllerMetadata: params.workspaceExportArtifacts.sourceControllerMetadata,
            registry: params.registry,
        });
        if (previousTargetPath) {
            await rm(previousTargetPath, { recursive: true, force: true });
        }
    } catch (error) {
        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);
        throw error;
    }

    await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);

    return { targetPath };
}
