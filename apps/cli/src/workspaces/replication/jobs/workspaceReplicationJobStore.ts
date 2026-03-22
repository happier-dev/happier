import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStatusSchema,
} from '@happier-dev/protocol';
import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationJobPath,
} from '../state/workspaceReplicationPaths';

export const WorkspaceReplicationJobRecordSchema = z
  .object({
    jobId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
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
  .strict();

export type WorkspaceReplicationJobRecord = z.infer<typeof WorkspaceReplicationJobRecordSchema>;

export type WorkspaceReplicationJobStore = Readonly<{
  write: (record: WorkspaceReplicationJobRecord) => Promise<void>;
  read: (jobId: string) => Promise<WorkspaceReplicationJobRecord | null>;
  findByCorrelationId: (correlationId: string) => Promise<WorkspaceReplicationJobRecord | null>;
  update: (
    jobId: string,
    updater: (current: WorkspaceReplicationJobRecord) => WorkspaceReplicationJobRecord,
  ) => Promise<WorkspaceReplicationJobRecord | null>;
}>;

async function readWorkspaceReplicationJobFile(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = WorkspaceReplicationJobRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createWorkspaceReplicationJobStore(input: Readonly<{
  activeServerDir: string;
}>): WorkspaceReplicationJobStore {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: input.activeServerDir,
  });

  function resolveJobPath(jobId: string): string {
    return resolveWorkspaceReplicationJobPath({
      jobsDirectory: paths.jobsDirectory,
      jobId,
    });
  }

  return {
    async write(record) {
      await mkdir(paths.jobsDirectory, { recursive: true });
      const parsed = WorkspaceReplicationJobRecordSchema.parse(record);
      await writeJsonAtomic(resolveJobPath(parsed.jobId), parsed);
    },
    async read(jobId) {
      return await readWorkspaceReplicationJobFile(resolveJobPath(jobId));
    },
    async findByCorrelationId(correlationId) {
      await mkdir(paths.jobsDirectory, { recursive: true });
      const entries = await readdir(paths.jobsDirectory);
      let latestMatch: WorkspaceReplicationJobRecord | null = null;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const record = await readWorkspaceReplicationJobFile(join(paths.jobsDirectory, entry));
        if (!record || record.correlationId !== correlationId) continue;
        if (!latestMatch || record.updatedAtMs > latestMatch.updatedAtMs) {
          latestMatch = record;
        }
      }
      return latestMatch;
    },
    async update(jobId, updater) {
      const current = await readWorkspaceReplicationJobFile(resolveJobPath(jobId));
      if (!current) return null;
      const next = WorkspaceReplicationJobRecordSchema.parse(updater(current));
      await writeJsonAtomic(resolveJobPath(jobId), next);
      return next;
    },
  };
}
