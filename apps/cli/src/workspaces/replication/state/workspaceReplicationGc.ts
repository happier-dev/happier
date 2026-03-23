import { lstat, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import {
  WorkspaceReplicationJobRecordSchema,
  type WorkspaceReplicationJobRecord,
  safeParseWorkspaceReplicationJobRecordFromDiskValue,
} from '../jobs/workspaceReplicationJobStore';
import {
  createWorkspaceReplicationPaths,
  resolveWorkspaceReplicationJobPath,
  resolveWorkspaceReplicationJobStagingDirectory,
} from './workspaceReplicationPaths';

const TERMINAL_JOB_STATUSES = new Set<WorkspaceReplicationJobRecord['status']['status']>([
  'completed',
  'aborted',
  'failed',
  'awaiting_recovery',
]);

const VALID_JOB_ID_REGEX = /^[A-Za-z0-9._-]+$/u;

function resolveTerminalAtMs(record: WorkspaceReplicationJobRecord): number | null {
  if (typeof record.completedAtMs === 'number') return record.completedAtMs;
  if (typeof record.abortedAtMs === 'number') return record.abortedAtMs;
  if (typeof record.awaitingRecoveryAtMs === 'number') return record.awaitingRecoveryAtMs;
  if (typeof record.failedAtMs === 'number') return record.failedAtMs;
  return null;
}

async function readJobRecord(filePath: string): Promise<WorkspaceReplicationJobRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    // Use the job store's normalization so legacy persisted job records are GC'd correctly.
    return safeParseWorkspaceReplicationJobRecordFromDiskValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function recoverWorkspaceReplicationJobsAfterRestart(params: Readonly<{
  activeServerDir: string;
  nowMs: number;
}>): Promise<Readonly<{ recoveredJobIds: string[] }>> {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: params.activeServerDir,
  });

  const recoveredJobIds: string[] = [];

  try {
    const entries = await readdir(paths.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = join(paths.jobsDirectory, entry.name);
      const record = await readJobRecord(filePath);
      if (!record) {
        continue;
      }
      if (TERMINAL_JOB_STATUSES.has(record.status.status)) {
        continue;
      }

      const updatedAtMs = params.nowMs;
      const next: WorkspaceReplicationJobRecord = record.cancelRequestedAtMs
        ? {
          ...record,
          updatedAtMs,
          abortedAtMs: record.abortedAtMs ?? updatedAtMs,
          status: {
            ...record.status,
            status: 'aborted',
          },
          ...(record.lastErrorMessage ? {} : { lastErrorMessage: 'Workspace replication aborted after daemon restart' }),
        }
        : {
          ...record,
          updatedAtMs,
          status: {
            ...record.status,
            status: 'pending',
            warnings: record.status.warnings.includes('recovered_after_daemon_restart')
              ? record.status.warnings
              : [...record.status.warnings, 'recovered_after_daemon_restart'],
          },
        };

      // Write to the enumerated filePath directly so corrupt jobId values cannot escape into path resolution.
      await writeJsonAtomic(filePath, WorkspaceReplicationJobRecordSchema.parse(next));
      // Clear the job lease on daemon restart recovery. The owning process is gone, but the lease
      // could still be unexpired, which would otherwise stall resumability for up to the TTL.
      const jobIdFromFilename = entry.name.slice(0, -'.json'.length);
      if (VALID_JOB_ID_REGEX.test(jobIdFromFilename)) {
        const stagingDir = resolveWorkspaceReplicationJobStagingDirectory({
          stagingDirectory: paths.stagingDirectory,
          jobId: jobIdFromFilename,
        });
        await rm(join(stagingDir, 'lease'), { recursive: true, force: true }).catch(() => undefined);
      }
      recoveredJobIds.push(record.jobId);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }

  return { recoveredJobIds };
}

async function resolveLatestMtimeMsRecursively(rootPath: string): Promise<number> {
  // Walk the directory tree without following symlinks (crash leftovers are expected to be files/dirs).
  const stack: string[] = [rootPath];
  let latestMtimeMs = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const info = await lstat(current).catch(() => null);
    if (!info) continue;
    latestMtimeMs = Math.max(latestMtimeMs, info.mtimeMs);
    if (!info.isDirectory()) continue;

    const entries = await readdir(current, { withFileTypes: true }).catch((error: unknown) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      stack.push(join(current, entry.name));
    }
  }

  return latestMtimeMs;
}

async function gcWorkspaceReplicationStagingBestEffort(params: Readonly<{
  stagingDirectory: string;
  jobRecordsById: ReadonlyMap<string, WorkspaceReplicationJobRecord>;
  nowMs: number;
  terminalTtlMs: number;
}>): Promise<void> {
  const entries = await readdir(params.stagingDirectory, { withFileTypes: true }).catch((error: unknown) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    if (!VALID_JOB_ID_REGEX.test(jobId)) continue;

    const record = params.jobRecordsById.get(jobId) ?? null;
    if (record && !TERMINAL_JOB_STATUSES.has(record.status.status)) {
      // Never touch staging for active jobs.
      continue;
    }

    const jobDirectory = join(params.stagingDirectory, jobId);
    if (record) {
      const terminalAtMs = resolveTerminalAtMs(record) ?? record.updatedAtMs;
      if (params.nowMs - terminalAtMs <= params.terminalTtlMs) {
        continue;
      }
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }

    // Orphaned job staging directory: use filesystem mtime as a proxy for last activity.
    const latestMtimeMs = await resolveLatestMtimeMsRecursively(jobDirectory);
    if (params.nowMs - latestMtimeMs <= params.terminalTtlMs) {
      continue;
    }
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function gcWorkspaceReplicationJobs(params: Readonly<{
  activeServerDir: string;
  nowMs: number;
  terminalTtlMs: number;
}>): Promise<Readonly<{ removedJobIds: string[] }>> {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: params.activeServerDir,
  });

  const removedJobIds: string[] = [];
  const jobRecordsById = new Map<string, WorkspaceReplicationJobRecord>();
  try {
    const entries = await readdir(paths.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = join(paths.jobsDirectory, entry.name);
      const record = await readJobRecord(filePath);
      if (!record) {
        continue;
      }
      jobRecordsById.set(record.jobId, record);
      if (!TERMINAL_JOB_STATUSES.has(record.status.status)) {
        continue;
      }
      const terminalAtMs = resolveTerminalAtMs(record) ?? record.updatedAtMs;
      if (params.nowMs - terminalAtMs <= params.terminalTtlMs) {
        continue;
      }
      // Best-effort: delete the enumerated filePath directly so corrupt jobId values can't
      // crash GC via strict path validation.
      await unlink(filePath).catch(() => undefined);
      removedJobIds.push(record.jobId);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }

  // Staging GC piggybacks on job GC so the daemon heartbeat doesn't need separate wiring.
  // This is intentionally conservative: never delete staging for active jobs.
  await gcWorkspaceReplicationStagingBestEffort({
    stagingDirectory: paths.stagingDirectory,
    jobRecordsById,
    nowMs: params.nowMs,
    terminalTtlMs: params.terminalTtlMs,
  });

  return { removedJobIds };
}

async function hasActiveWorkspaceReplicationJobs(params: Readonly<{
  jobsDirectory: string;
}>): Promise<boolean> {
  try {
    const entries = await readdir(params.jobsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(params.jobsDirectory, entry.name);
      const record = await readJobRecord(filePath);
      if (!record) {
        // Fail closed: if we cannot parse a job record we cannot prove there are no active jobs.
        return true;
      }
      if (!TERMINAL_JOB_STATUSES.has(record.status.status)) {
        return true;
      }
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }
  return false;
}

async function collectBaselineReferencedDigests(params: Readonly<{
  relationshipsDirectory: string;
}>): Promise<Set<string>> {
  const referenced = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'baseline.json') {
        continue;
      }
      try {
        const raw = await readFile(entryPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const baseline = parsed.baseline as Record<string, unknown> | undefined;
        const manifest = baseline?.manifest as Record<string, unknown> | undefined;
        const entries = manifest?.entries as unknown;
        if (!Array.isArray(entries)) {
          continue;
        }
        for (const manifestEntry of entries) {
          if (!manifestEntry || typeof manifestEntry !== 'object' || Array.isArray(manifestEntry)) continue;
          const kind = (manifestEntry as { kind?: unknown }).kind;
          if (kind !== 'file') continue;
          const digest = (manifestEntry as { digest?: unknown }).digest;
          if (typeof digest === 'string' && digest.startsWith('sha256:') && digest.length > 'sha256:'.length) {
            referenced.add(digest);
          }
        }
      } catch {
        // ignore malformed baseline files
      }
    }
  };

  await walk(params.relationshipsDirectory);
  return referenced;
}

export async function gcWorkspaceReplicationCas(params: Readonly<{
  activeServerDir: string;
  nowMs: number;
  unreferencedTtlMs: number;
  maxBytes?: number;
}>): Promise<Readonly<{
  skippedDueToActiveJobs: boolean;
  removedDigests: string[];
}>> {
  const paths = createWorkspaceReplicationPaths({
    activeServerDir: params.activeServerDir,
  });

  if (await hasActiveWorkspaceReplicationJobs({ jobsDirectory: paths.jobsDirectory })) {
    return {
      skippedDueToActiveJobs: true,
      removedDigests: [],
    };
  }

  const referencedDigests = await collectBaselineReferencedDigests({
    relationshipsDirectory: paths.relationshipsDirectory,
  });

  const removedDigests: string[] = [];
  const sha256Directory = join(paths.casDirectory, 'sha256');

  try {
    const entries = await readdir(sha256Directory, { withFileTypes: true });

    const unreferenced: Array<Readonly<{
      digest: string;
      filePath: string;
      sizeBytes: number;
      mtimeMs: number;
    }>> = [];

    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const hex = entry.name;
      if (!/^[a-f0-9]{64}$/u.test(hex)) continue;
      const digest = `sha256:${hex}`;

      const filePath = join(sha256Directory, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (!info) continue;

      totalBytes += info.size;

      if (referencedDigests.has(digest)) {
        continue;
      }

      unreferenced.push({
        digest,
        filePath,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
      });
    }

    // 1) TTL-based pruning of unreferenced blobs.
    if (params.unreferencedTtlMs > 0) {
      const ttlCandidates = unreferenced
        .filter((blob) => params.nowMs - blob.mtimeMs > params.unreferencedTtlMs)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      const ttlRemoved = new Set<string>();

      for (const blob of ttlCandidates) {
        await unlink(blob.filePath).catch(() => undefined);
        removedDigests.push(blob.digest);
        ttlRemoved.add(blob.digest);
        totalBytes -= blob.sizeBytes;
      }

      if (ttlRemoved.size > 0) {
        // Remove TTL-deleted candidates before applying max-bytes pruning.
        for (let i = unreferenced.length - 1; i >= 0; i -= 1) {
          if (ttlRemoved.has(unreferenced[i].digest)) {
            unreferenced.splice(i, 1);
          }
        }
      }
    }

    // 2) Size-cap pruning of remaining unreferenced blobs (oldest-first).
    if (typeof params.maxBytes === 'number' && params.maxBytes > 0 && totalBytes > params.maxBytes) {
      unreferenced.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const blob of unreferenced) {
        if (totalBytes <= params.maxBytes) {
          break;
        }
        await unlink(blob.filePath).catch(() => undefined);
        removedDigests.push(blob.digest);
        totalBytes -= blob.sizeBytes;
      }
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code !== 'ENOENT') {
      throw error;
    }
  }

  return {
    skippedDueToActiveJobs: false,
    removedDigests,
  };
}
