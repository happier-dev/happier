import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import {
  requestDirectPeerTransferToFile,
  requestTypedDirectPeerTransferPayload,
} from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadFileResult } from '@/machines/transfer/transferPayloadFileSink';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import {
  requestServerRoutedTransferToFile,
  requestTypedServerRoutedTransferPayload,
  type MachineTransferChannel,
} from '@/machines/transfer/serverRoutedTransport';

import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';
import { workspaceReplicationSourceOfferCodec } from './workspaceReplicationSourceOfferCodec';

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
  requestTypedDirectPeerTransferPayload: typeof requestTypedDirectPeerTransferPayload<WorkspaceReplicationSourceOffer>;
  requestTypedServerRoutedTransferPayload: typeof requestTypedServerRoutedTransferPayload<WorkspaceReplicationSourceOffer>;
  requestDirectPeerTransferToFile: typeof requestDirectPeerTransferToFile;
  requestServerRoutedTransferToFile: typeof requestServerRoutedTransferToFile;
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
  const requestDirectPeerSourceOfferPayload =
    dependencies.requestTypedDirectPeerTransferPayload ?? requestTypedDirectPeerTransferPayload;
  const requestServerRoutedSourceOfferPayload =
    dependencies.requestTypedServerRoutedTransferPayload ?? requestTypedServerRoutedTransferPayload;
  const requestDirectPeerBlobPackToFile =
    dependencies.requestDirectPeerTransferToFile ?? requestDirectPeerTransferToFile;
  const requestServerRoutedBlobPackToFile =
    dependencies.requestServerRoutedTransferToFile ?? requestServerRoutedTransferToFile;

  return {
    publishDirectPeerSourceOffer: (input) =>
      input.directPeerTransfer?.publishTransfer({
        transferId: input.transferId,
        payload: input.sourceOffer,
      }) ?? [],
    requestDirectPeerSourceOffer: async (input) =>
      await requestDirectPeerSourceOfferPayload({
        transferId: input.transferId,
        endpointCandidates: input.endpointCandidates,
        codec: workspaceReplicationSourceOfferCodec,
      }),
    requestServerRoutedSourceOffer: async (input) =>
      await requestServerRoutedSourceOfferPayload({
        transferId: input.transferId,
        sourceMachineId: input.sourceMachineId,
        machineTransferChannel: input.machineTransferChannel,
        codec: workspaceReplicationSourceOfferCodec,
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
