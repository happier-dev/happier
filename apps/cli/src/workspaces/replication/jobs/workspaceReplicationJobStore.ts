import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationJobPath,
} from '../state/workspaceReplicationPaths';
import { WORKSPACE_REPLICATION_SCHEMA_VERSION } from '../state/workspaceReplicationSchemaVersion';
import { isTerminalWorkspaceReplicationJobStatus } from './workspaceReplicationJobTerminalStatuses';

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

function createDefaultWorkspaceReplicationProgressCounters(): Readonly<{
  plannedFiles: number;
  plannedBytes: number;
  transferredFiles: number;
  transferredBytes: number;
  appliedFiles: number;
  appliedBytes: number;
}> {
  return {
    plannedFiles: 0,
    plannedBytes: 0,
    transferredFiles: 0,
    transferredBytes: 0,
    appliedFiles: 0,
    appliedBytes: 0,
  };
}

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
    progressCounters: WorkspaceReplicationJobProgressCountersSchema.default(createDefaultWorkspaceReplicationProgressCounters),
    warnings: z.array(z.string().min(1)).default([]),
    // Divergence detection is planned but not yet fully implemented; keep this persisted surface stable.
    blockingDivergenceCandidates: z.array(z.unknown()).default([]),
  })
  .strip();

export const WorkspaceReplicationJobResumeContextSchema = z
  .object({
    apply: z
      .object({
        targetPath: z.string().min(1),
        strategy: z.enum(['transfer_snapshot', 'sync_changes']),
        conflictPolicy: z.enum(['create_sibling_copy', 'replace_existing']),
      })
      .strip(),
  })
  .strip();

export const WorkspaceReplicationJobRecordSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_REPLICATION_SCHEMA_VERSION).optional(),
    lastAttempt: z
      .object({
        attemptNumber: z.number().int().min(1),
        leaseId: z.string().min(1),
        ownerId: z.string().min(1),
        acquiredAtMs: z.number().int().min(0),
      })
      .strip()
      .optional(),
    jobId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    relationshipId: z.string().min(1).optional(),
    directionId: z.string().min(1).optional(),
    offerId: z.string().min(1).optional(),
    mode: z.enum(['one_way_safe', 'one_way_replica', 'two_way_safe']).optional(),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
    resumeContext: WorkspaceReplicationJobResumeContextSchema.optional(),
    cancelRequestedAtMs: z.number().int().min(0).optional(),
    abortedAtMs: z.number().int().min(0).optional(),
    completedAtMs: z.number().int().min(0).optional(),
    awaitingRecoveryAtMs: z.number().int().min(0).optional(),
    failedAtMs: z.number().int().min(0).optional(),
    lastErrorMessage: z.string().min(1).optional(),
    result: z
      .object({
        targetPath: z.string().min(1),
      })
      .strip()
      .optional(),
    status: WorkspaceReplicationJobStatusSchema,
  })
  .strip();

// Disk records must always include schemaVersion; in-memory/write inputs may omit it because the store stamps it.
export const WorkspaceReplicationJobRecordDiskSchema = WorkspaceReplicationJobRecordSchema.extend({
  schemaVersion: z.literal(WORKSPACE_REPLICATION_SCHEMA_VERSION),
});

export type WorkspaceReplicationJobRecord = z.output<typeof WorkspaceReplicationJobRecordDiskSchema>;
export type WorkspaceReplicationJobRecordInput = z.input<typeof WorkspaceReplicationJobRecordSchema>;

export function safeParseWorkspaceReplicationJobRecordFromDiskValue(
  raw: unknown,
): WorkspaceReplicationJobRecord | null {
  const parsed = WorkspaceReplicationJobRecordDiskSchema.safeParse(
    normalizeWorkspaceReplicationJobRecordValue(raw),
  );
  return parsed.success ? parsed.data : null;
}

export type WorkspaceReplicationJobStore = Readonly<{
  write: (record: WorkspaceReplicationJobRecordInput) => Promise<void>;
  read: (jobId: string) => Promise<WorkspaceReplicationJobRecord | null>;
  findByCorrelationId: (correlationId: string) => Promise<WorkspaceReplicationJobRecord | null>;
  update: (
    jobId: string,
    updater: (current: WorkspaceReplicationJobRecord) => WorkspaceReplicationJobRecordInput,
  ) => Promise<WorkspaceReplicationJobRecord | null>;
}>;

const CHECKPOINT_ORDER: readonly WorkspaceReplicationJobRecord['status']['checkpoint'][] = [
  'job_created',
  'relationship_resolved',
  'missing_digests_negotiated',
  'blob_transfer_started',
  'blob_transfer_completed',
  'apply_started',
  'apply_completed',
  'baseline_committed',
] as const;

function isTerminalJobStatus(status: WorkspaceReplicationJobRecord['status']['status']): boolean {
  return isTerminalWorkspaceReplicationJobStatus(status);
}

function compareCheckpoint(
  a: WorkspaceReplicationJobRecord['status']['checkpoint'],
  b: WorkspaceReplicationJobRecord['status']['checkpoint'],
): number {
  return CHECKPOINT_ORDER.indexOf(a) - CHECKPOINT_ORDER.indexOf(b);
}

function mergeProgressCounters(
  a: WorkspaceReplicationJobRecord['status']['progressCounters'],
  b: WorkspaceReplicationJobRecord['status']['progressCounters'],
): WorkspaceReplicationJobRecord['status']['progressCounters'] {
  return {
    plannedFiles: Math.max(a.plannedFiles, b.plannedFiles),
    plannedBytes: Math.max(a.plannedBytes, b.plannedBytes),
    transferredFiles: Math.max(a.transferredFiles, b.transferredFiles),
    transferredBytes: Math.max(a.transferredBytes, b.transferredBytes),
    appliedFiles: Math.max(a.appliedFiles, b.appliedFiles),
    appliedBytes: Math.max(a.appliedBytes, b.appliedBytes),
  };
}

function mergeWorkspaceReplicationJobRecordsForWrite(
  existing: WorkspaceReplicationJobRecord | null,
  incoming: WorkspaceReplicationJobRecord,
): WorkspaceReplicationJobRecord {
  if (!existing) {
    return incoming;
  }

  // Fail closed: never allow a terminal record to be downgraded by a stale writer.
  if (isTerminalJobStatus(existing.status.status)) {
    return existing;
  }

  let base = incoming;
  const incomingStatus = incoming.status.status;
  // "Terminal" outcomes that indicate the runner must stop and require user/system action.
  // We allow these to win even if the writer is stale and regresses the checkpoint, because
  // dropping them can leave a job stuck "in_progress" with no runner.
  const incomingIsNonSuccessTerminal =
    incomingStatus === 'aborted'
    || incomingStatus === 'failed'
    || incomingStatus === 'awaiting_recovery';

  function mergeWarnings(
    a: readonly string[],
    b: readonly string[],
  ): string[] {
    if (b.length === 0) return [...a];
    if (a.length === 0) return [...b];
    const merged: string[] = [...a];
    for (const warning of b) {
      if (!merged.includes(warning)) merged.push(warning);
    }
    return merged;
  }

  // Fail closed: prevent checkpoint regressions from stale writers.
  if (compareCheckpoint(existing.status.checkpoint, incoming.status.checkpoint) > 0) {
    if (incomingIsNonSuccessTerminal) {
      base = {
        ...incoming,
        status: {
          ...existing.status,
          status: incomingStatus,
          progressCounters: mergeProgressCounters(existing.status.progressCounters, incoming.status.progressCounters),
          warnings: mergeWarnings(existing.status.warnings, incoming.status.warnings),
          blockingDivergenceCandidates:
            incoming.status.blockingDivergenceCandidates.length > 0
              ? incoming.status.blockingDivergenceCandidates
              : existing.status.blockingDivergenceCandidates,
        },
      };
    } else {
      base = {
        ...incoming,
        status: existing.status,
      };
    }
  } else if (existing.status.checkpoint === incoming.status.checkpoint) {
    base = {
      ...incoming,
      status: {
        ...incoming.status,
        progressCounters: mergeProgressCounters(existing.status.progressCounters, incoming.status.progressCounters),
      },
    };
  }

  const cancelRequestedAtMs = existing.cancelRequestedAtMs ?? incoming.cancelRequestedAtMs;
  const correlationId = incoming.correlationId ?? existing.correlationId;
  const relationshipId = incoming.relationshipId ?? existing.relationshipId;
  const directionId = incoming.directionId ?? existing.directionId;
  const offerId = incoming.offerId ?? existing.offerId;
  const mode = incoming.mode ?? existing.mode;
  const lastAttempt = (() => {
    if (!existing.lastAttempt) return incoming.lastAttempt;
    if (!incoming.lastAttempt) return existing.lastAttempt;
    return incoming.lastAttempt.attemptNumber >= existing.lastAttempt.attemptNumber
      ? incoming.lastAttempt
      : existing.lastAttempt;
  })();
  return {
    ...base,
    // Identity fields must be sticky so partial/stale writers can't clear them.
    createdAtMs: existing.createdAtMs,
    ...(lastAttempt === undefined ? {} : { lastAttempt }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(relationshipId === undefined ? {} : { relationshipId }),
    ...(directionId === undefined ? {} : { directionId }),
    ...(offerId === undefined ? {} : { offerId }),
    ...(mode === undefined ? {} : { mode }),
    ...(cancelRequestedAtMs === undefined ? {} : { cancelRequestedAtMs }),
    ...(base.abortedAtMs === undefined && existing.abortedAtMs !== undefined ? { abortedAtMs: existing.abortedAtMs } : {}),
    ...(base.completedAtMs === undefined && existing.completedAtMs !== undefined ? { completedAtMs: existing.completedAtMs } : {}),
    ...(base.failedAtMs === undefined && existing.failedAtMs !== undefined ? { failedAtMs: existing.failedAtMs } : {}),
    ...(base.awaitingRecoveryAtMs === undefined && existing.awaitingRecoveryAtMs !== undefined ? { awaitingRecoveryAtMs: existing.awaitingRecoveryAtMs } : {}),
    ...(base.lastErrorMessage === undefined && existing.lastErrorMessage !== undefined ? { lastErrorMessage: existing.lastErrorMessage } : {}),
    ...(base.result === undefined && existing.result !== undefined ? { result: existing.result } : {}),
    ...(base.resumeContext === undefined && existing.resumeContext !== undefined ? { resumeContext: existing.resumeContext } : {}),
  };
}

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
    // Engine-native persistence requires an explicit schemaVersion. Missing schemaVersion is invalid.
    status: normalizeWorkspaceReplicationJobStatusValue(value.status),
  };
}

async function readWorkspaceReplicationJobFile(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return safeParseWorkspaceReplicationJobRecordFromDiskValue(JSON.parse(raw));
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
      const parsed = WorkspaceReplicationJobRecordDiskSchema.parse({
        ...record,
        schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
      });
      const jobPath = resolveJobPath(parsed.jobId);
      const existing = await readWorkspaceReplicationJobFile(jobPath);
      const merged = mergeWorkspaceReplicationJobRecordsForWrite(existing, parsed);
      await writeJsonAtomic(jobPath, merged);
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
      const jobPath = resolveJobPath(jobId);
      const current = await readWorkspaceReplicationJobFile(jobPath);
      if (!current) return null;
      const next = WorkspaceReplicationJobRecordDiskSchema.parse({
        ...updater(current),
        schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
      });
      const latest = await readWorkspaceReplicationJobFile(jobPath);
      const merged = mergeWorkspaceReplicationJobRecordsForWrite(latest, next);
      await writeJsonAtomic(jobPath, merged);
      return merged;
    },
  };
}
