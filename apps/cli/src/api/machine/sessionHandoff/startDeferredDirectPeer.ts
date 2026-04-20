import { configuration } from '@/configuration';
import type {
  SessionHandoffMetadataV2,
  SessionHandoffStartRequest,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

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
  buildSessionHandoffProviderBundleTransferId,
  type SessionHandoffProviderBundleTransferPublication,
} from '../../../session/handoff/providerBundle/transferPublication';
import { createSessionHandoffProviderBundlePayloadSource } from '../../../session/handoff/providerBundle/file';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import { assertSafeHandoffWorkspaceReplicationPackId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/assertSafePackId';
import {
  createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope,
  parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/directPeer';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

type PersistedProviderBundleFile = Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes: number;
  manifestHash: string;
  endpointCandidates?: readonly TransferEndpointCandidate[];
}>;

type SessionHandoffSourceExportStoreLike = Readonly<{
  writeProviderBundleFile: (params: Readonly<{
    handoffId: string;
    providerBundle: SessionHandoffProviderBundle;
  }>) => Promise<PersistedProviderBundleFile>;
  save: (record: Readonly<Omit<SessionHandoffSourceExportRecord, 't' | 'schemaVersion'>>) => Promise<void>;
}>;

export type DeferredDirectPeerPreExportedProviderBundle = Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
  providerBundlePayloadSource: TransferPayloadSource;
  providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication;
}>;

export type DeferredDirectPeerStartResult = Readonly<{
  deferredStartEndpointCandidates: readonly TransferEndpointCandidate[];
  deferredStartWorkPromise: Promise<void> | null;
  preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
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
  ) => Promise<Readonly<{ providerBundle: SessionHandoffProviderBundle; targetPath: string }>>;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
  }>) => Promise<unknown>;
  resolveSourceStopState: () => Promise<SessionHandoffSourceStopState>;
  recordDeferredStartFailure: (error: unknown) => void;
}>): Promise<DeferredDirectPeerStartResult> {
  let deferredStartEndpointCandidates: readonly TransferEndpointCandidate[] = [];
  let deferredStartWorkPromise: Promise<void> | null = null;
  let preExportedProviderBundle: DeferredDirectPeerPreExportedProviderBundle | undefined;

  if (input.hasServerRoutedFallback) {
    const providerBundleTransferId = buildSessionHandoffProviderBundleTransferId(input.handoffId);
    const providerBundleCarrierTransferId = `${providerBundleTransferId}:deferred-carrier`;
    const providerBundleCarrierPayloadSource = createBufferTransferPayloadSource(Buffer.from('{}', 'utf8'));
    const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId: input.handoffId });

    let cachedWorkspaceScope: DirectPeerOnDemandTransferScope | null = null;
    const carrierCandidates = [
      ...await input.directPeerTransfer.publishTransfer({
        transferId: providerBundleCarrierTransferId,
        payload: {},
        payloadSource: providerBundleCarrierPayloadSource,
        onDemandScope: {
          allowTransferId: (transferId) => {
            if (transferId === providerBundleTransferId || transferId === manifestTransferId) {
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
            if (transferId === providerBundleTransferId) {
              const persisted = await input.waitForPersistedSourceExport(
                input.handoffId,
                (record) => Boolean(record.providerBundle),
              );
              if (!persisted?.providerBundle) {
                throw new Error('Direct peer transfer not ready');
              }

              return createFileTransferPayloadSource({
                filePath: persisted.providerBundle.filePath,
                sizeBytes: persisted.providerBundle.sizeBytes,
                manifestHash: persisted.providerBundle.manifestHash,
              });
            }

            if (!cachedWorkspaceScope) {
              const persisted = await input.waitForPersistedSourceExport(
                input.handoffId,
                (record) => Boolean(record.workspaceManifest),
              );
              if (!persisted?.workspaceManifest) {
                throw new Error('Direct peer transfer not ready');
              }

              const manifest = await readWorkspaceReplicationManifestFromFile({
                transferId: persisted.workspaceManifest.transferId,
                filePath: persisted.workspaceManifest.filePath,
                sizeBytes: persisted.workspaceManifest.sizeBytes,
              });

              const workspaceSourceRootPath = persisted.workspaceSourceRootPath;
              if (!workspaceSourceRootPath) {
                throw new Error('Direct peer transfer not ready');
              }

              cachedWorkspaceScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
                handoffId: input.handoffId,
                activeServerDir: configuration.activeServerDir,
                sourceRootPath: workspaceSourceRootPath,
                manifest,
              });
            }
            return await cachedWorkspaceScope.resolvePayloadSourceOnOpen({
              transferId,
              requestBody,
            });
          },
        },
      }),
    ];
    const providerBundleEndpointCandidates = rewriteDirectPeerEndpointCandidatesForTransferId({
      endpointCandidates: carrierCandidates,
      transferId: providerBundleTransferId,
    });

    const manifestEndpointCandidates =
      input.request.workspaceTransfer?.enabled === true
        ? rewriteDirectPeerEndpointCandidatesForTransferId({
          endpointCandidates: providerBundleEndpointCandidates,
          transferId: manifestTransferId,
        })
        : undefined;
    const providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication = {
      transferId: providerBundleTransferId,
      sizeBytes: await resolveTransferPayloadSizeBytes(providerBundleCarrierPayloadSource),
      manifestHash: await resolveTransferPayloadManifestHash(providerBundleCarrierPayloadSource),
      endpointCandidates: providerBundleEndpointCandidates,
    };

    if (input.deferredHandoffMetadataV2) {
      input.deferredHandoffMetadataV2.providerBundleTransferPublication = providerBundleTransferPublication;
      if (manifestEndpointCandidates?.length) {
        input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication = {
          ...(input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication ?? { transferId: manifestTransferId }),
          endpointCandidates: manifestEndpointCandidates,
        };
      }
    }

    deferredStartEndpointCandidates = providerBundleEndpointCandidates;

    deferredStartWorkPromise = (async () => {
      let providerBundlePayloadSource: TransferPayloadSource | null = null;
      try {
        const exported = await input.exportSessionBundle(input.metadata);
        providerBundlePayloadSource = await createSessionHandoffProviderBundlePayloadSource(exported.providerBundle);

        const actualSourceStopState = await input.resolveSourceStopState();
        if (actualSourceStopState === 'failed') {
          throw new Error('Failed to stop the active source session before handoff cutover');
        }

        await input.prepareStartedState({
          handoffId: input.handoffId,
          request: input.request,
          metadata: input.metadata,
          sourceStopState: actualSourceStopState,
          preExportedProviderBundle: {
            providerBundle: exported.providerBundle,
            targetPath: exported.targetPath,
            providerBundlePayloadSource,
            providerBundleTransferPublication: {
              transferId: providerBundleTransferId,
              sizeBytes: await resolveTransferPayloadSizeBytes(providerBundlePayloadSource),
              manifestHash: await resolveTransferPayloadManifestHash(providerBundlePayloadSource),
              endpointCandidates: providerBundleEndpointCandidates,
            },
          },
        });
      } catch (error) {
        if (providerBundlePayloadSource) {
          await disposeTransferPayloadSource(providerBundlePayloadSource);
        }
        throw error;
      }
    })();
    void deferredStartWorkPromise.catch((error) => {
      input.directPeerTransfer.clearPublishedTransfer(providerBundleCarrierTransferId);
      input.recordDeferredStartFailure(error);
    });
  } else {
    const exported = await input.exportSessionBundle(input.metadata);
    const persistedProviderBundle = await input.sourceExportStore.writeProviderBundleFile({
      handoffId: input.handoffId,
      providerBundle: exported.providerBundle,
    });
    const providerBundlePayloadSource = createFileTransferPayloadSource({
      filePath: persistedProviderBundle.filePath,
      sizeBytes: persistedProviderBundle.sizeBytes,
      manifestHash: persistedProviderBundle.manifestHash,
    });
    const providerBundleTransferId = persistedProviderBundle.transferId;
    const providerBundleSizeBytes = persistedProviderBundle.sizeBytes;
    const providerBundleManifestHash = persistedProviderBundle.manifestHash;
    const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId: input.handoffId });

    await input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      workspaceSourceRootPath: exported.targetPath,
      providerBundle: persistedProviderBundle,
    });

    let cachedWorkspaceScope: DirectPeerOnDemandTransferScope | null = null;
    const carrierCandidates = [
      ...await input.directPeerTransfer.publishTransfer({
        transferId: providerBundleTransferId,
        payload: {},
        payloadSource: providerBundlePayloadSource,
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
            if (!cachedWorkspaceScope) {
              const persisted = await input.waitForPersistedSourceExport(
                input.handoffId,
                (record) => Boolean(record.workspaceManifest),
              );
              if (!persisted?.workspaceManifest) {
                throw new Error('Direct peer transfer not ready');
              }

              const manifest = await readWorkspaceReplicationManifestFromFile({
                transferId: persisted.workspaceManifest.transferId,
                filePath: persisted.workspaceManifest.filePath,
                sizeBytes: persisted.workspaceManifest.sizeBytes,
              });

              const workspaceSourceRootPath = persisted.workspaceSourceRootPath;
              if (!workspaceSourceRootPath) {
                throw new Error('Direct peer transfer not ready');
              }

              cachedWorkspaceScope = createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
                handoffId: input.handoffId,
                activeServerDir: configuration.activeServerDir,
                sourceRootPath: workspaceSourceRootPath,
                manifest,
              });
            }
            return await cachedWorkspaceScope.resolvePayloadSourceOnOpen({
              transferId,
              requestBody,
            });
          },
        },
      }),
    ];

    const manifestEndpointCandidates =
      input.request.workspaceTransfer?.enabled === true
        ? rewriteDirectPeerEndpointCandidatesForTransferId({
          endpointCandidates: carrierCandidates,
          transferId: manifestTransferId,
        })
        : undefined;

    preExportedProviderBundle = {
      providerBundle: exported.providerBundle,
      targetPath: exported.targetPath,
      providerBundlePayloadSource,
      providerBundleTransferPublication: {
        transferId: providerBundleTransferId,
        sizeBytes: providerBundleSizeBytes,
        manifestHash: providerBundleManifestHash,
        endpointCandidates: carrierCandidates,
      },
    };

    if (input.deferredHandoffMetadataV2) {
      input.deferredHandoffMetadataV2.providerBundleTransferPublication = preExportedProviderBundle.providerBundleTransferPublication;
      if (manifestEndpointCandidates?.length) {
        input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication = {
          ...(input.deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication ?? { transferId: manifestTransferId }),
          endpointCandidates: manifestEndpointCandidates,
        };
      }
    }

    await input.sourceExportStore.save({
      handoffId: input.handoffId,
      sessionId: input.request.sessionId,
      sourceMachineId: input.request.sourceMachineId,
      targetMachineId: input.request.targetMachineId,
      exportedAtMs: Date.now(),
      workspaceSourceRootPath: exported.targetPath,
      providerBundle: {
        ...persistedProviderBundle,
        ...(carrierCandidates.length ? { endpointCandidates: [...carrierCandidates] } : {}),
      },
    });

    deferredStartEndpointCandidates = carrierCandidates;
  }

  return {
    deferredStartEndpointCandidates,
    deferredStartWorkPromise,
    ...(preExportedProviderBundle ? { preExportedProviderBundle } : {}),
    ...(input.deferredHandoffMetadataV2 ? { deferredHandoffMetadataV2: input.deferredHandoffMetadataV2 } : {}),
  };
}
