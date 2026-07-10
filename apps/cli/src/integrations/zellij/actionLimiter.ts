import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LIMITER_DIRECTORY_NAME = '.happier-action-slots';
const OWNER_FILE_NAME = 'owner.json';
const OWNERLESS_SLOT_STALE_MS = 30_000;
const MIN_CONTENTION_BACKOFF_MS = 5;
const MAX_CONTENTION_BACKOFF_MS = 50;

type ReleaseZellijActionSlot = () => Promise<void>;

type LocalWaiter = {
  maxConcurrency: number;
  start: () => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout> | undefined;
};

let activeLocalActionCount = 0;
const localWaiters: LocalWaiter[] = [];

function remainingDeadlineMs(deadlineMs: number | undefined): number | undefined {
  if (deadlineMs === undefined) return undefined;
  return Math.max(0, deadlineMs - Date.now());
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimDeadSlot(slotPath: string): Promise<void> {
  try {
    const ownerRaw = await readFile(join(slotPath, OWNER_FILE_NAME), 'utf8');
    const owner = JSON.parse(ownerRaw) as { pid?: unknown };
    const ownerPid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) ? owner.pid : null;
    if (ownerPid === null || processIsAlive(ownerPid)) return;
    await rm(slotPath, { recursive: true, force: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) return;
  }

  try {
    const slotStat = await stat(slotPath);
    if (Date.now() - slotStat.mtimeMs >= OWNERLESS_SLOT_STALE_MS) {
      await rm(slotPath, { recursive: true, force: true });
    }
  } catch {
    // Another owner may have released or reclaimed the slot concurrently.
  }
}

function contentionBackoffMs(attempt: number): number {
  const exponentialCap = Math.min(
    MAX_CONTENTION_BACKOFF_MS,
    MIN_CONTENTION_BACKOFF_MS * (2 ** Math.min(Math.max(0, attempt), 4)),
  );
  const jitterFloor = Math.max(1, Math.floor(exponentialCap / 2));
  return jitterFloor + Math.floor(Math.random() * (exponentialCap - jitterFloor + 1));
}

async function waitForContentionRetry(params: Readonly<{
  attempt: number;
  deadlineMs?: number | undefined;
  timeoutError: () => Error;
}>): Promise<void> {
  const remainingMs = remainingDeadlineMs(params.deadlineMs);
  if (remainingMs === 0) throw params.timeoutError();
  const delayMs = Math.min(contentionBackoffMs(params.attempt), remainingMs ?? Number.POSITIVE_INFINITY);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  if (remainingDeadlineMs(params.deadlineMs) === 0) throw params.timeoutError();
}

async function acquireSharedSlot(params: Readonly<{
  socketDir: string;
  maxConcurrency: number;
  deadlineMs?: number | undefined;
  timeoutError: () => Error;
}>): Promise<ReleaseZellijActionSlot> {
  const limiterDir = join(params.socketDir, LIMITER_DIRECTORY_NAME);
  await mkdir(limiterDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt += 1) {
    if (remainingDeadlineMs(params.deadlineMs) === 0) throw params.timeoutError();
    for (let slotIndex = 0; slotIndex < params.maxConcurrency; slotIndex += 1) {
      const slotPath = join(limiterDir, `slot-${slotIndex}`);
      const nonce = randomUUID();
      try {
        await mkdir(slotPath, { mode: 0o700 });
        await writeFile(
          join(slotPath, OWNER_FILE_NAME),
          JSON.stringify({ pid: process.pid, nonce, acquiredAtMs: Date.now() }),
          { encoding: 'utf8', mode: 0o600 },
        );
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            const ownerRaw = await readFile(join(slotPath, OWNER_FILE_NAME), 'utf8');
            const owner = JSON.parse(ownerRaw) as { nonce?: unknown };
            if (owner.nonce !== nonce) return;
            await rm(slotPath, { recursive: true, force: true });
          } catch {
            // Release is best-effort and must never replace the zellij action outcome.
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          await rm(slotPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        await reclaimDeadSlot(slotPath);
      }
    }
    await waitForContentionRetry({
      attempt,
      deadlineMs: params.deadlineMs,
      timeoutError: params.timeoutError,
    });
  }
}

function startNextLocalWaiter(): void {
  for (let index = 0; index < localWaiters.length; index += 1) {
    const waiter = localWaiters[index];
    if (!waiter || activeLocalActionCount >= waiter.maxConcurrency) continue;
    localWaiters.splice(index, 1);
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    activeLocalActionCount += 1;
    queueMicrotask(waiter.start);
    return;
  }
}

async function acquireLocalSlot(params: Readonly<{
  maxConcurrency: number;
  deadlineMs?: number | undefined;
  timeoutError: () => Error;
}>): Promise<ReleaseZellijActionSlot> {
  if (activeLocalActionCount < params.maxConcurrency) {
    activeLocalActionCount += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: LocalWaiter = {
        maxConcurrency: params.maxConcurrency,
        start: resolve,
        reject,
      };
      const remainingMs = remainingDeadlineMs(params.deadlineMs);
      if (remainingMs === 0) {
        reject(params.timeoutError());
        return;
      }
      if (remainingMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          const index = localWaiters.indexOf(waiter);
          if (index >= 0) localWaiters.splice(index, 1);
          waiter.reject(params.timeoutError());
        }, remainingMs);
      }
      localWaiters.push(waiter);
    });
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    activeLocalActionCount = Math.max(0, activeLocalActionCount - 1);
    startNextLocalWaiter();
  };
}

/**
 * Acquires one machine-shared zellij action slot. The caller's deadline begins before this call,
 * so contention wait consumes the same end-to-end timeout budget as the eventual client process.
 */
export function acquireZellijActionSlot(params: Readonly<{
  socketDir?: string | undefined;
  maxConcurrency: number;
  deadlineMs?: number | undefined;
  timeoutError: () => Error;
}>): Promise<ReleaseZellijActionSlot> {
  const socketDir = params.socketDir?.trim();
  return socketDir
    ? acquireSharedSlot({ ...params, socketDir })
    : acquireLocalSlot(params);
}
