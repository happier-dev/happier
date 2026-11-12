import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

export type PersonalHomeOperationKind = 'inspect' | 'backup' | 'verify_backup' | 'restore' | 'erase' | 'relocate' | 'uninstall' | 'upgrade' | 'lifecycle' | 'claim_owner';
export type PersonalHomeOperationRole = 'source' | 'destination';

export class PersonalHomeOperationError extends Error {
  constructor(
    public readonly code: 'operation_in_progress' | 'ambiguous_stale_lock',
    message: string,
  ) {
    super(message);
    this.name = 'PersonalHomeOperationError';
  }
}

type LockRecord = Readonly<{
  token: string;
  pid: number;
  host: string;
  startedAt: string;
  operation: PersonalHomeOperationKind;
  role?: PersonalHomeOperationRole;
}>;

const lockPath = (dataDir: string): string => resolve(dataDir, '.operations', 'lock');

type AsyncLockOwnership = {
  active: boolean;
  operation: PersonalHomeOperationKind;
  token: string;
};

// Canonical lock paths owned by the current async operation. The active bit prevents a detached
// descendant from retaining authority after the operation callback has completed and its file
// lock has been released.
const heldLockPaths = new AsyncLocalStorage<ReadonlyMap<string, AsyncLockOwnership>>();

function parseLockRecord(value: string): LockRecord {
  const parsed = JSON.parse(value) as Partial<LockRecord>;
  if (
    typeof parsed.token !== 'string'
    || !parsed.token
    || typeof parsed.pid !== 'number'
    || typeof parsed.host !== 'string'
    || typeof parsed.startedAt !== 'string'
    || typeof parsed.operation !== 'string'
    || (parsed.role !== undefined && parsed.role !== 'source' && parsed.role !== 'destination')
  ) throw new Error('Invalid Personal Home operation lock record');
  return parsed as LockRecord;
}

async function ownerAlive(record: LockRecord): Promise<boolean | null> {
  if (record.host !== hostname()) return null;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
}

async function publishExclusiveLockRecord(path: string, record: LockRecord): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } catch (error) {
    // Only our unpublished exclusive create is ours to retire. Close before unlinking
    // for Windows, and preserve the publication error if cleanup also fails.
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function writeExclusiveTakeoverClaim(path: string, record: LockRecord): Promise<boolean> {
  const temporaryPath = `${path}.${record.token}.tmp`;
  await publishExclusiveLockRecord(temporaryPath, record);
  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function releaseExactTakeoverClaim(path: string, pinnedPath: string, token: string): Promise<void> {
  try {
    const current = parseLockRecord(await readFile(path, 'utf8'));
    if (current.token !== token) return;
    await unlink(pinnedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function isPersonalHomeOperationLeaseAttested(
  dataDir: string,
  expectedOperation?: PersonalHomeOperationKind,
): Promise<boolean> {
  const path = lockPath(dataDir);
  const ownership = heldLockPaths.getStore()?.get(path);
  if (ownership?.active !== true || (expectedOperation !== undefined && ownership.operation !== expectedOperation)) return false;
  try {
    const record = parseLockRecord(await readFile(path, 'utf8'));
    return record.token === ownership.token
      && record.host === hostname()
      && record.pid === process.pid
      && record.operation === ownership.operation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function isPersonalHomeOperationLockHeld(dataDir: string, operation: PersonalHomeOperationKind): Promise<boolean> {
  return isPersonalHomeOperationLeaseAttested(dataDir, operation);
}

type PersonalHomeOperationLease = Readonly<{
  record: LockRecord;
  release: (movedToDataDirs?: readonly string[]) => Promise<void>;
}>;

async function acquirePersonalHomeOperationLease(
  dataDir: string,
  operation: PersonalHomeOperationKind,
  options: Readonly<{ role?: PersonalHomeOperationRole }> = {},
): Promise<PersonalHomeOperationLease> {
  const path = lockPath(dataDir);
  const takeoverPath = `${path}.takeover`;
  const pinnedTakeoverPath = `${takeoverPath}.inode`;
  await mkdir(dirname(path), { recursive: true });
  const record: LockRecord = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    operation,
    ...(options.role ? { role: options.role } : {}),
  };

  for (;;) {
    let takeover: LockRecord | null = null;
    try {
      takeover = parseLockRecord(await readFile(takeoverPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PersonalHomeOperationError('ambiguous_stale_lock', 'Unable to inspect Personal Home lock takeover owner');
      }
    }
    if (takeover) {
      const takeoverAlive = await ownerAlive(takeover);
      if (takeoverAlive !== false) {
        throw new PersonalHomeOperationError(
          takeoverAlive === null ? 'ambiguous_stale_lock' : 'operation_in_progress',
          'Personal Home lock takeover is in progress',
        );
      }
      await releaseExactTakeoverClaim(takeoverPath, pinnedTakeoverPath, takeover.token);
      continue;
    }
    try {
      await publishExclusiveLockRecord(path, record);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: LockRecord;
      try {
        existing = parseLockRecord(await readFile(path, 'utf8'));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new PersonalHomeOperationError('ambiguous_stale_lock', 'Unable to inspect operation lock');
      }
      const alive = await ownerAlive(existing);
      if (alive !== false) {
        throw new PersonalHomeOperationError(
          alive === null ? 'ambiguous_stale_lock' : 'operation_in_progress',
          'Personal Home operation is already in progress',
        );
      }

      if (!(await writeExclusiveTakeoverClaim(takeoverPath, record))) continue;
      try {
        try {
          // The claimant record identifies the takeover process so an interrupted takeover is
          // recoverable. This separate hard link pins the exact stale inode being replaced.
          await link(path, pinnedTakeoverPath);
          const [current, pinned] = await Promise.all([lstat(path), lstat(pinnedTakeoverPath)]);
          const pinnedRecord = parseLockRecord(await readFile(pinnedTakeoverPath, 'utf8'));
          if (current.dev !== pinned.dev || current.ino !== pinned.ino || pinnedRecord.token !== existing.token) {
            throw new PersonalHomeOperationError('operation_in_progress', 'Personal Home lock changed during stale takeover');
          }
          await unlink(path);
        } catch (claimError) {
          const code = (claimError as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EEXIST') continue;
          if (claimError instanceof PersonalHomeOperationError) throw claimError;
          throw new PersonalHomeOperationError('ambiguous_stale_lock', 'Filesystem cannot safely claim the stale Personal Home lock');
        }
        await publishExclusiveLockRecord(path, record);
        break;
      } finally {
        await releaseExactTakeoverClaim(takeoverPath, pinnedTakeoverPath, record.token);
      }
    }
  }

  return {
    record,
    release: async (movedToDataDirs = []) => {
      const releasePaths = new Set([
        path,
        ...movedToDataDirs.map((dataDir) => lockPath(dataDir)),
      ]);
      for (const releasePath of releasePaths) {
        try {
          const current = parseLockRecord(await readFile(releasePath, 'utf8'));
          if (current.token === record.token) await unlink(releasePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

export async function acquirePersonalHomeOperationLock(
  dataDir: string,
  operation: PersonalHomeOperationKind,
  options: Readonly<{ role?: PersonalHomeOperationRole }> = {},
): Promise<() => Promise<void>> {
  return (await acquirePersonalHomeOperationLease(dataDir, operation, options)).release;
}

export async function withPersonalHomeOperationLock<T>(
  dataDir: string,
  operation: PersonalHomeOperationKind,
  fn: () => Promise<T>,
  options: Readonly<{ movedToDataDir?: string }> = {},
): Promise<T> {
  const path = lockPath(dataDir);
  const held = heldLockPaths.getStore();
  if (operation === 'lifecycle' && await isPersonalHomeOperationLeaseAttested(dataDir)) {
    // Genuine nesting: the enclosing Personal Home operation owns this Home's lease and its
    // production lifecycle adapter (start/stop/restart) proceeds under the same lease instead
    // of deadlocking against it. Independent flows in the same process never inherit this
    // context and still contend on the exclusive lock file; nested mutations stay exclusive.
    return await fn();
  }
  const lease = await acquirePersonalHomeOperationLease(dataDir, operation);
  const ownership: AsyncLockOwnership = { active: true, operation, token: lease.record.token };
  try {
    return await heldLockPaths.run(new Map([...(held ?? []), [path, ownership]]), fn);
  } finally {
    ownership.active = false;
    await lease.release(options.movedToDataDir ? [options.movedToDataDir] : []);
  }
}
