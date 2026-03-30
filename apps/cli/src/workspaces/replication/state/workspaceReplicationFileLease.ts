import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLI_DAEMON_LEASE_OWNER_PID_REGEX = /^cli-daemon:(\d+)(?::|$)/u;

export type WorkspaceReplicationFileLeaseRecord = Readonly<{
  leaseId?: string;
  attempt?: number;
  ownerId: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
}>;

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

// Unknown/legacy owner ids fail closed (treated as alive) for acquisition to avoid accidental lease stealing.
function isLeaseOwnerAliveOrUnknown(ownerId: string): boolean {
  const match = CLI_DAEMON_LEASE_OWNER_PID_REGEX.exec(ownerId);
  if (!match) {
    return true;
  }
  const pid = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  return isPidAlive(pid);
}

export function parseWorkspaceReplicationFileLeaseObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

export function parseWorkspaceReplicationFileLeaseBase(
  value: Record<string, unknown>,
): WorkspaceReplicationFileLeaseRecord | null {
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
}

export async function readWorkspaceReplicationFileLease<T>(input: Readonly<{
  leaseFilePath: string;
  parseRecord: (raw: unknown) => T | null;
}>): Promise<T | null> {
  try {
    const raw = await readFile(input.leaseFilePath, 'utf8');
    return input.parseRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeWorkspaceReplicationFileLease(
  filePath: string,
  record: WorkspaceReplicationFileLeaseRecord | Record<string, unknown>,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function writeWorkspaceReplicationFileLeaseAtomic(input: Readonly<{
  leaseDirectory: string;
  leaseFilePath: string;
  record: WorkspaceReplicationFileLeaseRecord | Record<string, unknown>;
}>): Promise<void> {
  const tmpPath = join(input.leaseDirectory, `lease.${randomUUID()}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(input.record)}\n`, 'utf8');
  await rename(tmpPath, input.leaseFilePath);
}

function isLeaseAlreadyExistsError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError?.code === 'EEXIST' || nodeError?.code === 'ENOTEMPTY' || nodeError?.code === 'EPERM';
}

export async function tryAcquireWorkspaceReplicationFileLease<T extends WorkspaceReplicationFileLeaseRecord>(input: Readonly<{
  leaseParentDirectory: string;
  leaseDirectory: string;
  leaseFilePath: string;
  nowMs: number;
  readLease: () => Promise<T | null>;
  createLease: (attemptNumber: number) => T;
}>): Promise<Readonly<{
  acquired: boolean;
  lease: T | null;
}>> {
  await mkdir(input.leaseParentDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await input.readLease();
    if (existing && existing.expiresAtMs > input.nowMs && isLeaseOwnerAliveOrUnknown(existing.ownerId)) {
      return { acquired: false, lease: existing };
    }
    const previousAttempt = existing?.attempt ?? 0;
    if (existing) {
      await rm(input.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const nextLease = input.createLease(previousAttempt + 1);
    const tempLeaseDirectory = `${input.leaseDirectory}.tmp-${randomUUID()}`;
    await mkdir(tempLeaseDirectory, { recursive: false });
    await writeWorkspaceReplicationFileLease(join(tempLeaseDirectory, 'lease.json'), nextLease);
    try {
      await rename(tempLeaseDirectory, input.leaseDirectory);
      return { acquired: true, lease: nextLease };
    } catch (error) {
      if (!isLeaseAlreadyExistsError(error)) {
        await rm(tempLeaseDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      await rm(tempLeaseDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const locked = await input.readLease();
    if (locked && locked.expiresAtMs > input.nowMs && isLeaseOwnerAliveOrUnknown(locked.ownerId)) {
      return { acquired: false, lease: locked };
    }

    await rm(input.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  const existing = await input.readLease();
  return { acquired: false, lease: existing };
}

export async function renewWorkspaceReplicationFileLease<T extends WorkspaceReplicationFileLeaseRecord>(input: Readonly<{
  leaseDirectory: string;
  leaseFilePath: string;
  nowMs: number;
  readLease: () => Promise<T | null>;
  canMutateLease: (lease: T) => boolean;
  createRenewedLease: (lease: T) => T;
}>): Promise<Readonly<{
  renewed: boolean;
  lease: T | null;
}>> {
  const existing = await input.readLease();
  if (!existing || !input.canMutateLease(existing)) {
    return { renewed: false, lease: existing };
  }
  if (existing.expiresAtMs <= input.nowMs) {
    return { renewed: false, lease: existing };
  }
  const next = input.createRenewedLease(existing);
  await writeWorkspaceReplicationFileLeaseAtomic({
    leaseDirectory: input.leaseDirectory,
    leaseFilePath: input.leaseFilePath,
    record: next,
  });
  return { renewed: true, lease: next };
}

export async function releaseWorkspaceReplicationFileLease<T extends WorkspaceReplicationFileLeaseRecord>(input: Readonly<{
  leaseDirectory: string;
  readLease: () => Promise<T | null>;
  canReleaseLease: (lease: T) => boolean;
}>): Promise<void> {
  const existing = await input.readLease();
  if (!existing || !input.canReleaseLease(existing)) {
    return;
  }
  await rm(input.leaseDirectory, { recursive: true, force: true }).catch(() => undefined);
}
