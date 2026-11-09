import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProcessGeneration, parseProcessGenerationWitness, readProcessIdentityByPid, type ProcessGenerationWitness } from '@/daemon/processIdentity';
import { resolvePrepareTargetJobPath, withPrepareTargetJobMutationLock } from './jobMutation';

export type SessionHandoffPrepareTargetJobLeaseRecord = Readonly<{
  leaseId: string;
  ownerId: string;
  ownerProcess?: ProcessGenerationWitness;
  acquiredAtMs: number;
}>;

function resolveLeasePaths(input: Readonly<{ activeServerDir: string; jobId: string }>) {
  const jobPath = resolvePrepareTargetJobPath(input.activeServerDir, input.jobId);
  const jobStagingDirectory = join(input.activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', input.jobId);
  const leaseDirectory = join(jobStagingDirectory, 'lease');
  return { jobPath, jobStagingDirectory, leaseDirectory, leaseFilePath: join(leaseDirectory, 'lease.json') };
}

async function readLeaseRecord(filePath: string): Promise<SessionHandoffPrepareTargetJobLeaseRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.leaseId !== 'string' || !record.leaseId.trim()
      || typeof record.ownerId !== 'string' || !record.ownerId.trim()
      || typeof record.acquiredAtMs !== 'number' || !Number.isFinite(record.acquiredAtMs)) return null;
    const ownerProcess = record.ownerProcess === undefined ? undefined : parseProcessGenerationWitness(record.ownerProcess);
    if (record.ownerProcess !== undefined && !ownerProcess) return null;
    return { leaseId: record.leaseId, ownerId: record.ownerId, acquiredAtMs: record.acquiredAtMs,
      ...(ownerProcess ? { ownerProcess } : {}) };
  } catch { return null; }
}

/** Old target claims stored only the daemon PID in ownerId. A live PID without birth stays unknown. */
function readPredecessorPid(ownerId: string): number | null {
  const match = /^(?:cli-daemon|daemon):([1-9][0-9]*)(?::|$)/u.exec(ownerId);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) ? pid : null;
}

export async function tryAcquireSessionHandoffPrepareTargetJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  nowMs: number;
}>): Promise<Readonly<{ acquired: true; lease: SessionHandoffPrepareTargetJobLeaseRecord }>
  | Readonly<{ acquired: false; lease: SessionHandoffPrepareTargetJobLeaseRecord | null }>> {
  const paths = resolveLeasePaths(input);
  return await withPrepareTargetJobMutationLock(paths.jobPath, async () => {
    const existing = await readLeaseRecord(paths.leaseFilePath);
    if (await lstat(paths.leaseDirectory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    })) {
      const pid = existing ? readPredecessorPid(existing.ownerId) : null;
      const ownerProcess = existing?.ownerProcess ?? (pid ? { pid } : null);
      if (!ownerProcess || await inspectProcessGeneration(ownerProcess) !== 'verified_stopped') {
        return { acquired: false, lease: existing } as const;
      }
      await rm(paths.leaseDirectory, { recursive: true, force: true });
    }
    const identity = await readProcessIdentityByPid(process.pid);
    const ownerProcess = parseProcessGenerationWitness({ pid: process.pid, processStartTimeMs: identity?.processStartTimeMs });
    if (!ownerProcess) throw new Error('Current process birth is unavailable for handoff target ownership');
    const lease = { leaseId: randomUUID(), ownerId: input.ownerId, ownerProcess, acquiredAtMs: input.nowMs };
    await mkdir(paths.jobStagingDirectory, { recursive: true });
    const temporary = `${paths.leaseDirectory}.tmp-${randomUUID()}`;
    await mkdir(temporary);
    try {
      await writeFile(join(temporary, 'lease.json'), `${JSON.stringify(lease)}\n`, 'utf8');
      await rename(temporary, paths.leaseDirectory);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return { acquired: true, lease } as const;
  });
}

export async function releaseSessionHandoffPrepareTargetJobLease(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  leaseId: string;
}>): Promise<void> {
  const paths = resolveLeasePaths(input);
  await withPrepareTargetJobMutationLock(paths.jobPath, async () => {
    const existing = await readLeaseRecord(paths.leaseFilePath);
    if (existing?.ownerId !== input.ownerId || existing.leaseId !== input.leaseId) return;
    await rm(paths.leaseDirectory, { recursive: true, force: true });
  });
}
