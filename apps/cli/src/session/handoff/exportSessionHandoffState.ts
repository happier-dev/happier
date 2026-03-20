import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import type { SessionHandoffProviderBundle } from './types';
import type { SessionHandoffWorkspaceTransferInput } from './sessionHandoffWorkspaceTransferInput';

import { exportSessionHandoffProviderBundle } from './exportSessionHandoffProviderBundle';
import { buildSessionHandoffWorkspaceExportArtifacts } from './workspace/sessionHandoffWorkspaceArtifacts';

export async function exportSessionHandoffState(params: Readonly<{
  metadata: Record<string, unknown>;
  activeServerDir: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): Promise<Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>> {
  const providerExport = await exportSessionHandoffProviderBundle({
    metadata: params.metadata,
    activeServerDir: params.activeServerDir,
  });
  const workspaceExportArtifacts = await buildSessionHandoffWorkspaceExportArtifacts({
    sourcePath: providerExport.targetPath,
    workspaceTransfer: params.workspaceTransfer,
  });

  return {
    ...providerExport,
    ...(workspaceExportArtifacts ? { workspaceExportArtifacts } : {}),
  };
}
