import { randomUUID } from 'node:crypto';

import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffTransportStrategy,
  WorkspaceManifest,
  SessionHandoffWorkspaceTransfer,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { applyWorkspaceReplicationPlan } from '@/workspaces/replication/apply/applyWorkspaceReplicationPlan';
import { createWorkspaceReplicationEngine } from '@/workspaces/replication/createWorkspaceReplicationEngine';
import {
  createWorkspaceReplicationTransfers,
  type WorkspaceReplicationTransfers,
} from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import { createWorkspaceReplicationBaselineStore } from '@/workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import { buildOneWaySafeReplicationPlan } from '@/workspaces/replication/planning/buildOneWaySafeReplicationPlan';

import {
  buildSessionHandoffWorkspaceExportArtifacts,
  buildSessionHandoffWorkspaceExportPayload,
  importSessionHandoffWorkspaceArtifacts,
} from '../workspace/sessionHandoffWorkspaceArtifacts';
import {
  buildSessionHandoffWorkspaceReplicationSourceOffer,
  createSessionHandoffWorkspaceReplicationMetadata,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../workspace/sessionHandoffWorkspaceReplicationMetadata';
import {
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  publishSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  receiveDirectPeerSessionHandoffWorkspaceReplication,
  type SessionHandoffWorkspaceReplicationDirectPeerPublication,
} from '../workspace/sessionHandoffWorkspaceReplicationDirectPeer';
import {
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource,
  buildSessionHandoffWorkspaceBlobPackTransferId,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  parseSessionHandoffWorkspaceSourceOfferTransferId,
  receiveServerRoutedSessionHandoffWorkspaceReplication,
} from '../workspace/sessionHandoffWorkspaceReplicationServerRouted';
import {
  createSessionHandoffTransferredBundles,
  createSessionHandoffTransferredBundlesPayloadSource,
  normalizeCurrentSessionHandoffTransferredPayloadForStorage,
  receiveSessionHandoffTransferredBundlesPayloadFile,
  type ReceivedSessionHandoffTransferredBundlesPayloadFile,
  type SessionHandoffTransferredBundles,
} from '../transfer/sessionHandoffTransferredBundles';
import {
  createSessionHandoffMetadataV2,
  type SessionHandoffMetadataV2,
} from '../transfer/sessionHandoffMetadataV2';
import type { SessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';

type DirectPeerTransferPublisher = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: ReturnType<typeof createSessionHandoffTransferredBundles>;
    payloadSource?: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
}>;

type MachineTransferChannel = Readonly<{
  onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
  sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
}>;

export {
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  parseSessionHandoffWorkspaceSourceOfferTransferId,
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  type SessionHandoffWorkspaceReplicationDirectPeerPublication,
  type SessionHandoffWorkspaceReplicationMetadata,
  type SessionHandoffTransferredBundles,
};

export type SessionHandoffWorkspaceReplicationSourceOffer =
  Awaited<ReturnType<typeof buildSessionHandoffWorkspaceReplicationSourceOffer>>;

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES = new Set<string>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

async function waitForTerminalWorkspaceReplicationJob(params: Readonly<{
  engine: ReturnType<typeof createWorkspaceReplicationEngine>;
  jobId: string;
  assertCanContinue?: () => Promise<void>;
}>): Promise<Awaited<ReturnType<ReturnType<typeof createWorkspaceReplicationEngine>['getJobStatus']>>> {
  // Short polling loop; job runner persists progress frequently so this converges quickly.
  while (true) {
    await params.assertCanContinue?.();
    const record = await params.engine.getJobStatus(params.jobId);
    if (TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES.has(record.status.status)) {
      return record;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function defaultLoadCurrentTargetManifest(input: Readonly<{
  activeServerDir: string;
  targetPath: string;
  workspaceTransfer: SessionHandoffWorkspaceTransfer;
  buildWorkspaceExportPayload?: typeof buildSessionHandoffWorkspaceExportPayload;
}>): Promise<WorkspaceManifest> {
  try {
    const workspaceExport = await (input.buildWorkspaceExportPayload ?? buildSessionHandoffWorkspaceExportPayload)({
      activeServerDir: input.activeServerDir,
      sourcePath: input.targetPath,
      workspaceTransfer: input.workspaceTransfer,
    });
    if (!workspaceExport.workspaceExportArtifacts) {
      return { entries: [] };
    }
    return {
      entries: workspaceExport.workspaceExportArtifacts.manifest.entries.map((entry) => ({ ...entry })),
      ...(workspaceExport.workspaceExportArtifacts.manifest.fingerprint
        ? { fingerprint: workspaceExport.workspaceExportArtifacts.manifest.fingerprint }
        : {}),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { entries: [] };
    }
    throw error;
  }
}

export async function createSessionHandoffWorkspaceReplicationState(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  negotiatedTransportStrategy?: SessionHandoffTransportStrategy;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  directPeerTransfer?: DirectPeerTransferPublisher;
  sourceRootPath: string;
  blobProvider?: WorkspaceExportBlobProvider;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
}>): Promise<Readonly<{
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  publishedWorkspaceDirectPeerTransfers?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers;
}>> {
  const workspaceReplicationMetadata = createSessionHandoffWorkspaceReplicationMetadata({
    sourceRootPath: input.sourceRootPath,
    workspaceExportArtifacts: input.workspaceExportArtifacts,
  });

  if (
    input.negotiatedTransportStrategy !== 'direct_peer'
    || input.workspaceTransfer?.enabled !== true
    || !workspaceReplicationMetadata
    || !input.directPeerTransfer
  ) {
    return {
      ...(workspaceReplicationMetadata ? { workspaceReplicationMetadata } : {}),
    };
  }

  const publishedWorkspaceDirectPeerTransfers =
    await publishSessionHandoffWorkspaceReplicationDirectPeerTransfers({
      handoffId: input.handoffId,
      activeServerDir: input.activeServerDir,
      manifest: workspaceReplicationMetadata.manifest,
      directPeerTransfer: input.directPeerTransfer,
      blobProvider: input.blobProvider,
      ...(input.workspaceExportArtifacts
        ? { workspaceExportArtifacts: input.workspaceExportArtifacts }
        : {}),
    });

  return {
    workspaceReplicationMetadata,
    publishedWorkspaceDirectPeerTransfers,
  };
}

export async function resolveSessionHandoffWorkspaceReplicationSourceOffer(input: Readonly<{
  activeServerDir: string;
  actualTransportStrategy: SessionHandoffTransportStrategy;
  handoffId: string;
  sourceMachineId: string;
  targetMachineId: string;
  targetPath: string;
  metadata?: SessionHandoffWorkspaceReplicationMetadata;
  directPeerPublication?: SessionHandoffWorkspaceReplicationDirectPeerPublication;
  persistedBlobProvider?: WorkspaceExportBlobProvider;
  machineTransferChannel?: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): Promise<Awaited<ReturnType<typeof buildSessionHandoffWorkspaceReplicationSourceOffer>> | null> {
  if (!input.metadata) {
    return null;
  }

  if (input.actualTransportStrategy === 'server_routed_stream' && input.machineTransferChannel) {
    return (await receiveServerRoutedSessionHandoffWorkspaceReplication({
      activeServerDir: input.activeServerDir,
      handoffId: input.handoffId,
      sourceMachineId: input.sourceMachineId,
      targetPath: input.targetPath,
      machineTransferChannel: input.machineTransferChannel,
      transfers: input.transfers,
      blobPackTargetBytes: input.blobPackTargetBytes,
      blobPackMaxBlobs: input.blobPackMaxBlobs,
      blobPackMaxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
    })).sourceOffer;
  }

  if (
    input.actualTransportStrategy === 'direct_peer'
    && input.directPeerPublication
    && !input.persistedBlobProvider
  ) {
    return (await receiveDirectPeerSessionHandoffWorkspaceReplication({
      activeServerDir: input.activeServerDir,
      handoffId: input.handoffId,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
      targetPath: input.targetPath,
      metadata: input.metadata,
      directPeerPublication: input.directPeerPublication,
      transfers: input.transfers,
      maxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
    })).sourceOffer;
  }

  return await buildSessionHandoffWorkspaceReplicationSourceOffer({
    activeServerDir: input.activeServerDir,
    sourceMachineId: input.sourceMachineId,
    targetMachineId: input.targetMachineId,
    targetPath: input.targetPath,
    metadata: input.metadata,
  });
}

export async function prepareSessionHandoffWorkspaceTarget(input: Readonly<{
  activeServerDir: string;
  actualTransportStrategy: SessionHandoffTransportStrategy;
  handoffId: string;
  sourceMachineId: string;
  targetMachineId: string;
  targetPath: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  metadata?: SessionHandoffWorkspaceReplicationMetadata;
  directPeerPublication?: SessionHandoffWorkspaceReplicationDirectPeerPublication;
  persistedBlobProvider?: WorkspaceExportBlobProvider;
  machineTransferChannel?: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
  persistedTransferredBundles: SessionHandoffTransferredBundles;
  assertCanContinue?: () => Promise<void>;
  buildWorkspaceExportPayload?: typeof buildSessionHandoffWorkspaceExportPayload;
  loadCurrentTargetManifest?: (params: Readonly<{
    targetPath: string;
    workspaceTransfer: SessionHandoffWorkspaceTransfer;
  }>) => Promise<WorkspaceManifest>;
  importWorkspaceBundle?: (params: Readonly<{
    workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
    targetPath: string;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    assertCanContinue?: () => Promise<void>;
  }>) => Promise<Readonly<{ targetPath: string }>>;
  applyReplicationPlan?: (params: Readonly<{
    activeServerDir: string;
    sourceOffer: SessionHandoffWorkspaceReplicationSourceOffer;
    targetPath: string;
    strategy: NonNullable<SessionHandoffWorkspaceTransfer['strategy']>;
    conflictPolicy: SessionHandoffWorkspaceTransfer['conflictPolicy'];
    assertCanContinue?: () => Promise<void>;
    currentTargetManifest?: WorkspaceManifest;
  }>) => Promise<Readonly<{ targetPath: string }>>;
}>): Promise<Readonly<{
  importedWorkspace: Readonly<{ targetPath: string }>;
  currentTargetManifest: WorkspaceManifest;
  sourceOffer: SessionHandoffWorkspaceReplicationSourceOffer | null;
}>> {
  const jobStore = createWorkspaceReplicationJobStore({
    activeServerDir: input.activeServerDir,
  });
  const baselineStore = createWorkspaceReplicationBaselineStore({
    activeServerDir: input.activeServerDir,
  });
  const correlationId = `session_handoff_workspace_prepare_target:${input.handoffId}`;

  const currentTargetManifest =
    input.workspaceTransfer?.enabled && input.workspaceTransfer.strategy === 'sync_changes'
      ? await (input.loadCurrentTargetManifest ?? (async (params: Readonly<{
        targetPath: string;
        workspaceTransfer: SessionHandoffWorkspaceTransfer;
      }>) => await defaultLoadCurrentTargetManifest({
        activeServerDir: input.activeServerDir,
        ...params,
        ...(input.buildWorkspaceExportPayload
          ? { buildWorkspaceExportPayload: input.buildWorkspaceExportPayload }
          : {}),
      })))({
        targetPath: input.targetPath,
        workspaceTransfer: input.workspaceTransfer,
      })
      : { entries: [] };

  const sourceOffer =
    input.workspaceTransfer?.enabled
      ? await resolveSessionHandoffWorkspaceReplicationSourceOffer({
        activeServerDir: input.activeServerDir,
        actualTransportStrategy: input.actualTransportStrategy,
        handoffId: input.handoffId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        targetPath: input.targetPath,
        metadata: input.metadata,
        directPeerPublication: input.directPeerPublication,
        persistedBlobProvider: input.persistedBlobProvider,
        machineTransferChannel: input.machineTransferChannel,
        transfers: input.transfers,
        blobPackTargetBytes: input.blobPackTargetBytes,
        blobPackMaxBlobs: input.blobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
      })
      : null;

  if (
    input.workspaceTransfer?.enabled === true
    && input.workspaceTransfer.strategy === 'sync_changes'
    && sourceOffer
    && input.metadata
  ) {
    const baseline = await baselineStore.load({
      sourceMachineId: input.sourceMachineId,
      sourceWorkspaceRoot: input.metadata.sourceRootPath,
      targetMachineId: input.targetMachineId,
      targetWorkspaceRoot: input.targetPath,
      mode: 'one_way_safe',
    });
    if (baseline) {
      const plan = buildOneWaySafeReplicationPlan({
        baseline,
        sourceManifest: sourceOffer.manifest,
        targetManifest: currentTargetManifest,
      });
      if (!plan.canApplySafely) {
        const existingJob = await jobStore.findByCorrelationId(correlationId);
        const nowMs = Date.now();
        const jobId = existingJob?.jobId ?? `job_${randomUUID().replace(/-/gu, '')}`;
        await jobStore.write({
          jobId,
          correlationId,
          relationshipId: sourceOffer.relationshipId,
          directionId: sourceOffer.directionId,
          offerId: sourceOffer.offerId,
          mode: 'one_way_safe',
          createdAtMs: existingJob?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          failedAtMs: nowMs,
          lastErrorMessage: `Target workspace diverged since last baseline (${plan.blockingTargetDivergencePaths.length} paths)`,
	          status: {
	            status: 'failed',
	            phase: 'planning',
	            checkpoint: 'relationship_resolved',
	            blockingDivergenceCandidates: [...plan.blockingTargetDivergencePaths],
	          },
	        });
	        throw new Error(`Target workspace diverged since last baseline for ${input.targetPath}`);
	      }
	    }
  }

  if (input.workspaceTransfer?.enabled === true && input.workspaceTransfer.strategy === 'sync_changes' && sourceOffer) {
    const existingJob = await jobStore.findByCorrelationId(correlationId);
    const nowMs = Date.now();
    const jobId = existingJob?.jobId ?? `job_${randomUUID().replace(/-/gu, '')}`;
    await jobStore.write({
      jobId,
      correlationId,
      relationshipId: sourceOffer.relationshipId,
      directionId: sourceOffer.directionId,
      offerId: sourceOffer.offerId,
      mode: 'one_way_safe',
      createdAtMs: existingJob?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      status: {
        status: 'in_progress',
        phase: 'apply',
        checkpoint: 'apply_started',
      },
    });
  }

  const importedWorkspace =
    input.workspaceTransfer?.enabled && sourceOffer && (
      (input.actualTransportStrategy === 'server_routed_stream' && input.machineTransferChannel)
      || (input.actualTransportStrategy === 'direct_peer' && input.directPeerPublication && !input.persistedBlobProvider)
    )
      ? await (async () => {
        const engine = createWorkspaceReplicationEngine({
          activeServerDir: input.activeServerDir,
          localMachineId: input.targetMachineId,
          transfers: input.transfers,
        });

        const metadata = input.metadata;
        const workspaceTransfer = input.workspaceTransfer;
        if (!metadata || !workspaceTransfer) {
          throw new Error('Missing workspace replication metadata or transfer configuration');
        }

        const scope = {
          sourceMachineId: input.sourceMachineId,
          sourceWorkspaceRoot: metadata.sourceRootPath,
          targetMachineId: input.targetMachineId,
          targetWorkspaceRoot: input.targetPath,
          mode: 'one_way_safe' as const,
        };

        const { jobId } = await engine.startJobFromOffer({
          scope,
          sourceOffer,
          correlationId,
          apply: {
            targetPath: input.targetPath,
            strategy: workspaceTransfer.strategy,
            conflictPolicy: workspaceTransfer.conflictPolicy,
          },
          requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
            if (input.actualTransportStrategy === 'server_routed_stream' && input.machineTransferChannel) {
              await input.transfers.requestServerRoutedBlobPackToFile({
                transferId: buildSessionHandoffWorkspaceBlobPackTransferId({
                  handoffId: input.handoffId,
                  packId,
                  digests,
                }),
                sourceMachineId: input.sourceMachineId,
                machineTransferChannel: input.machineTransferChannel,
                destinationPath,
              });
              return;
            }
            throw new Error(`Unexpected workspace blob-pack request for ${packId} (direct_peer packs should already be staged)`);
          },
        });

        const completed = await waitForTerminalWorkspaceReplicationJob({
          engine,
          jobId,
          assertCanContinue: input.assertCanContinue,
        });

        if (completed.status.status !== 'completed') {
          throw new Error(`Workspace replication job did not complete successfully: ${completed.status.status}`);
        }
        if (!completed.result?.targetPath) {
          throw new Error(`Workspace replication job completed without a target path: ${jobId}`);
        }

        return {
          targetPath: completed.result.targetPath,
        };
      })()
      : input.workspaceTransfer?.enabled && sourceOffer
      ? await (input.applyReplicationPlan ?? applyWorkspaceReplicationPlan)({
        activeServerDir: input.activeServerDir,
        sourceOffer,
        targetPath: input.targetPath,
        strategy: input.workspaceTransfer.strategy,
        conflictPolicy: input.workspaceTransfer.conflictPolicy,
        assertCanContinue: input.assertCanContinue,
        ...(input.workspaceTransfer.strategy === 'sync_changes'
          ? {
            currentTargetManifest,
          }
          : {}),
      })
      : await (input.importWorkspaceBundle ?? importSessionHandoffWorkspaceArtifacts)({
        ...(input.persistedTransferredBundles.workspaceExportArtifacts
          ? { workspaceExportArtifacts: input.persistedTransferredBundles.workspaceExportArtifacts }
          : {}),
        ...(input.persistedBlobProvider ? { blobProvider: input.persistedBlobProvider } : {}),
        targetPath: input.targetPath,
        workspaceTransfer: input.workspaceTransfer,
        assertCanContinue: input.assertCanContinue,
      });

  if (
    input.workspaceTransfer?.enabled === true
    && input.workspaceTransfer.strategy === 'sync_changes'
    && sourceOffer
    && input.metadata
  ) {
    const nowMs = Date.now();
    await baselineStore.save({
      scope: {
        sourceMachineId: input.sourceMachineId,
        sourceWorkspaceRoot: input.metadata.sourceRootPath,
        targetMachineId: input.targetMachineId,
        targetWorkspaceRoot: input.targetPath,
        mode: 'one_way_safe',
      },
      baseline: {
        manifestFingerprint: sourceOffer.sourceFingerprint,
        manifest: sourceOffer.manifest,
        savedAtMs: nowMs,
      },
    });

    const existingJob = await jobStore.findByCorrelationId(correlationId);
    const jobId = existingJob?.jobId ?? `job_${randomUUID().replace(/-/gu, '')}`;
    await jobStore.write({
      jobId,
      correlationId,
      relationshipId: sourceOffer.relationshipId,
      directionId: sourceOffer.directionId,
      offerId: sourceOffer.offerId,
      mode: 'one_way_safe',
      createdAtMs: existingJob?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
      completedAtMs: nowMs,
      status: {
        status: 'completed',
        phase: 'commit_baseline',
        checkpoint: 'baseline_committed',
      },
    });
  }

  return {
    importedWorkspace,
    currentTargetManifest,
    sourceOffer,
  };
}

export async function prepareSessionHandoffSourceWorkspaceTransfer(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  negotiatedTransportStrategy?: SessionHandoffTransportStrategy;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  directPeerTransfer?: DirectPeerTransferPublisher;
  sourceRootPath: string;
  blobProvider?: WorkspaceExportBlobProvider;
  workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  providerBundleTransferPublication?: SessionHandoffProviderBundleTransferPublication;
}>): Promise<Readonly<{
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  publishedWorkspaceDirectPeerTransfers?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  transferredBundles: SessionHandoffTransferredBundles;
  transferredPayloadSource: TransferPayloadSource;
  storedTransferredPayload: ReceivedSessionHandoffTransferredBundlesPayloadFile;
  includeWorkspaceBlobPayloads: boolean;
}>> {
  const workspaceReplicationState = await createSessionHandoffWorkspaceReplicationState({
    handoffId: input.handoffId,
    activeServerDir: input.activeServerDir,
    negotiatedTransportStrategy: input.negotiatedTransportStrategy,
    workspaceTransfer: input.workspaceTransfer,
    directPeerTransfer: input.directPeerTransfer,
    sourceRootPath: input.sourceRootPath,
    blobProvider: input.blobProvider,
    ...(input.workspaceExportArtifacts
      ? { workspaceExportArtifacts: input.workspaceExportArtifacts }
      : {}),
  });
  const workspaceReplicationMetadata = workspaceReplicationState.workspaceReplicationMetadata;
  const publishedWorkspaceDirectPeerTransfers =
    workspaceReplicationState.publishedWorkspaceDirectPeerTransfers;
  const handoffMetadataV2 = createSessionHandoffMetadataV2({
    ...(input.providerBundleTransferPublication
      ? { providerBundleTransferPublication: input.providerBundleTransferPublication }
      : {}),
    ...(workspaceReplicationMetadata
      ? { workspaceReplicationMetadata }
      : {}),
    ...(publishedWorkspaceDirectPeerTransfers
      ? { workspaceReplicationDirectPeerPublication: publishedWorkspaceDirectPeerTransfers.publication }
      : {}),
  });
  const includeWorkspaceBlobPayloads = !(workspaceReplicationMetadata && input.workspaceTransfer?.enabled);
  const transferredBundles = createSessionHandoffTransferredBundles({
    ...(input.workspaceExportArtifacts
      ? { workspaceExportArtifacts: input.workspaceExportArtifacts }
      : {}),
  });
  const transferredPayloadSource = await createSessionHandoffTransferredBundlesPayloadSource(
    transferredBundles,
    {
      blobProvider: input.blobProvider,
      includeWorkspaceBlobPayloads,
      ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
    },
  );
  const storedTransferredPayload = await normalizeCurrentSessionHandoffTransferredPayloadForStorage({
    activeServerDir: input.activeServerDir,
    transferredBundles,
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
    ...(input.blobProvider ? { blobProvider: input.blobProvider } : {}),
  });

  return {
    ...(workspaceReplicationMetadata ? { workspaceReplicationMetadata } : {}),
    ...(publishedWorkspaceDirectPeerTransfers ? { publishedWorkspaceDirectPeerTransfers } : {}),
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
    transferredBundles,
    transferredPayloadSource,
    storedTransferredPayload,
    includeWorkspaceBlobPayloads,
  };
}

export function createSessionHandoffWorkspaceReplicationAdapter(): Readonly<{
  createReplicationTransfers: typeof createWorkspaceReplicationTransfers;
  createState: typeof createSessionHandoffWorkspaceReplicationState;
  resolveSourceOffer: typeof resolveSessionHandoffWorkspaceReplicationSourceOffer;
  prepareTargetWorkspace: typeof prepareSessionHandoffWorkspaceTarget;
  prepareSourceWorkspaceTransfer: typeof prepareSessionHandoffSourceWorkspaceTransfer;
  buildWorkspaceExportArtifacts: typeof buildSessionHandoffWorkspaceExportArtifacts;
  importWorkspaceArtifacts: typeof importSessionHandoffWorkspaceArtifacts;
  createTransferredBundles: typeof createSessionHandoffTransferredBundles;
  createTransferredBundlesPayloadSource: typeof createSessionHandoffTransferredBundlesPayloadSource;
  normalizeTransferredPayloadForStorage: typeof normalizeCurrentSessionHandoffTransferredPayloadForStorage;
  receiveTransferredBundlesPayloadFile: typeof receiveSessionHandoffTransferredBundlesPayloadFile;
}> {
  return {
    createReplicationTransfers: createWorkspaceReplicationTransfers,
    createState: createSessionHandoffWorkspaceReplicationState,
    resolveSourceOffer: resolveSessionHandoffWorkspaceReplicationSourceOffer,
    prepareTargetWorkspace: prepareSessionHandoffWorkspaceTarget,
    prepareSourceWorkspaceTransfer: prepareSessionHandoffSourceWorkspaceTransfer,
    buildWorkspaceExportArtifacts: buildSessionHandoffWorkspaceExportArtifacts,
    importWorkspaceArtifacts: importSessionHandoffWorkspaceArtifacts,
    createTransferredBundles: createSessionHandoffTransferredBundles,
    createTransferredBundlesPayloadSource: createSessionHandoffTransferredBundlesPayloadSource,
    normalizeTransferredPayloadForStorage: normalizeCurrentSessionHandoffTransferredPayloadForStorage,
    receiveTransferredBundlesPayloadFile: receiveSessionHandoffTransferredBundlesPayloadFile,
  };
}
