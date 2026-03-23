import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffMetadataV2,
  SessionHandoffTransportStrategy,
  WorkspaceManifest,
  SessionHandoffWorkspaceTransfer,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { createWorkspaceReplicationEngine } from '@/workspaces/replication/createWorkspaceReplicationEngine';
import { abortWorkspaceReplicationJob } from '@/workspaces/replication/jobs/abortWorkspaceReplicationJob';
import { createWorkspaceReplicationJobStore } from '@/workspaces/replication/jobs/workspaceReplicationJobStore';
import { assertSafeWorkspaceReplicationPackId } from '@/workspaces/replication/transport/workspaceReplicationPackId';
import {
  createWorkspaceReplicationTransfers,
  type WorkspaceReplicationTransfers,
} from '@/workspaces/replication/transport/workspaceReplicationTransfers';

import {
  buildSessionHandoffWorkspaceReplicationSourceOffer,
  createSessionHandoffWorkspaceReplicationMetadata,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../workspace/sessionHandoffWorkspaceReplicationMetadata';
import {
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  publishSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId,
} from '../workspace/sessionHandoffWorkspaceReplicationDirectPeer';
import {
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  buildSessionHandoffWorkspaceBlobPackTransferId,
  buildSessionHandoffWorkspaceManifestTransferId,
  parseSessionHandoffWorkspaceBlobPackTransferId,
} from '../workspace/sessionHandoffWorkspaceReplicationServerRouted';
import type { SessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';

function rewriteDirectPeerEndpointCandidatesForTransferId(input: Readonly<{
  endpointCandidates: readonly TransferEndpointCandidate[];
  transferId: string;
}>): readonly TransferEndpointCandidate[] {
  const encodedKey = Buffer.from(input.transferId, 'utf8').toString('base64url');
  const marker = '/machine-transfers/direct/';

  return input.endpointCandidates.map((candidate) => {
    if (candidate.kind !== 'http' && candidate.kind !== 'https') {
      return candidate;
    }
    const parsed = new URL(candidate.url);
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error(`Invalid direct-peer endpoint candidate URL for ${input.transferId}`);
    }
    parsed.pathname = `${parsed.pathname.slice(0, markerIndex + marker.length)}${encodedKey}`;
    // Direct-peer candidates should not rely on query params for auth or routing.
    parsed.search = '';
    parsed.hash = '';
    return {
      ...candidate,
      url: parsed.toString(),
    };
  });
}

type DirectPeerTransferPublisher = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: Readonly<Record<never, never>>;
    payloadSource?: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
}>;

type MachineTransferChannel = Readonly<{
  onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
  sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
}>;

export {
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  type SessionHandoffWorkspaceReplicationMetadata,
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
  // Poll on a coarse interval to avoid hammering the job store while still providing fast convergence.
  while (true) {
    await params.assertCanContinue?.();
    const record = await params.engine.getJobStatus(params.jobId);
    if (TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES.has(record.status.status)) {
      return record;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
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
  persistedBlobProvider?: WorkspaceExportBlobProvider;
  machineTransferChannel?: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): Promise<Awaited<ReturnType<typeof buildSessionHandoffWorkspaceReplicationSourceOffer>> | null> {
  if (input.metadata) {
    return await buildSessionHandoffWorkspaceReplicationSourceOffer({
      activeServerDir: input.activeServerDir,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
      targetPath: input.targetPath,
      metadata: input.metadata,
    });
  }

  return null;
}

async function loadCurrentTargetManifestViaEnginePlan(input: Readonly<{
  activeServerDir: string;
  sourceMachineId: string;
  sourceRootPath: string;
  targetMachineId: string;
  targetPath: string;
  sourceManifest: WorkspaceManifest;
  transfers: WorkspaceReplicationTransfers;
}>): Promise<WorkspaceManifest> {
  try {
    const engine = createWorkspaceReplicationEngine({
      activeServerDir: input.activeServerDir,
      localMachineId: input.targetMachineId,
    });

    const scope = {
      sourceMachineId: input.sourceMachineId,
      sourceWorkspaceRoot: input.sourceRootPath,
      targetMachineId: input.targetMachineId,
      targetWorkspaceRoot: input.targetPath,
      mode: 'one_way_safe' as const,
    };

    const plan = await engine.plan({
      scope,
      sourceManifest: input.sourceManifest,
      targetWorkspaceRoot: input.targetPath,
    });

    return {
      entries: plan.targetManifest.entries.map((entry) => ({ ...entry })),
      ...(plan.targetManifest.fingerprint ? { fingerprint: plan.targetManifest.fingerprint } : {}),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { entries: [] };
    }
    throw error;
  }
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
  directPeerManifestEndpointCandidates?: readonly TransferEndpointCandidate[];
  persistedBlobProvider?: WorkspaceExportBlobProvider;
  machineTransferChannel?: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
  onWorkspaceReplicationJobStarted?: (jobId: string) => Promise<void>;
  assertCanContinue?: () => Promise<void>;
}>): Promise<Readonly<{
  importedWorkspace: Readonly<{ targetPath: string }>;
  currentTargetManifest: WorkspaceManifest;
  sourceOffer: SessionHandoffWorkspaceReplicationSourceOffer | null;
}>> {
  const correlationId = `session_handoff_workspace_prepare_target:${input.handoffId}`;
  const metadata = input.metadata;
  if (!input.workspaceTransfer?.enabled) {
    // Workspace transfer is explicitly disabled; do not attempt any legacy import path.
    return {
      importedWorkspace: { targetPath: input.targetPath },
      currentTargetManifest: { entries: [] },
      sourceOffer: null,
    };
  }

  const currentTargetManifest =
    input.workspaceTransfer?.enabled
    && input.workspaceTransfer.strategy === 'sync_changes'
    && metadata
      ? await loadCurrentTargetManifestViaEnginePlan({
        activeServerDir: input.activeServerDir,
        sourceMachineId: input.sourceMachineId,
        sourceRootPath: metadata.sourceRootPath,
        targetMachineId: input.targetMachineId,
        targetPath: input.targetPath,
        sourceManifest: metadata.manifest,
        transfers: input.transfers,
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
        persistedBlobProvider: input.persistedBlobProvider,
        machineTransferChannel: input.machineTransferChannel,
        transfers: input.transfers,
        blobPackTargetBytes: input.blobPackTargetBytes,
        blobPackMaxBlobs: input.blobPackMaxBlobs,
        blobPackMaxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
      })
      : null;

  if (input.workspaceTransfer?.enabled && !sourceOffer) {
    throw new Error('Missing workspace replication source offer');
  }
  const resolvedSourceOffer = sourceOffer as NonNullable<typeof sourceOffer>;

  // one_way_safe divergence gating, job lifecycle, and baseline persistence are owned by the engine job runner.

  const importedWorkspace =
    await (async () => {
      const engine = createWorkspaceReplicationEngine({
        activeServerDir: input.activeServerDir,
        localMachineId: input.targetMachineId,
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
        sourceOffer: resolvedSourceOffer,
        correlationId,
        apply: {
          targetPath: input.targetPath,
          strategy: workspaceTransfer.strategy,
          conflictPolicy: workspaceTransfer.conflictPolicy,
        },
        blobPackPlanningMode: 'missing_only',
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
          if (input.actualTransportStrategy === 'direct_peer') {
            const endpointCandidates = input.directPeerManifestEndpointCandidates;
            if (!endpointCandidates?.length) {
              throw new Error('Direct peer transfer is unavailable for workspace replication');
            }
            const safePackId = assertSafeWorkspaceReplicationPackId(packId);
            const transferId = buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId({
              handoffId: input.handoffId,
              packId: safePackId,
            });
            await input.transfers.requestDirectPeerBlobPackToFile({
              transferId,
              endpointCandidates: rewriteDirectPeerEndpointCandidatesForTransferId({
                endpointCandidates,
                transferId,
              }),
              destinationPath,
              openBody: {
                t: 'workspace_replication_blob_pack_v1',
                packId: safePackId,
                digests: [...digests],
              },
            });
            return;
          }
          throw new Error(`Unexpected workspace blob-pack request for ${packId} (${input.actualTransportStrategy})`);
        },
      });

      if (input.onWorkspaceReplicationJobStarted) {
        await input.onWorkspaceReplicationJobStarted(jobId);
      }

      const completed = await waitForTerminalWorkspaceReplicationJob({
        engine,
        jobId,
        assertCanContinue: input.assertCanContinue,
      });

      if (completed.status.status !== 'completed') {
        const reason =
          completed.lastErrorMessage
          ?? (completed.status.status === 'aborted'
            ? 'Workspace replication job aborted'
            : `Workspace replication job did not complete successfully: ${completed.status.status}`);
        throw new Error(reason);
      }
      if (!completed.result?.targetPath) {
        throw new Error(`Workspace replication job completed without a target path: ${jobId}`);
      }

      return {
        targetPath: completed.result.targetPath,
      };
    })();

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
}>> {
  const workspaceTransferEnabled = input.workspaceTransfer?.enabled === true;
  const workspaceReplicationState = workspaceTransferEnabled
    ? await createSessionHandoffWorkspaceReplicationState({
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
    })
    : null;
  const workspaceReplicationMetadata = workspaceReplicationState?.workspaceReplicationMetadata;
  const publishedWorkspaceDirectPeerTransfers = workspaceReplicationState?.publishedWorkspaceDirectPeerTransfers;

  const workspaceReplicationManifestTransferPublication =
    publishedWorkspaceDirectPeerTransfers?.manifestTransferPublication
    ?? (workspaceReplicationMetadata && input.workspaceTransfer?.enabled
      ? {
          transferId: buildSessionHandoffWorkspaceManifestTransferId({
            handoffId: input.handoffId,
          }),
          endpointCandidates: undefined,
        }
      : undefined);

  const providerBundleTransferPublication = input.providerBundleTransferPublication
    ? {
        transferId: input.providerBundleTransferPublication.transferId,
        sizeBytes: input.providerBundleTransferPublication.sizeBytes,
        manifestHash: input.providerBundleTransferPublication.manifestHash,
        ...(input.providerBundleTransferPublication.endpointCandidates
          ? { endpointCandidates: [...input.providerBundleTransferPublication.endpointCandidates] }
          : {}),
      }
    : undefined;

  const workspaceReplicationManifestTransferPublicationNormalized = workspaceReplicationManifestTransferPublication
    ? {
        transferId: workspaceReplicationManifestTransferPublication.transferId,
        ...(workspaceReplicationManifestTransferPublication.endpointCandidates
          ? { endpointCandidates: [...workspaceReplicationManifestTransferPublication.endpointCandidates] }
          : {}),
      }
    : undefined;

  const handoffMetadataV2: SessionHandoffMetadataV2 | undefined =
    providerBundleTransferPublication
    || workspaceReplicationMetadata
    || workspaceReplicationManifestTransferPublicationNormalized
    || publishedWorkspaceDirectPeerTransfers
      ? {
          ...(providerBundleTransferPublication
            ? { providerBundleTransferPublication: providerBundleTransferPublication }
            : {}),
          ...(workspaceReplicationMetadata
            ? { workspaceReplicationSourceRootPath: workspaceReplicationMetadata.sourceRootPath }
            : {}),
          ...(workspaceReplicationManifestTransferPublicationNormalized
            ? { workspaceReplicationManifestTransferPublication: workspaceReplicationManifestTransferPublicationNormalized }
            : {}),
          ...(workspaceReplicationMetadata?.sourceControllerMetadata
            ? { workspaceReplicationSourceControllerMetadata: workspaceReplicationMetadata.sourceControllerMetadata }
            : {}),
        }
      : undefined;

  return {
    ...(workspaceReplicationMetadata ? { workspaceReplicationMetadata } : {}),
    ...(publishedWorkspaceDirectPeerTransfers ? { publishedWorkspaceDirectPeerTransfers } : {}),
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
  };
}

export function createSessionHandoffWorkspaceReplicationAdapter(): Readonly<{
  createReplicationTransfers: typeof createWorkspaceReplicationTransfers;
  createState: typeof createSessionHandoffWorkspaceReplicationState;
  resolveSourceOffer: typeof resolveSessionHandoffWorkspaceReplicationSourceOffer;
  prepareTargetWorkspace: typeof prepareSessionHandoffWorkspaceTarget;
  prepareSourceWorkspaceTransfer: typeof prepareSessionHandoffSourceWorkspaceTransfer;
  abortWorkspaceReplicationJob: (input: Readonly<{
    activeServerDir: string;
    jobId: string;
    now?: () => number;
  }>) => Promise<void>;
}> {
  return {
    createReplicationTransfers: createWorkspaceReplicationTransfers,
    createState: createSessionHandoffWorkspaceReplicationState,
    resolveSourceOffer: resolveSessionHandoffWorkspaceReplicationSourceOffer,
    prepareTargetWorkspace: prepareSessionHandoffWorkspaceTarget,
    prepareSourceWorkspaceTransfer: prepareSessionHandoffSourceWorkspaceTransfer,
    abortWorkspaceReplicationJob: async (input) => {
      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir: input.activeServerDir });
      await abortWorkspaceReplicationJob({
        jobStore,
        jobId: input.jobId,
        now: input.now,
      });
    },
  };
}
