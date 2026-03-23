import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import type { MachineTransferStrategy } from '@/machines/transfer/types';
import {
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';
import type { MachineTransferChannel } from '@/machines/transfer/serverRoutedTransport';

import type { ReceiveWorkspaceReplicationBlobPackResult } from './receiveWorkspaceReplicationBlobPack';
import { receiveWorkspaceReplicationBlobPack } from './receiveWorkspaceReplicationBlobPack';
import { createWorkspaceReplicationBlobPackPayloadSource } from './createWorkspaceReplicationBlobPackPayloadSource';
import type { WorkspaceReplicationBlobPack } from './buildWorkspaceReplicationBlobPacks';
import type { WorkspaceReplicationTransfers } from './workspaceReplicationTransfers';

type WorkspaceReplicationDirectPeerBlobPackHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
}>;

export type SendWorkspaceReplicationBlobPacksResult = Readonly<{
  packResults: readonly (Readonly<{
    packId: string;
  }> & ReceiveWorkspaceReplicationBlobPackResult)[];
  transferredPackCount: number;
  receivedDigests: readonly string[];
  committedDigests: readonly string[];
  transferredBlobs: number;
  transferredBytes: number;
}>;

function buildWorkspaceReplicationBlobPackTransferId(input: Readonly<{
  jobId: string;
  packId: string;
}>): string {
  return `workspace-replication:${input.jobId}:${input.packId}`;
}

async function requestWorkspaceReplicationBlobPackFile(input: Readonly<{
  transferId: string;
  sourceMachineId: string;
  negotiatedTransportStrategy: MachineTransferStrategy;
  destinationPath: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  transfers: WorkspaceReplicationTransfers;
  machineTransferChannel?: MachineTransferChannel;
}>): Promise<void> {
  if (input.negotiatedTransportStrategy === 'direct_peer') {
    await input.transfers.requestDirectPeerBlobPackToFile({
      transferId: input.transferId,
      endpointCandidates: input.endpointCandidates,
      destinationPath: input.destinationPath,
    });
    return;
  }

  if (!input.machineTransferChannel) {
    throw new Error('Workspace replication server-routed blob-pack transfer requires a machine transfer channel');
  }

  await input.transfers.requestServerRoutedBlobPackToFile({
    transferId: input.transferId,
    sourceMachineId: input.sourceMachineId,
    machineTransferChannel: input.machineTransferChannel,
    destinationPath: input.destinationPath,
  });
}

export async function sendWorkspaceReplicationBlobPacks(input: Readonly<{
  sourceActiveServerDir: string;
  targetActiveServerDir: string;
  jobId: string;
  sourceMachineId: string;
  negotiatedTransportStrategy: MachineTransferStrategy;
  packs: readonly WorkspaceReplicationBlobPack[];
  transfers: WorkspaceReplicationTransfers;
  maxSingleBlobBytes: number;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: WorkspaceReplicationDirectPeerBlobPackHandle;
}>): Promise<SendWorkspaceReplicationBlobPacksResult> {
  const packResults: Array<Readonly<{ packId: string }> & ReceiveWorkspaceReplicationBlobPackResult> = [];
  const allReceivedDigests: string[] = [];
  const allCommittedDigests: string[] = [];
  let transferredBlobs = 0;
  let transferredBytes = 0;

  for (const pack of input.packs) {
    const transferId = buildWorkspaceReplicationBlobPackTransferId({
      jobId: input.jobId,
      packId: pack.packId,
    });
    const payloadSource = await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.sourceActiveServerDir,
      packId: pack.packId,
      digests: pack.digests,
    });
    const endpointCandidates = input.transfers.publishDirectPeerBlobPack({
      transferId,
      payloadSource,
      directPeerTransfer: input.directPeerTransfer,
    });
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-replication-send-packs-'));
    const destinationPath = join(temporaryDirectory, `${pack.packId}.bin`);

    try {
      await requestWorkspaceReplicationBlobPackFile({
        transferId,
        sourceMachineId: input.sourceMachineId,
        negotiatedTransportStrategy: input.negotiatedTransportStrategy,
        destinationPath,
        endpointCandidates,
        transfers: input.transfers,
        machineTransferChannel: input.machineTransferChannel,
      });

      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir: input.targetActiveServerDir,
        jobId: input.jobId,
        packId: pack.packId,
        packFilePath: destinationPath,
        maxSingleBlobBytes: input.maxSingleBlobBytes,
      });

      packResults.push({
        packId: pack.packId,
        ...result,
      });
      allReceivedDigests.push(...result.receivedDigests);
      allCommittedDigests.push(...result.committedDigests);
      transferredBlobs += result.transferredBlobs;
      transferredBytes += result.transferredBytes;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      await disposeTransferPayloadSource(payloadSource).catch(() => undefined);
    }
  }

  return {
    packResults,
    transferredPackCount: packResults.length,
    receivedDigests: allReceivedDigests,
    committedDigests: allCommittedDigests,
    transferredBlobs,
    transferredBytes,
  };
}
