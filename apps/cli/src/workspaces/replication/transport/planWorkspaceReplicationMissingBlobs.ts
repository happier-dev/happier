import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';

import type { WorkspaceReplicationSourceOfferBlob } from './createWorkspaceReplicationSourceOffer';

export type WorkspaceReplicationMissingBlobPlan = Readonly<{
  missingBlobs: readonly WorkspaceReplicationSourceOfferBlob[];
  plannedFileCount: number;
  plannedByteCount: number;
  alreadyPresentFileCount: number;
  alreadyPresentByteCount: number;
}>;

export async function planWorkspaceReplicationMissingBlobs(input: Readonly<{
  activeServerDir: string;
  blobIndex: readonly WorkspaceReplicationSourceOfferBlob[];
}>): Promise<WorkspaceReplicationMissingBlobPlan> {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const missingBlobs: WorkspaceReplicationSourceOfferBlob[] = [];
  let alreadyPresentFileCount = 0;
  let alreadyPresentByteCount = 0;
  const seenDigests = new Set<string>();

  for (const blob of input.blobIndex) {
    if (seenDigests.has(blob.digest)) {
      continue;
    }
    seenDigests.add(blob.digest);
    if (await casStore.contains(blob.digest)) {
      alreadyPresentFileCount += 1;
      alreadyPresentByteCount += blob.sizeBytes;
      continue;
    }
    missingBlobs.push(blob);
  }

  return {
    missingBlobs,
    plannedFileCount: missingBlobs.length,
    plannedByteCount: missingBlobs.reduce((total, blob) => total + blob.sizeBytes, 0),
    alreadyPresentFileCount,
    alreadyPresentByteCount,
  };
}
