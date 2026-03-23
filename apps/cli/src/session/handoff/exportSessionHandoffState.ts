import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import type { SessionHandoffProviderBundle } from './types';
import type { SessionHandoffWorkspaceTransferInput } from './sessionHandoffWorkspaceTransferInput';

import { exportSessionHandoffProviderBundle } from './exportSessionHandoffProviderBundle';
import { buildSessionHandoffWorkspaceExportPayload } from './workspace/sessionHandoffWorkspaceArtifacts';

export async function exportSessionHandoffState(params: Readonly<{
  metadata: Record<string, unknown>;
  activeServerDir: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): Promise<Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  blobProvider?: WorkspaceExportBlobProvider;
}>> {
  const providerExport = await exportSessionHandoffProviderBundle({
    metadata: params.metadata,
    activeServerDir: params.activeServerDir,
  });
  const workspaceExport = await buildSessionHandoffWorkspaceExportPayload({
    activeServerDir: params.activeServerDir,
    sourcePath: providerExport.targetPath,
    workspaceTransfer: params.workspaceTransfer,
  });

  return {
    ...providerExport,
    ...(workspaceExport.workspaceExportArtifacts ? { workspaceExportArtifacts: workspaceExport.workspaceExportArtifacts } : {}),
    ...(workspaceExport.blobProvider ? { blobProvider: workspaceExport.blobProvider } : {}),
  };
}
