import type {
  SessionHandoffMetadataV2,
  SessionHandoffStartRequest,
  SessionHandoffStatus,
  SessionHandoffWorkspaceTransfer,
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
import {
  createSessionHandoffWorkspaceReplicationAdapter,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';

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
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export type PrepareStartedStateResult = Readonly<{
  targetPath: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  nextState: StoredHandoffState;
  agentBundlePayloadSource?: TransferPayloadSource;
}>;

export async function prepareStartedState(input: Readonly<{
  callInput: PrepareStartedStateCallInput;
  activeServerDir: string;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{ agentBundle: SessionHandoffAgentBundle; targetPath: string }>>;
  sourceExportStore: ReturnType<typeof createSessionHandoffSourceExportStore>;
  workspaceReplicationAdapter: ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  resolveWorkspaceReplicationHandoffBackTargetRootPath: (input: Readonly<{
    metadata: Record<string, unknown>;
    workspaceTransfer: SessionHandoffStartRequest['workspaceTransfer'] | undefined;
    requestedTargetMachineId: string;
  }>) => string | null;
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
      workspaceSourceRootPath: exported.targetPath,
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

    const preparedWorkspaceTransfer = await input.workspaceReplicationAdapter.prepareSourceWorkspaceTransfer({
      handoffId: callInput.handoffId,
      activeServerDir: input.activeServerDir,
      negotiatedTransportStrategy: callInput.request.negotiatedTransportStrategy,
      workspaceTransfer: callInput.request.workspaceTransfer,
      directPeerTransfer: input.directPeerTransfer,
      sourceRootPath: exported.targetPath,
      agentBundleTransferPublication,
      sessionMetadata: callInput.metadata,
      agentBundle: exported.agentBundle,
    });

    const workspaceReplicationMetadata = preparedWorkspaceTransfer.workspaceReplicationMetadata;
    const workspaceTransferEnabled = callInput.request.workspaceTransfer?.enabled === true;
    const persistedWorkspaceManifest =
      workspaceTransferEnabled && workspaceReplicationMetadata
        ? await input.sourceExportStore.writeWorkspaceReplicationManifestFile({
            handoffId: callInput.handoffId,
            manifest: workspaceReplicationMetadata.manifest,
          })
        : undefined;

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      ...(workspaceReplicationMetadata?.sourceRootPath
        ? { workspaceSourceRootPath: workspaceReplicationMetadata.sourceRootPath }
        : { workspaceSourceRootPath: exported.targetPath }),
      agentBundle: {
        ...persistedAgentBundle,
        ...(agentBundleTransferPublication.endpointCandidates?.length
          ? { endpointCandidates: [...agentBundleTransferPublication.endpointCandidates] }
          : {}),
      },
      ...(persistedWorkspaceManifest
        ? {
            workspaceManifest: {
              ...persistedWorkspaceManifest,
              ...(preparedWorkspaceTransfer.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates?.length
                ? {
                    endpointCandidates: [
                      ...preparedWorkspaceTransfer.handoffMetadataV2.workspaceReplicationManifestTransferPublication.endpointCandidates,
                    ],
                  }
                : {}),
            },
          }
        : {}),
    });

    const workspaceReplicationHandoffBackTargetRootPathForRequest =
      input.resolveWorkspaceReplicationHandoffBackTargetRootPath({
        metadata: callInput.metadata,
        workspaceTransfer: callInput.request.workspaceTransfer,
        requestedTargetMachineId: callInput.request.targetMachineId,
      }) ?? undefined;

    const handoffMetadataV2: SessionHandoffMetadataV2 | undefined =
      agentBundleTransferPublication || preparedWorkspaceTransfer.handoffMetadataV2
        ? {
            ...(agentBundleTransferPublication ? { agentBundleTransferPublication } : {}),
            ...(preparedWorkspaceTransfer.handoffMetadataV2?.workspaceReplicationSourceRootPath
              ? { workspaceReplicationSourceRootPath: preparedWorkspaceTransfer.handoffMetadataV2.workspaceReplicationSourceRootPath }
              : { workspaceReplicationSourceRootPath: exported.targetPath }),
            ...(workspaceReplicationHandoffBackTargetRootPathForRequest
              ? { workspaceReplicationHandoffBackTargetRootPath: workspaceReplicationHandoffBackTargetRootPathForRequest }
              : {}),
            ...(preparedWorkspaceTransfer.handoffMetadataV2?.workspaceReplicationManifestTransferPublication
              ? { workspaceReplicationManifestTransferPublication: preparedWorkspaceTransfer.handoffMetadataV2.workspaceReplicationManifestTransferPublication }
              : (workspaceTransferEnabled
                  ? { workspaceReplicationManifestTransferPublication: { transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId: callInput.handoffId }) } }
                  : {})),
            ...(workspaceReplicationMetadata?.workspaceIntegrationMetadata
              ? { workspaceReplicationSourceControllerMetadata: workspaceReplicationMetadata.workspaceIntegrationMetadata }
              : {}),
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
        ...(preparedWorkspaceTransfer.workspaceReplicationMetadata
          ? { workspaceReplicationMetadata: preparedWorkspaceTransfer.workspaceReplicationMetadata }
          : {}),
        ...(agentBundlePayloadSource ? { agentBundlePayloadSource } : {}),
        workspaceTransfer: callInput.request.workspaceTransfer,
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
