import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffMetadataV2,
  SessionHandoffTransportStrategy,
  WorkspaceManifest,
  SessionHandoffWorkspaceTransfer,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

import { relative, resolve, sep } from 'node:path';

import { rewriteDirectPeerEndpointCandidatesForTransferId } from '@/machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';
import { buildWorkspaceExportArtifactsWithSourceController } from '@/scm/sourceController/workspaceTransferResolution';
import { createWorkspaceReplicationEngine } from '@/workspaces/replication/createWorkspaceReplicationEngine';
import { createWorkspaceReplicationBaselineStore } from '@/workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationSourceOfferFromManifest } from '@/workspaces/replication/transport/createWorkspaceReplicationSourceOffer';
import { assertWorkspaceReplicationDigestsAllowedByManifest } from '@/workspaces/replication/transport/workspaceReplicationAllowedDigests';
import { assertSafeWorkspaceReplicationPackId } from '@/workspaces/replication/transport/workspaceReplicationPackId';
import {
  createWorkspaceReplicationTransfers,
  type WorkspaceReplicationTransfers,
} from '@/workspaces/replication/transport/workspaceReplicationTransfers';
import { WorkspaceReplicationError } from '@/workspaces/replication/workspaceReplicationError';

import {
  buildSessionHandoffWorkspaceReplicationSourceOffer,
  createSessionHandoffWorkspaceReplicationMetadata,
  type SessionHandoffWorkspaceReplicationMetadata,
} from './sessionHandoffWorkspaceReplicationMetadata';
import {
  buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId,
} from './sessionHandoffWorkspaceReplicationDirectPeer';
import {
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  buildSessionHandoffWorkspaceBlobPackTransferId,
  buildSessionHandoffWorkspaceManifestTransferId,
  parseSessionHandoffWorkspaceBlobPackTransferId,
} from './sessionHandoffWorkspaceReplicationServerRouted';
import type { SessionHandoffProviderBundleTransferPublication } from '../sessionHandoffProviderBundleTransferPublication';

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
  type SessionHandoffWorkspaceReplicationMetadata,
};

export type SessionHandoffWorkspaceReplicationSourceOffer =
  Awaited<ReturnType<typeof buildSessionHandoffWorkspaceReplicationSourceOffer>>;

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function resolveSafeWorkspaceFilePath(params: Readonly<{
  workspaceRoot: string;
  relativePath: string;
}>): string | null {
  const rawRelativePath = params.relativePath.trim();
  if (!rawRelativePath) {
    return null;
  }
  if (rawRelativePath.includes('\0')) {
    return null;
  }
  const absolutePath = resolve(params.workspaceRoot, rawRelativePath);
  const rel = relative(params.workspaceRoot, absolutePath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    return null;
  }
  // Fail closed: disallow Windows-style absolute paths and any backslash segments.
  if (rel.startsWith('\\') || rel.includes('\\')) {
    return null;
  }
  return absolutePath;
}

const TERMINAL_WORKSPACE_REPLICATION_JOB_STATUSES = new Set<string>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

type WorkspaceReplicationJobStatus =
  Awaited<ReturnType<ReturnType<typeof createWorkspaceReplicationEngine>['getJobStatus']>>;

async function waitForTerminalWorkspaceReplicationJob(params: Readonly<{
  engine: ReturnType<typeof createWorkspaceReplicationEngine>;
  jobId: string;
  assertCanContinue?: () => Promise<void>;
}>): Promise<WorkspaceReplicationJobStatus> {
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
  sourceRootPath: string;
  activeServerDir: string;
  workspaceTransfer: SessionHandoffWorkspaceTransfer;
}>): Promise<Readonly<{
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
}>> {
  const workspaceExportArtifacts = await buildWorkspaceExportArtifactsWithSourceController({
    sourcePath: input.sourceRootPath,
    workspaceTransfer: input.workspaceTransfer,
  });
  const workspaceReplicationMetadata = createSessionHandoffWorkspaceReplicationMetadata({
    sourceRootPath: input.sourceRootPath,
    workspaceExportArtifacts,
  });

  return {
    ...(workspaceReplicationMetadata ? { workspaceReplicationMetadata } : {}),
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
  machineTransferChannel?: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
  serverRoutedTransferTimeoutMs?: number;
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

      const baselineStore = createWorkspaceReplicationBaselineStore({
        activeServerDir: input.activeServerDir,
      });
      const requestedStrategy = workspaceTransfer.strategy;
      const effectiveStrategy =
        requestedStrategy === 'sync_changes'
          ? (await baselineStore.load(scope) ? 'sync_changes' : 'transfer_snapshot')
          : requestedStrategy;
      const effectiveConflictPolicy =
        requestedStrategy === 'sync_changes' && effectiveStrategy === 'transfer_snapshot'
          ? 'create_sibling_copy'
          : workspaceTransfer.conflictPolicy;

      const { jobId } = await engine.startJobFromOffer({
        scope,
        sourceOffer: resolvedSourceOffer,
        correlationId,
        apply: {
          targetPath: input.targetPath,
          strategy: effectiveStrategy,
          conflictPolicy: effectiveConflictPolicy,
        },
        requestBlobPackToFile: async ({ packId, digests, destinationPath }) => {
          if (input.actualTransportStrategy === 'server_routed_stream' && input.machineTransferChannel) {
            await input.transfers.requestServerRoutedBlobPackToFile({
              transferId: buildSessionHandoffWorkspaceBlobPackTransferId({
                handoffId: input.handoffId,
                packId,
              }),
              sourceMachineId: input.sourceMachineId,
              machineTransferChannel: input.machineTransferChannel,
              destinationPath,
              openBody: {
                t: 'workspace_replication_blob_pack_v1',
                packId,
                digests: [...digests],
                ...(typeof input.serverRoutedTransferTimeoutMs === 'number'
                  ? { timeoutMs: input.serverRoutedTransferTimeoutMs }
                  : {}),
              },
              ...(typeof input.serverRoutedTransferTimeoutMs === 'number'
                ? { timeoutMs: input.serverRoutedTransferTimeoutMs }
                : {}),
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
              ...(typeof input.serverRoutedTransferTimeoutMs === 'number'
                ? { timeoutMs: input.serverRoutedTransferTimeoutMs }
                : {}),
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
  providerBundleTransferPublication?: SessionHandoffProviderBundleTransferPublication;
}>): Promise<Readonly<{
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>> {
  const workspaceTransferEnabled = input.workspaceTransfer?.enabled === true;
  const workspaceReplicationState = workspaceTransferEnabled
    ? await createSessionHandoffWorkspaceReplicationState({
      handoffId: input.handoffId,
      sourceRootPath: input.sourceRootPath,
      activeServerDir: input.activeServerDir,
      workspaceTransfer: input.workspaceTransfer,
    })
    : null;
  const workspaceReplicationMetadata = workspaceReplicationState?.workspaceReplicationMetadata;

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

  const workspaceReplicationManifestTransferPublication =
    workspaceReplicationMetadata && input.workspaceTransfer?.enabled
      ? (() => {
          const transferId = buildSessionHandoffWorkspaceManifestTransferId({
            handoffId: input.handoffId,
          });
          const carrierCandidates = providerBundleTransferPublication?.endpointCandidates;
          const endpointCandidates =
            input.negotiatedTransportStrategy === 'direct_peer' && carrierCandidates?.length
              ? rewriteDirectPeerEndpointCandidatesForTransferId({
                  endpointCandidates: carrierCandidates,
                  transferId,
                })
              : undefined;

          return {
            transferId,
            ...(endpointCandidates ? { endpointCandidates } : {}),
          };
        })()
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
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
  };
}

export function createSessionHandoffWorkspaceReplicationAdapter(): Readonly<{
  createReplicationTransfers: typeof createWorkspaceReplicationTransfers;
  createState: typeof createSessionHandoffWorkspaceReplicationState;
  resolveSourceOffer: typeof resolveSessionHandoffWorkspaceReplicationSourceOffer;
  prepareTargetWorkspace: typeof prepareSessionHandoffWorkspaceTarget;
  prepareSourceWorkspaceTransfer: typeof prepareSessionHandoffSourceWorkspaceTransfer;
  createBlobPackPayloadSourceFromManifest: (input: Readonly<{
    activeServerDir: string;
    packId: string;
    digests: readonly string[];
    sourceRootPath: string;
    manifest: WorkspaceManifest;
  }>) => Promise<TransferPayloadSource>;
  persistBaselineFromManifest: (input: Readonly<{
    activeServerDir: string;
    scope: Readonly<{
      sourceMachineId: string;
      sourceWorkspaceRoot: string;
      targetMachineId: string;
      targetWorkspaceRoot: string;
      mode: 'one_way_safe';
    }>;
    manifest: WorkspaceManifest;
    savedAtMs: number;
  }>) => Promise<void>;
  readWorkspaceReplicationJobStatus: (input: Readonly<{
    activeServerDir: string;
    localMachineId?: string;
    jobId: string;
  }>) => Promise<WorkspaceReplicationJobStatus | null>;
  abortWorkspaceReplicationJob: (input: Readonly<{
    activeServerDir: string;
    localMachineId?: string;
    jobId: string;
  }>) => Promise<void>;
}> {
  return {
    createReplicationTransfers: createWorkspaceReplicationTransfers,
    createState: createSessionHandoffWorkspaceReplicationState,
    resolveSourceOffer: resolveSessionHandoffWorkspaceReplicationSourceOffer,
    prepareTargetWorkspace: prepareSessionHandoffWorkspaceTarget,
    prepareSourceWorkspaceTransfer: prepareSessionHandoffSourceWorkspaceTransfer,
    createBlobPackPayloadSourceFromManifest: async (input) => {
      assertWorkspaceReplicationDigestsAllowedByManifest(input.manifest, input.digests);
      return await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: input.activeServerDir,
        packId: input.packId,
        digests: input.digests,
        sourceRootPath: input.sourceRootPath,
        manifest: input.manifest,
      });
    },
    persistBaselineFromManifest: async (input) => {
      const offer = await createWorkspaceReplicationSourceOfferFromManifest({
        activeServerDir: input.activeServerDir,
        source: { machineId: input.scope.sourceMachineId, rootPath: input.scope.sourceWorkspaceRoot },
        target: { machineId: input.scope.targetMachineId, rootPath: input.scope.targetWorkspaceRoot },
        mode: input.scope.mode,
        manifest: input.manifest,
      });
      const baselineStore = createWorkspaceReplicationBaselineStore({
        activeServerDir: input.activeServerDir,
      });
      await baselineStore.save({
        scope: input.scope,
        baseline: {
          manifestFingerprint: offer.sourceFingerprint,
          manifest: offer.manifest,
          savedAtMs: input.savedAtMs,
        },
      });
    },
    readWorkspaceReplicationJobStatus: async (input) => {
      const engine = createWorkspaceReplicationEngine({
        activeServerDir: input.activeServerDir,
        localMachineId: input.localMachineId ?? 'machine_unknown',
      });

      try {
        return await engine.getJobStatus(input.jobId);
      } catch (error) {
        if (error instanceof WorkspaceReplicationError && error.code === 'job_not_found') {
          return null;
        }
        throw error;
      }
    },
    abortWorkspaceReplicationJob: async (input) => {
      const engine = createWorkspaceReplicationEngine({
        activeServerDir: input.activeServerDir,
        localMachineId: input.localMachineId ?? 'machine_unknown',
      });
      await engine.abortJob(input.jobId);
    },
  };
}
