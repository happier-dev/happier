import {
  createScmSourceControllerWorkspaceExportArtifacts,
  type ScmSourceControllerWorkspaceExportArtifacts,
} from '@/scm/sourceController/workspaceExportArtifacts';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import type { WorkspaceReplicationSourceOffer } from '../transport/createWorkspaceReplicationSourceOffer';

export type WorkspaceReplicationCasBackedImportArtifacts = Readonly<{
  workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
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
    workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
      manifest: input.sourceOffer.manifest,
      sourceControllerMetadata: input.sourceOffer.sourceControllerMetadata ?? null,
    }),
    blobProvider: {
      getBlobFilePath: (digest) => casStore.resolveBlobPath(digest),
    },
  };
}
