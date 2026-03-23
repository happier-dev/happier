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
  type MachineTransferChannel,
} from '../../machines/transfer/serverRoutedTransport';
import type { DirectPeerOnDemandTransferScope } from '../../machines/transfer/directPeerTransport';
import { createMachineTransferRouteCache } from '../../machines/transfer/transferRouteCache';
import {
  disposeTransferPayloadSource,
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
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
} from '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';
import { readSessionHandoffWorkspaceReplicationManifestFromFile } from '../../session/handoff/workspace/sessionHandoffWorkspaceReplicationManifestTransfer';
import {
  parseSessionHandoffWorkspaceManifestTransferId,
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../../session/handoff/workspace/sessionHandoffWorkspaceReplicationServerRouted';
import { createSessionHandoffWorkspaceReplicationManifestPayloadSource } from '../../session/handoff/workspace/sessionHandoffWorkspaceReplicationManifestTransfer';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '../../scm/sourceController/workspaceExportArtifacts';
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
import type { WorkspaceExportBlobProvider } from '../../scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { compareWorkspaceManifests } from '../../scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';
const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const PREPARE_JOB_FAST_PATH_BUDGET_MS = 250;

type StoredHandoffState = Readonly<{
  status: SessionHandoffStatus;
  sourceMachineId?: string;
  targetMachineId?: string;
  workspaceBlobProvider?: WorkspaceExportBlobProvider;
  providerBundlePayloadSource?: TransferPayloadSource;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  workspaceReplicationMetadata?: SessionHandoffWorkspaceReplicationMetadata;
  workspaceReplicationDirectPeerPayloadSources?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers['payloadSources'];
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
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

function resolveStoredProviderBundlePayloadSource(current?: StoredHandoffState): TransferPayloadSource | null {
  return current?.providerBundlePayloadSource ?? null;
}

function resolvePersistedWorkspaceBlobProvider(params: Readonly<{
  current?: StoredHandoffState;
  blobProvider?: WorkspaceExportBlobProvider;
}>): WorkspaceExportBlobProvider | undefined {
  return params.blobProvider ?? params.current?.workspaceBlobProvider;
}

function resolvePersistedHandoffMetadataV2(params: Readonly<{
  current?: StoredHandoffState;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>): SessionHandoffMetadataV2 | undefined {
  return params.handoffMetadataV2 ?? params.current?.handoffMetadataV2;
}

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

function buildPrepareJobId(): string {
  return `prepare_${randomUUID()}`;
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
    ...(input.prepareTargetResult ? { prepareTargetResult: input.prepareTargetResult } : {}),
  };
}

async function readPersistedPrepareJob(params: Readonly<{
  handoffId: string;
  current?: StoredHandoffState;
  jobStore: ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
}>): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  const currentJobId = params.current?.status.jobId;
  if (currentJobId) {
    const currentJob = await params.jobStore.read(currentJobId);
    if (currentJob) {
      return currentJob;
    }
  }
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

  try {
    await requestServerRoutedTransferToFile({
      transferId: params.transferId,
      sourceMachineId: params.sourceMachineId,
      machineTransferChannel: params.machineTransferChannel,
      destinationPath: payloadFilePath,
    });
    return await readSessionHandoffProviderBundleFile(payloadFilePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolvePrepareProviderBundle(params: Readonly<{
  current?: StoredHandoffState;
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  providerBundlePayloadSource?: TransferPayloadSource;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferRouteCache?: ReturnType<typeof createMachineTransferRouteCache>;
}>): Promise<SessionHandoffProviderBundle | undefined> {
  if (params.providerBundlePayloadSource?.kind === 'file') {
    return await readSessionHandoffProviderBundleFile(params.providerBundlePayloadSource.filePath);
  }
  if (params.current?.providerBundlePayloadSource?.kind === 'file') {
    return await readSessionHandoffProviderBundleFile(params.current.providerBundlePayloadSource.filePath);
  }

  const transferPublication =
    params.handoffMetadataV2?.providerBundleTransferPublication
    ?? params.current?.handoffMetadataV2?.providerBundleTransferPublication;
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
  const transferEndpointCandidates = transferPublication.endpointCandidates;
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
  current?: StoredHandoffState;
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): Promise<SessionHandoffWorkspaceReplicationMetadata | undefined> {
  if (params.current?.workspaceReplicationMetadata) {
    return params.current.workspaceReplicationMetadata;
  }

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
          const received = await requestServerRoutedTransferToFile({
            transferId: transferPublication.transferId,
            sourceMachineId: params.request.sourceMachineId,
            machineTransferChannel,
            destinationPath: payloadFilePath,
          });
          return await readSessionHandoffWorkspaceReplicationManifestFromFile({
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
          const endpointCandidates = transferPublication.endpointCandidates;
          const requestedFilePayload = params.directPeerTransfer?.requestPayloadFile;
          if (!endpointCandidates?.length || !requestedFilePayload) {
            throw new Error(`Direct peer transfer is unavailable for ${transferPublication.transferId}`);
          }
          const filteredEndpointCandidates = endpointCandidates.filter((candidate) => candidate.expiresAt >= Date.now());
          const allowServerRoutedFallback = params.request.allowServerRoutedFallback !== false;
          const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;
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
                });
                return await readSessionHandoffWorkspaceReplicationManifestFromFile({
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
              return await readSessionHandoffWorkspaceReplicationManifestFromFile({
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
                  });
                  return await readSessionHandoffWorkspaceReplicationManifestFromFile({
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
  exportSessionBundle?: (metadata: Record<string, unknown>, workspaceTransfer?: SessionHandoffWorkspaceTransfer) => Promise<Readonly<{
    providerBundle: SessionHandoffProviderBundle;
    targetPath: string;
    workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
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
  const store = new Map<string, StoredHandoffState>();
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: configuration.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  const prepareTargetJobLeaseOwnerId = `cli-daemon:${process.pid}:${randomUUID()}`;
  const prepareTargetJobLeaseTtlMs = resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  type PreparedStartedHandoffState = Awaited<ReturnType<typeof prepareStartedHandoffState>>;
  // When we acknowledge start before source export completes (server-routed cross-daemon),
  // transfer responders must be able to await the eventual prepared state to avoid
  // transient not-found failures for manifest/blob-pack/provider-bundle payloads.
  const activeSourcePrepareStates = new Map<string, Promise<PreparedStartedHandoffState>>();
  const { rpcHandlerManager } = params;
  const transferRouteCache = createMachineTransferRouteCache({
    serverId: configuration.activeServerId,
  });
  const workspaceReplicationAdapter = createSessionHandoffWorkspaceReplicationAdapter();
  const workspaceReplicationTransfers = workspaceReplicationAdapter.createReplicationTransfers();
  const ephemeralServerRoutedPayloadSources = new Map<string, TransferPayloadSource>();

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
  const disposeDirectPeerWorkspacePayloadSources = async (current?: StoredHandoffState): Promise<void> => {
    for (const publishedPayloadSource of current?.workspaceReplicationDirectPeerPayloadSources ?? []) {
      params.directPeerTransfer?.clearPublishedTransfer(publishedPayloadSource.transferId);
      await disposeTransferPayloadSource(publishedPayloadSource.payloadSource).catch(() => undefined);
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
  const exportSessionBundle =
    params.exportSessionBundle ??
    (async (metadata: Record<string, unknown>, workspaceTransfer?: SessionHandoffWorkspaceTransfer) => {
      return await exportSessionHandoffState({
        metadata,
        activeServerDir: configuration.activeServerDir,
        workspaceTransfer,
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
  const shouldDeferSourcePreparation = (request: SessionHandoffStartRequest): boolean =>
    params.machineTransferChannel !== undefined
    && request.sourceMachineId !== request.targetMachineId
    && (
      request.negotiatedTransportStrategy === 'server_routed_stream'
      || request.negotiatedTransportStrategy === 'direct_peer'
    )
    && request.workspaceTransfer?.enabled === true;
  const prepareStartedHandoffState = async (input: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: 'stopped' | 'already_inactive';
  }>): Promise<Readonly<{
    targetPath: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    nextState: StoredHandoffState;
    providerBundlePayloadSource?: TransferPayloadSource;
    directPeerWorkspacePayloadSources?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers['payloadSources'];
  }>> => {
    let providerBundlePayloadSource: TransferPayloadSource | null = null;
    let publishedWorkspaceDirectPeerTransfers: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers | null = null;
    let providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication | null = null;

    try {
      const exported = await exportSessionBundle(input.metadata, input.request.workspaceTransfer);
      providerBundlePayloadSource = await createSessionHandoffProviderBundlePayloadSource(exported.providerBundle);
      const providerBundleTransferId = buildSessionHandoffProviderBundleTransferId(input.handoffId);
      const providerBundleEndpointCandidates =
        input.request.negotiatedTransportStrategy === 'direct_peer' && params.directPeerTransfer
          ? [...params.directPeerTransfer.publishTransfer({
            transferId: providerBundleTransferId,
            payload: {},
            payloadSource: providerBundlePayloadSource,
          })]
          : [];
      providerBundleTransferPublication = {
        transferId: providerBundleTransferId,
        sizeBytes: await resolveTransferPayloadSizeBytes(providerBundlePayloadSource),
        manifestHash: await resolveTransferPayloadManifestHash(providerBundlePayloadSource),
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
        blobProvider: exported.blobProvider,
        ...(exported.workspaceExportArtifacts
          ? { workspaceExportArtifacts: exported.workspaceExportArtifacts }
          : {}),
        ...(providerBundleTransferPublication
          ? { providerBundleTransferPublication }
          : {}),
      });
      const handoffMetadataV2 = preparedWorkspaceTransfer.handoffMetadataV2;
      publishedWorkspaceDirectPeerTransfers =
        preparedWorkspaceTransfer.publishedWorkspaceDirectPeerTransfers ?? null;
      const status = buildStartPendingStatus({
        handoffId: input.handoffId,
        sourceStopState: input.sourceStopState,
      });

      return {
        targetPath: exported.targetPath,
        endpointCandidates: [],
        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
        ...(publishedWorkspaceDirectPeerTransfers
          ? { directPeerWorkspacePayloadSources: publishedWorkspaceDirectPeerTransfers.payloadSources }
          : {}),
        nextState: {
          status,
          sourceMachineId: input.request.sourceMachineId,
          targetMachineId: input.request.targetMachineId,
          ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
          ...(preparedWorkspaceTransfer.workspaceReplicationMetadata
            ? { workspaceReplicationMetadata: preparedWorkspaceTransfer.workspaceReplicationMetadata }
            : {}),
          ...(exported.blobProvider ? { workspaceBlobProvider: exported.blobProvider } : {}),
          ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
          ...(publishedWorkspaceDirectPeerTransfers
            ? { workspaceReplicationDirectPeerPayloadSources: publishedWorkspaceDirectPeerTransfers.payloadSources }
            : {}),
          workspaceTransfer: input.request.workspaceTransfer,
        },
      };
    } catch (error) {
      if (providerBundleTransferPublication?.endpointCandidates?.length) {
        params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
      }
      await disposeTransferPayloadSource(providerBundlePayloadSource);
      if (publishedWorkspaceDirectPeerTransfers) {
        for (const publishedPayloadSource of publishedWorkspaceDirectPeerTransfers.payloadSources) {
          params.directPeerTransfer?.clearPublishedTransfer(publishedPayloadSource.transferId);
          await disposeTransferPayloadSource(publishedPayloadSource.payloadSource).catch(() => undefined);
        }
      }
      throw error;
    }
  };

  if (params.machineTransferChannel) {
    registerServerRoutedTransferResponder({
      machineTransferChannel: params.machineTransferChannel,
      loadTransferPayloadSource: async (transferId) => {
        const cachedPayloadSource = ephemeralServerRoutedPayloadSources.get(transferId);
      if (cachedPayloadSource) {
        return cachedPayloadSource;
      }

        const workspaceBlobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
        if (workspaceBlobPackTransfer) {
          let current = store.get(workspaceBlobPackTransfer.handoffId);
          if (!current || !current.workspaceReplicationMetadata || !current.workspaceBlobProvider) {
            const pending = activeSourcePrepareStates.get(workspaceBlobPackTransfer.handoffId);
            if (pending) {
              await pending.catch(() => undefined);
              current = store.get(workspaceBlobPackTransfer.handoffId);
            }
          }
          if (!current || !current.workspaceReplicationMetadata) {
            return null;
          }
          const payloadSource = await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
            activeServerDir: configuration.activeServerDir,
            packId: workspaceBlobPackTransfer.packId,
            digests: workspaceBlobPackTransfer.digests,
            blobProvider: current.workspaceBlobProvider,
          });
          ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
          return payloadSource;
        }

        const workspaceManifestTransfer = parseSessionHandoffWorkspaceManifestTransferId(transferId);
        if (workspaceManifestTransfer) {
          let current = store.get(workspaceManifestTransfer.handoffId);
          if (!current || !current.workspaceReplicationMetadata) {
            const pending = activeSourcePrepareStates.get(workspaceManifestTransfer.handoffId);
            if (pending) {
              await pending.catch(() => undefined);
              current = store.get(workspaceManifestTransfer.handoffId);
            }
          }
          const workspaceReplicationMetadata = current?.workspaceReplicationMetadata;
          if (!workspaceReplicationMetadata) {
            return null;
          }
          const payloadSource = await createSessionHandoffWorkspaceReplicationManifestPayloadSource({
            manifest: workspaceReplicationMetadata.manifest,
          });
          ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
          return payloadSource;
        }

        const providerBundleTransfer = parseSessionHandoffProviderBundleTransferId(transferId);
        if (providerBundleTransfer) {
          let current = store.get(providerBundleTransfer.handoffId);
          if (!current || !current.providerBundlePayloadSource) {
            const pending = activeSourcePrepareStates.get(providerBundleTransfer.handoffId);
            if (pending) {
              await pending.catch(() => undefined);
              current = store.get(providerBundleTransfer.handoffId);
            }
          }
          return resolveStoredProviderBundlePayloadSource(current);
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

    const handoffId = `handoff_${randomUUID()}`;
    const sourceStopState = params.stopSessionForHandoff
      ? await params.stopSessionForHandoff(parsed.data.sessionId)
      : 'already_inactive';
    if (sourceStopState === 'failed') {
      return {
        ok: false,
        errorCode: 'source_stop_failed',
        error: 'Failed to stop the active source session before handoff cutover',
      } as const;
    }
    const pendingStatus = buildStartPendingStatus({
      handoffId,
      sourceStopState,
    });
	    if (shouldDeferSourcePreparation(parsed.data)) {
	      const targetPath = resolveSessionHandoffTargetPathFromMetadata(metadata);
	      if (!targetPath) {
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: 'Session path is unavailable for handoff',
	        } as const;
	      }
		      const deferredHandoffMetadataV2: SessionHandoffMetadataV2 | undefined =
		        parsed.data.workspaceTransfer?.enabled === true
		          ? {
		              workspaceReplicationSourceRootPath: targetPath,
		              workspaceReplicationManifestTransferPublication: {
		                transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId }),
		              },
		            }
		          : undefined;

	      store.set(handoffId, {
	        status: pendingStatus,
	        sourceMachineId: parsed.data.sourceMachineId,
	        targetMachineId: parsed.data.targetMachineId,
	        ...(deferredHandoffMetadataV2 ? { handoffMetadataV2: deferredHandoffMetadataV2 } : {}),
	        workspaceTransfer: parsed.data.workspaceTransfer,
	      });

      const sourcePreparePromise = prepareStartedHandoffState({
        handoffId,
        request: parsed.data,
        metadata,
        sourceStopState,
      });
      activeSourcePrepareStates.set(handoffId, sourcePreparePromise);
	      void sourcePreparePromise.then(async (prepared) => {
	        activeSourcePrepareStates.delete(handoffId);
	        const current = store.get(handoffId);
	        if (current?.status.status === 'aborted') {
	          await disposeTransferPayloadSource(prepared.providerBundlePayloadSource);
	          if (prepared.directPeerWorkspacePayloadSources) {
	            for (const publishedPayloadSource of prepared.directPeerWorkspacePayloadSources) {
	              params.directPeerTransfer?.clearPublishedTransfer(publishedPayloadSource.transferId);
              await disposeTransferPayloadSource(publishedPayloadSource.payloadSource).catch(() => undefined);
            }
          }
          return;
        }
        store.set(handoffId, prepared.nextState);
      }).catch((error) => {
        activeSourcePrepareStates.delete(handoffId);
        const current = store.get(handoffId);
        if (current?.status.status === 'aborted') {
          return;
        }
        const status = buildStartRecoveryStatus(handoffId);
        store.set(handoffId, {
          ...(current ?? {}),
          status,
          sourceMachineId: parsed.data.sourceMachineId,
          targetMachineId: parsed.data.targetMachineId,
          workspaceTransfer: parsed.data.workspaceTransfer,
        });
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
      const prepared = await prepareStartedHandoffState({
        handoffId,
        request: parsed.data,
        metadata,
        sourceStopState,
      });
      store.set(handoffId, prepared.nextState);

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
      store.set(handoffId, {
        status,
        sourceMachineId: parsed.data.sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        workspaceTransfer: parsed.data.workspaceTransfer,
      });
      return {
        ok: false,
        errorCode: 'source_export_failed',
        error: errorMessage,
        handoffId,
        status,
      } as const;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET, async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    let persistedBlobProvider = resolvePersistedWorkspaceBlobProvider({
      current,
    });
    let persistedProviderBundlePayloadSource = current?.providerBundlePayloadSource;
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current,
      jobStore: prepareJobStore,
    });
    if (persistedJob?.prepareTargetResult) {
      store.set(parsed.data.handoffId, {
        ...(current ?? {}),
        status: persistedJob.status,
        ...(persistedBlobProvider ? { workspaceBlobProvider: persistedBlobProvider } : {}),
        ...(persistedProviderBundlePayloadSource ? { providerBundlePayloadSource: persistedProviderBundlePayloadSource } : {}),
        workspaceTransfer: current?.workspaceTransfer ?? parsed.data.workspaceTransfer,
      });
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob && !isTerminalHandoffStatus(persistedJob.status)) {
      // If we already have an in-flight runner, return the durable status as-is.
      // Otherwise continue below: we'll restart the job runner against the existing job record.
      if (activePrepareJobs.has(persistedJob.jobId)) {
        store.set(parsed.data.handoffId, {
          ...(current ?? {}),
          status: persistedJob.status,
          workspaceTransfer: current?.workspaceTransfer ?? parsed.data.workspaceTransfer,
        });
        return {
          handoffId: parsed.data.handoffId,
          status: persistedJob.status,
        };
      }
    }

    const jobId = persistedJob?.jobId ?? buildPrepareJobId();
    const createdAtMs = persistedJob?.createdAtMs ?? Date.now();
    let workspaceReplicationJobId: string | undefined = persistedJob?.workspaceReplicationJobId;
    const isRestartingPersistedJob = Boolean(
      persistedJob
      && !isTerminalHandoffStatus(persistedJob.status)
      && !activePrepareJobs.has(persistedJob.jobId),
    );
    const pendingStatus = buildPreparePendingStatus({
      handoffId: parsed.data.handoffId,
      jobId,
      transportStrategy: parsed.data.negotiatedTransportStrategy,
      recoveryActions: current?.status.recoveryActions ?? [],
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
      await prepareJobStore.write(mergedJobRecord);
      const previous = store.get(parsed.data.handoffId) ?? current;
      store.set(parsed.data.handoffId, {
        ...(previous ?? {}),
        status: jobRecord.status,
        ...(persistedBlobProvider ? { workspaceBlobProvider: persistedBlobProvider } : {}),
        ...(persistedProviderBundlePayloadSource ? { providerBundlePayloadSource: persistedProviderBundlePayloadSource } : {}),
        workspaceTransfer: current?.workspaceTransfer ?? parsed.data.workspaceTransfer,
      });
    };

    await persistJobRecord(buildPrepareJobRecord({
      jobId,
      handoffId: parsed.data.handoffId,
      createdAtMs,
      status: pendingStatus,
    }));

    const existingActiveJob = activePrepareJobs.get(jobId);
    const runJob =
      existingActiveJob
      ?? (async () => {
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

        const leaseHeartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
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
          const resolvedWorkspaceTransfer = parsed.data.workspaceTransfer ?? current?.workspaceTransfer;
          actualTransportStrategy = parsed.data.negotiatedTransportStrategy;
          const requestHandoffMetadataV2 = parsed.data.handoffMetadataV2;
          const requestResolvedHandoffMetadataV2 = resolvePersistedHandoffMetadataV2({
            current,
            handoffMetadataV2: requestHandoffMetadataV2,
          });

          const allowServerRoutedFallback = parsed.data.allowServerRoutedFallback !== false;
          const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;

          const hasStoredProviderBundlePayloadSource = current?.providerBundlePayloadSource?.kind === 'file';
          const hasProviderBundleTransferPublication =
            requestResolvedHandoffMetadataV2?.providerBundleTransferPublication !== undefined;
          if (
            actualTransportStrategy === 'direct_peer'
            && !hasStoredProviderBundlePayloadSource
            && !hasProviderBundleTransferPublication
          ) {
            if (canFallbackToServerRouted) {
              // Direct-peer starts can be deferred (to avoid socket ack timeouts) which means the
              // provider bundle publication won't exist yet. Fail over to server-routed when allowed.
              actualTransportStrategy = 'server_routed_stream';
            } else {
              throw new Error(missingHandoffMetadataV2().error);
            }
          }

          const needsWorkspaceReplicationMetadata =
            resolvedWorkspaceTransfer?.enabled === true && !current?.workspaceReplicationMetadata;
          if (needsWorkspaceReplicationMetadata) {
            if (
              requestResolvedHandoffMetadataV2?.workspaceReplicationSourceRootPath === undefined
              || requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication === undefined
            ) {
              throw new Error(missingHandoffMetadataV2().error);
            }
          }

          if (actualTransportStrategy === 'direct_peer') {
            const directPeerRequester = params.directPeerTransfer?.requestPayloadFile;
            const providerEndpointCandidates =
              requestResolvedHandoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates;
            const manifestEndpointCandidates =
              requestResolvedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates;

            const nowMs = Date.now();
            const hasUsableProviderEndpointCandidates =
              Array.isArray(providerEndpointCandidates)
              && providerEndpointCandidates.some((candidate) => candidate.expiresAt >= nowMs);
            const hasUsableManifestEndpointCandidates =
              Array.isArray(manifestEndpointCandidates)
              && manifestEndpointCandidates.some((candidate) => candidate.expiresAt >= nowMs);

            const canUseDirectPeerForProviderBundle =
              hasStoredProviderBundlePayloadSource
              || (
                typeof directPeerRequester === 'function'
                && hasUsableProviderEndpointCandidates
              );
            const canUseDirectPeerForWorkspaceManifest =
              resolvedWorkspaceTransfer?.enabled !== true
              || !needsWorkspaceReplicationMetadata
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
          const resolvedProviderBundle = await resolvePrepareProviderBundle({
            current,
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
          persistedProviderBundlePayloadSource =
            current?.providerBundlePayloadSource
            ?? await createSessionHandoffProviderBundlePayloadSource(providerBundle);
          const persistedHandoffMetadataV2 = resolvePersistedHandoffMetadataV2({
            current,
            ...(requestResolvedHandoffMetadataV2 ? { handoffMetadataV2: requestResolvedHandoffMetadataV2 } : {}),
          });
          const persistedWorkspaceReplicationMetadata = await resolvePrepareWorkspaceReplicationMetadata({
            current,
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
            targetPath: parsed.data.targetPath,
            workspaceTransfer: resolvedWorkspaceTransfer,
            metadata: persistedWorkspaceReplicationMetadata,
            directPeerManifestEndpointCandidates:
              persistedHandoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates,
            persistedBlobProvider,
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
        } finally {
          await leaseHeartbeat.stop().catch(() => undefined);
          await releaseSessionHandoffPrepareTargetJobLease({
            activeServerDir: configuration.activeServerDir,
            jobId,
            ownerId: prepareTargetJobLeaseOwnerId,
          }).catch(() => undefined);
          activePrepareJobs.delete(jobId);
        }
      })();

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
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, async (raw: unknown) => {
    const parsed = SessionHandoffCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current,
      jobStore: prepareJobStore,
    });
    if (!current && !persistedJob) return { ok: false, errorCode: 'not_found' } as const;

    const status: SessionHandoffStatus = {
      ...(persistedJob?.status ?? current!.status),
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
    }
    const providerBundleTransferPublication =
      current?.handoffMetadataV2?.providerBundleTransferPublication;
    if (providerBundleTransferPublication?.endpointCandidates?.length) {
      params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
    }
    await disposeDirectPeerWorkspacePayloadSources(current);
    await disposeTransferPayloadSource(resolveStoredProviderBundlePayloadSource(current));
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    store.set(parsed.data.handoffId, {
      ...(store.get(parsed.data.handoffId) ?? {}),
      status,
    });
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, async (raw: unknown) => {
    const parsed = SessionHandoffAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current,
      jobStore: prepareJobStore,
    });
    if (!current && !persistedJob) return { ok: false, errorCode: 'not_found' } as const;

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
        status,
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
      store.set(parsed.data.handoffId, {
        ...(current ?? {}),
        status,
      });
    }

    const status: SessionHandoffStatus = {
      ...(persistedJob?.status ?? current!.status),
      status: 'aborted',
      phase: (persistedJob?.status ?? current!.status).phase,
    };
    activeSourcePrepareStates.delete(parsed.data.handoffId);
    const providerBundleTransferPublication =
      current?.handoffMetadataV2?.providerBundleTransferPublication;
    if (providerBundleTransferPublication?.endpointCandidates?.length) {
      params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
    }
    await disposeDirectPeerWorkspacePayloadSources(current);
    await disposeTransferPayloadSource(resolveStoredProviderBundlePayloadSource(current));
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    store.set(parsed.data.handoffId, {
      ...(store.get(parsed.data.handoffId) ?? {}),
      status,
    });
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, async (raw: unknown) => {
    const parsed = SessionHandoffStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current,
      jobStore: prepareJobStore,
    });
    if (persistedJob) {
      return { handoffId: parsed.data.handoffId, status: persistedJob.status };
    }
    if (!current) return { ok: false, errorCode: 'not_found' } as const;

    return { handoffId: parsed.data.handoffId, status: current.status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetResultGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current: store.get(parsed.data.handoffId),
      jobStore: prepareJobStore,
    });
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    return { ok: false, errorCode: 'not_found' } as const;
  });
}
