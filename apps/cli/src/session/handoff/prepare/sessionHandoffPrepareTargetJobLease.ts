import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SessionHandoffPrepareTargetJobLeaseRecord = Readonly<{
  leaseId?: string;
  attempt?: number;
  ownerId: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
}>;

const DEFAULT_LEASE_TTL_MS = 60 * 1000;
const MIN_LEASE_TTL_MS = 5_000;
const MAX_LEASE_TTL_MS = 60 * 60 * 1000;

export function resolveSessionHandoffPrepareTargetJobLeaseTtlMs(): number {
  const raw = process.env.HAPPIER_SESSION_HANDOFF_PREPARE_TARGET_JOB_LEASE_TTL_MS;
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
  if (!/^[A-Za-z0-9._-]+$/u.test(input.jobId)) {
    throw new Error(`Invalid session handoff prepare-target job id: ${input.jobId}`);
  }
  const jobStagingDirectory = join(
    input.activeServerDir,
    'session-handoff',
    'prepare-target-jobs-staging',
    input.jobId,
  );
  const leaseDirectory = join(jobStagingDirectory, 'lease');
  const leaseFilePath = join(leaseDirectory, 'lease.json');
  const runnerFilePath = join(leaseDirectory, 'runner.json');
  return { jobStagingDirectory, leaseDirectory, leaseFilePath, runnerFilePath } as const;
}

async function readLeaseRecord(filePath: string): Promise<SessionHandoffPrepareTargetJobLeaseRecord | null> {
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

async function writeLeaseRecord(filePath: string, record: SessionHandoffPrepareTargetJobLeaseRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function isLeaseAlreadyExistsError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError?.code === 'EEXIST' || nodeError?.code === 'ENOTEMPTY' || nodeError?.code === 'EPERM';
}

function resolveDaemonPidFromOwnerId(ownerId: string): number | null {
  const prefix = ownerId.startsWith('cli-daemon:')
    ? 'cli-daemon:'
    : ownerId.startsWith('daemon:')
      ? 'daemon:'
      : null;
  if (!prefix) {
    return null;
  }
  const rest = ownerId.slice(prefix.length);
  const pidStr = rest.split(':')[0] ?? '';
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ESRCH') {
      return false;
    }
    // Fail closed: if we cannot determine, assume alive and respect the lease.
    return true;
  }
}

export async function tryAcquireSessionHandoffPrepareTargetJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{ acquired: boolean; lease: SessionHandoffPrepareTargetJobLeaseRecord | null }>> {
  const ttlMs = input.ttlMs ?? resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  await mkdir(resolved.jobStagingDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readLeaseRecord(resolved.leaseFilePath);
    if (existing && existing.expiresAtMs > input.nowMs) {
      const pid = resolveDaemonPidFromOwnerId(existing.ownerId);
      if (pid !== null && !isPidAlive(pid)) {
        // Daemon process is gone; treat the lease as stale to avoid restart stalls.
        await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
      } else {
        if (pid === process.pid) {
          const runner = await readLeaseRecord(resolved.runnerFilePath);
          const runnerIsFresh =
            runner
            && runner.ownerId === existing.ownerId
            && runner.renewedAtMs + Math.max(250, Math.floor(ttlMs / 2)) > input.nowMs;
          if (!runnerIsFresh) {
            await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
          } else {
            return { acquired: false, lease: existing };
          }
        } else {
          return { acquired: false, lease: existing };
        }
      }
    }
    const previousAttempt = existing?.attempt ?? 0;
    if (existing) {
      await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const next: SessionHandoffPrepareTargetJobLeaseRecord = {
      leaseId: randomUUID(),
      attempt: previousAttempt + 1,
      ownerId: input.ownerId,
      acquiredAtMs: input.nowMs,
      renewedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + ttlMs,
    };

    const tempLeaseDirectory = `${resolved.leaseDirectory}.tmp-${randomUUID()}`;
    await mkdir(tempLeaseDirectory, { recursive: false });
    await writeLeaseRecord(join(tempLeaseDirectory, 'lease.json'), next);
    await writeLeaseRecord(join(tempLeaseDirectory, 'runner.json'), next);
    try {
      await rename(tempLeaseDirectory, resolved.leaseDirectory);
      return { acquired: true, lease: next };
    } catch (error) {
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

    await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  const existing = await readLeaseRecord(resolved.leaseFilePath);
  return { acquired: false, lease: existing };
}

export async function renewSessionHandoffPrepareTargetJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{ renewed: boolean; lease: SessionHandoffPrepareTargetJobLeaseRecord | null }>> {
  const ttlMs = input.ttlMs ?? resolveSessionHandoffPrepareTargetJobLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  const existing = await readLeaseRecord(resolved.leaseFilePath);
  if (!existing || existing.ownerId !== input.ownerId) {
    return { renewed: false, lease: existing };
  }
  const next: SessionHandoffPrepareTargetJobLeaseRecord = {
    ...existing,
    renewedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + ttlMs,
  };
  // Best-effort atomic: overwrite within the lease directory, which is already acquired/owned.
  await writeLeaseRecord(resolved.leaseFilePath, next);
  await writeLeaseRecord(resolved.runnerFilePath, next);
  return { renewed: true, lease: next };
}

export async function releaseSessionHandoffPrepareTargetJobLease(input: Readonly<{
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

export function startSessionHandoffPrepareTargetJobLeaseHeartbeat(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  ttlMs: number;
  nowMs: () => number;
}>): Readonly<{ stop: () => Promise<void> }> {
  const intervalMs = Math.max(250, Math.floor(input.ttlMs / 3));
  let stopped = false;
  const handle = setInterval(() => {
    if (stopped) return;
    void renewSessionHandoffPrepareTargetJobLease({
      activeServerDir: input.activeServerDir,
      jobId: input.jobId,
      ownerId: input.ownerId,
      nowMs: input.nowMs(),
      ttlMs: input.ttlMs,
    }).catch(() => undefined);
  }, intervalMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
