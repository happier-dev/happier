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
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import type { SessionHandoffProviderBundleTransferPublication } from '../../../session/handoff/providerBundle/transferPublication';
import type { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import type { DeferredDirectPeerPreExportedProviderBundle } from './startDeferredDirectPeer';

export type PrepareStartedStateCallInput = Readonly<{
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  sourceStopState: 'stopped' | 'already_inactive';
  preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
}>;

export type StoredHandoffState = Readonly<{
  status: SessionHandoffStatus;
  sourceMachineId?: string;
  targetMachineId?: string;
  providerBundlePayloadSource?: TransferPayloadSource;
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
  providerBundlePayloadSource?: TransferPayloadSource;
}>;

export async function prepareStartedState(input: Readonly<{
  callInput: PrepareStartedStateCallInput;
  activeServerDir: string;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{ providerBundle: SessionHandoffProviderBundle; targetPath: string }>>;
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
  let providerBundlePayloadSource: TransferPayloadSource | null =
    callInput.preExportedProviderBundle?.providerBundlePayloadSource ?? null;
  let providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication | null =
    callInput.preExportedProviderBundle?.providerBundleTransferPublication ?? null;

  try {
    const exported = callInput.preExportedProviderBundle
      ? {
          providerBundle: callInput.preExportedProviderBundle.providerBundle,
          targetPath: callInput.preExportedProviderBundle.targetPath,
        }
      : await input.exportSessionBundle(callInput.metadata);

    const persistedProviderBundle = await input.sourceExportStore.writeProviderBundleFile({
      handoffId: callInput.handoffId,
      providerBundle: exported.providerBundle,
    });

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      workspaceSourceRootPath: exported.targetPath,
      providerBundle: {
        ...persistedProviderBundle,
        ...(callInput.preExportedProviderBundle?.providerBundleTransferPublication?.endpointCandidates?.length
          ? { endpointCandidates: [...callInput.preExportedProviderBundle.providerBundleTransferPublication.endpointCandidates] }
          : {}),
      },
    });

    providerBundlePayloadSource =
      providerBundlePayloadSource ?? createFileTransferPayloadSource({
        filePath: persistedProviderBundle.filePath,
        sizeBytes: persistedProviderBundle.sizeBytes,
        manifestHash: persistedProviderBundle.manifestHash,
      });

    const providerBundleEndpointCandidates: TransferEndpointCandidate[] =
      callInput.request.negotiatedTransportStrategy === 'direct_peer' && input.directPeerTransfer
        ? (
            providerBundleTransferPublication?.endpointCandidates?.length
              ? [...providerBundleTransferPublication.endpointCandidates]
              : [...await input.directPeerTransfer.publishTransfer({
                  transferId: persistedProviderBundle.transferId,
                  payload: {},
                  payloadSource: providerBundlePayloadSource,
                })]
          )
        : [];

    providerBundleTransferPublication = {
      transferId: persistedProviderBundle.transferId,
      sizeBytes: persistedProviderBundle.sizeBytes,
      manifestHash: persistedProviderBundle.manifestHash,
      ...(providerBundleEndpointCandidates.length > 0
        ? { endpointCandidates: providerBundleEndpointCandidates }
        : {}),
    };

    const preparedWorkspaceTransfer = await input.workspaceReplicationAdapter.prepareSourceWorkspaceTransfer({
      handoffId: callInput.handoffId,
      activeServerDir: input.activeServerDir,
      negotiatedTransportStrategy: callInput.request.negotiatedTransportStrategy,
      workspaceTransfer: callInput.request.workspaceTransfer,
      directPeerTransfer: input.directPeerTransfer,
      sourceRootPath: exported.targetPath,
      providerBundleTransferPublication,
      sessionMetadata: callInput.metadata,
      providerBundle: exported.providerBundle,
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
      providerBundle: {
        ...persistedProviderBundle,
        ...(providerBundleTransferPublication.endpointCandidates?.length
          ? { endpointCandidates: [...providerBundleTransferPublication.endpointCandidates] }
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
      providerBundleTransferPublication || preparedWorkspaceTransfer.handoffMetadataV2
        ? {
            ...(providerBundleTransferPublication ? { providerBundleTransferPublication } : {}),
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
      endpointCandidates: providerBundleEndpointCandidates,
      ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
      nextState: {
        status,
        sourceMachineId: callInput.request.sourceMachineId,
        targetMachineId: callInput.request.targetMachineId,
        ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
        ...(preparedWorkspaceTransfer.workspaceReplicationMetadata
          ? { workspaceReplicationMetadata: preparedWorkspaceTransfer.workspaceReplicationMetadata }
          : {}),
        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
        workspaceTransfer: callInput.request.workspaceTransfer,
      },
    };
  } catch (error) {
    if (providerBundleTransferPublication?.endpointCandidates?.length) {
      input.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
    }
    await disposeTransferPayloadSource(providerBundlePayloadSource);
    throw error;
  }
}
