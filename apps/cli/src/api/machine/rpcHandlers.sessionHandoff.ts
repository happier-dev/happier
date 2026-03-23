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
} from '../../machines/transfer/serverRoutedTransport';
import {
} from '../../machines/transfer/directPeerTransport';
import { createMachineTransferRouteCache } from '../../machines/transfer/transferRouteCache';
import {
  disposeTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  type TransferPayloadSource,
} from '../../machines/transfer/transferPayloadSource';
import {
  resolveRequestedTypedTransferPayload,
  resolveTypedTransferPayloadDelivery,
} from '../../machines/transfer/typedTransferPayloadDelivery';
import {
  exportSessionHandoffState,
} from '../../session/handoff/exportSessionHandoffState';
import { importSessionHandoffProviderBundle } from '../../session/handoff/importSessionHandoffProviderBundle';
import {
  resolveSessionHandoffExportMetadata,
  type SessionHandoffLocalMetadataSource,
} from '../../session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import {
  createSessionHandoffStoredTransferredState,
  resolveStoredSessionHandoffMetadataV2,
} from '../../session/handoff/sessionHandoffStoredTransferredState';
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
  createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource,
  parseSessionHandoffWorkspaceBlobPackTransferId,
  parseSessionHandoffWorkspaceSourceOfferTransferId,
  resolveSessionHandoffWorkspaceReplicationSourceOffer,
  type SessionHandoffWorkspaceReplicationMetadata,
  type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers,
  type SessionHandoffWorkspaceReplicationDirectPeerPublication,
} from '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '../../scm/sourceController/workspaceExportArtifacts';
import {
  createSessionHandoffTransferredBundles,
  type SessionHandoffTransferredBundles,
} from '../../session/handoff/transfer/sessionHandoffTransferredBundles';
import {
  createSessionHandoffMetadataV2,
  type SessionHandoffMetadataV2,
} from '../../session/handoff/transfer/sessionHandoffMetadataV2';
import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

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
  prepareResult?: SessionHandoffPrepareTargetResultGetResponse;
  transferredBundles?: SessionHandoffTransferredBundles;
  workspaceBlobProvider?: WorkspaceExportBlobProvider;
  providerBundlePayloadSource?: TransferPayloadSource;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  workspaceReplicationDirectPeerPayloadSources?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers['payloadSources'];
  sourceWorkspaceExportArtifactsForReplication?: ScmSourceControllerWorkspaceExportArtifacts;
  transferredPayloadSource?: TransferPayloadSource;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export type SessionHandoffDirectPeerTransferHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: SessionHandoffTransferredBundles;
    payloadSource?: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
  requestPayloadFile?: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
  }>) => Promise<Readonly<{ destinationPath: string }>>;
  clearPublishedTransfer: (transferId: string) => void;
}>;

function buildSessionHandoffTransferId(handoffId: string): string {
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${handoffId}`;
}

function parseHandoffIdFromTransferId(transferId: string): string | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) return null;
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length).trim();
  return handoffId.length > 0 && !handoffId.includes(':') ? handoffId : null;
}

type ResolvedTransferredWorkspacePayload = Readonly<{
  transferredBundles: SessionHandoffTransferredBundles;
  providerBundlePayloadSource?: TransferPayloadSource;
  blobProvider?: WorkspaceExportBlobProvider;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>;

function resolveStoredTransferredBundles(current?: StoredHandoffState): SessionHandoffTransferredBundles | null {
  return current?.transferredBundles ?? null;
}

function resolveStoredTransferredWorkspacePayload(
  current?: StoredHandoffState,
): ResolvedTransferredWorkspacePayload | null {
  if (!current?.transferredBundles) {
    return null;
  }
  const handoffMetadataV2 = resolveStoredSessionHandoffMetadataV2(current);
  return {
    transferredBundles: current.transferredBundles,
    ...(current.workspaceBlobProvider ? { blobProvider: current.workspaceBlobProvider } : {}),
    ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
  };
}

function resolveStoredTransferredPayloadSource(current?: StoredHandoffState): TransferPayloadSource | null {
  return current?.transferredPayloadSource ?? null;
}

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
  const currentMetadata = resolveStoredSessionHandoffMetadataV2(params.current);
  const incomingMetadata = params.handoffMetadataV2;
  return createSessionHandoffMetadataV2({
    ...(incomingMetadata?.providerBundleTransferPublication
      ? { providerBundleTransferPublication: incomingMetadata.providerBundleTransferPublication }
      : currentMetadata?.providerBundleTransferPublication
        ? { providerBundleTransferPublication: currentMetadata.providerBundleTransferPublication }
        : {}),
    ...(incomingMetadata?.workspaceReplicationMetadata
      ? { workspaceReplicationMetadata: incomingMetadata.workspaceReplicationMetadata }
      : currentMetadata?.workspaceReplicationMetadata
        ? { workspaceReplicationMetadata: currentMetadata.workspaceReplicationMetadata }
        : {}),
    ...(incomingMetadata?.workspaceReplicationDirectPeerPublication
      ? {
          workspaceReplicationDirectPeerPublication:
            incomingMetadata.workspaceReplicationDirectPeerPublication,
        }
      : currentMetadata?.workspaceReplicationDirectPeerPublication
        ? {
            workspaceReplicationDirectPeerPublication:
              currentMetadata.workspaceReplicationDirectPeerPublication,
          }
        : {}),
  });
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

async function requestServerRoutedPrepareTransferredBundles(params: Readonly<{
  handoffId: string;
  sourceMachineId: string;
  activeServerDir: string;
  machineTransferChannel: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel']>;
  receiveTransferredBundlesPayloadFile: (params: Readonly<{
    activeServerDir: string;
    payloadFilePath: string;
  }>) => Promise<ResolvedTransferredWorkspacePayload>;
}>): Promise<ResolvedTransferredWorkspacePayload> {
  const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-'));
  const payloadFilePath = join(temporaryDirectory, 'payload.bin');

  try {
    await requestServerRoutedTransferToFile({
      transferId: buildSessionHandoffTransferId(params.handoffId),
      sourceMachineId: params.sourceMachineId,
      machineTransferChannel: params.machineTransferChannel,
      destinationPath: payloadFilePath,
    });
    return await params.receiveTransferredBundlesPayloadFile({
      activeServerDir: params.activeServerDir,
      payloadFilePath,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
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

type PrepareTransferredBundlesResolution = Readonly<{
  kind: 'resolved';
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  transferredBundles: SessionHandoffTransferredBundles;
  providerBundlePayloadSource?: TransferPayloadSource;
  blobProvider?: WorkspaceExportBlobProvider;
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>;

type PrepareTransferredBundlesUnavailable = Readonly<{
  kind: 'unavailable';
  response: ReturnType<typeof directPeerTransferUnavailable>;
}>;

type StartTransferredPayloadDelivery = Readonly<{
  endpointCandidates: readonly TransferEndpointCandidate[];
}>;

async function resolvePrepareTransferredBundles(params: Readonly<{
  current?: StoredHandoffState;
  request: SessionHandoffPrepareTargetRequest;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferRouteCache?: ReturnType<typeof createMachineTransferRouteCache>;
  receiveTransferredBundlesPayloadFile: (params: Readonly<{
    activeServerDir: string;
    payloadFilePath: string;
  }>) => Promise<ResolvedTransferredWorkspacePayload>;
}>): Promise<PrepareTransferredBundlesResolution | PrepareTransferredBundlesUnavailable> {
  const resolved = await resolveRequestedTypedTransferPayload({
    transferId: params.request.handoffId,
    sourceMachineId: params.request.sourceMachineId,
    negotiatedTransportStrategy: params.request.negotiatedTransportStrategy,
    endpointCandidates: params.request.endpointCandidates,
    allowServerRoutedFallback: params.request.allowServerRoutedFallback !== false,
    storedPayload: resolveStoredTransferredWorkspacePayload(params.current),
    requestDirectPeerPayload: async ({ transferId, endpointCandidates }) => {
      const directPeerRouteInput = {
        remoteMachineId: params.request.sourceMachineId,
        endpointCandidates,
      } as const;
      const cachedDirectPeerRoute = params.transferRouteCache?.readDirectPeerRoute(directPeerRouteInput);
      if (cachedDirectPeerRoute?.status === 'unavailable') {
        throw new Error(cachedDirectPeerRoute.failureReason);
      }
      try {
        const requestedFilePayload = params.directPeerTransfer?.requestPayloadFile;
        const requestedPayload = requestedFilePayload
          ? await (async (): Promise<ResolvedTransferredWorkspacePayload> => {
            const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-'));
            const payloadFilePath = join(temporaryDirectory, 'payload.bin');
            try {
              await requestedFilePayload({
                transferId,
                endpointCandidates,
                destinationPath: payloadFilePath,
              });
              return await params.receiveTransferredBundlesPayloadFile({
                activeServerDir: configuration.activeServerDir,
                payloadFilePath,
              });
            } finally {
              await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
          })()
          : (() => {
            throw new Error(`Direct peer transfer is unavailable for ${transferId}`);
          })();
        params.transferRouteCache?.recordDirectPeerRouteViable(directPeerRouteInput);
        return requestedPayload;
      } catch (error) {
        if (isDirectPeerTransferProtocolError(error)) {
          throw error;
        }
        params.transferRouteCache?.recordDirectPeerRouteUnavailable(
          directPeerRouteInput,
          'direct_peer_request_failed',
        );
        throw error;
      }
    },
    requestServerRoutedPayload: params.machineTransferChannel
      ? async ({ sourceMachineId }) =>
        await requestServerRoutedPrepareTransferredBundles({
          handoffId: params.request.handoffId,
          sourceMachineId,
          activeServerDir: configuration.activeServerDir,
          machineTransferChannel: params.machineTransferChannel!,
          receiveTransferredBundlesPayloadFile: params.receiveTransferredBundlesPayloadFile,
        })
      : null,
    isDirectPeerProtocolError: isDirectPeerTransferProtocolError,
    unavailableResponse: directPeerTransferUnavailable,
  });

  return resolved.kind === 'resolved'
    ? {
      kind: 'resolved',
      actualTransportStrategy: resolved.actualTransportStrategy,
      transferredBundles: resolved.payload.transferredBundles,
      ...(resolved.payload.providerBundlePayloadSource
        ? { providerBundlePayloadSource: resolved.payload.providerBundlePayloadSource }
        : {}),
      ...(resolved.payload.blobProvider ? { blobProvider: resolved.payload.blobProvider } : {}),
      ...(resolved.payload.handoffMetadataV2
        ? { handoffMetadataV2: resolved.payload.handoffMetadataV2 }
        : {}),
    }
    : resolved;
}

async function resolvePrepareProviderBundle(params: Readonly<{
  current?: StoredHandoffState;
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  providerBundlePayloadSource?: TransferPayloadSource;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): Promise<SessionHandoffProviderBundle | undefined> {
  if (params.providerBundlePayloadSource?.kind === 'file') {
    return await readSessionHandoffProviderBundleFile(params.providerBundlePayloadSource.filePath);
  }
  if (params.current?.providerBundlePayloadSource?.kind === 'file') {
    return await readSessionHandoffProviderBundleFile(params.current.providerBundlePayloadSource.filePath);
  }

  const transferPublication =
    params.handoffMetadataV2?.providerBundleTransferPublication
    ?? resolveStoredSessionHandoffMetadataV2(params.current)?.providerBundleTransferPublication;
  if (!transferPublication) {
    return undefined;
  }
  const transferEndpointCandidates = transferPublication.endpointCandidates;

  const providerBundle =
    params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel
      ? await requestServerRoutedPrepareProviderBundle({
        transferId: transferPublication.transferId,
        sourceMachineId: params.request.sourceMachineId,
        machineTransferChannel: params.machineTransferChannel,
      })
      : params.actualTransportStrategy === 'direct_peer' && transferEndpointCandidates && params.directPeerTransfer?.requestPayloadFile
        ? await (async (): Promise<SessionHandoffProviderBundle> => {
          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-provider-direct-peer-'));
          const payloadFilePath = join(temporaryDirectory, 'provider-bundle.json');
          try {
            await params.directPeerTransfer!.requestPayloadFile!({
              transferId: transferPublication.transferId,
              endpointCandidates: transferEndpointCandidates,
              destinationPath: payloadFilePath,
            });
            return await readSessionHandoffProviderBundleFile(payloadFilePath);
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

function resolveStartTransferredPayloadDelivery(params: Readonly<{
  negotiatedTransportStrategy: SessionHandoffStartRequest['negotiatedTransportStrategy'];
  transferredBundles: SessionHandoffTransferredBundles;
  transferredPayloadSource?: TransferPayloadSource;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  handoffId: string;
}>): StartTransferredPayloadDelivery {
  const negotiatedTransportStrategy = params.negotiatedTransportStrategy ?? 'direct_peer';
  const delivery = resolveTypedTransferPayloadDelivery({
    transferId: params.handoffId,
    negotiatedTransportStrategy,
    payload: params.transferredBundles,
    payloadSource: params.transferredPayloadSource,
    directPeerTransfer: params.directPeerTransfer,
  });
  return {
    endpointCandidates: delivery.endpointCandidates,
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
  importWorkspaceBundle?: (params: Readonly<{
    workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    blobProvider?: WorkspaceExportBlobProvider;
    targetPath: string;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    assertCanContinue?: () => Promise<void>;
  }>) => Promise<Readonly<{ targetPath: string }>>;
  applyReplicationPlan?: (params: Readonly<{
    activeServerDir: string;
    sourceOffer: NonNullable<Awaited<ReturnType<typeof resolveSessionHandoffWorkspaceReplicationSourceOffer>>>;
    targetPath: string;
    strategy: NonNullable<SessionHandoffWorkspaceTransfer['strategy']>;
    conflictPolicy: SessionHandoffWorkspaceTransfer['conflictPolicy'];
    currentTargetManifest?: WorkspaceManifest;
    assertCanContinue?: () => Promise<void>;
  }>) => Promise<Readonly<{ targetPath: string }>>;
  loadCurrentTargetManifest?: (params: Readonly<{
    targetPath: string;
    workspaceTransfer: SessionHandoffWorkspaceTransfer;
  }>) => Promise<WorkspaceManifest>;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): void {
  const store = new Map<string, StoredHandoffState>();
  const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
    activeServerDir: configuration.activeServerDir,
  });
  const activePrepareJobs = new Map<string, Promise<void>>();
  const activeSourcePreparePayloads = new Map<string, Promise<TransferPayloadSource>>();
  const { rpcHandlerManager } = params;
  const transferRouteCache = createMachineTransferRouteCache({
    serverId: configuration.activeServerId,
  });
  const workspaceReplicationAdapter = createSessionHandoffWorkspaceReplicationAdapter();
  const workspaceReplicationTransfers = workspaceReplicationAdapter.createReplicationTransfers();
  const ephemeralServerRoutedPayloadSources = new Map<string, TransferPayloadSource>();

  const disposeEphemeralServerRoutedPayloadSourcesForHandoff = async (handoffId: string): Promise<void> => {
    for (const [transferId, payloadSource] of [...ephemeralServerRoutedPayloadSources.entries()]) {
      const sourceOfferTransfer = parseSessionHandoffWorkspaceSourceOfferTransferId(transferId);
      const blobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
      if (sourceOfferTransfer?.handoffId !== handoffId && blobPackTransfer?.handoffId !== handoffId) {
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
  const importWorkspaceBundle = params.importWorkspaceBundle;
  const applyReplicationPlanInternal = params.applyReplicationPlan;
  const loadCurrentTargetManifest = params.loadCurrentTargetManifest;
  const shouldDeferSourcePreparation = (request: SessionHandoffStartRequest): boolean =>
    params.machineTransferChannel !== undefined
    && request.sourceMachineId !== request.targetMachineId
    && request.negotiatedTransportStrategy === 'server_routed_stream'
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
    transferredPayloadSource: TransferPayloadSource;
    providerBundlePayloadSource?: TransferPayloadSource;
    directPeerWorkspacePayloadSources?: PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers['payloadSources'];
  }>> => {
    let transferredPayloadSource: TransferPayloadSource | null = null;
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
            payload: createSessionHandoffTransferredBundles({}),
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
      const workspaceTransferredBundles = preparedWorkspaceTransfer.transferredBundles;
      publishedWorkspaceDirectPeerTransfers =
        preparedWorkspaceTransfer.publishedWorkspaceDirectPeerTransfers ?? null;
      const includeWorkspaceBlobPayloads = preparedWorkspaceTransfer.includeWorkspaceBlobPayloads;
      transferredPayloadSource = preparedWorkspaceTransfer.transferredPayloadSource;
      const storedTransferredPayload = {
        ...preparedWorkspaceTransfer.storedTransferredPayload,
        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
      };
      const status = buildStartPendingStatus({
        handoffId: input.handoffId,
        sourceStopState: input.sourceStopState,
      });
      const storedTransferredState = createSessionHandoffStoredTransferredState({
        transferredBundles: storedTransferredPayload.transferredBundles,
        handoffMetadataV2: storedTransferredPayload.handoffMetadataV2 ?? handoffMetadataV2,
      });
      const startTransferredPayloadDelivery = resolveStartTransferredPayloadDelivery({
        negotiatedTransportStrategy: input.request.negotiatedTransportStrategy,
        transferredBundles: workspaceTransferredBundles,
        transferredPayloadSource,
        directPeerTransfer: params.directPeerTransfer,
        handoffId: input.handoffId,
      });

      return {
        targetPath: exported.targetPath,
        endpointCandidates: startTransferredPayloadDelivery.endpointCandidates,
        transferredPayloadSource,
        ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
        ...(publishedWorkspaceDirectPeerTransfers
          ? { directPeerWorkspacePayloadSources: publishedWorkspaceDirectPeerTransfers.payloadSources }
          : {}),
        nextState: {
          status,
          sourceMachineId: input.request.sourceMachineId,
          targetMachineId: input.request.targetMachineId,
          transferredBundles: storedTransferredState.transferredBundles,
          ...(storedTransferredState.handoffMetadataV2 ? { handoffMetadataV2: storedTransferredState.handoffMetadataV2 } : {}),
          ...((storedTransferredPayload.blobProvider ?? exported.blobProvider)
            ? { workspaceBlobProvider: storedTransferredPayload.blobProvider ?? exported.blobProvider }
            : {}),
          ...(providerBundlePayloadSource ? { providerBundlePayloadSource } : {}),
          ...(publishedWorkspaceDirectPeerTransfers
            ? { workspaceReplicationDirectPeerPayloadSources: publishedWorkspaceDirectPeerTransfers.payloadSources }
            : {}),
          ...(!includeWorkspaceBlobPayloads && exported.workspaceExportArtifacts?.blobContentsByDigest.size
            ? { sourceWorkspaceExportArtifactsForReplication: exported.workspaceExportArtifacts }
            : {}),
          transferredPayloadSource,
          workspaceTransfer: input.request.workspaceTransfer,
        },
      };
    } catch (error) {
      await disposeTransferPayloadSource(transferredPayloadSource);
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

        const workspaceSourceOfferTransfer = parseSessionHandoffWorkspaceSourceOfferTransferId(transferId);
        if (workspaceSourceOfferTransfer) {
          const current = store.get(workspaceSourceOfferTransfer.handoffId);
          const workspaceReplicationMetadata =
            resolveStoredSessionHandoffMetadataV2(current)?.workspaceReplicationMetadata;
          if (!workspaceReplicationMetadata || !current?.sourceMachineId || !current.targetMachineId) {
            return null;
          }
          const payloadSource = await createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource({
            activeServerDir: configuration.activeServerDir,
            sourceMachineId: current.sourceMachineId,
            targetMachineId: current.targetMachineId,
            targetPath: workspaceSourceOfferTransfer.targetPath,
            metadata: workspaceReplicationMetadata,
          });
          ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
          return payloadSource;
        }

        const workspaceBlobPackTransfer = parseSessionHandoffWorkspaceBlobPackTransferId(transferId);
        if (workspaceBlobPackTransfer) {
          const current = store.get(workspaceBlobPackTransfer.handoffId);
          if (!current || !resolveStoredSessionHandoffMetadataV2(current)?.workspaceReplicationMetadata) {
            return null;
          }
          const payloadSource = await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
            activeServerDir: configuration.activeServerDir,
            packId: workspaceBlobPackTransfer.packId,
            digests: workspaceBlobPackTransfer.digests,
            blobProvider: current.workspaceBlobProvider,
            workspaceExportArtifacts: current.sourceWorkspaceExportArtifactsForReplication,
          });
          ephemeralServerRoutedPayloadSources.set(transferId, payloadSource);
          return payloadSource;
        }

        const providerBundleTransfer = parseSessionHandoffProviderBundleTransferId(transferId);
        if (providerBundleTransfer) {
          return resolveStoredProviderBundlePayloadSource(store.get(providerBundleTransfer.handoffId));
        }

        const handoffId = parseHandoffIdFromTransferId(transferId);
        if (!handoffId) return null;
        const storedPayloadSource = resolveStoredTransferredPayloadSource(store.get(handoffId));
        if (storedPayloadSource) {
          return storedPayloadSource;
        }
        return await activeSourcePreparePayloads.get(handoffId) ?? null;
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

      store.set(handoffId, {
        status: pendingStatus,
        sourceMachineId: parsed.data.sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        workspaceTransfer: parsed.data.workspaceTransfer,
      });

      const sourcePreparePromise = prepareStartedHandoffState({
        handoffId,
        request: parsed.data,
        metadata,
        sourceStopState,
      });
      activeSourcePreparePayloads.set(
        handoffId,
        sourcePreparePromise.then((prepared) => prepared.transferredPayloadSource),
      );
      void sourcePreparePromise.then(async (prepared) => {
        activeSourcePreparePayloads.delete(handoffId);
        const current = store.get(handoffId);
        if (current?.status.status === 'aborted') {
          await disposeTransferPayloadSource(prepared.transferredPayloadSource);
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
        activeSourcePreparePayloads.delete(handoffId);
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
    let persistedTransferredState = createSessionHandoffStoredTransferredState({
      current,
      transferredBundles: createSessionHandoffTransferredBundles({}),
    });
    let persistedTransferredBundles =
      persistedTransferredState.transferredBundles ?? createSessionHandoffTransferredBundles({});
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
        prepareResult: persistedJob.prepareTargetResult,
        transferredBundles: persistedTransferredBundles,
        ...(persistedTransferredState.handoffMetadataV2 ? { handoffMetadataV2: persistedTransferredState.handoffMetadataV2 } : {}),
        ...(persistedBlobProvider ? { workspaceBlobProvider: persistedBlobProvider } : {}),
        ...(persistedProviderBundlePayloadSource ? { providerBundlePayloadSource: persistedProviderBundlePayloadSource } : {}),
        workspaceTransfer: current?.workspaceTransfer ?? parsed.data.workspaceTransfer,
      });
      return persistedJob.prepareTargetResult;
    }
    if (persistedJob && !isTerminalHandoffStatus(persistedJob.status)) {
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

    const jobId = persistedJob?.jobId ?? buildPrepareJobId();
    const createdAtMs = persistedJob?.createdAtMs ?? Date.now();
    const pendingStatus = buildPreparePendingStatus({
      handoffId: parsed.data.handoffId,
      jobId,
      transportStrategy: parsed.data.negotiatedTransportStrategy,
      recoveryActions: current?.status.recoveryActions ?? [],
      phaseDetail: 'importing_workspace',
    });
    let actualTransportStrategy = parsed.data.negotiatedTransportStrategy;
    let providerBundle: SessionHandoffProviderBundle | null = null;
    let providerBundleTransferPublication: SessionHandoffProviderBundleTransferPublication | null = null;

    const persistJobRecord = async (jobRecord: SessionHandoffPrepareTargetJobRecordInput): Promise<void> => {
      await prepareJobStore.write(jobRecord);
      const previous = store.get(parsed.data.handoffId) ?? current;
      store.set(parsed.data.handoffId, {
        ...(previous ?? {}),
        status: jobRecord.status,
        ...(jobRecord.prepareTargetResult ? { prepareResult: jobRecord.prepareTargetResult } : {}),
        transferredBundles: persistedTransferredBundles,
        ...(persistedTransferredState.handoffMetadataV2 ? { handoffMetadataV2: persistedTransferredState.handoffMetadataV2 } : {}),
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
          const prepareResolution = await resolvePrepareTransferredBundles({
            current,
            request: parsed.data,
            machineTransferChannel: params.machineTransferChannel,
            directPeerTransfer: params.directPeerTransfer,
            transferRouteCache,
            receiveTransferredBundlesPayloadFile: workspaceReplicationAdapter.receiveTransferredBundlesPayloadFile,
          });
          if (prepareResolution.kind === 'unavailable') {
            throw new Error(prepareResolution.response.error);
          }
          actualTransportStrategy = prepareResolution.actualTransportStrategy;
          const resolvedProviderBundlePayloadSource = prepareResolution.providerBundlePayloadSource;
          const handoffMetadataV2 = prepareResolution.handoffMetadataV2;
          providerBundleTransferPublication = handoffMetadataV2?.providerBundleTransferPublication ?? null;
          const resolvedProviderBundle = await resolvePrepareProviderBundle({
            current,
            request: parsed.data,
            actualTransportStrategy,
            providerBundlePayloadSource: resolvedProviderBundlePayloadSource,
            handoffMetadataV2,
            machineTransferChannel: params.machineTransferChannel,
            directPeerTransfer: params.directPeerTransfer,
          });
          if (!resolvedProviderBundle) {
            throw new Error('Invalid session handoff provider bundle');
          }
          providerBundle = resolvedProviderBundle;
          persistedTransferredState = createSessionHandoffStoredTransferredState({
            current,
            transferredBundles: prepareResolution.transferredBundles,
            handoffMetadataV2: resolvePersistedHandoffMetadataV2({
              current,
              handoffMetadataV2,
            }),
          });
          persistedTransferredBundles =
            persistedTransferredState.transferredBundles ?? createSessionHandoffTransferredBundles({});
          persistedBlobProvider = resolvePersistedWorkspaceBlobProvider({
            current,
            blobProvider: prepareResolution.blobProvider,
          });
          persistedProviderBundlePayloadSource =
            current?.providerBundlePayloadSource
            ?? resolvedProviderBundlePayloadSource
            ?? await createSessionHandoffProviderBundlePayloadSource(providerBundle);

          const resolvedWorkspaceTransfer = parsed.data.workspaceTransfer ?? current?.workspaceTransfer;
          const persistedHandoffMetadataV2 =
            resolveStoredSessionHandoffMetadataV2(persistedTransferredState);
          const persistedWorkspaceReplicationMetadata =
            persistedHandoffMetadataV2?.workspaceReplicationMetadata;
          const persistedWorkspaceReplicationDirectPeerPublication =
            persistedHandoffMetadataV2?.workspaceReplicationDirectPeerPublication;
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
            directPeerPublication: persistedWorkspaceReplicationDirectPeerPublication,
            persistedBlobProvider,
            machineTransferChannel: params.machineTransferChannel,
            transfers: workspaceReplicationTransfers,
            blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
            blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
            blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
            persistedTransferredBundles,
            assertCanContinue: assertPrepareJobNotCancelled,
            loadCurrentTargetManifest,
            importWorkspaceBundle,
            ...(applyReplicationPlanInternal
              ? { applyReplicationPlan: applyReplicationPlanInternal }
              : {}),
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
        status,
        ...(persistedJob.prepareTargetResult ? {
          prepareTargetResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      }));
    }
    params.directPeerTransfer?.clearPublishedTransfer(parsed.data.handoffId);
    const providerBundleTransferPublication =
      resolveStoredSessionHandoffMetadataV2(current)?.providerBundleTransferPublication;
    if (providerBundleTransferPublication?.endpointCandidates?.length) {
      params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
    }
    await disposeDirectPeerWorkspacePayloadSources(current);
    await disposeTransferPayloadSource(resolveStoredTransferredPayloadSource(current));
    await disposeTransferPayloadSource(resolveStoredProviderBundlePayloadSource(current));
    await disposeEphemeralServerRoutedPayloadSourcesForHandoff(parsed.data.handoffId);
    store.set(parsed.data.handoffId, {
      ...(store.get(parsed.data.handoffId) ?? {}),
      status,
      ...(persistedJob?.prepareTargetResult ? {
        prepareResult: {
          ...persistedJob.prepareTargetResult,
          status,
        },
      } : {}),
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
        ...(persistedJob.prepareTargetResult ? {
          prepareResult: {
            ...persistedJob.prepareTargetResult,
            status,
          },
        } : {}),
      });
    }

    const status: SessionHandoffStatus = {
      ...(persistedJob?.status ?? current!.status),
      status: 'aborted',
      phase: (persistedJob?.status ?? current!.status).phase,
    };
    activeSourcePreparePayloads.delete(parsed.data.handoffId);
    params.directPeerTransfer?.clearPublishedTransfer(parsed.data.handoffId);
    const providerBundleTransferPublication =
      resolveStoredSessionHandoffMetadataV2(current)?.providerBundleTransferPublication;
    if (providerBundleTransferPublication?.endpointCandidates?.length) {
      params.directPeerTransfer?.clearPublishedTransfer(providerBundleTransferPublication.transferId);
    }
    await disposeDirectPeerWorkspacePayloadSources(current);
    await disposeTransferPayloadSource(resolveStoredTransferredPayloadSource(current));
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

    const current = store.get(parsed.data.handoffId);
    const persistedJob = await readPersistedPrepareJob({
      handoffId: parsed.data.handoffId,
      current,
      jobStore: prepareJobStore,
    });
    if (persistedJob?.prepareTargetResult) {
      return persistedJob.prepareTargetResult;
    }
    if (!current?.prepareResult) return { ok: false, errorCode: 'not_found' } as const;

    return current.prepareResult;
  });
}
