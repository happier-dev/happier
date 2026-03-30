import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceReplicationPaths, resolveWorkspaceReplicationJobStagingDirectory } from './workspaceReplicationPaths';
import { isCliDaemonOwnedLeaseStealable } from './leaseOwnerPid';

export type WorkspaceReplicationJobLeaseRecord = Readonly<{
  // A unique lease id (per acquisition) for diagnostics and future strengthening.
  leaseId?: string;
  // Monotonic attempt counter (per job) that increments when a lease is stolen after expiry.
  attempt?: number;
  ownerId: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
}>;

// Keep crash/restart stall bounded by default; the active runner heartbeats while executing.
const DEFAULT_LEASE_TTL_MS = 60 * 1000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;

export function resolveWorkspaceReplicationJobLeaseTtlMs(): number {
  const raw = process.env.HAPPIER_WORKSPACE_REPLICATION_JOB_LEASE_TTL_MS;
  if (!raw) {
    return DEFAULT_LEASE_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LEASE_TTL_MS;
  }
  return Math.max(MIN_LEASE_TTL_MS, Math.min(MAX_LEASE_TTL_MS, parsed));
}

function resolveLeasePaths(input: Readonly<{
  activeServerDir: string;
  jobId: string;
}>) {
  const paths = createWorkspaceReplicationPaths({ activeServerDir: input.activeServerDir });
  const jobStagingDirectory = resolveWorkspaceReplicationJobStagingDirectory({
    stagingDirectory: paths.stagingDirectory,
    jobId: input.jobId,
  });
  const leaseDirectory = join(jobStagingDirectory, 'lease');
  const leaseFilePath = join(leaseDirectory, 'lease.json');
  return {
    paths,
    jobStagingDirectory,
    leaseDirectory,
    leaseFilePath,
  } as const;
}

async function readLeaseRecord(filePath: string): Promise<WorkspaceReplicationJobLeaseRecord | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    const leaseId = typeof value.leaseId === 'string' && value.leaseId.trim().length > 0 ? value.leaseId : undefined;
    const attempt = typeof value.attempt === 'number' && Number.isFinite(value.attempt) && value.attempt >= 1
      ? Math.floor(value.attempt)
      : undefined;
    if (
      typeof value.ownerId !== 'string'
      || value.ownerId.trim().length === 0
      || typeof value.acquiredAtMs !== 'number'
      || typeof value.renewedAtMs !== 'number'
      || typeof value.expiresAtMs !== 'number'
    ) {
      return null;
    }
    return {
      ...(leaseId ? { leaseId } : {}),
      ...(attempt ? { attempt } : {}),
      ownerId: value.ownerId,
      acquiredAtMs: value.acquiredAtMs,
      renewedAtMs: value.renewedAtMs,
      expiresAtMs: value.expiresAtMs,
    };
  } catch {
    return null;
  }
}

async function writeLeaseRecord(filePath: string, record: WorkspaceReplicationJobLeaseRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function writeLeaseRecordAtomic(input: Readonly<{
  leaseDirectory: string;
  leaseFilePath: string;
  record: WorkspaceReplicationJobLeaseRecord;
}>): Promise<void> {
  const tmpPath = join(input.leaseDirectory, `lease.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(input.record)}\n`, 'utf8');
  await rename(tmpPath, input.leaseFilePath);
}

function isLeaseAlreadyExistsError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  // POSIX: EEXIST/ENOTEMPTY. Windows can surface EPERM for directory renames into existing.
  return nodeError?.code === 'EEXIST' || nodeError?.code === 'ENOTEMPTY' || nodeError?.code === 'EPERM';
}

export async function removeWorkspaceReplicationJobStagingDirectory(input: Readonly<{
  activeServerDir: string;
  jobId: string;
}>): Promise<void> {
  const resolved = resolveLeasePaths(input);
  await rm(resolved.jobStagingDirectory, { recursive: true, force: true }).catch(() => undefined);
}

export async function tryAcquireWorkspaceReplicationJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{
  acquired: boolean;
  lease: WorkspaceReplicationJobLeaseRecord | null;
}>> {
  const ttlMs = input.ttlMs ?? resolveWorkspaceReplicationJobLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  await mkdir(resolved.jobStagingDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readLeaseRecord(resolved.leaseFilePath);
    if (existing && existing.expiresAtMs > input.nowMs) {
      if (!isCliDaemonOwnedLeaseStealable(existing.ownerId)) {
        return { acquired: false, lease: existing };
      }
    }
    const previousAttempt = existing?.attempt ?? 0;
    if (existing) {
      // Expired lease: clear it before attempting to acquire so we can compute attempt/run metadata
      // from the prior record rather than dropping back to a missing-file retry.
      await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const nextLease: WorkspaceReplicationJobLeaseRecord = {
      leaseId: randomUUID(),
      attempt: previousAttempt + 1,
      ownerId: input.ownerId,
      acquiredAtMs: input.nowMs,
      renewedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + ttlMs,
    };

    // Acquire is made atomic by fully writing a temp lease directory and then renaming it into place.
    // This avoids a mkdir-write gap where another runner could mis-detect a missing lease record and
    // delete an in-progress acquisition.
    const tempLeaseDirectory = `${resolved.leaseDirectory}.tmp-${randomUUID()}`;
    await mkdir(tempLeaseDirectory, { recursive: false });
    await writeLeaseRecord(join(tempLeaseDirectory, 'lease.json'), nextLease);
    try {
      await rename(tempLeaseDirectory, resolved.leaseDirectory);
      return { acquired: true, lease: nextLease };
    } catch (error) {
      // Another runner holds the lease directory.
      if (!isLeaseAlreadyExistsError(error)) {
        await rm(tempLeaseDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      await rm(tempLeaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const locked = await readLeaseRecord(resolved.leaseFilePath);
    if (locked && locked.expiresAtMs > input.nowMs) {
      return { acquired: false, lease: locked };
    }

    // Stale/corrupt lease: best-effort cleanup and retry once.
    await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  const existing = await readLeaseRecord(resolved.leaseFilePath);
  return { acquired: false, lease: existing };
}

export async function renewWorkspaceReplicationJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{ renewed: boolean; lease: WorkspaceReplicationJobLeaseRecord | null }>> {
  const ttlMs = input.ttlMs ?? resolveWorkspaceReplicationJobLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  const existing = await readLeaseRecord(resolved.leaseFilePath);
  if (!existing || existing.ownerId !== input.ownerId) {
    return { renewed: false, lease: existing };
  }
  // Fail closed: once a lease has expired, the owner must re-acquire via the atomic acquire path.
  // This prevents a paused/zombie runner from extending a lease after TTL and masking a stalled job.
  if (existing.expiresAtMs <= input.nowMs) {
    return { renewed: false, lease: existing };
  }
  const next: WorkspaceReplicationJobLeaseRecord = {
    ...existing,
    renewedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + ttlMs,
  };
  await writeLeaseRecordAtomic({
    leaseDirectory: resolved.leaseDirectory,
    leaseFilePath: resolved.leaseFilePath,
    record: next,
  });
  return { renewed: true, lease: next };
}

export async function releaseWorkspaceReplicationJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
}>): Promise<void> {
  const resolved = resolveLeasePaths(input);
  const existing = await readLeaseRecord(resolved.leaseFilePath);
  if (!existing || existing.ownerId !== input.ownerId) {
    return;
  }
  await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
}
