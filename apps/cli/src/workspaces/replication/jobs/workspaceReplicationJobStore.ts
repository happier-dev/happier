import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationJobPath,
} from '../state/workspaceReplicationPaths';

const WORKSPACE_REPLICATION_JOB_SCHEMA_VERSION = 1 as const;

export const WorkspaceReplicationJobPhaseSchema = z.enum([
  'planning',
  'negotiate_missing_digests',
  'transfer_missing_blobs_to_target_cas',
  'apply',
  'commit_baseline',
]);

export const WorkspaceReplicationJobCheckpointSchema = z.enum([
  'job_created',
  'relationship_resolved',
  'missing_digests_negotiated',
  'blob_transfer_started',
  'blob_transfer_completed',
  'apply_started',
  'apply_completed',
  'baseline_committed',
]);

export const WorkspaceReplicationJobProgressCountersSchema = z
  .object({
    plannedFiles: z.number().int().min(0).default(0),
    plannedBytes: z.number().int().min(0).default(0),
    transferredFiles: z.number().int().min(0).default(0),
    transferredBytes: z.number().int().min(0).default(0),
    appliedFiles: z.number().int().min(0).default(0),
    appliedBytes: z.number().int().min(0).default(0),
  })
  .strip();

export const WorkspaceReplicationJobStatusSchema = z
  .object({
    status: z.enum(['pending', 'in_progress', 'completed', 'aborted', 'failed', 'awaiting_recovery']),
    phase: WorkspaceReplicationJobPhaseSchema,
    checkpoint: WorkspaceReplicationJobCheckpointSchema,
    progressCounters: WorkspaceReplicationJobProgressCountersSchema.default({}),
    warnings: z.array(z.string().min(1)).default([]),
    // Divergence detection is planned but not yet fully implemented; keep this persisted surface stable.
    blockingDivergenceCandidates: z.array(z.unknown()).default([]),
  })
  .strip();

export const WorkspaceReplicationJobRecordSchema = z
  .object({
    schemaVersion: z
      .literal(WORKSPACE_REPLICATION_JOB_SCHEMA_VERSION)
      .default(WORKSPACE_REPLICATION_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    relationshipId: z.string().min(1).optional(),
    directionId: z.string().min(1).optional(),
    offerId: z.string().min(1).optional(),
    mode: z.enum(['one_way_safe', 'one_way_replica', 'two_way_safe']).optional(),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    status: WorkspaceReplicationJobStatusSchema,
  })
  .strip();

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

function normalizeWorkspaceReplicationJobPhase(raw: unknown): z.infer<typeof WorkspaceReplicationJobPhaseSchema> {
  const parsed = WorkspaceReplicationJobPhaseSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  switch (raw) {
    case 'initializing':
      return 'planning';
    case 'transferring_blobs':
      return 'transfer_missing_blobs_to_target_cas';
    case 'applying':
      return 'apply';
    case 'finalizing':
      return 'commit_baseline';
    default:
      return 'planning';
  }
}

function normalizeWorkspaceReplicationJobStatusValue(
  raw: unknown,
): Record<string, unknown> {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const statusRaw = value.status === 'running' ? 'in_progress' : value.status;
  const statusParsed = WorkspaceReplicationJobStatusSchema.shape.status.safeParse(statusRaw);

  const checkpointParsed = WorkspaceReplicationJobStatusSchema.shape.checkpoint.safeParse(value.checkpoint);

  const progressCounters =
    value.progressCounters && typeof value.progressCounters === 'object' && !Array.isArray(value.progressCounters)
      ? value.progressCounters
      : undefined;

  return {
    ...value,
    status: statusParsed.success ? statusParsed.data : 'pending',
    phase: normalizeWorkspaceReplicationJobPhase(value.phase),
    checkpoint: checkpointParsed.success ? checkpointParsed.data : 'job_created',
    ...(progressCounters ? { progressCounters } : {}),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings } : {}),
    ...(Array.isArray(value.blockingDivergenceCandidates)
      ? { blockingDivergenceCandidates: value.blockingDivergenceCandidates }
      : {}),
  };
}

function normalizeWorkspaceReplicationJobRecordValue(raw: unknown): Record<string, unknown> {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    ...value,
    schemaVersion: WORKSPACE_REPLICATION_JOB_SCHEMA_VERSION,
    status: normalizeWorkspaceReplicationJobStatusValue(value.status),
  };
}

async function readWorkspaceReplicationJobFile(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = WorkspaceReplicationJobRecordSchema.safeParse(
      normalizeWorkspaceReplicationJobRecordValue(JSON.parse(raw)),
    );
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
      const parsed = WorkspaceReplicationJobRecordSchema.parse({
        ...record,
        schemaVersion: WORKSPACE_REPLICATION_JOB_SCHEMA_VERSION,
      });
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
