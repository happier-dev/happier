import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStatusSchema,
  SessionHandoffTargetCleanupSchema,
} from '@happier-dev/protocol';

import {
  releaseSessionHandoffPrepareTargetJobLease,
  startSessionHandoffPrepareTargetJobLeaseHeartbeat,
  tryAcquireSessionHandoffPrepareTargetJobLease,
  type SessionHandoffPrepareTargetJobLeaseProof,
} from './sessionHandoffPrepareTargetJobLease';
import {
  SESSION_HANDOFF_PREPARE_TARGET_JOB_RECORD_LOCK_TIMEOUT_MS,
  SESSION_HANDOFF_PREPARE_TARGET_JOB_RECOVERY_PROOF_TTL_MS,
} from './sessionHandoffPrepareTargetJobTiming';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { assertSessionHandoffPrepareTargetJobId } from './sessionHandoffPrepareTargetJobId';
import { lazySchema } from '@happier-dev/protocol';

const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1 = 1 as const;
const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2 = 2 as const;

const sessionHandoffPrepareTargetJobCommonShape = {
    jobId: z.string().min(1),
    handoffId: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorCode: z.string().min(1).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    workspaceReplicationJobId: z.string().min(1).optional(),
    existingStateSessionId: z.string().min(1).optional(),
    status: SessionHandoffStatusSchema,
    // Persist the validated prepare-target request so the daemon can resume/restart the job after a restart,
    // even when callers keep polling status/result without issuing a second PREPARE_TARGET call.
    prepareTargetRequest: SessionHandoffPrepareTargetRequestSchema.optional(),
    prepareTargetResult: SessionHandoffPrepareTargetResultGetResponseSchema.optional(),
} as const;

const SessionHandoffPrepareTargetJobRecordV1Schema = lazySchema(() => z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1),
    ...sessionHandoffPrepareTargetJobCommonShape,
  })
  .strip()
  .superRefine(refineSessionHandoffPrepareTargetJobRecordCoherence));

const SessionHandoffPreparedTargetResumeStateV2Schema = lazySchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_attempted') }).strict(),
  z.object({ status: z.literal('preexisting_unowned') }).strict(),
  z
    .object({
      status: z.literal('attempted'),
      attemptId: z.string().min(1),
      acceptedAtMs: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      status: z.literal('confirmed'),
      attemptId: z.string().min(1),
      acceptedAtMs: z.number().int().min(0),
      confirmedAtMs: z.number().int().min(0),
    })
    .strict(),
]));

const SessionHandoffTerminalStateV2Schema = lazySchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('open') }).strict(),
  z
    .object({
      status: z.literal('aborting'),
      operationId: z.string().min(1),
      claimedRevision: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      status: z.literal('aborted'),
      operationId: z.string().min(1),
      completedRevision: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      status: z.literal('completed'),
      operationId: z.string().min(1),
      completedRevision: z.number().int().min(0),
    })
    .strict(),
]));

const SessionHandoffPreparedTargetJobRecordV2Schema = lazySchema(() => z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
    recordKind: z.literal('prepared_target'),
    ...sessionHandoffPrepareTargetJobCommonShape,
    sessionId: z.string().min(1),
    transitionRevision: z.number().int().min(0),
    resume: SessionHandoffPreparedTargetResumeStateV2Schema,
    terminal: SessionHandoffTerminalStateV2Schema,
    targetCleanup: SessionHandoffTargetCleanupSchema,
  })
  .strip());

const SessionHandoffLegacyTargetJobRecordV2Schema = lazySchema(() => z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
    recordKind: z.literal('legacy_target'),
    ...sessionHandoffPrepareTargetJobCommonShape,
    transitionRevision: z.number().int().min(0),
    resume: z.object({ status: z.literal('legacy_unknown') }).strict(),
    terminal: SessionHandoffTerminalStateV2Schema,
    targetCleanup: z.object({ status: z.literal('legacy_cleanup_unavailable') }).strict(),
  })
  .strip());

const SessionHandoffSourceOnlyJobRecordV2Schema = lazySchema(() => z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2),
    recordKind: z.literal('source_only'),
    ...sessionHandoffPrepareTargetJobCommonShape,
    sessionId: z.string().min(1).optional(),
    transitionRevision: z.number().int().min(0),
    resume: z.object({ status: z.literal('not_applicable') }).strict(),
    terminal: SessionHandoffTerminalStateV2Schema,
    targetCleanup: z.object({ status: z.literal('not_applicable'), reason: z.literal('source_only') }).strict(),
  })
  .strip());

const SessionHandoffPrepareTargetJobRecordV2Schema = lazySchema(() => z.discriminatedUnion('recordKind', [
  SessionHandoffPreparedTargetJobRecordV2Schema,
  SessionHandoffLegacyTargetJobRecordV2Schema,
  SessionHandoffSourceOnlyJobRecordV2Schema,
]).superRefine((record, context) => {
  refineSessionHandoffPrepareTargetJobRecordCoherence(record, context);
  const publicStatus = record.status.status;
  const terminalStatus = record.terminal.status;
  const terminalMatchesPublicStatus = terminalStatus === 'aborted'
    ? publicStatus === 'aborted'
    : terminalStatus === 'completed'
      ? publicStatus === 'completed'
      : publicStatus !== 'aborted' && publicStatus !== 'completed';
  if (!terminalMatchesPublicStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminal'],
      message: 'V2 terminal state must match the public handoff status',
    });
  }
  if (record.recordKind === 'prepared_target') {
    const cleanupIsLegal = record.terminal.status === 'aborted'
      ? record.resume.status === 'not_attempted'
        ? record.targetCleanup.status === 'not_owned' && record.targetCleanup.reason === 'resume_not_attempted'
        : record.resume.status === 'preexisting_unowned'
          ? record.targetCleanup.status === 'not_owned' && record.targetCleanup.reason === 'preexisting_or_adopted'
          : record.targetCleanup.status === 'proved_absent'
      : record.terminal.status === 'aborting'
        ? (record.resume.status === 'attempted' || record.resume.status === 'confirmed')
          && (record.targetCleanup.status === 'pending' || record.targetCleanup.status === 'failed')
        : record.targetCleanup.status === 'not_required';
    if (!cleanupIsLegal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetCleanup'],
        message: 'Prepared target cleanup state must match its resume ownership state',
      });
    }
  }
  const terminalRevision = record.terminal.status === 'aborting'
    ? record.terminal.claimedRevision
    : record.terminal.status === 'aborted' || record.terminal.status === 'completed'
      ? record.terminal.completedRevision
      : null;
  if (terminalRevision !== null && terminalRevision !== record.transitionRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminal'],
      message: 'Terminal transition revision must match the record transitionRevision',
    });
  }
}));

const SessionHandoffPrepareTargetJobRecordSchema = lazySchema(() => z.union([
  SessionHandoffPrepareTargetJobRecordV1Schema,
  SessionHandoffPrepareTargetJobRecordV2Schema,
]));

function refineSessionHandoffPrepareTargetJobRecordCoherence(
  record: Readonly<{
    jobId: string;
    handoffId: string;
    status: z.infer<typeof SessionHandoffStatusSchema>;
    prepareTargetResult?: z.infer<typeof SessionHandoffPrepareTargetResultGetResponseSchema>;
  }>,
  ctx: z.RefinementCtx,
): void {
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
}

export type SessionHandoffPrepareTargetJobRecord = z.output<typeof SessionHandoffPrepareTargetJobRecordSchema>;
export type SessionHandoffPrepareTargetJobRecordInput = Omit<z.output<typeof SessionHandoffPrepareTargetJobRecordV1Schema>, 'schemaVersion'>;
export type SessionHandoffPrepareTargetJobRecordV2 = z.output<typeof SessionHandoffPrepareTargetJobRecordV2Schema>;
export type SessionHandoffPreparedTargetJobRecordV2 = z.output<typeof SessionHandoffPreparedTargetJobRecordV2Schema>;
export type SessionHandoffPreparedTargetJobRecordV2Input = Omit<z.input<typeof SessionHandoffPreparedTargetJobRecordV2Schema>, 'schemaVersion' | 'recordKind'>;
type SessionHandoffLegacyTargetJobRecordV2Input = Omit<z.input<typeof SessionHandoffLegacyTargetJobRecordV2Schema>, 'schemaVersion' | 'recordKind'>;
type SessionHandoffSourceOnlyJobRecordV2Input = Omit<z.input<typeof SessionHandoffSourceOnlyJobRecordV2Schema>, 'schemaVersion' | 'recordKind'>;
type SessionHandoffPrepareTargetJobRecordAnyInput =
  | SessionHandoffPrepareTargetJobRecordInput
  | Omit<SessionHandoffPrepareTargetJobRecordV2, 'schemaVersion'>;

export type SessionHandoffPrepareTargetJobStore = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecordInput) => Promise<void>;
  writePreparedV2: (record: SessionHandoffPreparedTargetJobRecordV2Input) => Promise<void>;
  writeLegacyCleanupUnavailableV2: (record: SessionHandoffLegacyTargetJobRecordV2Input) => Promise<void>;
  writeSourceOnlyV2: (record: SessionHandoffSourceOnlyJobRecordV2Input) => Promise<void>;
  upgradeReadyV1ToPreparedV2: (input: Readonly<{ jobId: string; sessionId: string }>) => Promise<SessionHandoffPreparedTargetJobRecordV2>;
  transitionV2: (
    jobId: string,
    updater: (current: SessionHandoffPrepareTargetJobRecordV2) => Omit<SessionHandoffPrepareTargetJobRecordV2, 'schemaVersion'> | null,
  ) => Promise<SessionHandoffPrepareTargetJobRecordV2 | null>;
  recoverMissingRunner: (
    jobId: string,
    nowMs: number,
    proof: SessionHandoffPrepareTargetJobLeaseProof,
  ) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  read: (jobId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  findByHandoffId: (handoffId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  list: (input?: Readonly<{ handoffId?: string }>) => Promise<readonly SessionHandoffPrepareTargetJobRecord[]>;
  update: (
    jobId: string,
    updater: (current: SessionHandoffPrepareTargetJobRecord) => SessionHandoffPrepareTargetJobRecordAnyInput,
  ) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
}>;

const PREPARE_TARGET_JOB_LOCK_STALE_AFTER_MS = 30_000;

async function withPrepareTargetJobMutationLock<T>(jobPath: string, mutation: () => Promise<T>): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: `${jobPath}.lock`,
    timeoutMs: SESSION_HANDOFF_PREPARE_TARGET_JOB_RECORD_LOCK_TIMEOUT_MS,
    staleAfterMs: PREPARE_TARGET_JOB_LOCK_STALE_AFTER_MS,
    errorCode: 'session_handoff_prepare_target_job_lock_timeout',
  }, mutation);
}

function deepFreeze<T>(value: T): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }
  Object.freeze(value);
}

function createFrozenUpdaterSnapshot<T>(baseline: T): T {
  const snapshot = structuredClone(baseline);
  deepFreeze(snapshot);
  return snapshot;
}

function assertInitialPreparedTargetJob(record: SessionHandoffPrepareTargetJobRecordV2): asserts record is SessionHandoffPreparedTargetJobRecordV2 {
  if (record.recordKind !== 'prepared_target') {
    throw new Error('Session handoff prepared-target job creation must use prepared_target record kind');
  }
  if (record.transitionRevision !== 0) {
    throw new Error('Session handoff prepared-target job initial revision must be zero');
  }
  if (record.resume.status !== 'not_attempted') {
    throw new Error('Session handoff prepared-target job initial resume state must be not_attempted');
  }
  if (record.terminal.status !== 'open') {
    throw new Error('Session handoff prepared-target job initial terminal state must be open');
  }
  if (record.targetCleanup.status !== 'not_required') {
    throw new Error('Session handoff prepared-target job initial cleanup state must be not_required');
  }
}

function assertPreparedTargetResumeTransition(
  current: SessionHandoffPreparedTargetJobRecordV2['resume'],
  next: SessionHandoffPreparedTargetJobRecordV2['resume'],
): void {
  if (current.status === 'not_attempted') {
    if (next.status === 'not_attempted' || next.status === 'preexisting_unowned' || next.status === 'attempted') return;
    throw new Error('Session handoff prepared-target resume state cannot skip directly to confirmed');
  }
  if (current.status === 'preexisting_unowned') {
    if (next.status === 'preexisting_unowned') return;
    throw new Error('Session handoff prepared-target unowned resume classification is immutable');
  }
  if (current.status === 'attempted') {
    if (next.status !== 'attempted' && next.status !== 'confirmed') {
      throw new Error('Session handoff prepared-target resume ownership cannot move backward');
    }
    if (next.attemptId !== current.attemptId || next.acceptedAtMs !== current.acceptedAtMs) {
      throw new Error('Session handoff prepared-target resume attempt identity is immutable');
    }
    if (next.status === 'confirmed' && next.confirmedAtMs < next.acceptedAtMs) {
      throw new Error('Session handoff prepared-target resume confirmation cannot precede acceptance');
    }
    return;
  }
  if (
    next.status !== 'confirmed'
    || next.attemptId !== current.attemptId
    || next.acceptedAtMs !== current.acceptedAtMs
    || next.confirmedAtMs !== current.confirmedAtMs
  ) {
    throw new Error('Session handoff prepared-target confirmed resume ownership is immutable');
  }
}

function assertLegacyV1Identity(
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

function assertV2Transition(current: SessionHandoffPrepareTargetJobRecordV2, next: SessionHandoffPrepareTargetJobRecordV2): void {
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
  if (next.transitionRevision !== current.transitionRevision + 1) {
    throw new Error('Session handoff v2 transition revision must advance exactly once');
  }
  if (next.updatedAtMs < current.updatedAtMs) {
    throw new Error('Session handoff v2 updatedAtMs cannot move backward');
  }
  if (current.recordKind === 'prepared_target' && next.recordKind === 'prepared_target') {
    assertPreparedTargetResumeTransition(current.resume, next.resume);
  }
  if (current.terminal.status === 'aborted' || current.terminal.status === 'completed') {
    throw new Error('Session handoff v2 terminal state is immutable');
  }
  if (current.terminal.status === 'aborting') {
    if (
      (next.terminal.status !== 'aborting' && next.terminal.status !== 'aborted')
      || next.terminal.operationId !== current.terminal.operationId
    ) {
      throw new Error('Session handoff v2 abort retry/completion must preserve its operation identity');
    }
    if (
      next.terminal.status === 'aborting'
      && next.terminal.claimedRevision !== current.terminal.claimedRevision
    ) {
      throw new Error('Session handoff v2 abort retry must preserve its claimed revision');
    }
  }
}

function isTerminalPrepareTargetStatusCode(status: SessionHandoffPrepareTargetJobRecord['status']['status']): boolean {
  return status === 'ready_for_cutover'
    || status === 'completed'
    || status === 'aborted'
    || status === 'failed'
    || status === 'awaiting_recovery';
}

function buildMissingRunnerRecoveryProgress(
  current: SessionHandoffPrepareTargetJobRecord,
  nowMs: number,
): SessionHandoffPrepareTargetJobRecord['status']['progress'] {
  const previousProgress = current.status.progress;
  return previousProgress
    ? {
        ...previousProgress,
        updatedAtMs: nowMs,
        current: {
          ...(previousProgress.current ?? {}),
          phaseDetail: 'daemon_restart_missing_runner',
        },
      }
    : previousProgress;
}

export async function recoverSessionHandoffPrepareTargetJobsAfterRestart(input: Readonly<{
  activeServerDir: string;
  nowMs: number;
}>): Promise<void> {
  const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir: input.activeServerDir });
  const jobs = await store.list();
  await Promise.all(jobs.map(async (job) => {
    if (isTerminalPrepareTargetStatusCode(job.status.status)) {
      return;
    }

    // If we have enough persisted input to restart the job runner, keep the durable status non-terminal.
    // The RPC surface can then resume the job when clients continue polling status/result after restart.
    if (job.prepareTargetRequest) {
      return;
    }

    // Fail closed: if another daemon instance still owns a live durable lease, do not flip the job
    // into awaiting_recovery, since doing so would clobber a legitimately advancing job.
    const probeOwnerId = `cli-daemon:${process.pid}:prepare-target-recovery:${randomUUID()}`;
    const probeLeaseTtlMs = SESSION_HANDOFF_PREPARE_TARGET_JOB_RECOVERY_PROOF_TTL_MS;
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      nowMs: Date.now(),
      ttlMs: probeLeaseTtlMs,
    });
    if (!leaseAttempt.acquired) {
      return;
    }
    const probeLeaseId = leaseAttempt.lease?.leaseId;
    if (!probeLeaseId) {
      return;
    }
    const probeLeaseHeartbeat = startSessionHandoffPrepareTargetJobLeaseHeartbeat({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      leaseId: probeLeaseId,
      ttlMs: probeLeaseTtlMs,
      nowMs: () => Date.now(),
    });
    try {
      await store.recoverMissingRunner(job.jobId, input.nowMs, probeLeaseHeartbeat.proof);
      const proofState = probeLeaseHeartbeat.getState();
      if (proofState.status === 'error') {
        throw proofState.error;
      }
    } finally {
      await probeLeaseHeartbeat.stop();
      await releaseSessionHandoffPrepareTargetJobLease({
        activeServerDir: input.activeServerDir,
        jobId: job.jobId,
        ownerId: probeOwnerId,
        leaseId: probeLeaseId,
      }).catch(() => undefined);
    }
  }));
}

async function readPrepareTargetJobFile(filePath: string): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const value = JSON.parse(raw) as unknown;
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
export function createSessionHandoffPrepareTargetJobStore(input: Readonly<{
  activeServerDir: string;
}>): SessionHandoffPrepareTargetJobStore {
  const jobsDirectory = join(input.activeServerDir, 'session-handoff', 'prepare-target-jobs');

  function resolveJobPath(jobId: string): string {
    assertSessionHandoffPrepareTargetJobId(jobId);
    return join(jobsDirectory, `${jobId}.json`);
  }

  return {
    async write(record) {
      const jobPath = resolveJobPath(record.jobId);
      await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFile(jobPath);
        if (current?.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          throw new Error('Legacy v1 writer cannot mutate a v2 handoff job');
        }
        await mkdir(jobsDirectory, { recursive: true });
        const parsed = SessionHandoffPrepareTargetJobRecordV1Schema.parse({
          ...record,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1,
        });
        if (current) assertLegacyV1Identity(current, parsed);
        await writeJsonAtomic(jobPath, parsed);
      });
    },
    async writePreparedV2(record) {
      const parsed = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
        ...record,
        schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
        recordKind: 'prepared_target',
      });
      assertInitialPreparedTargetJob(parsed);
      const jobPath = resolveJobPath(parsed.jobId);
      await withPrepareTargetJobMutationLock(jobPath, async () => {
        if (await readPrepareTargetJobFile(jobPath)) {
          throw new Error(`Session handoff prepare-target job already exists: ${parsed.jobId}`);
        }
        await mkdir(jobsDirectory, { recursive: true });
        await writeJsonAtomic(jobPath, parsed);
      });
    },
    async writeLegacyCleanupUnavailableV2(record) {
      const parsed = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
        ...record,
        schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
        recordKind: 'legacy_target',
      });
      const jobPath = resolveJobPath(parsed.jobId);
      await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFile(jobPath);
        if (current?.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          throw new Error('Legacy conversion cannot replace an existing v2 handoff job');
        }
        if (current) assertLegacyV1Identity(current, parsed);
        await mkdir(jobsDirectory, { recursive: true });
        await writeJsonAtomic(jobPath, parsed);
      });
    },
    async writeSourceOnlyV2(record) {
      const parsed = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
        ...record,
        schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
        recordKind: 'source_only',
      });
      const jobPath = resolveJobPath(parsed.jobId);
      await withPrepareTargetJobMutationLock(jobPath, async () => {
        if (await readPrepareTargetJobFile(jobPath)) {
          throw new Error(`Session handoff prepare-target job already exists: ${parsed.jobId}`);
        }
        await mkdir(jobsDirectory, { recursive: true });
        await writeJsonAtomic(jobPath, parsed);
      });
    },
    async upgradeReadyV1ToPreparedV2(input) {
      const jobPath = resolveJobPath(input.jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFile(jobPath);
        if (!current) throw new Error(`Session handoff prepare-target job not found: ${input.jobId}`);
        if (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          if (current.recordKind !== 'prepared_target' || current.sessionId !== input.sessionId) {
            throw new Error('Existing v2 handoff job does not match the requested exact session');
          }
          return current;
        }
        if (current.status.status !== 'ready_for_cutover' || !current.prepareTargetResult) {
          throw new Error('Only a ready v1 target job with its durable prepare result can upgrade to v2');
        }
        const parsed = SessionHandoffPreparedTargetJobRecordV2Schema.parse({
          ...current,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
          recordKind: 'prepared_target',
          sessionId: input.sessionId,
          transitionRevision: 0,
          resume: { status: 'not_attempted' },
          terminal: { status: 'open' },
          targetCleanup: { status: 'not_required' },
        });
        await writeJsonAtomic(jobPath, parsed);
        return parsed;
      });
    },
    async transitionV2(jobId, updater) {
      const jobPath = resolveJobPath(jobId);
      return await withPrepareTargetJobMutationLock(jobPath, async () => {
        const current = await readPrepareTargetJobFile(jobPath);
        if (!current) return null;
        if (current.schemaVersion !== SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          throw new Error('V2 transition cannot mutate a legacy v1 handoff job');
        }
        const baseline = structuredClone(current);
        const nextInput = updater(createFrozenUpdaterSnapshot(baseline));
        if (nextInput === null) return baseline;
        const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
          ...nextInput,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2,
        });
        assertV2Transition(baseline, next);
        await writeJsonAtomic(jobPath, next);
        return next;
      });
    },
    async recoverMissingRunner(jobId, nowMs, proof) {
      const jobPath = resolveJobPath(jobId);
      const persisted = await proof.runIfValid(async () => await withPrepareTargetJobMutationLock(
        jobPath,
        async () => {
          const current = await readPrepareTargetJobFile(jobPath);
          if (
            !current
            || (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2
              && (current.terminal.status === 'aborted' || current.terminal.status === 'completed'))
            || isTerminalPrepareTargetStatusCode(current.status.status)
          ) {
            return current;
          }

          const baseline = structuredClone(current);
          const nextProgress = buildMissingRunnerRecoveryProgress(baseline, nowMs);
          const recoveryMessage = 'Daemon restarted while the handoff prepare-target job was in progress';

          if (baseline.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
            const next = SessionHandoffPrepareTargetJobRecordV2Schema.parse({
              ...baseline,
              transitionRevision: baseline.transitionRevision + 1,
              updatedAtMs: nowMs,
              status: {
                ...baseline.status,
                status: 'awaiting_recovery',
                ...(nextProgress ? { progress: nextProgress } : {}),
              },
              lastErrorMessage: baseline.lastErrorMessage ?? recoveryMessage,
            });
            assertV2Transition(baseline, next);
            await writeJsonAtomic(jobPath, next);
            return next;
          }

          const { schemaVersion: _schemaVersion, ...legacyRecord } = baseline;
          const next = SessionHandoffPrepareTargetJobRecordV1Schema.parse({
            ...legacyRecord,
            updatedAtMs: nowMs,
            ...(legacyRecord.cancelRequestedAtMs
              ? { abortedAtMs: legacyRecord.abortedAtMs ?? nowMs }
              : {}),
            status: {
              ...legacyRecord.status,
              status: legacyRecord.cancelRequestedAtMs ? 'aborted' : 'awaiting_recovery',
              ...(nextProgress ? { progress: nextProgress } : {}),
            },
            lastErrorMessage: legacyRecord.lastErrorMessage ?? recoveryMessage,
            schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1,
          });
          assertLegacyV1Identity(baseline, next);
          await writeJsonAtomic(jobPath, next);
          return next;
        },
      ));
      if (persisted.valid) return persisted.value;
      return await withPrepareTargetJobMutationLock(jobPath, async () => await readPrepareTargetJobFile(jobPath));
    },
    async read(jobId) {
      return await readPrepareTargetJobFile(resolveJobPath(jobId));
    },
    async findByHandoffId(handoffId) {
      await mkdir(jobsDirectory, { recursive: true });
      const entries = await readdir(jobsDirectory);
      let latestMatch: SessionHandoffPrepareTargetJobRecord | null = null;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const record = await readPrepareTargetJobFile(join(jobsDirectory, entry));
        if (!record || record.handoffId !== handoffId) continue;
        if (!latestMatch || record.updatedAtMs > latestMatch.updatedAtMs) {
          latestMatch = record;
        }
      }
      return latestMatch;
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
        const current = await readPrepareTargetJobFile(jobPath);
        if (!current) return null;
        if (current.schemaVersion === SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V2) {
          throw new Error('Legacy update cannot mutate a v2 handoff job; use transitionV2');
        }
        const baseline = structuredClone(current);
        const nextInput = updater(createFrozenUpdaterSnapshot(baseline));
        const next = SessionHandoffPrepareTargetJobRecordV1Schema.parse({
          ...nextInput,
          schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION_V1,
        });
        assertLegacyV1Identity(baseline, next);
        await writeJsonAtomic(jobPath, next);
        return next;
      });
    },
  };
}
