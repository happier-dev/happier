import type { ScmBackendRegistry } from '@/scm/registry';
import type { WorkspaceManifestSafeFilterPolicy } from '@/scm/sourceController/workspaceExportPackaging/workspaceManifestSafeFilterPolicy';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import { scanWorkspaceManifestWithDigestCache } from './scanWorkspaceManifestWithDigestCache';

export async function scanWorkspaceManifestIntoCas(params: Readonly<{
  activeServerDir: string;
  relationshipId: string;
  workspaceRoot: string;
  safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
  scmRegistry?: ScmBackendRegistry;
}>) {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: params.activeServerDir,
  });

  return await scanWorkspaceManifestWithDigestCache({
    activeServerDir: params.activeServerDir,
    relationshipId: params.relationshipId,
    workspaceRoot: params.workspaceRoot,
    safeFilterPolicy: params.safeFilterPolicy,
    scmRegistry: params.scmRegistry,
    async onFileScanned(file) {
      if (await casStore.contains(file.digest)) {
        return;
      }
      await casStore.commitFile({
        digest: file.digest,
        sourcePath: file.filePath,
      });
    },
  });
}
