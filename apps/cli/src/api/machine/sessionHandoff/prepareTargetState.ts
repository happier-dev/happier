import { normalizeSessionHandoffTargetPathForLocalMachine } from '../../../session/handoff/paths/sessionHandoffPathNormalization';
import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecord,
  type SessionHandoffPrepareTargetJobRecordInput,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';

import {
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffPrepareTargetResultGetSuccessResponse,
  type SessionHandoffStatus,
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

export function resolvePrepareTargetWorkspaceRootPath(input: Readonly<{
  requestedTargetPath: string;
  homeDir: string;
}>): string {
  return normalizeSessionHandoffTargetPathForLocalMachine({
    requestedTargetPath: input.requestedTargetPath,
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
  sessionTransfer?: Readonly<{ currentBytes: number; totalBytes: number }>;
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
      checkpoint: 'import_session',
      planned: input.sessionTransfer ? { totalBytes: input.sessionTransfer.totalBytes } : {},
      transferred: input.sessionTransfer ? { bytes: input.sessionTransfer.currentBytes } : {},
      applied: {},
      remaining: {},
      current: {
        phaseDetail: input.phaseDetail,
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
