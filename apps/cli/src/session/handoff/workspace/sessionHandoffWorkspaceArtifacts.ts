import type { ScmBackendRegistry } from '@/scm/registry';
import { buildWorkspaceExportArtifactsWithBlobProviderFromSourceController } from '@/scm/sourceController';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createScmSourceControllerWorkspaceTransferRequest } from '@/scm/sourceController/workspaceTransfer';

import type { SessionHandoffWorkspaceTransferInput } from '../sessionHandoffWorkspaceTransferInput';
import { assertSupportedSessionHandoffWorkspaceTransferStrategy } from '../validateSessionHandoffWorkspaceTransferStrategy';

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
