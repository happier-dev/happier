import { cp, lstat, mkdir, rm } from 'node:fs/promises';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import {
  buildWorkspaceExportArtifactsWithSourceController,
  reconcilePostMaterializationWithSourceController,
} from '@/scm/sourceController';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { materializeWorkspaceExportArtifactsWithSourceController } from '@/scm/sourceController/workspaceExportMaterialization';
import { resolveWorkspaceMaterializationTargetPath } from '@/scm/sourceController/workspaceMaterializationTargetPath';
import { createScmSourceControllerWorkspaceTransferRequest } from '@/scm/sourceController/workspaceTransfer';
import type { SessionHandoffWorkspaceTransferInput } from '../sessionHandoffWorkspaceTransferInput';
import { assertSupportedSessionHandoffWorkspaceTransferStrategy } from '../validateSessionHandoffWorkspaceTransferStrategy';
import { applySessionHandoffWorkspaceSyncArtifacts } from '../workspaceSync/applySessionHandoffWorkspaceSyncArtifacts';
import { createSessionHandoffWorkspaceSyncArtifacts } from '../workspaceSync/createSessionHandoffWorkspaceSyncArtifacts';

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function readCurrentSyncScopeManifestOrEmpty(params: Readonly<{
  targetPath: string;
  workspaceTransfer: SessionHandoffWorkspaceTransferInput;
  registry?: ScmBackendRegistry;
}>): Promise<WorkspaceManifest> {
  if (!(await pathExists(params.targetPath))) {
    return { entries: [] };
  }

  const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourceController({
    sourcePath: params.targetPath,
    workspaceTransfer: createScmSourceControllerWorkspaceTransferRequest(params.workspaceTransfer),
    registry: params.registry,
  });

  return {
    entries: workspaceExportArtifacts.manifest.entries.map((entry) => ({ ...entry })),
    fingerprint: workspaceExportArtifacts.manifest.fingerprint,
  };
}

async function prepareSyncChangesTargetPath(params: Readonly<{
  targetPath: string;
  workspaceTransfer: SessionHandoffWorkspaceTransferInput;
}>): Promise<Readonly<{
  resolvedTargetPath: string;
  cleanupOnFailure: boolean;
  previousTargetPath?: string;
}>> {
  const resolvedTargetPath = await resolveWorkspaceMaterializationTargetPath({
    targetPath: params.targetPath,
    conflictPolicy: params.workspaceTransfer.conflictPolicy,
    naming: {
      siblingCopySuffixBase: 'handoff',
    },
  });

  if (resolvedTargetPath === params.targetPath) {
    return {
      resolvedTargetPath,
      cleanupOnFailure: false,
    };
  }

  if (!(await pathExists(params.targetPath))) {
    return {
      resolvedTargetPath,
      cleanupOnFailure: false,
    };
  }

  await cp(params.targetPath, resolvedTargetPath, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });

  return {
    resolvedTargetPath,
    cleanupOnFailure: true,
    previousTargetPath: params.targetPath,
  };
}

export async function buildSessionHandoffWorkspaceExportArtifacts(params: Readonly<{
  sourcePath: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
  registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceExportArtifacts | undefined> {
  if (!params.workspaceTransfer?.enabled) return undefined;
  assertSupportedSessionHandoffWorkspaceTransferStrategy({
    workspaceTransfer: params.workspaceTransfer,
  });
  return await buildWorkspaceExportArtifactsWithSourceController({
    sourcePath: params.sourcePath,
    workspaceTransfer: createScmSourceControllerWorkspaceTransferRequest(params.workspaceTransfer),
    registry: params.registry,
  });
}

export async function importSessionHandoffWorkspaceArtifacts(params: Readonly<{
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  targetPath: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
  registry?: ScmBackendRegistry;
}>): Promise<Readonly<{ targetPath: string }>> {
  if (!params.workspaceExportArtifacts || !params.workspaceTransfer?.enabled) {
    return { targetPath: params.targetPath };
  }
  assertSupportedSessionHandoffWorkspaceTransferStrategy({
    workspaceTransfer: params.workspaceTransfer,
  });

  if (params.workspaceTransfer.strategy === 'sync_changes') {
    const preparedTarget = await prepareSyncChangesTargetPath({
      targetPath: params.targetPath,
      workspaceTransfer: params.workspaceTransfer,
    });

    try {
      const currentManifest = await readCurrentSyncScopeManifestOrEmpty({
        targetPath: preparedTarget.resolvedTargetPath,
        workspaceTransfer: params.workspaceTransfer,
        registry: params.registry,
      });
      const syncArtifacts = createSessionHandoffWorkspaceSyncArtifacts({
        currentManifest,
        workspaceExportArtifacts: params.workspaceExportArtifacts,
      });
      const imported = await applySessionHandoffWorkspaceSyncArtifacts({
        targetPath: preparedTarget.resolvedTargetPath,
        syncArtifacts,
        registry: params.registry,
      });
      await reconcilePostMaterializationWithSourceController({
        targetPath: imported.targetPath,
        previousTargetPath: preparedTarget.previousTargetPath,
        sourceControllerMetadata: params.workspaceExportArtifacts.sourceControllerMetadata,
        registry: params.registry,
      });
      return imported;
    } catch (error) {
      if (preparedTarget.cleanupOnFailure) {
        await rm(preparedTarget.resolvedTargetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  return await materializeWorkspaceExportArtifactsWithSourceController({
    workspaceExportArtifacts: params.workspaceExportArtifacts,
    targetPath: params.targetPath,
    conflictPolicy: params.workspaceTransfer.conflictPolicy,
    registry: params.registry,
    naming: {
      siblingCopySuffixBase: 'handoff',
      backupDirectoryPrefix: 'session-handoff-backup',
      stagingIdPrefix: 'session-handoff',
    },
  });
}
