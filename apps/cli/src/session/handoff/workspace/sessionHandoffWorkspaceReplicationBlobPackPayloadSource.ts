import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { createWorkspaceReplicationBlobPackPayloadSource } from '@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource';
import { seedWorkspaceReplicationCasBlobsFromManifest } from '@/workspaces/replication/transport/seedWorkspaceReplicationCasBlobsFromManifest';
import { WorkspaceReplicationError } from '@/workspaces/replication/workspaceReplicationError';

export async function createSessionHandoffWorkspaceReplicationBlobPackPayloadSource(input: Readonly<{
  activeServerDir: string;
  packId: string;
  digests: readonly string[];
  sourceRootPath?: string;
  manifest?: WorkspaceManifest;
}>): Promise<TransferPayloadSource> {
  try {
    return await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId: input.packId,
      digests: input.digests,
    });
  } catch (error) {
    if (!(error instanceof WorkspaceReplicationError) || error.code !== 'missing_cas_blob') {
      throw error;
    }

    if (!input.sourceRootPath || !input.manifest) {
      throw new Error(
        `${error.message} (sourceRootPath/manifest unavailable; cannot seed workspace replication CAS)`,
      );
    }

    await seedWorkspaceReplicationCasBlobsFromManifest({
      activeServerDir: input.activeServerDir,
      sourceRootPath: input.sourceRootPath,
      manifest: input.manifest,
      digests: input.digests,
    });

    return await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId: input.packId,
      digests: input.digests,
    });
  }
}
