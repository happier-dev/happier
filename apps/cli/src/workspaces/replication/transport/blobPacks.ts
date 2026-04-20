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

function compareBlobIndexesByDigest(
  leftIndex: number,
  rightIndex: number,
  blobs: readonly WorkspaceReplicationSourceOfferBlob[],
): number {
  return compareBlobsByDigest(blobs[leftIndex], blobs[rightIndex]);
}

function createSortedBlobIndexes(blobs: readonly WorkspaceReplicationSourceOfferBlob[]): number[] {
  return blobs.map((_, index) => index).sort((leftIndex, rightIndex) => compareBlobIndexesByDigest(leftIndex, rightIndex, blobs));
}

function createBlobPack(digests: readonly string[], totalBytes: number): WorkspaceReplicationBlobPack {
  return {
    packId: createWorkspaceReplicationPackIdForDigests(digests),
    digests,
    totalBytes,
  };
}

function countBlobPackPartitions(sortedBlobIndexes: readonly number[], input: Readonly<{
  blobs: readonly WorkspaceReplicationSourceOfferBlob[];
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): number {
  let packCount = 0;
  let currentPackBlobs = 0;
  let currentPackBytes = 0;

  const flushCurrentPack = (): void => {
    if (currentPackBlobs === 0) {
      return;
    }
    packCount += 1;
    currentPackBlobs = 0;
    currentPackBytes = 0;
  };

  for (const blobIndex of sortedBlobIndexes) {
    const blob = input.blobs[blobIndex];
    const blobSizeBytes = blob.sizeBytes;
    if (blobSizeBytes > input.blobPackMaxSingleBlobBytes) {
      throw new Error(`Workspace replication blob exceeds max single-blob bytes: ${blob.digest}`);
    }

    const exceedsTargetBytes = currentPackBytes + blobSizeBytes > input.blobPackTargetBytes;
    const exceedsMaxBlobs = currentPackBlobs >= input.blobPackMaxBlobs;
    if (currentPackBlobs > 0 && (exceedsTargetBytes || exceedsMaxBlobs)) {
      flushCurrentPack();
    }

    if (blobSizeBytes > input.blobPackTargetBytes) {
      packCount += 1;
      continue;
    }

    currentPackBlobs += 1;
    currentPackBytes += blobSizeBytes;
  }

  flushCurrentPack();

  return packCount;
}

export function countWorkspaceReplicationBlobPacks(input: Readonly<{
  blobs: readonly WorkspaceReplicationSourceOfferBlob[];
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): number {
  const sortedBlobIndexes = createSortedBlobIndexes(input.blobs);
  return countBlobPackPartitions(sortedBlobIndexes, input);
}

export function buildWorkspaceReplicationBlobPacks(input: Readonly<{
  blobs: readonly WorkspaceReplicationSourceOfferBlob[];
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): readonly WorkspaceReplicationBlobPack[] {
  const packs: WorkspaceReplicationBlobPack[] = [];
  const sortedBlobIndexes = createSortedBlobIndexes(input.blobs);
  let currentPackDigests: string[] = [];
  let currentPackBytes = 0;

  const flushCurrentPack = (): void => {
    if (currentPackDigests.length === 0) {
      return;
    }
    packs.push(createBlobPack(currentPackDigests, currentPackBytes));
    currentPackDigests = [];
    currentPackBytes = 0;
  };

  for (const blobIndex of sortedBlobIndexes) {
    const blob = input.blobs[blobIndex];
    const blobSizeBytes = blob.sizeBytes;
    if (blobSizeBytes > input.blobPackMaxSingleBlobBytes) {
      throw new Error(`Workspace replication blob exceeds max single-blob bytes: ${blob.digest}`);
    }

    const exceedsTargetBytes = currentPackBytes + blobSizeBytes > input.blobPackTargetBytes;
    const exceedsMaxBlobs = currentPackDigests.length >= input.blobPackMaxBlobs;
    if (currentPackDigests.length > 0 && (exceedsTargetBytes || exceedsMaxBlobs)) {
      flushCurrentPack();
    }

    if (blobSizeBytes > input.blobPackTargetBytes) {
      packs.push(createBlobPack([blob.digest], blobSizeBytes));
      continue;
    }

    currentPackDigests.push(blob.digest);
    currentPackBytes += blobSizeBytes;
  }

  flushCurrentPack();

  return packs;
}
