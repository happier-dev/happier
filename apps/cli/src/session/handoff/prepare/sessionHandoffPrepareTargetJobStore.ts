import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  SessionHandoffPrepareTargetRequestSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStatusSchema,
} from '@happier-dev/protocol';

import {
  releaseSessionHandoffPrepareTargetJobLease,
  tryAcquireSessionHandoffPrepareTargetJobLease,
} from './sessionHandoffPrepareTargetJobLease';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION = 1 as const;

const SessionHandoffPrepareTargetJobRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    handoffId: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    workspaceReplicationJobId: z.string().min(1).optional(),
    status: SessionHandoffStatusSchema,
    // Persist the validated prepare-target request so the daemon can resume/restart the job after a restart,
    // even when callers keep polling status/result without issuing a second PREPARE_TARGET call.
    prepareTargetRequest: SessionHandoffPrepareTargetRequestSchema.optional(),
    prepareTargetResult: SessionHandoffPrepareTargetResultGetResponseSchema.optional(),
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

export type SessionHandoffPrepareTargetJobRecord = z.output<typeof SessionHandoffPrepareTargetJobRecordSchema>;
export type SessionHandoffPrepareTargetJobRecordInput = Omit<SessionHandoffPrepareTargetJobRecord, 'schemaVersion'>;

export type SessionHandoffPrepareTargetJobStore = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecordInput) => Promise<void>;
  read: (jobId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  findByHandoffId: (handoffId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  list: (input?: Readonly<{ handoffId?: string }>) => Promise<readonly SessionHandoffPrepareTargetJobRecord[]>;
  update: (
    jobId: string,
    updater: (current: SessionHandoffPrepareTargetJobRecord) => SessionHandoffPrepareTargetJobRecordInput,
  ) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
}>;

function isTerminalPrepareTargetStatusCode(status: SessionHandoffPrepareTargetJobRecord['status']['status']): boolean {
  return status === 'ready_for_cutover'
    || status === 'completed'
    || status === 'aborted'
    || status === 'failed'
    || status === 'awaiting_recovery';
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
    const leaseAttempt = await tryAcquireSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
      nowMs: input.nowMs,
      ttlMs: 250,
    });
    if (!leaseAttempt.acquired) {
      return;
    }
    await releaseSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: job.jobId,
      ownerId: probeOwnerId,
    }).catch(() => undefined);

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
    if (!/^[A-Za-z0-9._-]+$/u.test(jobId)) {
      throw new Error(`Invalid session handoff prepare-target job id: ${jobId}`);
    }
    return join(jobsDirectory, `${jobId}.json`);
  }

  return {
    async write(record) {
      await mkdir(jobsDirectory, { recursive: true });
      const parsed = SessionHandoffPrepareTargetJobRecordSchema.parse({
        ...record,
        schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION,
      });
      await writeJsonAtomic(resolveJobPath(parsed.jobId), parsed);
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
      const current = await readPrepareTargetJobFile(resolveJobPath(jobId));
      if (!current) return null;
      const next = SessionHandoffPrepareTargetJobRecordSchema.parse({
        ...updater(current),
        schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION,
      });
      await writeJsonAtomic(resolveJobPath(jobId), next);
      return next;
    },
  };
}
