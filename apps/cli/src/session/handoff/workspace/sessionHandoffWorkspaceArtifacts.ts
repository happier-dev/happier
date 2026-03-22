import { lstat, mkdir, rm } from 'node:fs/promises';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { ScmBackendRegistry } from '@/scm/registry';
import {
  buildWorkspaceExportArtifactsWithBlobProviderFromSourceController,
  buildWorkspaceExportArtifactsWithSourceController,
  reconcilePostMaterializationWithSourceController,
} from '@/scm/sourceController';
import { applyWorkspaceSyncArtifacts } from '@/scm/sourceController/applyWorkspaceSyncArtifacts';
import { prepareWorkspaceSyncTargetPath } from '@/scm/sourceController/prepareWorkspaceSyncTargetPath';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { materializeWorkspaceExportArtifactsWithSourceController } from '@/scm/sourceController/workspaceExportMaterialization';
import {
  createWorkspaceSyncArtifacts,
  createWorkspaceSyncArtifactsFromManifest,
} from '@/scm/sourceController/workspaceSyncArtifacts';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createScmSourceControllerWorkspaceTransferRequest } from '@/scm/sourceController/workspaceTransfer';
import type { SessionHandoffWorkspaceTransferInput } from '../sessionHandoffWorkspaceTransferInput';
import { assertSupportedSessionHandoffWorkspaceTransferStrategy } from '../validateSessionHandoffWorkspaceTransferStrategy';

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
  return await prepareWorkspaceSyncTargetPath({
    targetPath: params.targetPath,
    conflictPolicy: params.workspaceTransfer.conflictPolicy,
    siblingCopySuffixBase: 'handoff',
  });
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

export async function buildSessionHandoffWorkspaceExportPayload(params: Readonly<{
  activeServerDir: string;
  sourcePath: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
  registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  blobProvider?: WorkspaceExportBlobProvider;
}>> {
  if (!params.workspaceTransfer?.enabled) {
    return {};
  }
  assertSupportedSessionHandoffWorkspaceTransferStrategy({
    workspaceTransfer: params.workspaceTransfer,
  });

  return await buildWorkspaceExportArtifactsWithBlobProviderFromSourceController({
    activeServerDir: params.activeServerDir,
    sourcePath: params.sourcePath,
    workspaceTransfer: createScmSourceControllerWorkspaceTransferRequest(params.workspaceTransfer),
    registry: params.registry,
  });
}

export async function importSessionHandoffWorkspaceArtifacts(params: Readonly<{
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  targetPath: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
  blobProvider?: WorkspaceExportBlobProvider;
  registry?: ScmBackendRegistry;
  assertCanContinue?: () => Promise<void>;
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
      const syncArtifacts =
        params.blobProvider && params.workspaceExportArtifacts.blobContentsByDigest.size === 0
          ? createWorkspaceSyncArtifactsFromManifest({
            currentManifest,
            nextManifest: params.workspaceExportArtifacts.manifest,
            sourceControllerMetadata: params.workspaceExportArtifacts.sourceControllerMetadata ?? null,
          })
          : createWorkspaceSyncArtifacts({
            currentManifest,
            workspaceExportArtifacts: params.workspaceExportArtifacts,
          });
      const imported = await applyWorkspaceSyncArtifacts({
        targetPath: preparedTarget.resolvedTargetPath,
        syncArtifacts,
        blobProvider: params.blobProvider,
        registry: params.registry,
        assertCanContinue: params.assertCanContinue,
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
    blobProvider: params.blobProvider,
    registry: params.registry,
    assertCanContinue: params.assertCanContinue,
    naming: {
      siblingCopySuffixBase: 'handoff',
      backupDirectoryPrefix: 'session-handoff-backup',
      stagingIdPrefix: 'session-handoff',
    },
  });
}
