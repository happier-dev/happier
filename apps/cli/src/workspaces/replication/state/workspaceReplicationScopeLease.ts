import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceReplicationPaths } from './workspaceReplicationPaths';
import { isCliDaemonOwnedLeaseStealable } from './leaseOwnerPid';

export type WorkspaceReplicationScopeLeaseRecord = Readonly<{
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

const RELATIONSHIP_ID_REGEX = /^rel_[A-Za-z0-9_-]+$/u;
const DIRECTION_ID_REGEX = /^dir_[A-Za-z0-9_-]+$/u;

export function resolveWorkspaceReplicationScopeLeaseTtlMs(): number {
  const raw = process.env.HAPPIER_WORKSPACE_REPLICATION_SCOPE_LEASE_TTL_MS;
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
  relationshipId: string;
  directionId: string;
}>) {
  if (!RELATIONSHIP_ID_REGEX.test(input.relationshipId)) {
    throw new Error(`Invalid workspace replication relationship id: ${input.relationshipId}`);
  }
  if (!DIRECTION_ID_REGEX.test(input.directionId)) {
    throw new Error(`Invalid workspace replication direction id: ${input.directionId}`);
  }

  const paths = createWorkspaceReplicationPaths({ activeServerDir: input.activeServerDir });
  const leaseRootDirectory = join(paths.rootDirectory, 'scope-leases');
  const leaseDirectory = join(leaseRootDirectory, `${input.relationshipId}__${input.directionId}`, 'lease');
  const leaseFilePath = join(leaseDirectory, 'lease.json');

  return {
    paths,
    leaseRootDirectory,
    leaseDirectory,
    leaseFilePath,
  } as const;
}

async function readLeaseRecord(filePath: string): Promise<WorkspaceReplicationScopeLeaseRecord | null> {
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

async function writeLeaseRecordAtomic(input: Readonly<{
  leaseDirectory: string;
  leaseFilePath: string;
  record: WorkspaceReplicationScopeLeaseRecord;
}>): Promise<void> {
  const tmpPath = join(input.leaseDirectory, `lease.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(input.record)}\n`, 'utf8');
  await rename(tmpPath, input.leaseFilePath);
}

function isLeaseAlreadyExistsError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError?.code === 'EEXIST' || nodeError?.code === 'ENOTEMPTY' || nodeError?.code === 'EPERM';
}

export async function tryAcquireWorkspaceReplicationScopeLease(input: Readonly<{
  activeServerDir: string;
  relationshipId: string;
  directionId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{ acquired: boolean; lease: WorkspaceReplicationScopeLeaseRecord | null }>> {
  const ttlMs = input.ttlMs ?? resolveWorkspaceReplicationScopeLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  await mkdir(resolved.leaseRootDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readLeaseRecord(resolved.leaseFilePath);
    if (existing && existing.expiresAtMs > input.nowMs) {
      if (!isCliDaemonOwnedLeaseStealable(existing.ownerId)) {
        return { acquired: false, lease: existing };
      }
    }
    const previousAttempt = existing?.attempt ?? 0;
    if (existing) {
      await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const nextLease: WorkspaceReplicationScopeLeaseRecord = {
      leaseId: randomUUID(),
      attempt: previousAttempt + 1,
      ownerId: input.ownerId,
      acquiredAtMs: input.nowMs,
      renewedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + ttlMs,
    };

    const tempLeaseDirectory = `${resolved.leaseDirectory}.tmp-${randomUUID()}`;
    await mkdir(tempLeaseDirectory, { recursive: true });
    await writeFile(join(tempLeaseDirectory, 'lease.json'), `${JSON.stringify(nextLease)}\n`, 'utf8');
    try {
      await rename(tempLeaseDirectory, resolved.leaseDirectory);
      return { acquired: true, lease: nextLease };
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

export async function renewWorkspaceReplicationScopeLease(input: Readonly<{
  activeServerDir: string;
  relationshipId: string;
  directionId: string;
  ownerId: string;
  nowMs: number;
  ttlMs?: number;
}>): Promise<Readonly<{ renewed: boolean; lease: WorkspaceReplicationScopeLeaseRecord | null }>> {
  const ttlMs = input.ttlMs ?? resolveWorkspaceReplicationScopeLeaseTtlMs();
  const resolved = resolveLeasePaths(input);
  const existing = await readLeaseRecord(resolved.leaseFilePath);
  if (!existing || existing.ownerId !== input.ownerId) {
    return { renewed: false, lease: existing };
  }
  if (existing.expiresAtMs <= input.nowMs) {
    return { renewed: false, lease: existing };
  }

  const next: WorkspaceReplicationScopeLeaseRecord = {
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

export async function releaseWorkspaceReplicationScopeLease(input: Readonly<{
  activeServerDir: string;
  relationshipId: string;
  directionId: string;
  ownerId: string;
}>): Promise<void> {
  const resolved = resolveLeasePaths(input);
  const existing = await readLeaseRecord(resolved.leaseFilePath);
  if (!existing || existing.ownerId !== input.ownerId) {
    return;
  }
  await rm(resolved.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
}
