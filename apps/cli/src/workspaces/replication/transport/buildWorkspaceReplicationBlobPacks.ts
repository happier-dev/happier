import type { WorkspaceReplicationSourceOfferBlob } from './createWorkspaceReplicationSourceOffer';
import { createWorkspaceReplicationPackIdForDigests } from './workspaceReplicationPackId';

export type WorkspaceReplicationBlobPack = Readonly<{
  packId: string;
  digests: readonly string[];
  totalBytes: number;
}>;

function compareBlobsByDigest(left: WorkspaceReplicationSourceOfferBlob, right: WorkspaceReplicationSourceOfferBlob): number {
  return left.digest.localeCompare(right.digest);
}

function createBlobPack(blobs: readonly WorkspaceReplicationSourceOfferBlob[]): WorkspaceReplicationBlobPack {
  const digests = blobs.map((blob) => blob.digest);
  return {
    packId: createWorkspaceReplicationPackIdForDigests(digests),
    digests,
    totalBytes: blobs.reduce((total, blob) => total + blob.sizeBytes, 0),
  };
}

export function buildWorkspaceReplicationBlobPacks(input: Readonly<{
  blobs: readonly WorkspaceReplicationSourceOfferBlob[];
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): readonly WorkspaceReplicationBlobPack[] {
  const sortedBlobs = [...input.blobs].sort(compareBlobsByDigest);
  const packs: WorkspaceReplicationBlobPack[] = [];
  let currentPackBlobs: WorkspaceReplicationSourceOfferBlob[] = [];
  let currentPackBytes = 0;

  const flushCurrentPack = (): void => {
    if (currentPackBlobs.length === 0) {
      return;
    }
    packs.push(createBlobPack(currentPackBlobs));
    currentPackBlobs = [];
    currentPackBytes = 0;
  };

  for (const blob of sortedBlobs) {
    if (blob.sizeBytes > input.blobPackMaxSingleBlobBytes) {
      throw new Error(`Workspace replication blob exceeds max single-blob bytes: ${blob.digest}`);
    }

    const exceedsTargetBytes = currentPackBytes + blob.sizeBytes > input.blobPackTargetBytes;
    const exceedsMaxBlobs = currentPackBlobs.length >= input.blobPackMaxBlobs;
    if (currentPackBlobs.length > 0 && (exceedsTargetBytes || exceedsMaxBlobs)) {
      flushCurrentPack();
    }

    if (blob.sizeBytes > input.blobPackTargetBytes) {
      packs.push(createBlobPack([blob]));
      continue;
    }

    currentPackBlobs.push(blob);
    currentPackBytes += blob.sizeBytes;
  }

  flushCurrentPack();

  return packs;
}
