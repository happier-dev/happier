import type {
  SessionHandoffMetadataV2,
  SessionHandoffStartRequest,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import type {
  ExternalSessionOperationClaimMaintenance,
} from '@/session/external/operationExclusion';

import type { DirectPeerOnDemandTransferScope } from '../../../machines/transfer/directPeerTransport';
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
import { assertSafeHandoffWorkspaceReplicationPackId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/assertSafePackId';
import {
  createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope,
  parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/directPeer';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';

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
  activeServerDir: string;
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
    const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId: input.handoffId });

    let cachedWorkspaceScope: DirectPeerOnDemandTransferScope | null = null;
    input.claimMaintenance.throwIfLost();
    const carrierCandidates = [
      ...await input.claimMaintenance.race(() => input.directPeerTransfer.publishTransfer({
        transferId: agentBundleCarrierTransferId,
        payload: {},
        payloadSource: agentBundleCarrierPayloadSource,
        onDemandScope: {
          allowTransferId: (transferId) => {
            if (transferId === agentBundleTransferId || transferId === manifestTransferId) {
              return true;
            }
            const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
            if (!parsed || parsed.handoffId !== input.handoffId) {
              return false;
            }
            try {
              assertSafeHandoffWorkspaceReplicationPackId(parsed.packId);
            } catch {
              return false;
            }
            return true;
          },
          resolvePayloadSourceOnOpen: async ({ transferId, requestBody }) => {
            input.claimMaintenance.throwIfLost();
            if (transferId === agentBundleTransferId) {
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
            }

            if (!cachedWorkspaceScope) {
              const persisted = await input.claimMaintenance.race(() => input.waitForPersistedSourceExport(
                input.handoffId,
                (record) => Boolean(record.workspaceManifest),
              ));
              if (!persisted?.workspaceManifest) {
                throw new Error('Direct peer transfer not ready');
              }
              const workspaceManifest = persisted.workspaceManifest;

              const manifest = await input.claimMaintenance.race(() => readWorkspaceReplicationManifestFromFile({
                transferId: workspaceManifest.transferId,
                filePath: workspaceManifest.filePath,
                sizeBytes: workspaceManifest.sizeBytes,
              }));

              const workspaceSourceRootPath = persisted.workspaceSourceRootPath;
              if (!workspaceSourceRootPath) {
                throw new Error('Direct peer transfer not ready');
              }

              cachedWorkspaceScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
                handoffId: input.handoffId,
                activeServerDir: input.activeServerDir,
                sourceRootPath: workspaceSourceRootPath,
                manifest,
              });
            }
            return await input.claimMaintenance.race(() => cachedWorkspaceScope!.resolvePayloadSourceOnOpen({
              transferId,
              requestBody,
            }));
          },
        },
      })),
    ];
    const agentBundleEndpointCandidates = rewriteDirectPeerEndpointCandidatesForTransferId({
      endpointCandidates: carrierCandidates,
      transferId: agentBundleTransferId,
    });

    const manifestEndpointCandidates =
      input.request.workspaceTransfer?.enabled === true
        ? rewriteDirectPeerEndpointCandidatesForTransferId({
          endpointCandidates: agentBundleEndpointCandidates,
          transferId: manifestTransferId,
        })
        : undefined;
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
      if (manifestEndpointCandidates?.length) {
        input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication = {
          ...(input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication ?? { transferId: manifestTransferId }),
          endpointCandidates: manifestEndpointCandidates,
        };
      }
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
    const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId: input.handoffId });

    await input.claimMaintenance.race(() => input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      workspaceSourceRootPath: exported.targetPath,
      agentBundle: persistedAgentBundle,
    }));

    let cachedWorkspaceScope: DirectPeerOnDemandTransferScope | null = null;
    input.claimMaintenance.throwIfLost();
    const carrierCandidates = [
      ...await input.claimMaintenance.race(() => input.directPeerTransfer.publishTransfer({
        transferId: agentBundleTransferId,
        payload: {},
        payloadSource: agentBundlePayloadSource,
        onDemandScope: {
          allowTransferId: (transferId) => {
            if (transferId === manifestTransferId) {
              return true;
            }
            const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
            if (!parsed || parsed.handoffId !== input.handoffId) {
              return false;
            }
            try {
              assertSafeHandoffWorkspaceReplicationPackId(parsed.packId);
            } catch {
              return false;
            }
            return true;
          },
          resolvePayloadSourceOnOpen: async ({ transferId, requestBody }) => {
            input.claimMaintenance.throwIfLost();
            if (!cachedWorkspaceScope) {
              const persisted = await input.claimMaintenance.race(() => input.waitForPersistedSourceExport(
                input.handoffId,
                (record) => Boolean(record.workspaceManifest),
              ));
              if (!persisted?.workspaceManifest) {
                throw new Error('Direct peer transfer not ready');
              }
              const workspaceManifest = persisted.workspaceManifest;

              const manifest = await input.claimMaintenance.race(() => readWorkspaceReplicationManifestFromFile({
                transferId: workspaceManifest.transferId,
                filePath: workspaceManifest.filePath,
                sizeBytes: workspaceManifest.sizeBytes,
              }));

              const workspaceSourceRootPath = persisted.workspaceSourceRootPath;
              if (!workspaceSourceRootPath) {
                throw new Error('Direct peer transfer not ready');
              }

              cachedWorkspaceScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
                handoffId: input.handoffId,
                activeServerDir: input.activeServerDir,
                sourceRootPath: workspaceSourceRootPath,
                manifest,
              });
            }
            return await input.claimMaintenance.race(() => cachedWorkspaceScope!.resolvePayloadSourceOnOpen({
              transferId,
              requestBody,
            }));
          },
        },
      })),
    ];

    const manifestEndpointCandidates =
      input.request.workspaceTransfer?.enabled === true
        ? rewriteDirectPeerEndpointCandidatesForTransferId({
          endpointCandidates: carrierCandidates,
          transferId: manifestTransferId,
        })
        : undefined;

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
      if (manifestEndpointCandidates?.length) {
        input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication = {
          ...(input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication ?? { transferId: manifestTransferId }),
          endpointCandidates: manifestEndpointCandidates,
        };
      }
    }

    await input.claimMaintenance.race(() => input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      workspaceSourceRootPath: exported.targetPath,
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
