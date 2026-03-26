import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import {
  type AgentRuntimeDescriptorV1,
  DirectSessionsSourceSchema,
  type MachineTransferReceiveEnvelope,
  type MachineTransferSendEnvelope,
  type SessionHandoffMetadataV2,
  type SessionHandoffPrepareTargetRequest,
  SessionHandoffPrepareTargetResultGetRequestSchema,
  type SessionHandoffPrepareTargetResultGetResponse,
  type SessionHandoffStartRequest,
  type TransferEndpointCandidate,
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetRequestSchema,
  type SessionHandoffResumePlan,
  type SessionHandoffWorkspaceTransfer,
  SessionHandoffStartRequestSchema,
  SessionHandoffStatusGetRequestSchema,
  type SessionHandoffStatus,
  type WorkspaceManifest,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  registerServerRoutedTransferResponder,
  requestServerRoutedTransferToFile,
  resolveServerRoutedTransferTimeoutMs,
  type MachineTransferChannel,
  ServerRoutedInvalidOpenRequestError,
  ServerRoutedAbortTransferError,
} from '../../machines/transfer/serverRoutedTransport';
import type { DirectPeerOnDemandTransferScope } from '../../machines/transfer/directPeerTransport';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
import { createMachineTransferRouteCache } from '../../machines/transfer/transferRouteCache';
import {
  disposeTransferPayloadSource,
  createFileTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from '../../machines/transfer/transferPayloadSource';
import {
  exportSessionHandoffState,
} from '../../session/handoff/exportSessionHandoffState';
import { importSessionHandoffProviderBundle } from '../../session/handoff/importSessionHandoffProviderBundle';
import {
  resolveSessionHandoffExportMetadata,
  type SessionHandoffLocalMetadataSource,
} from '../../session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import {
  createSessionHandoffProviderBundlePayloadSource,
  readSessionHandoffProviderBundleFile,
} from '../../session/handoff/sessionHandoffProviderBundleFile';
import { normalizeSessionHandoffTargetPathForLocalMachine } from '../../session/handoff/paths/sessionHandoffPathNormalization';
import { createSessionHandoffSourceExportStore } from '../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  buildSessionHandoffProviderBundleTransferId,
  parseSessionHandoffProviderBundleTransferId,
  type SessionHandoffProviderBundleTransferPublication,
} from '../../session/handoff/sessionHandoffProviderBundleTransferPublication';
import { validateSessionHandoffWorkspaceTransferSourcePath } from '../../session/handoff/validateSessionHandoffWorkspaceTransferSourcePath';
import { validateSessionHandoffWorkspaceTransferStrategy } from '../../session/handoff/validateSessionHandoffWorkspaceTransferStrategy';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  resolveSessionHandoffWorkspaceReplicationSourceOffer,
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';
import {
  createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope,
  parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId,
} from '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationDirectPeer';
import { assertSafeHandoffWorkspaceReplicationPackId } from '../../session/handoff/workspaceReplicationAdapter/assertSafeHandoffWorkspaceReplicationPackId';
import {
  parseSessionHandoffWorkspaceManifestTransferId,
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../session/handoff/workspaceReplicationAdapter/workspaceReplicationManifestFile';
import { parseWorkspaceReplicationBlobPackRequestV1 } from '../../workspaces/replication/transport/workspaceReplicationBlobPackRequestV1';
import { buildWorkspaceReplicationManifestDigestIndex } from '../../workspaces/replication/transport/workspaceReplicationManifestIndex';
import { assertWorkspaceReplicationBlobPackRequestWithinLimits } from '../../workspaces/replication/transport/assertWorkspaceReplicationBlobPackRequestWithinLimits';
import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import {
  releaseSessionHandoffPrepareTargetJobLease,
  resolveSessionHandoffPrepareTargetJobLeaseTtlMs,
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from '../../session/handoff/prepare/sessionHandoffPrepareTargetJobLease';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SessionHandoffProviderBundle } from '../../session/handoff/types';
import { compareWorkspaceManifests } from '../../scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';
const PREPARE_JOB_FAST_PATH_BUDGET_MS = 250;
// Status polling can race against the background prepare runner acquiring its durable lease and
// writing the runner heartbeat marker. Avoid incorrectly flipping a freshly (re)started job into
// `awaiting_recovery` in that window.
const PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS = 2_000;

type StoredHandoffState = Readonly<{
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

type SessionHandoffExportBundleResult = Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
}>;

export type SessionHandoffDirectPeerTransferHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: Readonly<Record<never, never>>;
    payloadSource?: TransferPayloadSource;
    onDemandScope?: DirectPeerOnDemandTransferScope;
  }>) => readonly TransferEndpointCandidate[];
  requestPayloadFile?: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
  }>) => Promise<Readonly<{ destinationPath: string }>>;
  clearPublishedTransfer: (transferId: string) => void;
}>;

function invalidRequest() {
  return { ok: false, errorCode: 'invalid_request' } as const;
}

function buildStartRecoveryStatus(handoffId: string): SessionHandoffStatus {
  return {
    handoffId,
    status: 'awaiting_recovery',
    phase: 'preparing',
    recoveryActions: ['restart_on_source', 'keep_stopped'],
  };
}

function buildStartPendingStatus(input: Readonly<{
  handoffId: string;
  sourceStopState: 'stopped' | 'already_inactive';
}>): SessionHandoffStatus {
  return {
    handoffId: input.handoffId,
    status: 'pending',
    phase: 'preparing',
    recoveryActions: input.sourceStopState === 'stopped' ? ['restart_on_source', 'keep_stopped'] : [],
  };
}

function resolveSessionHandoffTargetPathFromMetadata(metadata: Record<string, unknown>): string | null {
  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  return targetPath.length > 0 ? targetPath : null;
}

function normalizeHandoffWorkspaceRootPath(raw: unknown): string | null {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (!candidate.startsWith('/')) return null;
  if (candidate.includes('\0')) return null;
  const segments = candidate.split('/').filter(Boolean).filter((segment) => segment !== '.');
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '..')) return null;
  return `/${segments.join('/')}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveWorkspaceReplicationHandoffBackTargetRootPath(input: Readonly<{
  metadata: Record<string, unknown>;
  workspaceTransfer: SessionHandoffStartRequest['workspaceTransfer'] | undefined;
  requestedTargetMachineId: string;
}>): string | null {
  if (input.workspaceTransfer?.enabled !== true) return null;
  if (input.workspaceTransfer.strategy !== 'sync_changes') return null;

  const handoff = asRecord(input.metadata.handoffV1);
  if (!handoff) return null;

  const priorSourceMachineId = typeof handoff.sourceMachineId === 'string' ? handoff.sourceMachineId.trim() : '';
  if (!priorSourceMachineId) return null;
  if (priorSourceMachineId !== input.requestedTargetMachineId) return null;

  return normalizeHandoffWorkspaceRootPath(handoff.sourceWorkspaceRootPath);
}

function directPeerTransferUnavailable() {
  return {
    ok: false,
    errorCode: 'direct_peer_transfer_unavailable',
    error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
  } as const;
}

function missingHandoffMetadataV2() {
  return {
    ok: false,
    errorCode: 'missing_handoff_metadata_v2',
    error: 'Handoff metadata V2 is required to prepare the target',
  } as const;
}

function isMachineTransferTimeoutErrorMessage(message: string): boolean {
  return message.startsWith('Timed out waiting for machine transfer ');
}

function buildPrepareJobId(handoffId: string): string {
  // Prepare-target jobs should be stable per handoff so concurrent daemons contend on the same
  // lease key (avoid double-import when no durable job record exists yet).
  return `prepare_${handoffId}`;
}

function buildSourceExportOnlyPrepareJobId(handoffId: string): string {
  // Source-only (export/abort/source_cleanup) flows can still publish terminal status durably by
  // using a deterministic synthetic job id.
  return `source_${handoffId}`;
}

function isTerminalHandoffStatus(status: SessionHandoffStatus): boolean {
  return status.status === 'ready_for_cutover'
    || status.status === 'completed'
    || status.status === 'aborted'
    || status.status === 'failed'
    || status.status === 'awaiting_recovery';
}

function buildPreparePendingStatus(input: Readonly<{
  handoffId: string;
  jobId: string;
  transportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  recoveryActions: SessionHandoffStatus['recoveryActions'];
  phaseDetail: string;
}>): SessionHandoffStatus {
  return {
    handoffId: input.handoffId,
    jobId: input.jobId,
    status: 'pending',
    phase: 'staging_target',
    transportStrategy: input.transportStrategy,
    recoveryActions: [...input.recoveryActions],
    progress: {
      updatedAtMs: Date.now(),
      checkpoint: 'stage_target',
      planned: {},
      transferred: {},
      current: {
        phaseDetail: input.phaseDetail,
      },
      resumable: false,
    },
  };
}

function mapWorkspaceReplicationJobCheckpointToHandoffCheckpoint(
  checkpoint: string,
): NonNullable<SessionHandoffStatus['progress']>['checkpoint'] {
  switch (checkpoint) {
    case 'job_created':
    case 'relationship_resolved':
    case 'missing_digests_negotiated':
      return 'plan';
    case 'blob_transfer_started':
      return 'transfer_blobs';
    case 'blob_transfer_completed':
      return 'stage_target';
    case 'apply_started':
    case 'apply_completed':
      return 'apply';
    case 'baseline_committed':
      return 'finalize';
    default:
      return 'plan';
  }
}

function mergeWorkspaceReplicationProgressIntoHandoffStatus(params: Readonly<{
  baseStatus: SessionHandoffStatus;
  job: Readonly<{
    updatedAtMs: number;
    status: Readonly<{
      checkpoint: string;
      phase: string;
      progressCounters: Readonly<{
        plannedFiles: number;
        plannedBytes: number;
        transferredFiles: number;
        transferredBytes: number;
      }>;
    }>;
  }>;
}>): SessionHandoffStatus {
  const baseProgress = params.baseStatus.progress;
  const counters = params.job.status.progressCounters;
  const checkpoint = mapWorkspaceReplicationJobCheckpointToHandoffCheckpoint(params.job.status.checkpoint);

  return {
    ...params.baseStatus,
    progress: {
      updatedAtMs: params.job.updatedAtMs,
      checkpoint,
      planned: {
        totalFiles: counters.plannedFiles,
        totalBytes: counters.plannedBytes,
      },
      transferred: {
        files: counters.transferredFiles,
        bytes: counters.transferredBytes,
      },
      current: {
        ...(baseProgress?.current ?? {}),
        phaseDetail: `workspace_replication:${params.job.status.phase}`,
      },
      resumable: baseProgress?.resumable ?? false,
    },
  };
}

function buildWorkspaceReplicationStatusProgress(params: Readonly<{
  previousManifest: WorkspaceManifest;
  nextManifest: WorkspaceManifest;
  blobCount: number;
  checkpoint: NonNullable<SessionHandoffStatus['progress']>['checkpoint'];
  phaseDetail: string;
}>): Pick<SessionHandoffStatus, 'progress' | 'workspacePreflightSummary'> {
  const comparison = compareWorkspaceManifests({
    previousManifest: params.previousManifest,
    nextManifest: params.nextManifest,
  });
  const transferredFileEntries = [
    ...comparison.added,
    ...comparison.changed.map((entry) => entry.next),
  ].filter((entry): entry is Extract<WorkspaceManifest['entries'][number], { kind: 'file' }> => entry.kind === 'file');
  const totalBytes = transferredFileEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  return {
    workspacePreflightSummary: {
      addedPathsCount: comparison.added.length,
      changedPathsCount: comparison.changed.length,
      removedPathsCount: comparison.removed.length,
      totalBytes,
    },
    progress: {
      updatedAtMs: Date.now(),
      checkpoint: params.checkpoint,
      planned: {
        totalFiles: transferredFileEntries.length,
        totalBytes,
        added: comparison.added.length,
        changed: comparison.changed.length,
        removed: comparison.removed.length,
      },
      transferred: {
        files: transferredFileEntries.length,
        bytes: totalBytes,
        blobs: params.blobCount,
      },
      current: {
        phaseDetail: params.phaseDetail,
      },
      resumable: false,
    },
  };
}

function buildPrepareJobRecord(input: Readonly<{
  jobId: string;
  handoffId: string;
  status: SessionHandoffStatus;
  prepareTargetRequest?: SessionHandoffPrepareTargetRequest;
  prepareTargetResult?: SessionHandoffPrepareTargetResultGetResponse;
  createdAtMs: number;
  updatedAtMs?: number;
  cancelRequestedAtMs?: number;
  abortedAtMs?: number;
  completedAtMs?: number;
  failedAtMs?: number;
  lastErrorMessage?: string;
  workspaceReplicationJobId?: string;
}>): SessionHandoffPrepareTargetJobRecordInput {
  return {
    jobId: input.jobId,
    handoffId: input.handoffId,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs ?? input.createdAtMs,
    ...(input.cancelRequestedAtMs ? { cancelRequestedAtMs: input.cancelRequestedAtMs } : {}),
    ...(input.abortedAtMs ? { abortedAtMs: input.abortedAtMs } : {}),
    ...(input.completedAtMs ? { completedAtMs: input.completedAtMs } : {}),
    ...(input.failedAtMs ? { failedAtMs: input.failedAtMs } : {}),
    ...(input.lastErrorMessage ? { lastErrorMessage: input.lastErrorMessage } : {}),
    ...(input.workspaceReplicationJobId ? { workspaceReplicationJobId: input.workspaceReplicationJobId } : {}),
    status: input.status,
    ...(input.prepareTargetRequest ? { prepareTargetRequest: input.prepareTargetRequest } : {}),
    ...(input.prepareTargetResult ? { prepareTargetResult: input.prepareTargetResult } : {}),
  };
}

async function readPersistedPrepareJob(params: Readonly<{
  handoffId: string;
  jobStore: ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
}>): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  return await params.jobStore.findByHandoffId(params.handoffId);
}

async function waitForPrepareJobFastPath(runPromise: Promise<void>): Promise<'completed' | 'pending'> {
  return await Promise.race([
    runPromise.then(() => 'completed' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), PREPARE_JOB_FAST_PATH_BUDGET_MS);
    }),
  ]);
}

function isDirectPeerTransferProtocolError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return error.message === 'Invalid session handoff transfer payload'
    || error.message.startsWith('Direct peer transfer manifest mismatch for ');
}

async function requestServerRoutedPrepareProviderBundle(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  machineTransferChannel: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel']>;
}>): Promise<SessionHandoffProviderBundle> {
  const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-provider-server-routed-'));
  const payloadFilePath = join(temporaryDirectory, 'provider-bundle.json');
  const timeoutMs =
    typeof configuration.filesTransferSessionTtlMs === 'number' && configuration.filesTransferSessionTtlMs > 0
      ? configuration.filesTransferSessionTtlMs
      : undefined;

  try {
    await requestServerRoutedTransferToFile({
      transferId: params.transferId,
      sourceMachineId: params.sourceMachineId,
      machineTransferChannel: params.machineTransferChannel,
      destinationPath: payloadFilePath,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return await readSessionHandoffProviderBundleFile(payloadFilePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolvePrepareProviderBundle(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferRouteCache?: ReturnType<typeof createMachineTransferRouteCache>;
}>): Promise<SessionHandoffProviderBundle | undefined> {
  const transferPublication = params.handoffMetadataV2?.providerBundleTransferPublication;
  if (!transferPublication) {
    if (params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel) {
      return await requestServerRoutedPrepareProviderBundle({
        transferId: buildSessionHandoffProviderBundleTransferId(params.request.handoffId),
        sourceMachineId: params.request.sourceMachineId,
        machineTransferChannel: params.machineTransferChannel,
      });
    }
    return undefined;
  }
  const transferEndpointCandidates = transferPublication.endpointCandidates ?? params.request.endpointCandidates;
  const allowServerRoutedFallback = params.request.allowServerRoutedFallback !== false;
  const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;

  const providerBundle =
    params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel
      ? await requestServerRoutedPrepareProviderBundle({
        transferId: transferPublication.transferId,
        sourceMachineId: params.request.sourceMachineId,
        machineTransferChannel: params.machineTransferChannel,
      })
      : params.actualTransportStrategy === 'direct_peer' && transferEndpointCandidates && params.directPeerTransfer?.requestPayloadFile
        ? await (async (): Promise<SessionHandoffProviderBundle> => {
          const endpointCandidates = transferEndpointCandidates.filter((candidate) => candidate.expiresAt >= Date.now());
          if (endpointCandidates.length === 0) {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              return await requestServerRoutedPrepareProviderBundle({
                transferId: transferPublication.transferId,
                sourceMachineId: params.request.sourceMachineId,
                machineTransferChannel: params.machineTransferChannel,
              });
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          const cachedRoute = params.transferRouteCache?.readDirectPeerRoute({
            remoteMachineId: params.request.sourceMachineId,
            endpointCandidates,
          });
          if (cachedRoute?.status === 'unavailable') {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              return await requestServerRoutedPrepareProviderBundle({
                transferId: transferPublication.transferId,
                sourceMachineId: params.request.sourceMachineId,
                machineTransferChannel: params.machineTransferChannel,
              });
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-provider-direct-peer-'));
          const payloadFilePath = join(temporaryDirectory, 'provider-bundle.json');
          try {
            try {
              await params.directPeerTransfer!.requestPayloadFile!({
                transferId: transferPublication.transferId,
                endpointCandidates,
                destinationPath: payloadFilePath,
              });
              params.transferRouteCache?.recordDirectPeerRouteViable({
                remoteMachineId: params.request.sourceMachineId,
                endpointCandidates,
              });
              return await readSessionHandoffProviderBundleFile(payloadFilePath);
            } catch (error) {
              if (isDirectPeerTransferProtocolError(error)) {
                throw error;
              }
              params.transferRouteCache?.recordDirectPeerRouteUnavailable(
                {
                  remoteMachineId: params.request.sourceMachineId,
                  endpointCandidates,
                },
                error instanceof Error ? error.message : 'Direct peer transfer failed',
              );
              if (canFallbackToServerRouted && params.machineTransferChannel) {
                return await requestServerRoutedPrepareProviderBundle({
                  transferId: transferPublication.transferId,
                  sourceMachineId: params.request.sourceMachineId,
                  machineTransferChannel: params.machineTransferChannel,
                });
              }
              throw new Error(directPeerTransferUnavailable().error);
            }
          } finally {
            await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        })()
        : undefined;

  if (!providerBundle) {
    return undefined;
  }

  return providerBundle;
}

async function resolvePrepareWorkspaceReplicationMetadata(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): Promise<SessionHandoffWorkspaceReplicationMetadata | undefined> {
  if (params.workspaceTransfer?.enabled !== true) {
    return undefined;
  }

  const transferPublication = params.handoffMetadataV2?.workspaceReplicationManifestTransferPublication;
  const sourceRootPath = params.handoffMetadataV2?.workspaceReplicationSourceRootPath;
  if (!transferPublication || !sourceRootPath) {
    return undefined;
  }

  const manifest =
    params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel
      ? await (async (): Promise<WorkspaceManifest> => {
        const machineTransferChannel = params.machineTransferChannel;
        if (!machineTransferChannel) {
          throw new Error(`Server-routed transfer is unavailable for ${transferPublication.transferId}`);
        }
        const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
        const payloadFilePath = join(temporaryDirectory, 'workspace-manifest.txt');
        try {
          const timeoutMs =
            typeof configuration.filesTransferSessionTtlMs === 'number' && configuration.filesTransferSessionTtlMs > 0
              ? configuration.filesTransferSessionTtlMs
              : undefined;
          const received = await requestServerRoutedTransferToFile({
            transferId: transferPublication.transferId,
            sourceMachineId: params.request.sourceMachineId,
            machineTransferChannel,
            destinationPath: payloadFilePath,
            ...(timeoutMs ? { timeoutMs } : {}),
          });
          return await readWorkspaceReplicationManifestFromFile({
            transferId: transferPublication.transferId,
            filePath: received.destinationPath,
            sizeBytes: received.sizeBytes,
          });
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      })()
      : params.actualTransportStrategy === 'direct_peer'
        ? await (async (): Promise<WorkspaceManifest> => {
          const endpointCandidates =
            transferPublication.endpointCandidates
            ?? (params.request.endpointCandidates.length
              ? rewriteDirectPeerEndpointCandidatesForTransferId({
                  endpointCandidates: params.request.endpointCandidates,
                  transferId: transferPublication.transferId,
                })
              : undefined);
          const requestedFilePayload = params.directPeerTransfer?.requestPayloadFile;
          if (!endpointCandidates?.length || !requestedFilePayload) {
            throw new Error(`Direct peer transfer is unavailable for ${transferPublication.transferId}`);
          }
          const filteredEndpointCandidates = endpointCandidates.filter((candidate) => candidate.expiresAt >= Date.now());
          const allowServerRoutedFallback = params.request.allowServerRoutedFallback !== false;
          const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;
          const timeoutMs =
            typeof configuration.filesTransferSessionTtlMs === 'number' && configuration.filesTransferSessionTtlMs > 0
              ? configuration.filesTransferSessionTtlMs
              : undefined;
          if (filteredEndpointCandidates.length === 0) {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              const temporaryServerRoutedDirectory =
                await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
              const serverRoutedPath = join(temporaryServerRoutedDirectory, 'workspace-manifest.txt');
              try {
                const received = await requestServerRoutedTransferToFile({
                  transferId: transferPublication.transferId,
                  sourceMachineId: params.request.sourceMachineId,
                  machineTransferChannel: params.machineTransferChannel,
                  destinationPath: serverRoutedPath,
                  ...(timeoutMs ? { timeoutMs } : {}),
                });
                return await readWorkspaceReplicationManifestFromFile({
                  transferId: transferPublication.transferId,
                  filePath: received.destinationPath,
                  sizeBytes: received.sizeBytes,
                });
              } finally {
                await rm(temporaryServerRoutedDirectory, { recursive: true, force: true }).catch(() => undefined);
              }
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-direct-peer-'));
          const payloadFilePath = join(temporaryDirectory, 'workspace-manifest.txt');
          try {
            try {
              const received = await requestedFilePayload({
                transferId: transferPublication.transferId,
                endpointCandidates: filteredEndpointCandidates,
                destinationPath: payloadFilePath,
              });
              return await readWorkspaceReplicationManifestFromFile({
                transferId: transferPublication.transferId,
                filePath: received.destinationPath,
              });
            } catch (error) {
              if (isDirectPeerTransferProtocolError(error)) {
                throw error;
              }
              if (canFallbackToServerRouted && params.machineTransferChannel) {
                const temporaryServerRoutedDirectory =
                  await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
                const serverRoutedPath = join(temporaryServerRoutedDirectory, 'workspace-manifest.txt');
                try {
                  const received = await requestServerRoutedTransferToFile({
                    transferId: transferPublication.transferId,
                    sourceMachineId: params.request.sourceMachineId,
                    machineTransferChannel: params.machineTransferChannel,
                    destinationPath: serverRoutedPath,
                    ...(timeoutMs ? { timeoutMs } : {}),
                  });
                  return await readWorkspaceReplicationManifestFromFile({
                    transferId: transferPublication.transferId,
                    filePath: received.destinationPath,
                    sizeBytes: received.sizeBytes,
                  });
                } finally {
                  await rm(temporaryServerRoutedDirectory, { recursive: true, force: true }).catch(() => undefined);
                }
              }
              throw new Error(directPeerTransferUnavailable().error);
            }
          } finally {
            await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        })()
        : (() => {
          throw new Error(`Unexpected workspace replication manifest request (${params.actualTransportStrategy})`);
        })();

  return {
    sourceRootPath,
    manifest,
    ...(params.handoffMetadataV2?.workspaceReplicationSourceControllerMetadata
      ? { sourceControllerMetadata: params.handoffMetadataV2.workspaceReplicationSourceControllerMetadata }
      : {}),
  };
}

export function registerMachineSessionHandoffRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  loadSessionMetadata?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  stopSessionForHandoff?: (sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  exportSessionBundle?: (metadata: Record<string, unknown>) => Promise<Readonly<{
    providerBundle: SessionHandoffProviderBundle;
    targetPath: string;
  }>>;
  importSessionBundle?: (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): void {
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: configuration.activeServerDir,
  });
  const sourceExportStore = createSessionHandoffSourceExportStore({
    activeServerDir: configuration.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  // Used to restart prepare-target durable jobs when only status/result polling continues after a daemon restart.
  let restartPrepareTargetJobFromPersistedRequest: ((raw: unknown) => Promise<void>) | null = null;
  const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${randomUUID()}`;
  const prepareTargetJobLeaseTtlMs = resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  const prepareTargetJobRecoveryGraceMs = Math.min(
    PREPARE_TARGET_JOB_RECOVERY_GRACE_MAX_MS,
    Math.max(250, Math.floor(prepareTargetJobLeaseTtlMs / 4)),
  );
  const { rpcHandlerManager } = params;
  const transferRouteCache = createMachineTransferRouteCache({
    serverId: configuration.activeServerId,
  });
  const workspaceReplicationAdapter = createSessionHandoffWorkspaceReplicationAdapter();
  const workspaceReplicationTransfers = workspaceReplicationAdapter.createReplicationTransfers();
  const ephemeralServerRoutedPayloadSources = new Map<string, TransferPayloadSource>();

  const maybeRecoverPrepareTargetJobMissingRunner = async (
    job: SessionHandoffPrepareTargetJobRecord,
  ): Promise<SessionHandoffPrepareTargetJobRecord> => {
    if (
      job.status.phase !== 'staging_target'
      || (job.status.status !== 'pending' && job.status.status !== 'in_progress')
    ) {
      return job;
    }
    // If this daemon has an active in-memory runner, trust it and avoid any lease probing.
    if (activePrepareJobs.has(job.jobId)) {
      return job;
    }

    const nowMs = Date.now();
    if (job.updatedAtMs + prepareTargetJobRecoveryGraceMs > nowMs) {
      // Give the prepare runner time to acquire/renew its durable lease after a (re)start.
      return job;
    }
    const probeOwnerId = `status-probe:${process.pid}:${randomUUID()}`;
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir: configuration.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      nowMs,
      // Keep probe leases short so a crashed probe can't stall a real resume attempt.
      ttlMs: 5_000,
    });

    if (!leaseAttempt.acquired) {
      // Another daemon instance appears to hold the lease; keep the durable pending status.
      return job;
    }

    await releaseSessionHandoffPrepareTargetJobLease({
      activeServerDir: configuration.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
    }).catch(() => undefined);

    if (job.cancelRequestedAtMs) {
      // Preserve existing fail-closed behavior: if cancellation was requested and no runner/lease owner exists,
      // mark the job aborted immediately instead of attempting a restart.
    } else if (job.prepareTargetRequest && restartPrepareTargetJobFromPersistedRequest !== null) {
      // Restart in the background. Callers can keep polling status/result without issuing a second PREPARE_TARGET call.
      const restart = restartPrepareTargetJobFromPersistedRequest;
      void restart(job.prepareTargetRequest).catch(() => undefined);
      return job;
    }

    // With no active lease owner, the daemon cannot make forward progress without either:
    // 1) a persisted prepareTargetRequest (so we can restart), or
    // 2) a new PREPARE_TARGET call (so we can rehydrate the request inputs).
    // Fail closed into recovery instead of reporting a status with no runner.
    const recovered = await prepareJobStore.update(job.jobId, (current) => {
      const { schemaVersion: _schemaVersion, ...rest } = current;
      const previousProgress = rest.status.progress;
      const nextProgress = previousProgress
        ? {
          ...previousProgress,
          updatedAtMs: nowMs,
          current: {
            ...(previousProgress.current ?? {}),
            phaseDetail: 'daemon_restart_missing_runner',
          },
        }
        : previousProgress;

      const recoveryMessage = 'Daemon restarted while the handoff prepare-target job was in progress';

      if (rest.cancelRequestedAtMs) {
        return {
          ...rest,
          updatedAtMs: nowMs,
          abortedAtMs: rest.abortedAtMs ?? nowMs,
          status: {
            ...rest.status,
            status: 'aborted',
            ...(nextProgress ? { progress: nextProgress } : {}),
          },
          lastErrorMessage: rest.lastErrorMessage ?? recoveryMessage,
        };
      }

      return {
        ...rest,
        updatedAtMs: nowMs,
        failedAtMs: rest.failedAtMs ?? nowMs,
        status: {
          ...rest.status,
          status: 'awaiting_recovery',
          ...(nextProgress ? { progress: nextProgress } : {}),
        },
        lastErrorMessage: rest.lastErrorMessage ?? recoveryMessage,
      };
    });

    return recovered ?? job;
  };

	  const waitForPersistedSourceExport = async (
	    handoffId: string,
	    predicate: (record: NonNullable<Awaited<ReturnType<typeof sourceExportStore.load>>>) => boolean,
	  ): Promise<Awaited<ReturnType<typeof sourceExportStore.load>> | null> => {
	    const resolveTerminalAbortReason = (message?: string): string => {
	      const trimmed = typeof message === 'string' ? message.trim() : '';
	      const ineligibleMatch = /^Session is not eligible for handoff: ([a-z0-9_]+)$/u.exec(trimmed);
	      if (ineligibleMatch) {
	        return `handoff_ineligible:${ineligibleMatch[1]}`;
	      }
	      return 'handoff_source_export_failed';
	    };

	      // Waiting for a source-export record is not the same as "session TTL", but it *must* be long
	      // enough to cover deferred export on large repos.
	      //
	      // Important: server-routed transfers have a per-transfer timeout for the open/ack/chunk
	      // handshake. This wait budget must be derived from that timeout, not from unrelated
	      // app↔daemon file-transfer TTLs, or deferred exports can abort with `transfer_not_found`
	      // while still pending.
	      const serverRoutedTimeoutMs = resolveServerRoutedTransferTimeoutMs();
	      const timeoutMs = Math.max(1_000, serverRoutedTimeoutMs - 5_000);
	      const deadlineAtMs = Date.now() + timeoutMs;
		    let delayMs = 25;
	    while (Date.now() < deadlineAtMs) {
	      const record = await sourceExportStore.load(handoffId);
	      if (record && predicate(record)) {
	        return record;
	      }

	      const prepareJob = await prepareJobStore.findByHandoffId(handoffId).catch(() => null);
	      if (prepareJob && isTerminalHandoffStatus(prepareJob.status)) {
	        throw new ServerRoutedAbortTransferError(resolveTerminalAbortReason(prepareJob.lastErrorMessage));
	      }
		      await new Promise<void>((resolve) => {
		        setTimeout(resolve, delayMs);
		      });
		      delayMs = Math.min(2_000, Math.floor(delayMs * 1.5));
		    }
		    return null;
		  };

  const disposeEphemeralServerRoutedPayloadSourcesForHandoff = async (handoffId: string): Promise<void> => {
    for (const [transferId, payloadSource] of [...ephemeralServerRoutedPayloadSources.entries()]) {
      const blobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
      const manifestTransfer = parseSessionHandoffWorkspaceManifestTransferId(transferId);
      if (
        blobPackTransfer?.handoffId !== handoffId
        && manifestTransfer?.handoffId !== handoffId
      ) {
        continue;
      }
      ephemeralServerRoutedPayloadSources.delete(transferId);
      await disposeTransferPayloadSource(payloadSource).catch(() => undefined);
    }
  };
  const loadRemoteSessionMetadata =
    params.loadSessionMetadata ??
    (async (sessionId: string): Promise<Record<string, unknown> | null> => {
      const [{ readCredentials }, { fetchSessionById }, { tryDecryptSessionMetadata }] = await Promise.all([
        import('../../persistence'),
        import('@/session/transport/http/sessionsHttp'),
        import('@/session/transport/encryption/sessionEncryptionContext'),
      ]);
      const credentials = await readCredentials().catch(() => null);
      if (!credentials) return null;
      const rawSession = await fetchSessionById({ token: credentials.token, sessionId }).catch(() => null);
      if (!rawSession) return null;
      const metadata = tryDecryptSessionMetadata({ credentials, rawSession });
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
    });
  const loadLocalSessionMetadata =
    params.loadLocalSessionMetadata ??
    (async (): Promise<SessionHandoffLocalMetadataSource | null> => null);
  const loadSessionMetadata = async (
    sessionId: string,
    sourceMachineId?: string,
  ): Promise<Record<string, unknown> | null> => {
    const [localMetadata, remoteMetadata] = await Promise.all([
      loadLocalSessionMetadata(sessionId),
      loadRemoteSessionMetadata(sessionId),
    ]);
    return resolveSessionHandoffExportMetadata({
      remoteMetadata,
      localMetadata,
      ...(sourceMachineId ? { preferredLocalExportMachineId: sourceMachineId } : {}),
    });
  };
  const exportSessionBundle: (metadata: Record<string, unknown>) => Promise<SessionHandoffExportBundleResult> =
    params.exportSessionBundle ??
    (async (metadata: Record<string, unknown>) => {
      return await exportSessionHandoffState({
        metadata,
        activeServerDir: configuration.activeServerDir,
      });
    });
  const importSessionBundle =
    params.importSessionBundle ??
    (async (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') =>
      await importSessionHandoffProviderBundle({
        bundle,
        targetPath,
        sessionStorageMode,
      }));
  const shouldDeferSourcePreparation = (request: SessionHandoffStartRequest): boolean => {
    const crossMachine = request.sourceMachineId !== request.targetMachineId;
    const workspaceEnabled = request.workspaceTransfer?.enabled === true;
    if (!crossMachine || !workspaceEnabled) {
      return false;
    }

    const negotiated = request.negotiatedTransportStrategy;
    const isSupportedNegotiated =
      negotiated === undefined
      || negotiated === 'server_routed_stream'
      || negotiated === 'direct_peer';
    if (!isSupportedNegotiated) {
      return false;
    }

    const canUseServerRouted =
      params.machineTransferChannel !== undefined
      && request.preferredTransportStrategies.includes('server_routed_stream');
    const canUseDirectPeer =
      params.directPeerTransfer !== undefined
      && request.preferredTransportStrategies.includes('direct_peer')
      && (negotiated === undefined || negotiated === 'direct_peer');

    return canUseServerRouted || canUseDirectPeer;
  };
	  const prepareStartedHandoffState = async (input: Readonly<{
	    handoffId: string;
	    request: SessionHandoffStartRequest;
	    metadata: Record<string, unknown>;
	    sourceStopState: 'stopped' | 'already_inactive';
	    preExportedProviderBundle?: Readonly<{
	      providerBundle: SessionHandoffProviderBundle;
	      targetPath: string;
	      providerBundlePayloadSource?: TransferPayloadSource;
	      providerBundleTransferPublication?: SessionHandoffProviderBundleTransferPublication;
	    }>;
	  }>): Promise<Readonly<{
	    targetPath: string;
	    endpointCandidates: readonly TransferEndpointCandidate[];
	    nextState: StoredHandoffState;
	    providerBundlePayloadSource?: TransferPayloadSource;
			  }>> => {
		    let providerBundlePayloadSource: TransferPayloadSource | null =
		      input.preExportedProviderBundle?.providerBundlePayloadSource ?? null;
		    let providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication | null =
		      input.preExportedProviderBundle?.providerBundleTransferPublication ?? null;

			    try {
			      const exported = input.preExportedProviderBundle
			        ? {
			            providerBundle: input.preExportedProviderBundle.providerBundle,
			            targetPath: input.preExportedProviderBundle.targetPath,
		          }
		        : await exportSessionBundle(input.metadata);

          const persistedProviderBundle = await sourceExportStore.writeProviderBundleFile({
            handoffId: input.handoffId,
            providerBundle: exported.providerBundle,
          });

			      providerBundlePayloadSource =
			        providerBundlePayloadSource ?? createFileTransferPayloadSource({
                filePath: persistedProviderBundle.filePath,
                sizeBytes: persistedProviderBundle.sizeBytes,
                manifestHash: persistedProviderBundle.manifestHash,
              });

			      const providerBundleEndpointCandidates: TransferEndpointCandidate[] =
			        input.request.negotiatedTransportStrategy === 'direct_peer' && params.directPeerTransfer
			          ? (
			              providerBundleTransferPublication?.endpointCandidates?.length
			                ? [...providerBundleTransferPublication.endpointCandidates]
			                : [...params.directPeerTransfer.publishTransfer({
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

		      const preparedWorkspaceTransfer = await workspaceReplicationAdapter.prepareSourceWorkspaceTransfer({
		        handoffId: input.handoffId,
		        activeServerDir: configuration.activeServerDir,
		        negotiatedTransportStrategy: input.request.negotiatedTransportStrategy,
		        workspaceTransfer: input.request.workspaceTransfer,
		        directPeerTransfer: params.directPeerTransfer,
		        sourceRootPath: exported.targetPath,
		        providerBundleTransferPublication: providerBundleTransferPublication,
		      });

		      const workspaceReplicationMetadata = preparedWorkspaceTransfer.workspaceReplicationMetadata;
		      const workspaceTransferEnabled = input.request.workspaceTransfer?.enabled === true;
          const persistedWorkspaceManifest =
            workspaceTransferEnabled && workspaceReplicationMetadata
              ? await sourceExportStore.writeWorkspaceReplicationManifestFile({
                handoffId: input.handoffId,
                manifest: workspaceReplicationMetadata.manifest,
              })
              : undefined;

          await sourceExportStore.save({
            handoffId: input.handoffId,
            sessionId: input.request.sessionId,
            sourceMachineId: input.request.sourceMachineId,
            targetMachineId: input.request.targetMachineId,
            exportedAtMs: Date.now(),
            ...(workspaceReplicationMetadata?.sourceRootPath
              ? { workspaceSourceRootPath: workspaceReplicationMetadata.sourceRootPath }
              : { workspaceSourceRootPath: exported.targetPath }),
            providerBundle: persistedProviderBundle,
            ...(persistedWorkspaceManifest ? { workspaceManifest: persistedWorkspaceManifest } : {}),
          });

          const workspaceReplicationHandoffBackTargetRootPathForRequest =
            resolveWorkspaceReplicationHandoffBackTargetRootPath({
              metadata: input.metadata,
              workspaceTransfer: input.request.workspaceTransfer,
              requestedTargetMachineId: input.request.targetMachineId,
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
			                    ? { workspaceReplicationManifestTransferPublication: { transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId: input.handoffId }) } }
			                    : {})),
			              ...(workspaceReplicationMetadata?.sourceControllerMetadata
			                ? { workspaceReplicationSourceControllerMetadata: workspaceReplicationMetadata.sourceControllerMetadata }
			                : {}),
			            }
			          : undefined;

	      const status = buildStartPendingStatus({
	        handoffId: input.handoffId,
	        sourceStopState: input.sourceStopState,
      });

		        return {
		        targetPath: exported.targetPath,
		        endpointCandidates: [],
		        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
		          nextState: {
		            status,
		            sourceMachineId: input.request.sourceMachineId,
		            targetMachineId: input.request.targetMachineId,
		            ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
		            ...(preparedWorkspaceTransfer.workspaceReplicationMetadata
		              ? { workspaceReplicationMetadata: preparedWorkspaceTransfer.workspaceReplicationMetadata }
		              : {}),
		          ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
		            workspaceTransfer: input.request.workspaceTransfer,
		        },
		      };
			    } catch (error) {
			      if (providerBundleTransferPublication?.endpointCandidates?.length) {
			        params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
			      }
			      await disposeTransferPayloadSource(providerBundlePayloadSource);
			      throw error;
			    }
			  };

	  if (params.machineTransferChannel) {
	    registerServerRoutedTransferResponder({
	      machineTransferChannel: params.machineTransferChannel,
	      loadTransferPayloadSource: async (request) => {
	        const transferId = request.transferId;
	        const cachedPayloadSource = ephemeralServerRoutedPayloadSources.get(transferId);
	      if (cachedPayloadSource) {
	        return cachedPayloadSource;
	      }

		        const workspaceBlobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
		        if (workspaceBlobPackTransfer) {
		          const openBody = parseWorkspaceReplicationBlobPackRequestV1(request.openPayload, {
	              maxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
	            });
		          if (!openBody || openBody.packId !== workspaceBlobPackTransfer.packId) {
		            throw new ServerRoutedInvalidOpenRequestError('Invalid workspace blob-pack open payload');
		          }
	              const persistedSourceExport = await waitForPersistedSourceExport(
	                workspaceBlobPackTransfer.handoffId,
	                (record) => Boolean(record.workspaceManifest),
	              );
	              if (!persistedSourceExport?.workspaceManifest) {
	                return null;
	              }

	              let manifest: WorkspaceManifest;
	              try {
	                manifest = await readWorkspaceReplicationManifestFromFile({
	                  transferId: persistedSourceExport.workspaceManifest.transferId,
	                  filePath: persistedSourceExport.workspaceManifest.filePath,
	                  sizeBytes: persistedSourceExport.workspaceManifest.sizeBytes,
	                });
	              } catch {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }
	              const digestIndex = buildWorkspaceReplicationManifestDigestIndex(manifest);
	              try {
	                assertWorkspaceReplicationBlobPackRequestWithinLimits({
	                  digestIndex,
                  digests: openBody.digests,
                  blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
                  blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
                });
              } catch {
                throw new ServerRoutedInvalidOpenRequestError('Invalid workspace blob-pack open payload');
	              }

	              const sourceRootPath = persistedSourceExport.workspaceSourceRootPath;
	              if (!sourceRootPath) {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }

	              let payloadSource: TransferPayloadSource;
	              try {
	                payloadSource = await workspaceReplicationAdapter.createBlobPackPayloadSourceFromManifest({
	                  activeServerDir: configuration.activeServerDir,
	                  packId: workspaceBlobPackTransfer.packId,
	                  digests: openBody.digests,
	                  sourceRootPath,
	                  manifest,
	                });
	              } catch {
	                throw new ServerRoutedAbortTransferError('workspace_replication_source_error');
	              }
		          // Do not cache: the responder owns disposal for blob-pack payload sources, and cache reuse
		          // can cause retries to attempt reusing a disposed file handle/path.
		          return payloadSource;
		        }

        const workspaceManifestTransfer = parseSessionHandoffWorkspaceManifestTransferId(transferId);
        if (workspaceManifestTransfer) {
          const persisted = await waitForPersistedSourceExport(
            workspaceManifestTransfer.handoffId,
            (record) => Boolean(record.workspaceManifest),
          );
          if (persisted?.workspaceManifest) {
            const payloadSource = createFileTransferPayloadSource({
              filePath: persisted.workspaceManifest.filePath,
              sizeBytes: persisted.workspaceManifest.sizeBytes,
              manifestHash: persisted.workspaceManifest.manifestHash,
            });
            ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
            return payloadSource;
          }
          return null;
        }

	        const providerBundleTransfer = parseSessionHandoffProviderBundleTransferId(transferId);
	        if (providerBundleTransfer) {
          const persisted = await waitForPersistedSourceExport(
            providerBundleTransfer.handoffId,
            (record) => Boolean(record.providerBundle),
          );
          if (persisted?.providerBundle) {
            return createFileTransferPayloadSource({
              filePath: persisted.providerBundle.filePath,
              sizeBytes: persisted.providerBundle.sizeBytes,
              manifestHash: persisted.providerBundle.manifestHash,
            });
          }
          return null;
	        }
	        return null;
	      },
    });
  }

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, async (raw: unknown) => {
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const metadata = await loadSessionMetadata(parsed.data.sessionId, parsed.data.sourceMachineId);
    if (!metadata) {
      return { ok: false, errorCode: 'session_not_found' } as const;
    }
    const workspaceTransferValidation = validateSessionHandoffWorkspaceTransferSourcePath({
      metadata,
      fallbackSourceHomeDir: os.homedir(),
      workspaceTransfer: parsed.data.workspaceTransfer,
    });
    if (!workspaceTransferValidation.ok) {
      return workspaceTransferValidation;
    }
    const workspaceTransferStrategyValidation = validateSessionHandoffWorkspaceTransferStrategy({
      workspaceTransfer: parsed.data.workspaceTransfer,
      negotiatedTransportStrategy: parsed.data.negotiatedTransportStrategy,
      hasServerRoutedTransferChannel: params.machineTransferChannel !== undefined,
      hasDirectPeerTransfer: params.directPeerTransfer !== undefined,
      allowLocalPrepareReuse: true,
    });
    if (!workspaceTransferStrategyValidation.ok) {
      return workspaceTransferStrategyValidation;
    }

    const workspaceReplicationHandoffBackTargetRootPath =
      resolveWorkspaceReplicationHandoffBackTargetRootPath({
        metadata,
        workspaceTransfer: parsed.data.workspaceTransfer,
        requestedTargetMachineId: parsed.data.targetMachineId,
      }) ?? undefined;

    const handoffId = `handoff_${randomUUID()}`;
    const shouldDefer = shouldDeferSourcePreparation(parsed.data);
    const sourceStopState =
      shouldDefer
        ? 'already_inactive'
        : (params.stopSessionForHandoff
          ? await params.stopSessionForHandoff(parsed.data.sessionId)
          : 'already_inactive');
    if (!shouldDefer && sourceStopState === 'failed') {
      return {
        ok: false,
        errorCode: 'source_stop_failed',
        error: 'Failed to stop the active source session before handoff cutover',
      } as const;
    }
		    const pendingStatus = buildStartPendingStatus({
		      handoffId,
		      sourceStopState: sourceStopState === 'failed' ? 'already_inactive' : sourceStopState,
		    });
			    if (shouldDefer) {
			      const targetPath = resolveSessionHandoffTargetPathFromMetadata(metadata);
			      if (!targetPath) {
		        return {
		          ok: false,
		          errorCode: 'source_export_failed',
		          error: 'Session path is unavailable for handoff',
		        } as const;
		      }

			      // Persist a minimal durable marker so `status.get` can immediately report "pending"
			      // for deferred handoffs (instead of racing to `not_found` before export writes).
			      await sourceExportStore.save({
			        handoffId,
              sessionId: parsed.data.sessionId,
			        sourceMachineId: parsed.data.sourceMachineId,
			        targetMachineId: parsed.data.targetMachineId,
			        exportedAtMs: Date.now(),
			        workspaceSourceRootPath: targetPath,
			      });

			      const isDirectPeerDeferredStart =
			        parsed.data.negotiatedTransportStrategy === 'direct_peer'
			        && parsed.data.preferredTransportStrategies.includes('direct_peer')
			        && params.directPeerTransfer !== undefined
		        // If server-routed fallback is available, do not block start() on direct-peer publications.
		        // Prepare-target can fall back to server-routed until the async export finishes.
		        && !(params.machineTransferChannel !== undefined
		          && parsed.data.preferredTransportStrategies.includes('server_routed_stream'));

		      let preExportedProviderBundle:
		        | {
		            providerBundle: SessionHandoffProviderBundle;
		            targetPath: string;
		            providerBundlePayloadSource: TransferPayloadSource;
		            providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication;
		          }
		        | undefined;

	      const deferredHandoffMetadataV2: SessionHandoffMetadataV2 | undefined =
	        parsed.data.workspaceTransfer?.enabled === true
	          ? {
	              workspaceReplicationSourceRootPath: targetPath,
	              ...(workspaceReplicationHandoffBackTargetRootPath
	                ? { workspaceReplicationHandoffBackTargetRootPath: workspaceReplicationHandoffBackTargetRootPath }
	                : {}),
	              workspaceReplicationManifestTransferPublication: {
	                transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId }),
	              },
	            }
	          : undefined;

		      if (isDirectPeerDeferredStart) {
		        const exported = await exportSessionBundle(metadata);
            const persistedProviderBundle = await sourceExportStore.writeProviderBundleFile({
              handoffId,
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
	        const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId });

            await sourceExportStore.save({
              handoffId,
              sessionId: parsed.data.sessionId,
              sourceMachineId: parsed.data.sourceMachineId,
              targetMachineId: parsed.data.targetMachineId,
              exportedAtMs: Date.now(),
              workspaceSourceRootPath: exported.targetPath,
              providerBundle: persistedProviderBundle,
            });

	        let cachedWorkspaceScope: DirectPeerOnDemandTransferScope | null = null;
	        const carrierCandidates = [
	          ...params.directPeerTransfer.publishTransfer({
	            transferId: providerBundleTransferId,
	            payload: {},
	            payloadSource: providerBundlePayloadSource,
	            onDemandScope: {
	              allowTransferId: (transferId) => {
	                if (transferId === manifestTransferId) {
	                  return true;
	                }
	                const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
	                if (!parsed || parsed.handoffId !== handoffId) {
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
                      const persisted = await waitForPersistedSourceExport(
                        handoffId,
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
		                    handoffId,
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
	          parsed.data.workspaceTransfer?.enabled === true
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

		        if (deferredHandoffMetadataV2) {
		          deferredHandoffMetadataV2.providerBundleTransferPublication = preExportedProviderBundle.providerBundleTransferPublication;
		          if (manifestEndpointCandidates?.length) {
		            deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication = {
		              ...(deferredHandoffMetadataV2.workspaceReplicationManifestTransferPublication ?? { transferId: manifestTransferId }),
		              endpointCandidates: manifestEndpointCandidates,
		            };
		          }
		        }
		      }

		      void (async () => {
		        const actualSourceStopState =
		          params.stopSessionForHandoff
		            ? await params.stopSessionForHandoff(parsed.data.sessionId)
		            : 'already_inactive';
		        if (actualSourceStopState === 'failed') {
		          throw new Error('Failed to stop the active source session before handoff cutover');
		        }
		        await prepareStartedHandoffState({
		          handoffId,
		          request: parsed.data,
		          metadata,
		          sourceStopState: actualSourceStopState,
		          ...(preExportedProviderBundle ? { preExportedProviderBundle } : {}),
		        });
		      })().catch((error) => {
		        const nowMs = Date.now();
		        const jobId = `start_${handoffId}`;
		        const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
		        void prepareJobStore.write({
		          jobId,
		          handoffId,
		          createdAtMs: nowMs,
		          updatedAtMs: nowMs,
		          failedAtMs: nowMs,
		          lastErrorMessage: errorMessage,
		          status: {
		            ...buildStartRecoveryStatus(handoffId),
		            jobId,
		          },
		        }).catch(() => undefined);
		      });

	      return {
	        handoffId,
	        status: pendingStatus,
	        endpointCandidates: [],
	        targetPath,
	        ...(deferredHandoffMetadataV2 ? { handoffMetadataV2: deferredHandoffMetadataV2 } : {}),
	      };
	    }

    try {
      if (sourceStopState === 'failed') {
        // Unreachable: non-deferred start returns above on stop failure.
        return {
          ok: false,
          errorCode: 'source_stop_failed',
          error: 'Failed to stop the active source session before handoff cutover',
        } as const;
      }
      const prepared = await prepareStartedHandoffState({
        handoffId,
        request: parsed.data,
        metadata,
        sourceStopState,
      });

      return {
        handoffId,
        status: prepared.nextState.status,
        endpointCandidates: prepared.endpointCandidates,
        targetPath: prepared.targetPath,
        ...(prepared.nextState.handoffMetadataV2 ? { handoffMetadataV2: prepared.nextState.handoffMetadataV2 } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      if (sourceStopState !== 'stopped') {
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: errorMessage,
        } as const;
      }
      const status = buildStartRecoveryStatus(handoffId);
      return {
        ok: false,
        errorCode: 'source_export_failed',
        error: errorMessage,
        handoffId,
        status,
      } as const;
    }
  });

  const handlePrepareTargetRaw = async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob && isTerminalHandoffStatus(persistedJob.status)) {
      return {
        handoffId: parsed.data.handoffId,
        status: persistedJob.status,
      };
    }
    if (persistedJob && !isTerminalHandoffStatus(persistedJob.status)) {
      // If we already have an in-flight runner, return the durable status as-is.
      // Otherwise continue below: we'll restart the job runner against the existing job record.
      if (activePrepareJobs.has(persistedJob.jobId)) {
        return {
          handoffId: parsed.data.handoffId,
          status: persistedJob.status,
        };
      }
    }

    const jobId = persistedJob?.jobId ?? buildPrepareJobId(parsed.data.handoffId);
    const pendingUpdatedAtMs = Date.now();
    const createdAtMs = persistedJob?.createdAtMs ?? pendingUpdatedAtMs;
    let workspaceReplicationJobId: string | undefined = persistedJob?.workspaceReplicationJobId;
    let prepareTargetRequest: SessionHandoffPrepareTargetRequest | undefined =
      persistedJob?.prepareTargetRequest ?? parsed.data;
    const isRestartingPersistedJob = Boolean(
      persistedJob
      && !isTerminalHandoffStatus(persistedJob.status)
      && !activePrepareJobs.has(persistedJob.jobId),
    );
    const pendingStatus = buildPreparePendingStatus({
      handoffId: parsed.data.handoffId,
      jobId,
      transportStrategy: parsed.data.negotiatedTransportStrategy,
      recoveryActions: [],
      phaseDetail: isRestartingPersistedJob ? 'resuming_after_restart' : 'importing_workspace',
    });
    let actualTransportStrategy = parsed.data.negotiatedTransportStrategy;
    let providerBundle: SessionHandoffProviderBundle | null = null;
    let providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication | null = null;

    const persistJobRecord = async (jobRecord: SessionHandoffPrepareTargetJobRecordInput): Promise<void> => {
      if (jobRecord.workspaceReplicationJobId) {
        workspaceReplicationJobId = workspaceReplicationJobId ?? jobRecord.workspaceReplicationJobId;
      }
      const mergedJobRecord =
        workspaceReplicationJobId && !jobRecord.workspaceReplicationJobId
          ? {
            ...jobRecord,
            workspaceReplicationJobId,
          }
          : jobRecord;
      const mergedWithRequest =
        prepareTargetRequest && !mergedJobRecord.prepareTargetRequest
          ? {
            ...mergedJobRecord,
            prepareTargetRequest,
          }
          : mergedJobRecord;
      if (mergedWithRequest.prepareTargetRequest) {
        prepareTargetRequest = prepareTargetRequest ?? mergedWithRequest.prepareTargetRequest;
      }
      await prepareJobStore.write(mergedWithRequest);
    };

    await persistJobRecord(buildPrepareJobRecord({
      jobId,
      handoffId: parsed.data.handoffId,
      createdAtMs,
      updatedAtMs: pendingUpdatedAtMs,
      status: pendingStatus,
    }));

    const existingActiveJob = activePrepareJobs.get(jobId);
    let runJob = existingActiveJob;
    if (!runJob) {
      runJob = (async () => {
        let leaseAcquired = false;
        let leaseHeartbeat: Readonly<{ stop: () => Promise<void> }> | null = null;

        try {
        const assertPrepareJobNotCancelled = async (): Promise<void> => {
          const latestJob = await prepareJobStore.read(jobId);
          if (latestJob?.cancelRequestedAtMs) {
            throw new Error(`Session handoff prepare aborted: ${parsed.data.handoffId}`);
          }
        };
        const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
          activeServerDir: configuration.activeServerDir,
          jobId,
          ownerId: prepareTargetJobLeaseOwnerId,
          nowMs: Date.now(),
          ttlMs: prepareTargetJobLeaseTtlMs,
        });
        if (!leaseAttempt.acquired) {
          // Another daemon instance is responsible for advancing this durable job record.
          return;
        }

        leaseAcquired = true;
        leaseHeartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
          activeServerDir: configuration.activeServerDir,
          jobId,
          ownerId: prepareTargetJobLeaseOwnerId,
          ttlMs: prepareTargetJobLeaseTtlMs,
          nowMs: () => Date.now(),
        });

        try {
          const wasCancelledBeforeWorkspaceImport = await prepareJobStore.read(jobId);
          if (wasCancelledBeforeWorkspaceImport?.cancelRequestedAtMs) {
            const abortedAtMs = Date.now();
            await persistJobRecord(buildPrepareJobRecord({
              jobId,
              handoffId: parsed.data.handoffId,
              createdAtMs,
              updatedAtMs: abortedAtMs,
              cancelRequestedAtMs: wasCancelledBeforeWorkspaceImport.cancelRequestedAtMs,
              abortedAtMs,
              status: {
                ...pendingStatus,
                status: 'aborted',
              },
            }));
            return;
          }
          const resolvedWorkspaceTransfer = parsed.data.workspaceTransfer;
          actualTransportStrategy = parsed.data.negotiatedTransportStrategy;
          const requestHandoffMetadataV2 = parsed.data.handoffMetadataV2;
          const requestResolvedHandoffMetadataV2 = requestHandoffMetadataV2;
          const localSourceExport = await sourceExportStore.load(parsed.data.handoffId);
          const localProviderBundle =
            localSourceExport?.providerBundle
              ? await readSessionHandoffProviderBundleFile(localSourceExport.providerBundle.filePath).catch(() => null)
              : null;
          const localWorkspaceReplicationMetadata =
            localSourceExport?.workspaceManifest && localSourceExport.workspaceSourceRootPath
              ? {
                  sourceRootPath: localSourceExport.workspaceSourceRootPath,
                  manifest: await readWorkspaceReplicationManifestFromFile({
                    transferId: localSourceExport.workspaceManifest.transferId,
                    filePath: localSourceExport.workspaceManifest.filePath,
                    sizeBytes: localSourceExport.workspaceManifest.sizeBytes,
                  }),
                }
              : undefined;

          const allowServerRoutedFallback = parsed.data.allowServerRoutedFallback !== false;
          const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;

          const hasProviderBundleTransferPublication =
            requestResolvedHandoffMetadataV2?.providerBundleTransferPublication !== undefined;
          if (
            actualTransportStrategy === 'direct_peer'
            && !hasProviderBundleTransferPublication
            && !localProviderBundle
          ) {
            if (canFallbackToServerRouted) {
              // Direct-peer starts can be deferred (to avoid socket ack timeouts) which means the
              // provider bundle publication won't exist yet. Fail over to server-routed when allowed.
              actualTransportStrategy = 'server_routed_stream';
            } else {
              throw new Error(missingHandoffMetadataV2().error);
            }
          }

          const needsWorkspaceReplicationMetadata = resolvedWorkspaceTransfer?.enabled === true;
          if (needsWorkspaceReplicationMetadata) {
            if (
              !localWorkspaceReplicationMetadata
              && (
                requestResolvedHandoffMetadataV2?.workspaceReplicationSourceRootPath === undefined
                || requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication === undefined
              )
            ) {
              throw new Error(missingHandoffMetadataV2().error);
            }
          }

          if (actualTransportStrategy === 'direct_peer') {
            const directPeerRequester = params.directPeerTransfer?.requestPayloadFile;
            const providerEndpointCandidates =
              requestResolvedHandoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates;
            const providerCandidatesFallback = providerEndpointCandidates ?? parsed.data.endpointCandidates;
            const manifestEndpointCandidates =
              requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates
              ?? (parsed.data.endpointCandidates.length
                ? rewriteDirectPeerEndpointCandidatesForTransferId({
                    endpointCandidates: parsed.data.endpointCandidates,
                    transferId:
                      requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.transferId
                      ?? buildSessionHandoffWorkspaceManifestTransferId({ handoffId: parsed.data.handoffId }),
                  })
                : undefined);

            const nowMs = Date.now();
            const hasUsableProviderEndpointCandidates =
              Array.isArray(providerCandidatesFallback)
              && providerCandidatesFallback.some((candidate) => candidate.expiresAt >= nowMs);
            const hasUsableManifestEndpointCandidates =
              Array.isArray(manifestEndpointCandidates)
              && manifestEndpointCandidates.some((candidate) => candidate.expiresAt >= nowMs);

            const canUseDirectPeerForProviderBundle =
              Boolean(localProviderBundle)
              || (
                typeof directPeerRequester === 'function'
                && hasUsableProviderEndpointCandidates
              );
            const canUseDirectPeerForWorkspaceManifest =
              resolvedWorkspaceTransfer?.enabled !== true
              || !needsWorkspaceReplicationMetadata
              || Boolean(localWorkspaceReplicationMetadata)
              || (
                typeof directPeerRequester === 'function'
                && hasUsableManifestEndpointCandidates
              );

            if (!canUseDirectPeerForProviderBundle || !canUseDirectPeerForWorkspaceManifest) {
              if (canFallbackToServerRouted) {
                actualTransportStrategy = 'server_routed_stream';
              } else {
                throw new Error(directPeerTransferUnavailable().error);
              }
            }
          }

          providerBundleTransferPublication = requestResolvedHandoffMetadataV2?.providerBundleTransferPublication ?? null;
          const resolvedProviderBundle =
            localProviderBundle
            ?? await resolvePrepareProviderBundle({
              request: parsed.data,
              actualTransportStrategy,
              handoffMetadataV2: requestResolvedHandoffMetadataV2,
              machineTransferChannel: params.machineTransferChannel,
              directPeerTransfer: params.directPeerTransfer,
              transferRouteCache,
            });
          if (!resolvedProviderBundle) {
            throw new Error('Invalid session handoff provider bundle');
          }
          providerBundle = resolvedProviderBundle;
          const persistedHandoffMetadataV2 = requestResolvedHandoffMetadataV2;
          const persistedWorkspaceReplicationMetadata =
            localWorkspaceReplicationMetadata
            ?? await resolvePrepareWorkspaceReplicationMetadata({
              request: parsed.data,
              actualTransportStrategy,
              workspaceTransfer: resolvedWorkspaceTransfer,
              handoffMetadataV2: persistedHandoffMetadataV2,
              machineTransferChannel: params.machineTransferChannel,
              directPeerTransfer: params.directPeerTransfer,
            });
          const {
            currentTargetManifest,
            sourceOffer,
            importedWorkspace,
	          } = await workspaceReplicationAdapter.prepareTargetWorkspace({
	            activeServerDir: configuration.activeServerDir,
	            actualTransportStrategy,
	            handoffId: parsed.data.handoffId,
	            sourceMachineId: parsed.data.sourceMachineId,
	            targetMachineId: parsed.data.targetMachineId,
	            targetPath: normalizeSessionHandoffTargetPathForLocalMachine({
	              requestedTargetPath: parsed.data.targetPath,
	              homeDir: os.homedir(),
	            }),
	            workspaceTransfer: resolvedWorkspaceTransfer,
	            metadata: persistedWorkspaceReplicationMetadata,
	            directPeerManifestEndpointCandidates:
	              persistedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates,
            machineTransferChannel: params.machineTransferChannel,
            transfers: workspaceReplicationTransfers,
            blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
            blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
            blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
            onWorkspaceReplicationJobStarted: async (startedWorkspaceReplicationJobId: string) => {
              workspaceReplicationJobId = workspaceReplicationJobId ?? startedWorkspaceReplicationJobId;
              await prepareJobStore.update(jobId, (currentRecord) => {
                const { schemaVersion: _schemaVersion, ...rest } = currentRecord;
                return {
                  ...rest,
                  workspaceReplicationJobId: rest.workspaceReplicationJobId ?? startedWorkspaceReplicationJobId,
                  updatedAtMs: Date.now(),
                };
              });
            },
            assertCanContinue: assertPrepareJobNotCancelled,
          });
          const workspaceStatusProgress =
            resolvedWorkspaceTransfer?.enabled && sourceOffer
              ? buildWorkspaceReplicationStatusProgress({
                previousManifest: currentTargetManifest,
                nextManifest: sourceOffer.manifest,
                blobCount: sourceOffer.blobIndex.length,
                checkpoint: 'import_session',
                phaseDetail: 'importing_session',
              })
              : null;
          await persistJobRecord(buildPrepareJobRecord({
            jobId,
            handoffId: parsed.data.handoffId,
            createdAtMs,
            updatedAtMs: Date.now(),
            status: {
              ...buildPreparePendingStatus({
                handoffId: parsed.data.handoffId,
                jobId,
                transportStrategy: actualTransportStrategy,
                recoveryActions: pendingStatus.recoveryActions,
                phaseDetail: 'importing_session',
              }),
              ...(workspaceStatusProgress ?? {}),
            },
          }));

          const afterWorkspaceImportJob = await prepareJobStore.read(jobId);
          if (afterWorkspaceImportJob?.cancelRequestedAtMs) {
            const abortedAtMs = Date.now();
            await persistJobRecord(buildPrepareJobRecord({
              jobId,
              handoffId: parsed.data.handoffId,
              createdAtMs,
              updatedAtMs: abortedAtMs,
              cancelRequestedAtMs: afterWorkspaceImportJob.cancelRequestedAtMs,
              abortedAtMs,
              status: {
                ...afterWorkspaceImportJob.status,
                status: 'aborted',
              },
            }));
            return;
          }

          const imported = await importSessionBundle(
            providerBundle,
            importedWorkspace.targetPath,
            parsed.data.targetSessionStorageMode === 'persisted'
              ? 'persisted'
              : parsed.data.sourceSessionStorageMode === 'persisted'
                ? 'persisted'
                : 'direct',
          );
          const directSource = DirectSessionsSourceSchema.parse(imported.directSource);
          const readyForCutoverStatusBase: SessionHandoffStatus = {
            ...pendingStatus,
            status: 'ready_for_cutover',
            phase: 'staging_target',
            transportStrategy: actualTransportStrategy,
          };
          const readyForCutoverStatus: SessionHandoffStatus = workspaceStatusProgress
            ? {
              ...readyForCutoverStatusBase,
              ...buildWorkspaceReplicationStatusProgress({
                previousManifest: currentTargetManifest,
                nextManifest: sourceOffer!.manifest,
                blobCount: sourceOffer!.blobIndex.length,
                checkpoint: 'import_session',
                phaseDetail: 'ready_for_cutover',
              }),
            }
            : {
              ...readyForCutoverStatusBase,
              progress: {
                updatedAtMs: Date.now(),
                checkpoint: 'import_session',
                planned: {},
                transferred: {},
                current: {
                  phaseDetail: 'ready_for_cutover',
                },
                resumable: false,
              },
            };
          const prepareResult: SessionHandoffPrepareTargetResultGetResponse = {
            handoffId: parsed.data.handoffId,
            status: readyForCutoverStatus,
            remoteSessionId: imported.remoteSessionId,
            directSource,
            ...(imported.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: imported.agentRuntimeDescriptorV1 } : {}),
            resume: imported.resume,
          };
          const afterImportJob = await prepareJobStore.read(jobId);
          if (afterImportJob?.cancelRequestedAtMs) {
            const abortedAtMs = Date.now();
            await persistJobRecord(buildPrepareJobRecord({
              jobId,
              handoffId: parsed.data.handoffId,
              createdAtMs,
              updatedAtMs: abortedAtMs,
              cancelRequestedAtMs: afterImportJob.cancelRequestedAtMs,
              abortedAtMs,
              status: {
                ...readyForCutoverStatus,
                status: 'aborted',
              },
            }));
            return;
          }
          await persistJobRecord(buildPrepareJobRecord({
            jobId,
            handoffId: parsed.data.handoffId,
            createdAtMs,
            updatedAtMs: Date.now(),
            completedAtMs: Date.now(),
            status: readyForCutoverStatus,
            prepareTargetResult: prepareResult,
          }));
        } catch (error) {
          const failedAtMs = Date.now();
          const currentJob = await prepareJobStore.read(jobId);
          const failedStatus: SessionHandoffStatus = {
            ...(currentJob?.status ?? pendingStatus),
            status: currentJob?.cancelRequestedAtMs ? 'aborted' : 'awaiting_recovery',
          };
          await persistJobRecord(buildPrepareJobRecord({
            jobId,
            handoffId: parsed.data.handoffId,
            createdAtMs,
            updatedAtMs: failedAtMs,
            ...(currentJob?.cancelRequestedAtMs ? { cancelRequestedAtMs: currentJob.cancelRequestedAtMs, abortedAtMs: failedAtMs } : { failedAtMs }),
            lastErrorMessage: error instanceof Error ? error.message : 'Failed to prepare handoff target',
            status: failedStatus,
          }));
        }
        } finally {
          await leaseHeartbeat?.stop().catch(() => undefined);
          if (leaseAcquired) {
            await releaseSessionHandoffPrepareTargetJobLease({
              activeServerDir: configuration.activeServerDir,
              jobId,
              ownerId: prepareTargetJobLeaseOwnerId,
            }).catch(() => undefined);
          }
          // Only remove the in-memory runner if we still own the map entry. This prevents a
          // completed/failed runner from deleting a newer replacement runner during restarts.
          if (activePrepareJobs.get(jobId) === runJob) {
            activePrepareJobs.delete(jobId);
          }
        }
      })();
    }

    activePrepareJobs.set(jobId, runJob);

    const fastPathResult = await waitForPrepareJobFastPath(runJob);
    if (fastPathResult === 'completed') {
      const completedJob = await prepareJobStore.read(jobId);
      if (completedJob?.prepareTargetResult) {
        return completedJob.prepareTargetResult;
      }
      if (completedJob?.status.status === 'awaiting_recovery' && completedJob.lastErrorMessage) {
        if (isMachineTransferTimeoutErrorMessage(completedJob.lastErrorMessage)) {
          return {
            handoffId: parsed.data.handoffId,
            status: pendingStatus,
          };
        }
        if (completedJob.lastErrorMessage === directPeerTransferUnavailable().error) {
          return directPeerTransferUnavailable();
        }
        if (completedJob.lastErrorMessage === missingHandoffMetadataV2().error) {
          return missingHandoffMetadataV2();
        }
        throw new Error(completedJob.lastErrorMessage);
      }
      if (completedJob) {
        return {
          handoffId: parsed.data.handoffId,
          status: completedJob.status,
        };
      }
    }

    return {
      handoffId: parsed.data.handoffId,
      status: pendingStatus,
    };
  };

  restartPrepareTargetJobFromPersistedRequest = async (raw: unknown): Promise<void> => {
    await handlePrepareTargetRaw(raw);
  };

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET, handlePrepareTargetRaw);

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, async (raw: unknown) => {
    const parsed = SessionHandoffCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const mode = parsed.data.mode ?? 'target';
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = !persistedJob
      ? await sourceExportStore.load(parsed.data.handoffId)
      : null;
    const currentStatus = persistedJob?.status;
    if (
      mode === 'target'
      && currentStatus
      && currentStatus.status !== 'ready_for_cutover'
      && currentStatus.status !== 'completed'
    ) {
      // Fail closed: commit is not safe while the target is still being prepared because the daemon
      // would dispose transfer payload sources while the prepare job is still running.
      return {
        ok: false,
        errorCode: 'not_ready',
        error: 'Handoff target is not ready for cutover',
        handoffId: parsed.data.handoffId,
        status: currentStatus,
      } as const;
    }

    if (mode === 'source_cleanup') {
      if (persistedSourceExport?.sessionId && params.stopSessionForHandoff) {
        try {
          const stopResult = await params.stopSessionForHandoff(persistedSourceExport.sessionId);
          if (stopResult === 'failed') {
            return {
              ok: false,
              errorCode: 'source_stop_failed',
              error: 'Failed to stop the active source session during handoff cleanup',
              handoffId: parsed.data.handoffId,
              ...(currentStatus ? { status: currentStatus } : {}),
            } as const;
          }
        } catch (error) {
          return {
            ok: false,
            errorCode: 'source_stop_failed',
            error: error instanceof Error ? error.message : 'Failed to stop the active source session during handoff cleanup',
            handoffId: parsed.data.handoffId,
            ...(currentStatus ? { status: currentStatus } : {}),
          } as const;
        }
      }

      const normalizeReverseRootPath = (raw: unknown): string | null => {
        const candidate = typeof raw === 'string' ? raw.trim() : '';
        if (!candidate.startsWith('/')) return null;
        if (candidate.includes('\0')) return null;
        const segments = candidate.split('/').filter(Boolean);
        if (segments.length === 0) return null;
        if (segments.some((segment) => segment === '..')) return null;
        return `/${segments.join('/')}`;
      };

      // `sync_changes` in one-way-safe mode requires a baseline for the (source->target) direction.
      // After a successful cutover, persist the reverse-direction baseline locally so a subsequent
      // “handoff back” can use `sync_changes` immediately without forcing a full snapshot transfer.
      if (
        persistedSourceExport?.workspaceManifest
        && persistedSourceExport.sourceMachineId
        && persistedSourceExport.targetMachineId
      ) {
        const reverseSourceRootPath = normalizeReverseRootPath(parsed.data.workspaceReplicationReverseSourceRootPath);
        const reverseTargetRootPath = normalizeReverseRootPath(parsed.data.workspaceReplicationReverseTargetRootPath);
        if (reverseSourceRootPath && reverseTargetRootPath) {
          const reverseScope = {
            sourceMachineId: persistedSourceExport.targetMachineId,
            sourceWorkspaceRoot: reverseSourceRootPath,
            targetMachineId: persistedSourceExport.sourceMachineId,
            targetWorkspaceRoot: reverseTargetRootPath,
            mode: 'one_way_safe' as const,
          };

          // Canonicalize ordering + fingerprint so the saved baseline matches what the engine will
          // compute when building offers from manifests later.
          const manifest = await readWorkspaceReplicationManifestFromFile({
            transferId: persistedSourceExport.workspaceManifest.transferId,
            filePath: persistedSourceExport.workspaceManifest.filePath,
            sizeBytes: persistedSourceExport.workspaceManifest.sizeBytes,
          });
          await workspaceReplicationAdapter.persistBaselineFromManifest({
            activeServerDir: configuration.activeServerDir,
            scope: reverseScope,
            manifest,
            savedAtMs: Date.now(),
          });
        }
      }
    }

    if (!persistedJob && !persistedSourceExport) {
      return { ok: false, errorCode: 'not_found' } as const;
    }

    const status: SessionHandoffStatus = {
      ...(currentStatus ?? buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' })),
      status: 'completed',
      phase: 'finalizing',
    };
    if (persistedJob) {
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: persistedJob.jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedJob.createdAtMs,
        updatedAtMs: Date.now(),
        completedAtMs: Date.now(),
        workspaceReplicationJobId: persistedJob.workspaceReplicationJobId,
        status,
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
    } else if (persistedSourceExport) {
      const completedAtMs = Date.now();
      const jobId = buildSourceExportOnlyPrepareJobId(parsed.data.handoffId);
      const durableStatus: SessionHandoffStatus = { ...status, jobId };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedSourceExport.exportedAtMs,
        updatedAtMs: completedAtMs,
        completedAtMs,
        status: durableStatus,
      }));
      status.jobId = jobId;
    }
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    params.directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffProviderBundleTransferId(parsed.data.handoffId));
    params.directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffWorkspaceManifestTransferId({ handoffId: parsed.data.handoffId }));
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, async (raw: unknown) => {
    const parsed = SessionHandoffAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (!persistedJob && !persistedSourceExport) return { ok: false, errorCode: 'not_found' } as const;

    if (persistedJob?.workspaceReplicationJobId) {
      await workspaceReplicationAdapter.abortWorkspaceReplicationJob({
        activeServerDir: configuration.activeServerDir,
        jobId: persistedJob.workspaceReplicationJobId,
      }).catch(() => undefined);
    }

    if (persistedJob) {
      const abortedAtMs = Date.now();
      const status: SessionHandoffStatus = {
        ...persistedJob.status,
        status: 'aborted',
      };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId: persistedJob.jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedJob.createdAtMs,
        updatedAtMs: abortedAtMs,
        cancelRequestedAtMs: persistedJob.cancelRequestedAtMs ?? abortedAtMs,
        abortedAtMs,
        workspaceReplicationJobId: persistedJob.workspaceReplicationJobId,
        ...(persistedJob.failedAtMs ? { failedAtMs: persistedJob.failedAtMs } : {}),
        ...(persistedJob.lastErrorMessage ? { lastErrorMessage: persistedJob.lastErrorMessage } : {}),
        status,
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
    }

    const baseStatus =
      persistedJob?.status ?? buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' });
    const status: SessionHandoffStatus = {
      ...baseStatus,
      status: 'aborted',
      phase: baseStatus.phase,
    };
    if (!persistedJob && persistedSourceExport) {
      const abortedAtMs = Date.now();
      const jobId = buildSourceExportOnlyPrepareJobId(parsed.data.handoffId);
      const durableStatus: SessionHandoffStatus = { ...status, jobId };
      await prepareJobStore.write(buildPrepareJobRecord({
        jobId,
        handoffId: parsed.data.handoffId,
        createdAtMs: persistedSourceExport.exportedAtMs,
        updatedAtMs: abortedAtMs,
        cancelRequestedAtMs: abortedAtMs,
        abortedAtMs,
        status: durableStatus,
      }));
      status.jobId = jobId;
    }
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    params.directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffProviderBundleTransferId(parsed.data.handoffId));
    params.directPeerTransfer?.clearPublishedTransfer(buildSessionHandoffWorkspaceManifestTransferId({ handoffId: parsed.data.handoffId }));
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, async (raw: unknown) => {
    const parsed = SessionHandoffStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    let persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      persistedJob = await maybeRecoverPrepareTargetJobMissingRunner(persistedJob);
    }
    if (persistedJob) {
      const baseStatus = persistedJob.status;
      if (
        persistedJob.workspaceReplicationJobId
        && baseStatus.status === 'pending'
        && baseStatus.phase === 'staging_target'
      ) {
        const job = await workspaceReplicationAdapter.readWorkspaceReplicationJobStatus({
          activeServerDir: configuration.activeServerDir,
          jobId: persistedJob.workspaceReplicationJobId,
        });
        if (job) {
          return {
            handoffId: parsed.data.handoffId,
            status: mergeWorkspaceReplicationProgressIntoHandoffStatus({
              baseStatus,
              job,
            }),
          };
        }
      }
      return { handoffId: parsed.data.handoffId, status: baseStatus };
    }
    const persistedSourceExport = await sourceExportStore.load(parsed.data.handoffId);
    if (persistedSourceExport) {
      return {
        handoffId: parsed.data.handoffId,
        status: buildStartPendingStatus({ handoffId: parsed.data.handoffId, sourceStopState: 'already_inactive' }),
      };
    }
    return { ok: false, errorCode: 'not_found' } as const;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetResultGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    let persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      persistedJob = await maybeRecoverPrepareTargetJobMissingRunner(persistedJob);
    }
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob) {
      // Canonical contract: result-get returns the terminal ready payload. While the prepare
      // job is still running, callers should poll `status.get` for progress. If the job has
      // reached a terminal non-ready state (aborted/failed/awaiting_recovery), surface that
      // explicitly so callers don't spin forever on `not_found`.
      if (isTerminalHandoffStatus(persistedJob.status)) {
        const statusCode = persistedJob.status.status;
        // `ready_for_cutover` should always have a result payload, but fail closed if the record is corrupt.
        if (statusCode === 'ready_for_cutover') {
          return {
            ok: false,
            errorCode: 'awaiting_recovery',
            error: persistedJob.lastErrorMessage ?? 'Prepare-target result missing for ready_for_cutover job',
          } as const;
        }
        if (statusCode === 'completed') {
          return {
            ok: false,
            errorCode: 'awaiting_recovery',
            error: persistedJob.lastErrorMessage ?? 'Prepare-target job completed without a ready_for_cutover result',
          } as const;
        }
        return {
          ok: false,
          errorCode: statusCode,
          error: persistedJob.lastErrorMessage ?? `Prepare-target job is ${statusCode}`,
        } as const;
      }

      return { ok: false, errorCode: 'not_found' } as const;
    }
    return { ok: false, errorCode: 'not_found' } as const;
  });
}
