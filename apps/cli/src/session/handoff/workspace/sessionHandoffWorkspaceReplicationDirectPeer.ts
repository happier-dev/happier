import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TransferEndpointCandidate, WorkspaceManifest } from '@happier-dev/protocol';

import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { planWorkspaceReplicationMissingBlobs } from '@/workspaces/replication/transport/planWorkspaceReplicationMissingBlobs';
import { receiveWorkspaceReplicationBlobPack } from '@/workspaces/replication/transport/receiveWorkspaceReplicationBlobPack';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';

import { createSessionHandoffTransferredBundles } from '../transfer/sessionHandoffTransferredBundles';

import {
  buildSessionHandoffWorkspaceReplicationSourceOffer,
  type SessionHandoffWorkspaceReplicationMetadata,
} from './sessionHandoffWorkspaceReplicationMetadata';
import {
  buildSessionHandoffWorkspaceBlobPackTransferId,
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
} from './sessionHandoffWorkspaceReplicationServerRouted';

type DirectPeerTransferPublisher = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: ReturnType<typeof createSessionHandoffTransferredBundles>;
    payloadSource?: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
}>;

export type SessionHandoffWorkspaceReplicationDirectPeerBlobPackPublication = Readonly<{
  transferId: string;
  packId: string;
  digests: readonly [string];
  endpointCandidates: readonly TransferEndpointCandidate[];
}>;

export type SessionHandoffWorkspaceReplicationDirectPeerPublication = Readonly<{
  blobPacks: readonly SessionHandoffWorkspaceReplicationDirectPeerBlobPackPublication[];
}>;

export type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers = Readonly<{
  publication: SessionHandoffWorkspaceReplicationDirectPeerPublication;
  payloadSources: readonly Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>[];
}>;

function collectUniqueManifestDigests(manifest: WorkspaceManifest): readonly string[] {
  const uniqueDigests = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file') {
      continue;
    }
    uniqueDigests.add(entry.digest);
  }
  return [...uniqueDigests];
}

export async function publishSessionHandoffWorkspaceReplicationDirectPeerTransfers(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  manifest: WorkspaceManifest;
  directPeerTransfer: DirectPeerTransferPublisher;
  blobProvider?: WorkspaceExportBlobProvider;
  workspaceExportArtifacts?: Readonly<{
    blobContentsByDigest: ReadonlyMap<string, Uint8Array>;
  }>;
}>): Promise<PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers> {
  const payloadSources: Array<Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>> = [];
  const blobPacks: SessionHandoffWorkspaceReplicationDirectPeerBlobPackPublication[] = [];
  let blobIndex = 0;

  for (const digest of collectUniqueManifestDigests(input.manifest)) {
    blobIndex += 1;
    const packId = `blob_${blobIndex}`;
    const transferId = buildSessionHandoffWorkspaceBlobPackTransferId({
      handoffId: input.handoffId,
      packId,
      digests: [digest],
    });
    const payloadSource = await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId,
      digests: [digest],
      blobProvider: input.blobProvider,
      workspaceExportArtifacts: input.workspaceExportArtifacts,
    });
    const endpointCandidates = input.directPeerTransfer.publishTransfer({
      transferId,
      payload: createSessionHandoffTransferredBundles({}),
      payloadSource,
    });
    payloadSources.push({
      transferId,
      payloadSource,
    });
    blobPacks.push({
      transferId,
      packId,
      digests: [digest],
      endpointCandidates,
    });
  }

  return {
    publication: {
      blobPacks,
    },
    payloadSources,
  };
}

export async function receiveDirectPeerSessionHandoffWorkspaceReplication(input: Readonly<{
  activeServerDir: string;
  handoffId: string;
  sourceMachineId: string;
  targetMachineId: string;
  targetPath: string;
  metadata: SessionHandoffWorkspaceReplicationMetadata;
  directPeerPublication: SessionHandoffWorkspaceReplicationDirectPeerPublication;
  transfers: WorkspaceReplicationTransfers;
  maxSingleBlobBytes: number;
}>): Promise<Readonly<{
  sourceOffer: Awaited<ReturnType<typeof buildSessionHandoffWorkspaceReplicationSourceOffer>>;
  transferredPackCount: number;
  transferredBytes: number;
  transferredBlobs: number;
}>> {
  const sourceOffer = await buildSessionHandoffWorkspaceReplicationSourceOffer({
    activeServerDir: input.activeServerDir,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    targetPath: input.targetPath,
    metadata: input.metadata,
  });
  const missingBlobPlan = await planWorkspaceReplicationMissingBlobs({
    activeServerDir: input.activeServerDir,
    blobIndex: sourceOffer.blobIndex,
  });
  const publicationByDigest = new Map<string, SessionHandoffWorkspaceReplicationDirectPeerBlobPackPublication>();
  for (const publication of input.directPeerPublication.blobPacks) {
    publicationByDigest.set(publication.digests[0], publication);
  }

  let transferredPackCount = 0;
  let transferredBytes = 0;
  let transferredBlobs = 0;

  for (const missingBlob of missingBlobPlan.missingBlobs) {
    const publication = publicationByDigest.get(missingBlob.digest);
    if (!publication) {
      throw new Error(`Missing direct-peer workspace replication blob publication for ${missingBlob.digest}`);
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-session-handoff-workspace-direct-peer-pack-'));
    const destinationPath = join(temporaryDirectory, `${publication.packId}.bin`);

    try {
      await input.transfers.requestDirectPeerBlobPackToFile({
        transferId: publication.transferId,
        endpointCandidates: publication.endpointCandidates,
        destinationPath,
      });
      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir: input.activeServerDir,
        jobId: input.handoffId,
        packId: publication.packId,
        packFilePath: destinationPath,
        maxSingleBlobBytes: input.maxSingleBlobBytes,
      });
      transferredPackCount += 1;
      transferredBytes += result.transferredBytes;
      transferredBlobs += result.transferredBlobs;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    sourceOffer,
    transferredPackCount,
    transferredBytes,
    transferredBlobs,
  };
}
