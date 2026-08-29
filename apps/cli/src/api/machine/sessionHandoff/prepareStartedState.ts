import type {
  SessionHandoffMetadataV2,
  SessionHandoffStartRequest,
  SessionHandoffStatus,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

import {
  createFileTransferPayloadSource,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from '../../../machines/transfer/transferPayloadSource';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import type { SessionHandoffAgentBundleTransferPublication } from '../../../session/handoff/agentBundle/transferPublication';
import type { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import type { DeferredDirectPeerPreExportedAgentBundle } from './startDeferredDirectPeer';

export type PrepareStartedStateCallInput = Readonly<{
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  sourceStopState: 'stopped' | 'already_inactive';
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
}>;

export type StoredHandoffState = Readonly<{
  status: SessionHandoffStatus;
  sourceMachineId?: string;
  targetMachineId?: string;
  agentBundlePayloadSource?: TransferPayloadSource;
  directPeerPayloadSources?: readonly Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>[];
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>;

export type PrepareStartedStateResult = Readonly<{
  targetPath: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  nextState: StoredHandoffState;
  agentBundlePayloadSource?: TransferPayloadSource;
}>;

export async function prepareStartedState(input: Readonly<{
  callInput: PrepareStartedStateCallInput;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{ agentBundle: SessionHandoffAgentBundle; targetPath: string }>>;
  sourceExportStore: ReturnType<typeof createSessionHandoffSourceExportStore>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
}>): Promise<PrepareStartedStateResult> {
  const { callInput } = input;
  let agentBundlePayloadSource: TransferPayloadSource | null =
    callInput.preExportedAgentBundle?.agentBundlePayloadSource ?? null;
  let agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublication | null =
    callInput.preExportedAgentBundle?.agentBundleTransferPublication ?? null;

  try {
    const exported = callInput.preExportedAgentBundle
      ? {
          agentBundle: callInput.preExportedAgentBundle.agentBundle,
          targetPath: callInput.preExportedAgentBundle.targetPath,
        }
      : await input.exportSessionBundle(callInput.metadata);

    const persistedAgentBundle = await input.sourceExportStore.writeAgentBundleFile({
      handoffId: callInput.handoffId,
      agentBundle: exported.agentBundle,
      ...(callInput.onProgress ? { onProgress: callInput.onProgress } : {}),
    });

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: {
        ...persistedAgentBundle,
        ...(callInput.preExportedAgentBundle?.agentBundleTransferPublication?.endpointCandidates?.length
          ? { endpointCandidates: [...callInput.preExportedAgentBundle.agentBundleTransferPublication.endpointCandidates] }
          : {}),
      },
    });

    agentBundlePayloadSource =
      agentBundlePayloadSource ?? createFileTransferPayloadSource({
        filePath: persistedAgentBundle.filePath,
        sizeBytes: persistedAgentBundle.sizeBytes,
        manifestHash: persistedAgentBundle.manifestHash,
      });

    const agentBundleEndpointCandidates: TransferEndpointCandidate[] =
      callInput.request.negotiatedTransportStrategy === 'direct_peer' && input.directPeerTransfer
        ? (
            agentBundleTransferPublication?.endpointCandidates?.length
              ? [...agentBundleTransferPublication.endpointCandidates]
              : [...await input.directPeerTransfer.publishTransfer({
                  transferId: persistedAgentBundle.transferId,
                  payload: {},
                  payloadSource: agentBundlePayloadSource,
                })]
          )
        : [];

    agentBundleTransferPublication = {
      transferId: persistedAgentBundle.transferId,
      sizeBytes: persistedAgentBundle.sizeBytes,
      manifestHash: persistedAgentBundle.manifestHash,
      ...(agentBundleEndpointCandidates.length > 0
        ? { endpointCandidates: agentBundleEndpointCandidates }
        : {}),
    };

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: {
        ...persistedAgentBundle,
        ...(agentBundleTransferPublication.endpointCandidates?.length
          ? { endpointCandidates: [...agentBundleTransferPublication.endpointCandidates] }
          : {}),
      },
    });

    const handoffMetadataV2: SessionHandoffMetadataV2 | undefined =
      agentBundleTransferPublication
        ? {
            ...(agentBundleTransferPublication ? { agentBundleTransferPublication } : {}),
          }
        : undefined;

    const status = input.buildStartPendingStatus({
      handoffId: callInput.handoffId,
      sourceStopState: callInput.sourceStopState,
    });

    return {
      targetPath: exported.targetPath,
      endpointCandidates: agentBundleEndpointCandidates,
      ...(agentBundlePayloadSource ? { agentBundlePayloadSource } : {}),
      nextState: {
        status,
        sourceMachineId: callInput.request.sourceMachineId,
        targetMachineId: callInput.request.targetMachineId,
        ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
        ...(agentBundlePayloadSource ? { agentBundlePayloadSource } : {}),
      },
    };
  } catch (error) {
    if (agentBundleTransferPublication?.endpointCandidates?.length) {
      input.directPeerTransfer?.clearPublishedTransfer(agentBundleTransferPublication.transferId);
    }
    await disposeTransferPayloadSource(agentBundlePayloadSource);
    throw error;
  }
}
