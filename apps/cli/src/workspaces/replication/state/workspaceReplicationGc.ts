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
const CLI_DAEMON_LEASE_OWNER_PID_REGEX = /^cli-daemon:(\d+)(?::|$)/u;

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

type WorkspaceReplicationLeaseProbe = Readonly<{
  ownerId: string;
  expiresAtMs: number;
}>;

async function readLeaseProbe(filePath: string): Promise<WorkspaceReplicationLeaseProbe | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.ownerId !== 'string' || value.ownerId.trim().length === 0) {
      return null;
    }
    if (typeof value.expiresAtMs !== 'number' || !Number.isFinite(value.expiresAtMs)) {
      return null;
    }
    return {
      ownerId: value.ownerId,
      expiresAtMs: value.expiresAtMs,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'EPERM') {
      return true;
    }
    return false;
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

      const jobIdFromFilename = entry.name.slice(0, -'.json'.length);
      if (VALID_JOB_ID_REGEX.test(jobIdFromFilename)) {
        const stagingDir = resolveWorkspaceReplicationJobStagingDirectory({
          stagingDirectory: paths.stagingDirectory,
          jobId: jobIdFromFilename,
        });
        const leaseProbe = await readLeaseProbe(join(stagingDir, 'lease', 'lease.json'));
        if (leaseProbe && leaseProbe.expiresAtMs > params.nowMs) {
          const match = CLI_DAEMON_LEASE_OWNER_PID_REGEX.exec(leaseProbe.ownerId);
          if (match) {
            const pid = Number.parseInt(match[1] ?? '', 10);
            if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
              // Another daemon process is still alive and appears to own the lease. Avoid clearing the
              // lease or mutating the job record, since that could enable concurrent runners.
              continue;
            }
          }
        }
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
          awaitingRecoveryAtMs: record.awaitingRecoveryAtMs ?? updatedAtMs,
          ...(record.lastErrorMessage
            ? {}
            : { lastErrorMessage: 'Workspace replication requires restart after daemon restart' }),
          status: {
            ...record.status,
            status: 'awaiting_recovery',
            warnings: record.status.warnings.includes('recovered_after_daemon_restart')
              ? record.status.warnings
              : [...record.status.warnings, 'recovered_after_daemon_restart'],
          },
        };

      // Write to the enumerated filePath directly so corrupt jobId values cannot escape into path resolution.
      await writeJsonAtomic(filePath, WorkspaceReplicationJobRecordSchema.parse(next));
      // Clear the job lease on daemon restart recovery. The owning process is gone, but the lease
      // could still be unexpired, which would otherwise stall resumability for up to the TTL.
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

    const casBlobCandidates: Array<Readonly<{ hex: string; filePath: string }>> = [];
    for (const entry of entries) {
      const entryPath = join(sha256Directory, entry.name);
      if (entry.isFile()) {
        // Legacy layout (pre-sharding): cas/sha256/<hex>
        if (/^[a-f0-9]{64}$/u.test(entry.name)) {
          casBlobCandidates.push({ hex: entry.name, filePath: entryPath });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      // Sharded layout: cas/sha256/<prefix>/<hex>
      if (!/^[a-f0-9]{2}$/u.test(entry.name)) continue;

      const shardEntries = await readdir(entryPath, { withFileTypes: true }).catch((error: unknown) => {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError?.code === 'ENOENT') return [];
        throw error;
      });
      for (const shardEntry of shardEntries) {
        if (!shardEntry.isFile()) continue;
        const hex = shardEntry.name;
        if (!/^[a-f0-9]{64}$/u.test(hex)) continue;
        if (!hex.startsWith(entry.name)) continue;
        casBlobCandidates.push({
          hex,
          filePath: join(entryPath, shardEntry.name),
        });
      }
    }

    for (const candidate of casBlobCandidates) {
      const digest = `sha256:${candidate.hex}`;
      const info = await stat(candidate.filePath).catch(() => null);
      if (!info) continue;

      totalBytes += info.size;

      if (referencedDigests.has(digest)) {
        continue;
      }

      unreferenced.push({
        digest,
        filePath: candidate.filePath,
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
