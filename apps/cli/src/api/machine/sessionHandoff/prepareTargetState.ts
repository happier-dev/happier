import { compareWorkspaceManifests } from '../../../scm/workspace/workspaceExportPackaging/compareWorkspaceManifests';
import { normalizeSessionHandoffTargetPathForLocalMachine } from '../../../session/handoff/paths/sessionHandoffPathNormalization';
import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import type {
  SessionHandoffMetadataV2,
  SessionHandoffPrepareTargetRequest,
  SessionHandoffPrepareTargetResultGetSuccessResponse,
  SessionHandoffStartRequest,
  SessionHandoffStatus,
  WorkspaceManifest,
} from '@happier-dev/protocol';

export type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;

const PREPARE_JOB_FAST_PATH_BUDGET_MS = 250;

export function buildStartRecoveryStatus(handoffId: string): SessionHandoffStatus {
  return {
    handoffId,
    status: 'awaiting_recovery',
    phase: 'preparing',
    recoveryActions: ['restart_on_source', 'keep_stopped'],
  };
}

export function buildStartPendingStatus(input: Readonly<{
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

export function normalizeHandoffWorkspaceRootPath(raw: unknown): string | null {
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

export function resolveWorkspaceReplicationHandoffBackTargetRootPath(input: Readonly<{
  metadata: Record<string, unknown>;
  workspaceTransfer: SessionHandoffStartRequest['workspaceTransfer'] | undefined;
  requestedTargetMachineId: string;
}>): string | null {
  if (input.workspaceTransfer?.enabled !== true) return null;
  if (input.workspaceTransfer.strategy !== 'sync_changes') return null;

  const metadataSourceRootPath =
    typeof input.metadata.workspaceReplicationSourceRootPath === 'string'
      ? normalizeHandoffWorkspaceRootPath(input.metadata.workspaceReplicationSourceRootPath)
      : null;
  const handoff = asRecord(input.metadata.handoffV1);
  if (!handoff) {
    return metadataSourceRootPath;
  }

  const priorSourceMachineId = typeof handoff.sourceMachineId === 'string' ? handoff.sourceMachineId.trim() : '';
  if (!priorSourceMachineId || priorSourceMachineId !== input.requestedTargetMachineId) {
    return metadataSourceRootPath;
  }

  const handoffBackTargetRootPath = normalizeHandoffWorkspaceRootPath(handoff.sourceWorkspaceRootPath);
  if (handoffBackTargetRootPath) {
    return handoffBackTargetRootPath;
  }

  return metadataSourceRootPath;
}

export function resolvePrepareTargetWorkspaceRootPath(input: Readonly<{
  requestedTargetPath: string;
  workspaceTransfer: SessionHandoffPrepareTargetRequest['workspaceTransfer'] | undefined;
  handoffMetadataV2: SessionHandoffMetadataV2 | undefined;
  homeDir: string;
}>): string {
  const handoffBackTargetRootPath =
    input.workspaceTransfer?.enabled === true
    && input.workspaceTransfer.strategy === 'sync_changes'
      ? normalizeHandoffWorkspaceRootPath(input.handoffMetadataV2?.workspaceReplicationHandoffBackTargetRootPath)
      : null;

  return normalizeSessionHandoffTargetPathForLocalMachine({
    requestedTargetPath: handoffBackTargetRootPath ?? input.requestedTargetPath,
    homeDir: input.homeDir,
  });
}

export function missingHandoffMetadataV2() {
  return {
    ok: false,
    errorCode: 'missing_handoff_metadata_v2',
    error: 'Handoff metadata V2 is required to prepare the target',
  } as const;
}

export function invalidRequest() {
  return { ok: false, errorCode: 'invalid_request' } as const;
}

export function buildPrepareJobId(handoffId: string): string {
  return `prepare_${handoffId}`;
}

export function buildSourceExportOnlyPrepareJobId(handoffId: string): string {
  return `source_${handoffId}`;
}

export function isTerminalHandoffStatus(status: SessionHandoffStatus): boolean {
  return status.status === 'ready_for_cutover'
    || status.status === 'completed'
    || status.status === 'aborted'
    || status.status === 'failed'
    || status.status === 'awaiting_recovery'
    || status.status === 'awaiting_user_resume'
    || status.status === 'reconciliation_required';
}

export function buildPreparePendingStatus(input: Readonly<{
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
      applied: {},
      remaining: {},
      current: {
        phaseDetail: input.phaseDetail,
      },
      resumable: false,
    },
  };
}

export function buildWorkspaceReplicationStatusProgress(params: Readonly<{
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
  const totalFiles = transferredFileEntries.length;

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
        totalFiles,
        totalBytes,
        added: comparison.added.length,
        changed: comparison.changed.length,
        removed: comparison.removed.length,
      },
      transferred: {
        files: totalFiles,
        bytes: totalBytes,
        blobs: params.blobCount,
      },
      applied: {
        files: 0,
        bytes: 0,
      },
      remaining: {
        files: 0,
        bytes: 0,
      },
      current: {
        phaseDetail: params.phaseDetail,
      },
      resumable: false,
    },
  };
}

export function buildPrepareJobRecord(input: Readonly<{
  jobId: string;
  handoffId: string;
  status: SessionHandoffStatus;
  prepareTargetRequest?: SessionHandoffPrepareTargetRequest;
  prepareTargetResult?: SessionHandoffPrepareTargetResultGetSuccessResponse;
  createdAtMs: number;
  updatedAtMs?: number;
  cancelRequestedAtMs?: number;
  abortedAtMs?: number;
  completedAtMs?: number;
  failedAtMs?: number;
  lastErrorMessage?: string;
  lastErrorCode?: string;
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
    ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
    ...(input.workspaceReplicationJobId ? { workspaceReplicationJobId: input.workspaceReplicationJobId } : {}),
    status: input.status,
    ...(input.prepareTargetRequest ? { prepareTargetRequest: input.prepareTargetRequest } : {}),
    ...(input.prepareTargetResult ? { prepareTargetResult: input.prepareTargetResult } : {}),
  };
}

export async function readPersistedPrepareJob(params: Readonly<{
  handoffId: string;
  jobStore: SessionHandoffPrepareTargetJobStore;
}>): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  const byHandoffId = await params.jobStore.findByHandoffId(params.handoffId);
  if (byHandoffId) {
    return byHandoffId;
  }

  const prepareJobId = buildPrepareJobId(params.handoffId);
  const prepareJob = await params.jobStore.read(prepareJobId);
  if (prepareJob?.handoffId === params.handoffId) {
    return prepareJob;
  }

  const sourceJobId = buildSourceExportOnlyPrepareJobId(params.handoffId);
  const sourceJob = await params.jobStore.read(sourceJobId);
  if (sourceJob?.handoffId === params.handoffId) {
    return sourceJob;
  }

  return null;
}

export async function waitForPrepareJobFastPath(runPromise: Promise<void>): Promise<'completed' | 'pending'> {
  return await Promise.race([
    runPromise.then(() => 'completed' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), PREPARE_JOB_FAST_PATH_BUDGET_MS);
    }),
  ]);
}
