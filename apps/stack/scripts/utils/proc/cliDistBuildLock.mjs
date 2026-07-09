import { isJsonOwnerFileLockActive, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';

export function isCliDistBuildLockActive(lockPath, options = {}) {
  return isJsonOwnerFileLockActive(lockPath, {
    staleAfterMs: options.staleAfterMs ?? 240_000,
    nowMs: options.nowMs ?? Date.now(),
  });
}

export async function withCliDistBuildLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) {
    throw new Error('withCliDistBuildLock requires options.lockPath');
  }

  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  return withJsonOwnerFileLock(
    ({ waited }) => fn({ waited }),
    {
      lockPath,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs,
      errorLabel: 'CLI dist build lock',
      onWait: typeof options.onWait === 'function'
        ? (event) => options.onWait({
          lockPath,
          owner: event.owner,
          staleAfterMs,
          timeoutMs,
          waitedMs: event.waitedMs,
        })
        : undefined,
    },
  );
}
