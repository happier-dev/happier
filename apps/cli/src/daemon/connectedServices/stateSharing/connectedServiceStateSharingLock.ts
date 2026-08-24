import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';

const rootLocks = new Map<string, Promise<void>>();

export class ConnectedServiceStateSharingLockError extends Error {
  readonly code = 'state_sharing_lock_unavailable';
  readonly providerId: string | null;
  readonly destinationHome: string;
  readonly owner: ConnectedServiceStateSharingLockOwnerDiagnostic | null;

  constructor(params: Readonly<{
    providerId?: string | null;
    destinationHome: string;
    owner?: ConnectedServiceStateSharingLockOwnerDiagnostic | null;
  }>) {
    super(`Connected-service state sharing lock is unavailable for ${params.destinationHome}`);
    this.name = 'ConnectedServiceStateSharingLockError';
    this.providerId = params.providerId ?? null;
    this.destinationHome = params.destinationHome;
    this.owner = params.owner ?? null;
  }
}

export type ConnectedServiceStateSharingLockOwnerDiagnostic = Readonly<{
  pid: number | null;
  providerId: string | null;
  acquiredAt: string | null;
  acquiredAtMs: number | null;
  ageMs: number | null;
  alive: boolean | null;
}>;

type LockOptions = Readonly<{
  providerId?: string | null;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockTimeoutMs?: number;
}>;

async function withInProcessRootLock<T>(rootHome: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(rootHome);
  const previous = rootLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  rootLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (rootLocks.get(key) === queued) {
      rootLocks.delete(key);
    }
  }
}

async function withConnectedServiceStateSharingRootLock<T>(
  rootHome: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return await withInProcessRootLock(rootHome, async () => {
    const lockPath = `${resolve(rootHome)}.happier-state-sharing.lock`;
    try {
      return await withJsonOwnerFileLock({
        lockPath,
        timeoutMs: options.acquireTimeoutMs ?? 10_000,
        pollIntervalMs: options.retryDelayMs ?? 25,
        staleAfterMs: options.staleLockTimeoutMs ?? 5 * 60_000,
        errorCode: 'state_sharing_lock_unavailable',
      }, async () => {
        await mkdir(rootHome, { recursive: true });
        return await fn();
      });
    } catch (error) {
      if ((error as Error | null)?.message?.startsWith('state_sharing_lock_unavailable')) {
        throw new ConnectedServiceStateSharingLockError({
          providerId: options.providerId ?? null,
          destinationHome: rootHome,
        });
      }
      throw error;
    }
  });
}

export async function withConnectedServiceStateSharingLocks<T>(
  rootHomes: readonly string[],
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const roots = [...new Set(rootHomes.map((rootHome) => resolve(rootHome)))].sort();
  const acquire = async (index: number): Promise<T> => {
    if (index >= roots.length) return await fn();
    return await withConnectedServiceStateSharingRootLock(
      roots[index],
      async () => await acquire(index + 1),
      options,
    );
  };
  return await acquire(0);
}

export async function withConnectedServiceStateSharingDestinationLock<T>(
  destinationHome: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  return await withConnectedServiceStateSharingLocks([destinationHome], fn, options);
}
