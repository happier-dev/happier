import type {
  SessionHandoffMetadataV2,
  SessionHandoffStartRequest,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import type {
  ExternalSessionOperationClaimMaintenance,
} from '@/session/external/operationExclusion';

import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import {
  createBufferTransferPayloadSource,
  createFileTransferPayloadSource,
  disposeTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from '../../../machines/transfer/transferPayloadSource';
import {
  buildSessionHandoffAgentBundleTransferId,
  type SessionHandoffAgentBundleTransferPublication,
} from '../../../session/handoff/agentBundle/transferPublication';
import { createSessionHandoffAgentBundlePayloadSource } from '../../../session/handoff/agentBundle/file';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

type PersistedAgentBundleFile = Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes: number;
  manifestHash: string;
  endpointCandidates?: readonly TransferEndpointCandidate[];
}>;

type SessionHandoffSourceExportStoreLike = Readonly<{
  writeAgentBundleFile: (params: Readonly<{
    handoffId: string;
    agentBundle: SessionHandoffAgentBundle;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<PersistedAgentBundleFile>;
  save: (record: Readonly<Omit<SessionHandoffSourceExportRecord, 't' | 'schemaVersion'>>) => Promise<void>;
}>;

export type DeferredDirectPeerPreExportedAgentBundle = Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
  agentBundlePayloadSource: TransferPayloadSource;
  agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublication;
}>;

export type DeferredDirectPeerStartResult = Readonly<{
  deferredStartEndpointCandidates: readonly TransferEndpointCandidate[];
  deferredStartWorkPromise: Promise<void> | null;
  preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
  deferredHandoffMetadataV2?: SessionHandoffMetadataV2;
}>;

export async function prepareDeferredDirectPeerStart(input: Readonly<{
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  hasServerRoutedFallback: boolean;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle;
  deferredHandoffMetadataV2?: SessionHandoffMetadataV2;
  sourceExportStore: SessionHandoffSourceExportStoreLike;
  waitForPersistedSourceExport: (
    handoffId: string,
    predicate: (record: SessionHandoffSourceExportRecord) => boolean,
  ) => Promise<SessionHandoffSourceExportRecord | null>;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{ agentBundle: SessionHandoffAgentBundle; targetPath: string }>>;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<unknown>;
  sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
  recordDeferredStartFailure: (error: unknown) => void;
  claimMaintenance: ExternalSessionOperationClaimMaintenance;
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
}>): Promise<DeferredDirectPeerStartResult> {
  let deferredStartEndpointCandidates: readonly TransferEndpointCandidate[] = [];
  let deferredStartWorkPromise: Promise<void> | null = null;
  let preExportedAgentBundle: DeferredDirectPeerPreExportedAgentBundle | undefined;

  if (input.hasServerRoutedFallback) {
    const agentBundleTransferId = buildSessionHandoffAgentBundleTransferId(input.handoffId);
    const agentBundleCarrierTransferId = `${agentBundleTransferId}:deferred-carrier`;
    const agentBundleCarrierPayloadSource = createBufferTransferPayloadSource(Buffer.from('{}', 'utf8'));
    input.claimMaintenance.throwIfLost();
    const carrierCandidates = [
      ...await input.claimMaintenance.race(() => input.directPeerTransfer.publishTransfer({
        transferId: agentBundleCarrierTransferId,
        payload: {},
        payloadSource: agentBundleCarrierPayloadSource,
        onDemandScope: {
          allowTransferId: (transferId) => transferId === agentBundleTransferId,
          resolvePayloadSourceOnOpen: async () => {
            input.claimMaintenance.throwIfLost();
            const persisted = await input.claimMaintenance.race(() => input.waitForPersistedSourceExport(
              input.handoffId,
              (record) => Boolean(record.agentBundle),
            ));
            if (!persisted?.agentBundle) {
              throw new Error('Direct peer transfer not ready');
            }
            return createFileTransferPayloadSource({
              filePath: persisted.agentBundle.filePath,
              sizeBytes: persisted.agentBundle.sizeBytes,
              manifestHash: persisted.agentBundle.manifestHash,
            });
          },
        },
      })),
    ];
    const agentBundleEndpointCandidates = rewriteDirectPeerEndpointCandidatesForTransferId({
      endpointCandidates: carrierCandidates,
      transferId: agentBundleTransferId,
    });

    deferredStartEndpointCandidates = agentBundleEndpointCandidates;

    let exported: Awaited<ReturnType<typeof input.exportSessionBundle>>;
    let createdAgentBundlePayloadSource: TransferPayloadSource | null = null;
    try {
      input.claimMaintenance.throwIfLost();
      exported = await input.claimMaintenance.race(() => input.exportSessionBundle(input.metadata));
      createdAgentBundlePayloadSource = await input.claimMaintenance.race(
        () => createSessionHandoffAgentBundlePayloadSource(exported.agentBundle, input.onProgress),
      );
    } catch (error) {
      input.directPeerTransfer.clearPublishedTransfer(agentBundleCarrierTransferId);
      await disposeTransferPayloadSource(createdAgentBundlePayloadSource);
      throw error;
    }

    const agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublication = {
      transferId: agentBundleTransferId,
      sizeBytes: await resolveTransferPayloadSizeBytes(createdAgentBundlePayloadSource),
      manifestHash: await resolveTransferPayloadManifestHash(createdAgentBundlePayloadSource),
      endpointCandidates: agentBundleEndpointCandidates,
    };

    if (input.deferredHandoffMetadataV2) {
      input.deferredHandoffMetadataV2.agentBundleTransferPublication = agentBundleTransferPublication;
    }

    deferredStartWorkPromise = (async () => {
      try {
        input.claimMaintenance.throwIfLost();
        await input.claimMaintenance.race(async () => input.prepareStartedState({
          handoffId: input.handoffId,
          request: input.request,
          metadata: input.metadata,
          sourceStopState: input.sourceStopState,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          preExportedAgentBundle: {
            agentBundle: exported.agentBundle,
            targetPath: exported.targetPath,
            agentBundlePayloadSource: createdAgentBundlePayloadSource,
            agentBundleTransferPublication,
          },
        }));
      } catch (error) {
        await disposeTransferPayloadSource(createdAgentBundlePayloadSource);
        throw error;
      }
    })();
    void deferredStartWorkPromise.catch((error) => {
      input.directPeerTransfer.clearPublishedTransfer(agentBundleCarrierTransferId);
      input.recordDeferredStartFailure(error);
    });
  } else {
    input.claimMaintenance.throwIfLost();
    const exported = await input.claimMaintenance.race(() => input.exportSessionBundle(input.metadata));
    const persistedAgentBundle = await input.claimMaintenance.race(() => input.sourceExportStore.writeAgentBundleFile({
      handoffId: input.handoffId,
      agentBundle: exported.agentBundle,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    }));
    const agentBundlePayloadSource = createFileTransferPayloadSource({
      filePath: persistedAgentBundle.filePath,
      sizeBytes: persistedAgentBundle.sizeBytes,
      manifestHash: persistedAgentBundle.manifestHash,
    });
    const agentBundleTransferId = persistedAgentBundle.transferId;
    const agentBundleSizeBytes = persistedAgentBundle.sizeBytes;
    const agentBundleManifestHash = persistedAgentBundle.manifestHash;

    await input.claimMaintenance.race(() => input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: persistedAgentBundle,
    }));

    input.claimMaintenance.throwIfLost();
    const carrierCandidates = [
      ...await input.claimMaintenance.race(() => input.directPeerTransfer.publishTransfer({
        transferId: agentBundleTransferId,
        payload: {},
        payloadSource: agentBundlePayloadSource,
      })),
    ];

    preExportedAgentBundle = {
      agentBundle: exported.agentBundle,
      targetPath: exported.targetPath,
      agentBundlePayloadSource,
      agentBundleTransferPublication: {
        transferId: agentBundleTransferId,
        sizeBytes: agentBundleSizeBytes,
        manifestHash: agentBundleManifestHash,
        endpointCandidates: carrierCandidates,
      },
    };

    if (input.deferredHandoffMetadataV2) {
      input.deferredHandoffMetadataV2.agentBundleTransferPublication = preExportedAgentBundle.agentBundleTransferPublication;
    }

    await input.claimMaintenance.race(() => input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: {
        ...persistedAgentBundle,
        ...(carrierCandidates.length ? { endpointCandidates: [...carrierCandidates] } : {}),
      },
    }));

    deferredStartEndpointCandidates = carrierCandidates;
  }

  return {
    deferredStartEndpointCandidates,
    deferredStartWorkPromise,
    ...(preExportedAgentBundle ? { preExportedAgentBundle } : {}),
    ...(input.deferredHandoffMetadataV2 ? { deferredHandoffMetadataV2: input.deferredHandoffMetadataV2 } : {}),
  };
}
