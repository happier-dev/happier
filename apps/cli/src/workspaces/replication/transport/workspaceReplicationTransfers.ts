import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  requestDirectPeerTransferToFile,
} from '@/machines/transfer/directPeerTransport';
import { resolveInMemoryTransferMaxBytes } from '@/machines/transfer/inMemoryTransferSizeLimit';
import type { TransferPayloadFileResult } from '@/machines/transfer/transferPayloadFileSink';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import {
  requestServerRoutedTransferToFile,
  type MachineTransferChannel,
} from '@/machines/transfer/serverRoutedTransport';

import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';
import { readWorkspaceReplicationSourceOfferFromFile } from './workspaceReplicationSourceOfferFileFormat';

type WorkspaceReplicationDirectPeerSourceOfferHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: WorkspaceReplicationSourceOffer;
  }>) => readonly TransferEndpointCandidate[];
}>;

type WorkspaceReplicationDirectPeerBlobPackHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
}>;

type WorkspaceReplicationTransfersDependencies = Readonly<{
  requestDirectPeerTransferToFile: typeof requestDirectPeerTransferToFile;
  requestServerRoutedTransferToFile: typeof requestServerRoutedTransferToFile;
  readWorkspaceReplicationSourceOfferFromFile: typeof readWorkspaceReplicationSourceOfferFromFile;
  resolveLegacyWholeBufferMaxBytes: () => number;
}>;

export type WorkspaceReplicationTransfers = Readonly<{
  publishDirectPeerSourceOffer: (input: Readonly<{
    transferId: string;
    sourceOffer: WorkspaceReplicationSourceOffer;
    directPeerTransfer?: WorkspaceReplicationDirectPeerSourceOfferHandle;
  }>) => readonly TransferEndpointCandidate[];
  requestDirectPeerSourceOffer: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>) => Promise<WorkspaceReplicationSourceOffer>;
  requestServerRoutedSourceOffer: (input: Readonly<{
    transferId: string;
    sourceMachineId: string;
    machineTransferChannel: MachineTransferChannel;
  }>) => Promise<WorkspaceReplicationSourceOffer>;
  publishDirectPeerBlobPack: (input: Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
    directPeerTransfer?: WorkspaceReplicationDirectPeerBlobPackHandle;
  }>) => readonly TransferEndpointCandidate[];
  requestDirectPeerBlobPackToFile: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
    openBody?: unknown;
  }>) => Promise<TransferPayloadFileResult>;
  requestServerRoutedBlobPackToFile: (input: Readonly<{
    transferId: string;
    sourceMachineId: string;
    machineTransferChannel: MachineTransferChannel;
    destinationPath: string;
  }>) => Promise<TransferPayloadFileResult>;
}>;

export function createWorkspaceReplicationTransfers(
  dependencies: Partial<WorkspaceReplicationTransfersDependencies> = {},
): WorkspaceReplicationTransfers {
  const requestDirectPeerTransferToFileImpl =
    dependencies.requestDirectPeerTransferToFile ?? requestDirectPeerTransferToFile;
  const requestServerRoutedTransferToFileImpl =
    dependencies.requestServerRoutedTransferToFile ?? requestServerRoutedTransferToFile;
  const requestDirectPeerBlobPackToFile =
    dependencies.requestDirectPeerTransferToFile ?? requestDirectPeerTransferToFile;
  const requestServerRoutedBlobPackToFile =
    dependencies.requestServerRoutedTransferToFile ?? requestServerRoutedTransferToFile;
  const readSourceOfferFromFileImpl =
    dependencies.readWorkspaceReplicationSourceOfferFromFile ?? readWorkspaceReplicationSourceOfferFromFile;
  const resolveLegacyWholeBufferMaxBytes =
    dependencies.resolveLegacyWholeBufferMaxBytes ?? (() => resolveInMemoryTransferMaxBytes());

  return {
    publishDirectPeerSourceOffer: (input) =>
      input.directPeerTransfer?.publishTransfer({
        transferId: input.transferId,
        payload: input.sourceOffer,
      }) ?? [],
    requestDirectPeerSourceOffer: async (input) =>
      await requestSourceOfferViaDirectPeer({
        transferId: input.transferId,
        endpointCandidates: input.endpointCandidates,
        requestDirectPeerTransferToFile: requestDirectPeerTransferToFileImpl,
        readSourceOfferFromFile: readSourceOfferFromFileImpl,
        legacyWholeBufferMaxBytes: resolveLegacyWholeBufferMaxBytes(),
      }),
    requestServerRoutedSourceOffer: async (input) =>
      await requestSourceOfferViaServerRouted({
        transferId: input.transferId,
        sourceMachineId: input.sourceMachineId,
        machineTransferChannel: input.machineTransferChannel,
        requestServerRoutedTransferToFile: requestServerRoutedTransferToFileImpl,
        readSourceOfferFromFile: readSourceOfferFromFileImpl,
        legacyWholeBufferMaxBytes: resolveLegacyWholeBufferMaxBytes(),
      }),
    publishDirectPeerBlobPack: (input) =>
      input.directPeerTransfer?.publishTransfer({
        transferId: input.transferId,
        payloadSource: input.payloadSource,
      }) ?? [],
    requestDirectPeerBlobPackToFile: async (input) =>
      await requestDirectPeerBlobPackToFile({
        transferId: input.transferId,
        endpointCandidates: input.endpointCandidates,
        destinationPath: input.destinationPath,
        ...(input.openBody !== undefined ? { openBody: input.openBody } : {}),
      }),
    requestServerRoutedBlobPackToFile: async (input) =>
      await requestServerRoutedBlobPackToFile({
        transferId: input.transferId,
        sourceMachineId: input.sourceMachineId,
        machineTransferChannel: input.machineTransferChannel,
        destinationPath: input.destinationPath,
      }),
  };
}

async function requestSourceOfferViaDirectPeer(input: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  requestDirectPeerTransferToFile: typeof requestDirectPeerTransferToFile;
  readSourceOfferFromFile: typeof readWorkspaceReplicationSourceOfferFromFile;
  legacyWholeBufferMaxBytes: number;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-source-offer-'));
  const destinationPath = join(temporaryDirectory, 'source-offer.txt');

  try {
    const received = await input.requestDirectPeerTransferToFile({
      transferId: input.transferId,
      endpointCandidates: input.endpointCandidates,
      destinationPath,
    });
    return await input.readSourceOfferFromFile({
      transferId: input.transferId,
      filePath: received.destinationPath,
      sizeBytes: received.sizeBytes,
      legacyWholeBufferMaxBytes: input.legacyWholeBufferMaxBytes,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function requestSourceOfferViaServerRouted(input: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: MachineTransferChannel;
  requestServerRoutedTransferToFile: typeof requestServerRoutedTransferToFile;
  readSourceOfferFromFile: typeof readWorkspaceReplicationSourceOfferFromFile;
  legacyWholeBufferMaxBytes: number;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-source-offer-'));
  const destinationPath = join(temporaryDirectory, 'source-offer.txt');

  try {
    const received = await input.requestServerRoutedTransferToFile({
      transferId: input.transferId,
      sourceMachineId: input.sourceMachineId,
      machineTransferChannel: input.machineTransferChannel,
      destinationPath,
    });
    return await input.readSourceOfferFromFile({
      transferId: input.transferId,
      filePath: received.destinationPath,
      sizeBytes: received.sizeBytes,
      legacyWholeBufferMaxBytes: input.legacyWholeBufferMaxBytes,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
