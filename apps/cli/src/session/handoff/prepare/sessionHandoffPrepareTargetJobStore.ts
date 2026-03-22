import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStatusSchema,
} from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION = 1 as const;

const SessionHandoffPrepareTargetJobRecordSchema = z
  .object({
    schemaVersion: z
      .literal(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION)
      .default(SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    handoffId: z.string().min(1),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    status: SessionHandoffStatusSchema,
    prepareTargetResult: SessionHandoffPrepareTargetResultGetResponseSchema.optional(),
  })
  .strip();

export type SessionHandoffPrepareTargetJobRecord = z.infer<typeof SessionHandoffPrepareTargetJobRecordSchema>;

export type SessionHandoffPrepareTargetJobStore = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecord) => Promise<void>;
  read: (jobId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  findByHandoffId: (handoffId: string) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
  list: (input?: Readonly<{ handoffId?: string }>) => Promise<readonly SessionHandoffPrepareTargetJobRecord[]>;
  update: (
    jobId: string,
    updater: (current: SessionHandoffPrepareTargetJobRecord) => SessionHandoffPrepareTargetJobRecord,
  ) => Promise<SessionHandoffPrepareTargetJobRecord | null>;
}>;

async function readPrepareTargetJobFile(filePath: string): Promise<SessionHandoffPrepareTargetJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const value = JSON.parse(raw) as Record<string, unknown>;
    const parsed = SessionHandoffPrepareTargetJobRecordSchema.safeParse({
      ...value,
      schemaVersion: SESSION_HANDOFF_PREPARE_TARGET_JOB_SCHEMA_VERSION,
    });
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
