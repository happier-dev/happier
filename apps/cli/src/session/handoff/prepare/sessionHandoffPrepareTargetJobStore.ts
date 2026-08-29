import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResultGetSuccessResponseSchema,
  SessionHandoffStatusSchema,
} from '@happier-dev/protocol';

import {
  releaseSessionHandoffPrepareTargetJobLease,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { logger } from '@/ui/logger';

const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1 = 1 as const;
const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2 = 2 as const;

const SessionHandoffPrepareTargetJobRecordV1Schema = z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1),
    jobId: z.string().min(1),
    handoffId: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    lastErrorCode: z.string().min(1).optional(),
    status: SessionHandoffStatusSchema,
    // Persist the validated prepare-target request so the daemon can resume/restart the job after a restart,
    // even when callers keep polling status/result without issuing a second PREPARE_TARGET call.
    prepareTargetRequest: SessionHandoffPrepareTargetRequestSchema.optional(),
    prepareTargetResult: SessionHandoffPrepareTargetResultGetSuccessResponseSchema.optional(),
  })
  .strip()
  .superRefine((record, ctx) => {
    if (record.status.handoffId !== record.handoffId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'handoffId'],
        message: 'Prepare-target job status must use the same handoffId as the record',
      });
    }

    if (record.status.jobId && record.status.jobId !== record.jobId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status', 'jobId'],
        message: 'Prepare-target job status.jobId must match the record jobId',
      });
    }

    if (record.prepareTargetResult && record.prepareTargetResult.handoffId !== record.handoffId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prepareTargetResult', 'handoffId'],
        message: 'Prepare-target job result must use the same handoffId as the record',
      });
    }

    if (
      record.prepareTargetResult
      && record.prepareTargetResult.status.handoffId !== record.handoffId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prepareTargetResult', 'status', 'handoffId'],
        message: 'Prepare-target job result status must use the same handoffId as the record',
      });
    }
  });

const SessionHandoffPrepareRecoveryAttemptFenceV2Schema = z.object({
  attemptId: z.string().min(1).max(256),
  acceptedAtMs: z.number().int().min(0),
  acceptedRevision: z.number().int().min(0),
}).strict();

const SessionHandoffPrepareRecoveryStateV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_attempted') }).strict(),
  z.object({
    status: z.literal('awaiting_user_resume'),
    // Observation after a crashed accepted attempt remains passive, but retains the original
    // fence so that the identical request can rejoin without granting a replacement implicitly.
    interruptedAttempt: SessionHandoffPrepareRecoveryAttemptFenceV2Schema.optional(),
  }).strict(),
  z.object({
    status: z.literal('attempted'),
    ...SessionHandoffPrepareRecoveryAttemptFenceV2Schema.shape,
  }).strict(),
]);

const SessionHandoffRuntimeResumeStateV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_attempted') }).strict(),
  z.object({ status: z.literal('preexisting_unowned') }).strict(),
  z.object({
    status: z.literal('attempted'),
    attemptId: z.string().min(1),
    acceptedAtMs: z.number().int().min(0),
  }).strict(),
  z.object({
    status: z.literal('confirmed'),
    attemptId: z.string().min(1),
    acceptedAtMs: z.number().int().min(0),
    confirmedAtMs: z.number().int().min(0),
  }).strict(),
]);

const SessionHandoffTerminalStateV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }).strict(),
  z.object({
    status: z.literal('aborting'),
    operationId: z.string().min(1),
    claimedRevision: z.number().int().min(0),
  }).strict(),
  z.object({
    status: z.literal('aborted'),
    operationId: z.string().min(1),
    completedRevision: z.number().int().min(0),
  }).strict(),
  z.object({
    status: z.literal('completed'),
    operationId: z.string().min(1),
    completedRevision: z.number().int().min(0),
  }).strict(),
]);

const SessionHandoffTargetCleanupV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('legacy_cleanup_unavailable') }).strict(),
  z.object({ status: z.literal('not_applicable'), reason: z.literal('source_only') }).strict(),
  z.object({ status: z.literal('not_required') }).strict(),
  z.object({ status: z.literal('pending') }).strict(),
  z.object({
    status: z.literal('proved_absent'),
    proof: z.enum(['stopped', 'already_inactive']),
    provedAtMs: z.number().int().min(0),
  }).strict(),
  z.object({
    status: z.literal('not_owned'),
    reason: z.enum(['resume_not_attempted', 'preexisting_or_adopted']),
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['failed', 'unreachable', 'ambiguous']),
    attemptedAtMs: z.number().int().min(0),
  }).strict(),
]);

const sessionHandoffPrepareTargetJobV2CommonShape = {
  jobId: z.string().min(1),
  handoffId: z.string().min(1),
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
  cancelRequestedAtMs: z.number().int().min(0).optional(),
  abortedAtMs: z.number().int().min(0).optional(),
  completedAtMs: z.number().int().min(0).optional(),
  failedAtMs: z.number().int().min(0).optional(),
  lastErrorMessage: z.string().min(1).optional(),
  lastErrorCode: z.string().min(1).optional(),
  status: SessionHandoffStatusSchema,
  prepareTargetRequest: SessionHandoffPrepareTargetRequestSchema.optional(),
  prepareTargetResult: SessionHandoffPrepareTargetResultGetSuccessResponseSchema.optional(),
  transitionRevision: z.number().int().min(0),
  prepareRecovery: SessionHandoffPrepareRecoveryStateV2Schema.default({ status: 'not_attempted' }),
  terminal: SessionHandoffTerminalStateV2Schema,
} as const;

const SessionHandoffPreparedTargetJobRecordV2Schema = z.object({
  schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
  recordKind: z.literal('prepared_target'),
  ...sessionHandoffPrepareTargetJobV2CommonShape,
  sessionId: z.string().min(1),
  resume: SessionHandoffRuntimeResumeStateV2Schema,
  targetCleanup: SessionHandoffTargetCleanupV2Schema,
}).strip();

const SessionHandoffLegacyTargetJobRecordV2Schema = z.object({
  schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
  recordKind: z.literal('legacy_target'),
  ...sessionHandoffPrepareTargetJobV2CommonShape,
  resume: z.object({ status: z.literal('legacy_unknown') }).strict(),
  targetCleanup: z.object({ status: z.literal('legacy_cleanup_unavailable') }).strict(),
}).strip();

const SessionHandoffSourceOnlyJobRecordV2Schema = z.object({
  schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
  recordKind: z.literal('source_only'),
  ...sessionHandoffPrepareTargetJobV2CommonShape,
  sessionId: z.string().min(1).optional(),
  resume: z.object({ status: z.literal('not_applicable') }).strict(),
  targetCleanup: z.object({ status: z.literal('not_applicable'), reason: z.literal('source_only') }).strict(),
}).strip();

const SessionHandoffPrepareTargetJobRecordV2Schema = z.discriminatedUnion('recordKind', [
  SessionHandoffPreparedTargetJobRecordV2Schema,
  SessionHandoffLegacyTargetJobRecordV2Schema,
  SessionHandoffSourceOnlyJobRecordV2Schema,
]);

const SessionHandoffPrepareTargetJobRecordSchema = z.union([
  SessionHandoffPrepareTargetJobRecordV1Schema,
  SessionHandoffPrepareTargetJobRecordV2Schema,
]);

export type SessionHandoffPrepareTargetJobRecord = z.output<typeof SessionHandoffPrepareTargetJobRecordSchema>;
export type SessionHandoffPrepareTargetJobRecordV2 = z.output<typeof SessionHandoffPrepareTargetJobRecordV2Schema>;
export type SessionHandoffPrepareTargetJobRecordInput = Omit<
  z.output<typeof SessionHandoffPrepareTargetJobRecordV1Schema>,
  'schemaVersion'
>;
export type SessionHandoffPrepareTargetResumeAcceptance =
  | Readonly<{
      ok: true;
      disposition: 'accepted' | 'replay';
      record: SessionHandoffPrepareTargetJobRecordV2;
    }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'not_found'
        | 'identity_conflict'
        | 'stale_revision'
        | 'attempt_conflict'
        | 'invalid_state'
        | 'reconciliation_required';
    }>;

export type SessionHandoffPrepareTargetJobStore = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecordInput) => Promise<void>;
  read: (jobId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  findByHandoffId: (handoffId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  list: (input?: Readonly<{ handoffId?: string }>) => Promise<readonly SessionHandoffPrepareTargetJobRecord[]>;
  update: (
    jobId: string,
    updater: (
      current: SessionHandoffPrepareTargetJobRecord,
    ) => Omit<SessionHandoffPrepareTargetJobRecord, 'schemaVersion'>,
  ) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  upgradeReadyV1ToPreparedV2: (input: Readonly<{
    jobId: string;
    sessionId: string;
  }>) => Promise<SessionHandoffPrepareTargetJobRecordV2>;
  transitionPredecessorV2: (
    jobId: string,
    updater: (
      current: SessionHandoffPrepareTargetJobRecordV2,
    ) => Omit<SessionHandoffPrepareTargetJobRecordV2, 'schemaVersion'> | null,
  ) => Promise<SessionHandoffPrepareTargetJobRecordV2 | null>;
  hydrateInterrupted: (jobId: string, nowMs: number) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  acceptPrepareTargetResume: (input: Readonly<{
    jobId: string;
    handoffId: string;
    expectedRevision: number;
    attemptId: string;
    nowMs: number;
  }>) => Promise<SessionHandoffPrepareTargetResumeAcceptance>;
}>;

const PREPARE_TARGET_JOB_LOCK_TIMEOUT_MS = 5_000;
const PREPARE_TARGET_JOB_LOCK_STALE_AFTER_MS = 30_000;

async function withPrepareTargetJobMutationLock<T>(
  jobPath: string,
  mutation: () => Promise<T>,
): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: `${jobPath}.lock`,
    timeoutMs: PREPARE_TARGET_JOB_LOCK_TIMEOUT_MS,
    staleAfterMs: PREPARE_TARGET_JOB_LOCK_STALE_AFTER_MS,
    errorCode: 'session_handoff_prepare_target_job_lock_timeout',
  }, mutation);
}

function assertJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(jobId)) {
    throw new Error(`Invalid session handoff prepare-target job id: ${jobId}`);
  }
}

function assertV1Identity(
  current: z.output<typeof SessionHandoffPrepareTargetJobRecordV1Schema>,
  next: Readonly<{ jobId: string; handoffId: string; createdAtMs: number }>,
): void {
  if (
    next.jobId !== current.jobId
    || next.handoffId !== current.handoffId
    || next.createdAtMs !== current.createdAtMs
  ) {
    throw new Error('Session handoff legacy v1 job identity is immutable');
  }
}

function assertV2Identity(
  current: SessionHandoffPrepareTargetJobRecordV2,
  next: SessionHandoffPrepareTargetJobRecordV2,
): void {
  const currentSessionId = 'sessionId' in current ? current.sessionId : undefined;
  const nextSessionId = 'sessionId' in next ? next.sessionId : undefined;
  if (
    next.jobId !== current.jobId
    || next.handoffId !== current.handoffId
    || next.recordKind !== current.recordKind
    || next.createdAtMs !== current.createdAtMs
    || nextSessionId !== currentSessionId
  ) {
    throw new Error('Session handoff v2 job identity is immutable');
  }
  if (!isDeepStrictEqual(next.prepareTargetRequest, current.prepareTargetRequest)) {
    throw new Error('Session handoff prepare-target semantic request is immutable');
  }
  if (next.transitionRevision !== current.transitionRevision + 1) {
    throw new Error('Session handoff v2 transition revision must advance exactly once');
  }
  if (next.updatedAtMs < current.updatedAtMs) {
    throw new Error('Session handoff v2 updatedAtMs cannot move backward');
  }
  if (current.prepareRecovery.status === 'attempted') {
    const nextAttempt =
      next.prepareRecovery.status === 'attempted'
        ? next.prepareRecovery
        : next.prepareRecovery.status === 'awaiting_user_resume'
          ? next.prepareRecovery.interruptedAttempt
          : undefined;
    if (!isSamePrepareRecoveryAttempt(nextAttempt, current.prepareRecovery)) {
      throw new Error('Session handoff prepare recovery attempt identity is immutable');
    }
  }
  if (current.prepareRecovery.status === 'awaiting_user_resume') {
    if (next.prepareRecovery.status === 'not_attempted') {
      throw new Error('Session handoff prepare recovery state cannot move backward');
    }
    const interruptedAttempt = current.prepareRecovery.interruptedAttempt;
    if (interruptedAttempt && next.prepareRecovery.status === 'awaiting_user_resume') {
      if (!isSamePrepareRecoveryAttempt(next.prepareRecovery.interruptedAttempt, interruptedAttempt)) {
        throw new Error('Session handoff interrupted prepare recovery attempt identity is immutable');
      }
    }
    if (next.prepareRecovery.status === 'attempted') {
      const rejoinsInterruptedAttempt = interruptedAttempt
        ? isSamePrepareRecoveryAttempt(next.prepareRecovery, interruptedAttempt)
        : false;
      const acceptsCurrentRevisionAttempt =
        next.prepareRecovery.acceptedRevision === current.transitionRevision;
      if (!rejoinsInterruptedAttempt && !acceptsCurrentRevisionAttempt) {
        throw new Error('Session handoff prepare recovery attempt must rejoin its fence or accept the current revision');
      }
    }
  }
}

function assertPredecessorV2Transition(
  current: SessionHandoffPrepareTargetJobRecordV2,
  next: SessionHandoffPrepareTargetJobRecordV2,
): void {
  assertV2Identity(current, next);
  if (current.recordKind === 'prepared_target' && next.recordKind === 'prepared_target') {
    if (current.resume.status === 'not_attempted') {
      if (
        next.resume.status !== 'not_attempted'
        && next.resume.status !== 'preexisting_unowned'
        && next.resume.status !== 'attempted'
      ) {
        throw new Error('Session handoff predecessor resume cannot skip directly to confirmed');
      }
    } else if (current.resume.status === 'preexisting_unowned') {
      if (next.resume.status !== 'preexisting_unowned') {
        throw new Error('Session handoff predecessor unowned resume classification is immutable');
      }
    } else if (current.resume.status === 'attempted') {
      if (
        (next.resume.status !== 'attempted' && next.resume.status !== 'confirmed')
        || next.resume.attemptId !== current.resume.attemptId
        || next.resume.acceptedAtMs !== current.resume.acceptedAtMs
      ) {
        throw new Error('Session handoff predecessor resume attempt identity is immutable');
      }
    } else if (
      next.resume.status !== 'confirmed'
      || next.resume.attemptId !== current.resume.attemptId
      || next.resume.acceptedAtMs !== current.resume.acceptedAtMs
      || next.resume.confirmedAtMs !== current.resume.confirmedAtMs
    ) {
      throw new Error('Session handoff predecessor confirmed resume is immutable');
    }
  }
  if (current.terminal.status === 'completed' || current.terminal.status === 'aborted') {
    throw new Error('Session handoff predecessor terminal state is immutable');
  }
  if (
    current.terminal.status === 'aborting'
    && (
      (next.terminal.status !== 'aborting' && next.terminal.status !== 'aborted')
      || next.terminal.operationId !== current.terminal.operationId
    )
  ) {
    throw new Error('Session handoff predecessor abort operation identity is immutable');
  }
  const terminalRevision =
    next.terminal.status === 'aborting'
      ? next.terminal.claimedRevision
      : next.terminal.status === 'completed' || next.terminal.status === 'aborted'
        ? next.terminal.completedRevision
        : null;
  if (terminalRevision !== null && terminalRevision !== next.transitionRevision) {
    throw new Error('Session handoff predecessor terminal revision must match the transition');
  }
}

function isSamePrepareRecoveryAttempt(
  left: Readonly<{
    attemptId: string;
    acceptedAtMs: number;
    acceptedRevision: number;
  }> | undefined,
  right: Readonly<{
    attemptId: string;
    acceptedAtMs: number;
    acceptedRevision: number;
  }>,
): boolean {
  return left?.attemptId === right.attemptId
    && left.acceptedAtMs === right.acceptedAtMs
    && left.acceptedRevision === right.acceptedRevision;
}

function buildInterruptedProgress(
  progress: z.output<typeof SessionHandoffStatusSchema>['progress'],
  nowMs: number,
  phaseDetail: 'daemon_restart_awaiting_user_resume' | 'daemon_restart_reconciliation_required',
) {
  return {
    ...(progress ?? {
      updatedAtMs: nowMs,
      checkpoint: 'stage_target' as const,
      planned: {},
      transferred: {},
    }),
    updatedAtMs: Math.max(progress?.updatedAtMs ?? 0, nowMs),
    current: {
      ...(progress?.current ?? {}),
      phaseDetail,
    },
    resumable: true,
  };
}

function toInterruptedLegacyTargetV2(
  current: z.output<typeof SessionHandoffPrepareTargetJobRecordV1Schema>,
  nowMs: number,
): SessionHandoffPrepareTargetJobRecordV2 {
  const progress = current.status.progress;
  const canResume = current.prepareTargetRequest !== undefined;
  return SessionHandoffLegacyTargetJobRecordV2Schema.parse({
    ...current,
    schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
    recordKind: 'legacy_target',
    updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    transitionRevision: 0,
    prepareRecovery: canResume ? { status: 'awaiting_user_resume' } : { status: 'not_attempted' },
    resume: { status: 'legacy_unknown' },
    terminal: { status: 'open' },
    targetCleanup: { status: 'legacy_cleanup_unavailable' },
    status: {
      ...current.status,
      status: canResume ? 'awaiting_user_resume' : 'reconciliation_required',
      progress: buildInterruptedProgress(
        progress,
        nowMs,
        canResume
          ? 'daemon_restart_awaiting_user_resume'
          : 'daemon_restart_reconciliation_required',
      ),
    },
  });
}

function isTerminalPrepareTargetStatusCode(status: SessionHandoffPrepareTargetJobRecord['status']['status']): boolean {
  return status === 'ready_for_cutover'
    || status === 'completed'
    || status === 'aborted'
    || status === 'failed'
    || status === 'awaiting_recovery'
    || status === 'awaiting_user_resume'
    || status === 'reconciliation_required';
}

export async function recoverSessionHandoffPrepareTargetJobsAfterRestart(input: Readonly<{
  activeServerDir: string;
  nowMs: number;
}>): Promise<Readonly<{ deferredByLiveRunnerLease: boolean }>> {
  const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir: input.activeServerDir });
  const jobs = await store.list();
  const deferredByLiveRunnerLease = await Promise.all(jobs.map(async (job) => {
    if (isTerminalPrepareTargetStatusCode(job.status.status)) {
      return false;
    }

    // Fail closed: if another daemon instance still owns a live durable lease, do not reconstruct
    // an explicit recovery state, since doing so would clobber a legitimately advancing job.
    const probeOwnerId = `cli-daemon:${process.pid}:prepare-target-recovery:${randomUUID()}`;
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      nowMs: input.nowMs,
      ttlMs: 250,
    });
    if (!leaseAttempt.acquired) {
      return true;
    }
    await releaseSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
    }).catch(() => undefined);

    if (!job.cancelRequestedAtMs) {
      await store.hydrateInterrupted(job.jobId, input.nowMs);
      return false;
    }

    await store.update(job.jobId, (current) => {
      const { schemaVersion: _schemaVersion, ...rest } = current;
      const previousProgress = rest.status.progress;
      const nextProgress = previousProgress
        ? {
          ...previousProgress,
          updatedAtMs: input.nowMs,
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
          updatedAtMs: input.nowMs,
          abortedAtMs: rest.abortedAtMs ?? input.nowMs,
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
        updatedAtMs: input.nowMs,
        status: {
          ...rest.status,
          status: 'awaiting_recovery',
          ...(nextProgress ? { progress: nextProgress } : {}),
        },
        lastErrorMessage: rest.lastErrorMessage ?? recoveryMessage,
      };
    });
    return false;
  }));
  return {
    deferredByLiveRunnerLease: deferredByLiveRunnerLease.some(Boolean),
  };
}

async function quarantineInvalidPrepareTargetJobFile(filePath: string): Promise<void> {
  const quarantinePath = `${filePath}.invalid-${Date.now()}-${randomUUID()}`;
  try {
    await rename(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    throw error;
  }
  logger.debug(
    `[SESSION HANDOFF] Quarantined invalid prepare-target job '${filePath}' as '${quarantinePath}'`,
  );
}

/**
 * Reads while the job mutation lock is held. Invalid retained bytes are moved
 * aside once so one torn job cannot block recovery of every valid job after
 * each daemon restart. The exact bytes remain available for diagnosis.
 */
async function readPrepareTargetJobFileUnlocked(filePath: string): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      await quarantineInvalidPrepareTargetJobFile(filePath);
      return null;
    }
    const value = normalizePredecessorV2RecoveryActions(decoded);
    const parsed = SessionHandoffPrepareTargetJobRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readPrepareTargetJobFile(filePath: string): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  return await withPrepareTargetJobMutationLock(
    filePath,
    async () => await readPrepareTargetJobFileUnlocked(filePath),
  );
}

/**
 * The exact remote-dev 1b32cdc6 V2 record can persist retry_target_cleanup, which the current
 * recovery owner intentionally replaced with retrying the idempotent abort RPC while keeping the
 * source stopped. Normalize only this persisted predecessor seam; do not loosen the protocol-wide
 * recovery-action union. Remove with the V2 predecessor adapter once those records are unreachable.
 */
function normalizePredecessorV2RecoveryActions(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) return value;
  const normalizeStatus = (candidate: unknown): unknown => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    const status = candidate as Record<string, unknown>;
    if (!Array.isArray(status.recoveryActions) || !status.recoveryActions.includes('retry_target_cleanup')) {
      return candidate;
    }
    return {
      ...status,
      recoveryActions: status.recoveryActions.filter(
        (action) => action !== 'retry_target_cleanup',
      ),
    };
  };
  const prepareTargetResult =
    record.prepareTargetResult
    && typeof record.prepareTargetResult === 'object'
    && !Array.isArray(record.prepareTargetResult)
      ? record.prepareTargetResult as Record<string, unknown>
      : null;
  return {
    ...record,
    status: normalizeStatus(record.status),
    ...(prepareTargetResult
      ? {
          prepareTargetResult: {
            ...prepareTargetResult,
            status: normalizeStatus(prepareTargetResult.status),
          },
        }
      : {}),
  };
}
export function createSessionHandoffPrepareTargetJobStore(input: Readonly<{
  activeServerDir: string;
}>): SessionHandoffPrepareTargetJobStore {
  const jobsDirectory = join(input.activeServerDir, 'session-handoff', 'prepare-target-jobs');

  function resolveJobPath(jobId: string): string {
    assertJobId(jobId);
    return join(jobsDirectory, `${jobId}.json`);
  }

  return {
    async write(record) {
      const jobPath = resolveJobPath(record.jobId);
      await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        await mkdir(jobsDirectory, { recursive: true });
        if (current?.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
            ...current,
            ...record,
            schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
            transitionRevision: current.transitionRevision + 1,
            prepareRecovery: current.prepareRecovery,
            updatedAtMs: Math.max(current.updatedAtMs, record.updatedAtMs),
          });
          assertV2Identity(current, next);
          await writeJsonAtomic(jobPath, next);
          return;
        }
        const parsed = SessionHandoffPrepareTargetJobRecordV1Schema.parse({
          ...record,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1,
        });
        if (current) assertV1Identity(current, parsed);
        await writeJsonAtomic(jobPath, parsed);
      });
    },
    async read(jobId) {
      return await readPrepareTargetJobFile(resolveJobPath(jobId));
    },
    async findByHandoffId(handoffId) {
      await mkdir(jobsDirectory, { recursive: true });
      const entries = await readdir(jobsDirectory);
      let latestPrepareMatch: SessionHandoffPrepareTargetJobRecord | null = null;
      let latestSourceMatch: SessionHandoffPrepareTargetJobRecord | null = null;
      let latestFallbackMatch: SessionHandoffPrepareTargetJobRecord | null = null;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const record = await readPrepareTargetJobFile(join(jobsDirectory, entry));
        if (!record || record.handoffId !== handoffId) continue;
        const bucket =
          record.jobId.startsWith('prepare_')
            ? 'prepare'
            : record.jobId.startsWith('source_')
              ? 'source'
              : 'fallback';
        if (bucket === 'prepare') {
          if (!latestPrepareMatch || record.updatedAtMs > latestPrepareMatch.updatedAtMs) {
            latestPrepareMatch = record;
          }
          continue;
        }
        if (bucket === 'source') {
          if (!latestSourceMatch || record.updatedAtMs > latestSourceMatch.updatedAtMs) {
            latestSourceMatch = record;
          }
          continue;
        }
        if (!latestFallbackMatch || record.updatedAtMs > latestFallbackMatch.updatedAtMs) {
          latestFallbackMatch = record;
        }
      }
      return latestPrepareMatch ?? latestSourceMatch ?? latestFallbackMatch;
    },
    async list(input) {
      await mkdir(jobsDirectory, { recursive: true });
      const entries = await readdir(jobsDirectory);
      const records: SessionHandoffPrepareTargetJobRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const record = await readPrepareTargetJobFile(join(jobsDirectory, entry));
        if (!record) continue;
        if (input?.handoffId && record.handoffId !== input.handoffId) continue;
        records.push(record);
      }
      records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      return records;
    },
    async update(jobId, updater) {
      const jobPath = resolveJobPath(jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        if (!current) return null;
        const nextInput = updater(structuredClone(current));
        if (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
            ...nextInput,
            schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
            transitionRevision: current.transitionRevision + 1,
            prepareRecovery: current.prepareRecovery,
            updatedAtMs: Math.max(current.updatedAtMs, nextInput.updatedAtMs),
          });
          assertV2Identity(current, next);
          await writeJsonAtomic(jobPath, next);
          return next;
        }
        const next = SessionHandoffPrepareTargetJobRecordV1Schema.parse({
          ...nextInput,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1,
        });
        assertV1Identity(current, next);
        await writeJsonAtomic(jobPath, next);
        return next;
      });
    },
    async upgradeReadyV1ToPreparedV2(upgradeInput) {
      const jobPath = resolveJobPath(upgradeInput.jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        if (!current) {
          throw new Error(`Session handoff prepare-target job not found: ${upgradeInput.jobId}`);
        }
        if (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          if (
            current.recordKind !== 'prepared_target'
            || current.sessionId !== upgradeInput.sessionId
          ) {
            throw new Error('Existing v2 handoff job does not match the exact target session');
          }
          return current;
        }
        if (current.status.status !== 'ready_for_cutover' || !current.prepareTargetResult) {
          throw new Error('Only a ready v1 target job can be promoted for predecessor V2 resume');
        }
        const promoted = SessionHandoffPreparedTargetJobRecordV2Schema.parse({
          ...current,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
          recordKind: 'prepared_target',
          sessionId: upgradeInput.sessionId,
          transitionRevision: 0,
          prepareRecovery: { status: 'not_attempted' },
          resume: { status: 'not_attempted' },
          terminal: { status: 'open' },
          targetCleanup: { status: 'not_required' },
        });
        await writeJsonAtomic(jobPath, promoted);
        return promoted;
      });
    },
    async transitionPredecessorV2(jobId, updater) {
      const jobPath = resolveJobPath(jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        if (!current) return null;
        if (current.schemaVersion !== SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          throw new Error('Predecessor V2 transition cannot mutate a v1 handoff job');
        }
        const baseline = structuredClone(current);
        const nextInput = updater(structuredClone(baseline));
        if (nextInput === null) return baseline;
        const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
          ...nextInput,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
        });
        assertPredecessorV2Transition(baseline, next);
        await writeJsonAtomic(jobPath, next);
        return next;
      });
    },
    async hydrateInterrupted(jobId, nowMs) {
      const jobPath = resolveJobPath(jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        if (!current || isTerminalPrepareTargetStatusCode(current.status.status)) {
          return current;
        }
        if (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1) {
          const converted = toInterruptedLegacyTargetV2(current, nowMs);
          await writeJsonAtomic(jobPath, converted);
          return converted;
        }
        if (current.prepareRecovery.status === 'awaiting_user_resume') {
          return current;
        }
        const progress = current.status.progress;
        const canResume = current.prepareTargetRequest !== undefined;
        const interruptedAttempt =
          current.prepareRecovery.status === 'attempted'
            ? {
                attemptId: current.prepareRecovery.attemptId,
                acceptedAtMs: current.prepareRecovery.acceptedAtMs,
                acceptedRevision: current.prepareRecovery.acceptedRevision,
              }
            : undefined;
        const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
          ...current,
          transitionRevision: current.transitionRevision + 1,
          updatedAtMs: Math.max(current.updatedAtMs, nowMs),
          prepareRecovery:
            canResume || interruptedAttempt
              ? {
                  status: 'awaiting_user_resume',
                  ...(interruptedAttempt ? { interruptedAttempt } : {}),
                }
              : { status: 'not_attempted' },
          status: {
            ...current.status,
            status: canResume ? 'awaiting_user_resume' : 'reconciliation_required',
            progress: buildInterruptedProgress(
              progress,
              nowMs,
              canResume
                ? 'daemon_restart_awaiting_user_resume'
                : 'daemon_restart_reconciliation_required',
            ),
          },
        });
        assertV2Identity(current, next);
        await writeJsonAtomic(jobPath, next);
        return next;
      });
    },
    async acceptPrepareTargetResume(resumeInput) {
      const jobPath = resolveJobPath(resumeInput.jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFileUnlocked(jobPath);
        if (!current) return { ok: false, errorCode: 'not_found' } as const;
        if (
          current.jobId !== resumeInput.jobId
          || current.handoffId !== resumeInput.handoffId
        ) {
          return { ok: false, errorCode: 'identity_conflict' } as const;
        }
        if (current.schemaVersion !== SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          return { ok: false, errorCode: 'invalid_state' } as const;
        }
        if (current.prepareRecovery.status === 'attempted') {
          if (current.prepareRecovery.attemptId !== resumeInput.attemptId) {
            return { ok: false, errorCode: 'attempt_conflict' } as const;
          }
          if (resumeInput.expectedRevision !== current.prepareRecovery.acceptedRevision) {
            return { ok: false, errorCode: 'stale_revision' } as const;
          }
          return { ok: true, disposition: 'replay', record: current } as const;
        }
        const interruptedAttempt =
          current.prepareRecovery.status === 'awaiting_user_resume'
            ? current.prepareRecovery.interruptedAttempt
            : undefined;
        const rejoinsInterruptedAttempt =
          interruptedAttempt?.attemptId === resumeInput.attemptId;
        if (
          rejoinsInterruptedAttempt
            ? resumeInput.expectedRevision !== interruptedAttempt.acceptedRevision
            : current.transitionRevision !== resumeInput.expectedRevision
        ) {
          return { ok: false, errorCode: 'stale_revision' } as const;
        }
        if (current.prepareRecovery.status !== 'awaiting_user_resume') {
          return { ok: false, errorCode: 'invalid_state' } as const;
        }
        if (!current.prepareTargetRequest) {
          return { ok: false, errorCode: 'reconciliation_required' } as const;
        }
        const progress = current.status.progress;
        const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
          ...current,
          transitionRevision: current.transitionRevision + 1,
          updatedAtMs: Math.max(current.updatedAtMs, resumeInput.nowMs),
          prepareRecovery: {
            status: 'attempted',
            attemptId: resumeInput.attemptId,
            acceptedAtMs: rejoinsInterruptedAttempt
              ? interruptedAttempt.acceptedAtMs
              : resumeInput.nowMs,
            acceptedRevision: rejoinsInterruptedAttempt
              ? interruptedAttempt.acceptedRevision
              : current.transitionRevision,
          },
          status: {
            ...current.status,
            status: 'pending',
            ...(progress
              ? {
                  progress: {
                    ...progress,
                    updatedAtMs: Math.max(progress.updatedAtMs, resumeInput.nowMs),
                    current: {
                      ...(progress.current ?? {}),
                      phaseDetail: 'resuming_after_explicit_request',
                    },
                    resumable: false,
                  },
                }
              : {}),
          },
        });
        assertV2Identity(current, next);
        await writeJsonAtomic(jobPath, next);
        return {
          ok: true,
          disposition: rejoinsInterruptedAttempt ? 'replay' : 'accepted',
          record: next,
        } as const;
      });
    },
  };
}
