import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export type TestProcessLeaseOwner = Record<string, unknown>;

export type TestProcessLeaseSnapshot = Readonly<{
  exists: boolean;
  raw: string | null;
  owner: TestProcessLeaseOwner | null;
  mtimeMs: number | null;
}>;

export type TestProcessLease = Readonly<{
  lockPath: string;
  isCurrentOwner: () => boolean;
  readOwnRaw: () => string | null;
  updateOwnerMetadata: (metadata: TestProcessLeaseOwner) => boolean;
}>;

type ShouldReclaimTestProcessLeaseSnapshotParams = Readonly<{
  lockPath: string;
  snapshot: TestProcessLeaseSnapshot;
  staleAfterMs: number;
  nowMs: number;
}>;

export type TestProcessLeaseOptions = Readonly<{
  lockPath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  heartbeat?: boolean;
  heartbeatIntervalMs?: number;
  errorLabel?: string;
  isOwnerAlive?: (pid: number) => boolean;
  shouldReclaimSnapshot?: (
    params: ShouldReclaimTestProcessLeaseSnapshotParams
  ) => boolean | Promise<boolean>;
}>;

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return false;
    return true;
  }
}

export function parseTestProcessLeaseRaw(raw: string): TestProcessLeaseOwner | null {
  const text = raw.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as TestProcessLeaseOwner;
  } catch {
    return null;
  }
}

export function readTestProcessLeaseRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

export function readTestProcessLeaseSnapshot(lockPath: string): TestProcessLeaseSnapshot {
  try {
    const stats = statSync(lockPath);
    const raw = readFileSync(lockPath, 'utf8');
    return {
      exists: true,
      raw,
      owner: parseTestProcessLeaseRaw(raw),
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return {
      exists: false,
      raw: null,
      owner: null,
      mtimeMs: null,
    };
  }
}

export function shouldReclaimTestProcessLeaseSnapshot(
  snapshot: TestProcessLeaseSnapshot,
  options: Readonly<{
    staleAfterMs: number;
    nowMs?: number;
    isOwnerAlive?: (pid: number) => boolean;
  }>,
): boolean {
  if (!snapshot.exists) return true;

  const ownerPid = readPositiveNumber(snapshot.owner?.pid);
  if (ownerPid != null) {
    return !(options.isOwnerAlive ?? isRunningPid)(ownerPid);
  }

  const timestampMs = readPositiveNumber(snapshot.owner?.updatedAtMs)
    ?? readPositiveNumber(snapshot.owner?.createdAtMs)
    ?? snapshot.mtimeMs;
  return timestampMs != null && (options.nowMs ?? Date.now()) - timestampMs > options.staleAfterMs;
}

export function reclaimTestProcessLeaseSnapshot(lockPath: string, expectedRaw: string | null): boolean {
  if (expectedRaw == null) return true;

  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockPath, reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true;
    return false;
  }

  let movedRaw: string | null = null;
  try {
    movedRaw = readFileSync(reclaimPath, 'utf8');
  } catch {
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      unlinkSync(reclaimPath);
    } catch {
      // ignore cleanup failures for the quarantined stale lock
    }
    return true;
  }

  try {
    writeFileSync(lockPath, movedRaw, { encoding: 'utf8', flag: 'wx' });
    unlinkSync(reclaimPath);
  } catch {
    // Another owner already has the lock path. Keep the quarantined file for diagnostics.
  }
  return false;
}

function createOwnerRaw(metadata: TestProcessLeaseOwner, nowMs: number): string {
  return JSON.stringify({
    ...metadata,
    pid: process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

function isFileDescriptorAtLockPath(fd: number, lockPath: string): boolean {
  try {
    const fdStats = fstatSync(fd);
    const pathStats = statSync(lockPath);
    return fdStats.dev === pathStats.dev && fdStats.ino === pathStats.ino;
  } catch {
    return false;
  }
}

function writeOwnerRawToFd(fd: number, lockPath: string, raw: string): boolean {
  if (!isFileDescriptorAtLockPath(fd, lockPath)) return false;
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, raw, 0, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function describeTestProcessLease(lockPath: string, nowMs: number): string {
  const snapshot = readTestProcessLeaseSnapshot(lockPath);
  const owner = snapshot.owner;
  if (!owner) return 'ownerPid=unknown ownerAgeMs=unknown';
  const timestampMs = readPositiveNumber(owner.updatedAtMs) ?? readPositiveNumber(owner.createdAtMs);
  const ownerAgeMs = timestampMs != null ? Math.max(0, nowMs - timestampMs) : 'unknown';
  return `ownerPid=${String(owner.pid ?? 'unknown')} ownerAgeMs=${ownerAgeMs}`;
}

export async function withTestProcessLease<T>(
  fn: (lease: TestProcessLease) => Promise<T>,
  options: TestProcessLeaseOptions,
): Promise<T> {
  const lockPath = options.lockPath;
  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const errorLabel = options.errorLabel ?? 'test process lease';
  const startedAt = Date.now();

  let fd: number | null = null;
  let ownRaw: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  while (true) {
    try {
      const nextFd = openSync(lockPath, 'wx');
      const nextRaw = createOwnerRaw({}, Date.now());
      if (!writeOwnerRawToFd(nextFd, lockPath, nextRaw)) {
        closeSync(nextFd);
        throw new Error(`Failed to write ${errorLabel}: ${lockPath}`);
      }
      fd = nextFd;
      ownRaw = nextRaw;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
        throw error;
      }

      const snapshot = readTestProcessLeaseSnapshot(lockPath);
      const reclaim = options.shouldReclaimSnapshot
        ? await options.shouldReclaimSnapshot({
          lockPath,
          snapshot,
          staleAfterMs,
          nowMs: Date.now(),
        })
        : shouldReclaimTestProcessLeaseSnapshot(snapshot, {
          staleAfterMs,
          isOwnerAlive: options.isOwnerAlive,
        });

      if (reclaim) {
        reclaimTestProcessLeaseSnapshot(lockPath, snapshot.raw);
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${errorLabel}: ${lockPath} (${describeTestProcessLease(lockPath, Date.now())})`);
      }
      await sleep(pollIntervalMs);
    }
  }

  const lease: TestProcessLease = {
    lockPath,
    isCurrentOwner: () => fd != null && isFileDescriptorAtLockPath(fd, lockPath),
    readOwnRaw: () => ownRaw,
    updateOwnerMetadata: (metadata) => {
      if (fd == null || ownRaw == null) return false;
      const currentOwner = parseTestProcessLeaseRaw(ownRaw) ?? {};
      const createdAtMs = readPositiveNumber(currentOwner.createdAtMs) ?? Date.now();
      const nextRaw = JSON.stringify({
        ...currentOwner,
        ...metadata,
        pid: process.pid,
        createdAtMs,
        updatedAtMs: Date.now(),
      });
      if (!writeOwnerRawToFd(fd, lockPath, nextRaw)) return false;
      ownRaw = nextRaw;
      return true;
    },
  };

  try {
    if (options.heartbeat !== false && staleAfterMs > 0) {
      const heartbeatIntervalMs = options.heartbeatIntervalMs
        ?? Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        lease.updateOwnerMetadata({});
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn(lease);
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    try {
      if (fd != null && ownRaw != null && readTestProcessLeaseRaw(lockPath) === ownRaw) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore lock cleanup failures
    }
    try {
      if (fd != null) closeSync(fd);
    } catch {
      // ignore close failures
    }
  }
}
