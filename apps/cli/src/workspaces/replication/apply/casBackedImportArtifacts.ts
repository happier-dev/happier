import {
  createScmWorkspaceIntegrationWorkspaceExportArtifacts,
  type ScmWorkspaceIntegrationWorkspaceExportArtifacts,
} from '@/scm/workspace/workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from '@/scm/workspace/workspaceExportStaging/stageWorkspaceEntries';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

export type WorkspaceReplicationCasBackedImportArtifacts = Readonly<{
  workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
  blobProvider: WorkspaceExportBlobProvider;
}>;

export function createWorkspaceReplicationCasBackedImportArtifacts(input: Readonly<{
  activeServerDir: string;
  sourceOffer: WorkspaceReplicationSourceOffer;
}>): WorkspaceReplicationCasBackedImportArtifacts {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });

  return {
    workspaceExportArtifacts: createScmWorkspaceIntegrationWorkspaceExportArtifacts({
      manifest: input.sourceOffer.manifest,
      workspaceIntegrationMetadata: input.sourceOffer.workspaceIntegrationMetadata ?? null,
    }),
    blobProvider: {
      getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
    },
  };
}
