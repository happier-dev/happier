import { mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function parseLockOwner(lockPath: string): { pid?: number; createdAtMs?: number; updatedAtMs?: number } | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pid?: number; createdAtMs?: number; updatedAtMs?: number } | null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function serializeLockOwner(nowMs: number): string {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

function describeLockOwner(lockPath: string, nowMs: number): string {
  const owner = parseLockOwner(lockPath);
  if (!owner) return 'owner=unknown';
  const ageMs = Math.max(0, nowMs - Number(owner.updatedAtMs ?? owner.createdAtMs ?? nowMs));
  return `pid=${String(owner.pid ?? 'unknown')} ageMs=${ageMs}`;
}

function shouldReclaimLock(lockPath: string, staleAfterMs: number, nowMs: number): boolean {
  try {
    const stats = statSync(lockPath);
    const owner = parseLockOwner(lockPath);
    const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? stats.mtimeMs ?? 0);
    return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
  } catch {
    return false;
  }
}

export async function withCliDistBuildLock<T>(
  fn: (params: { waited: boolean }) => Promise<T>,
  options: {
    lockPath: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleAfterMs?: number;
  },
): Promise<T> {
  const { lockPath } = options;
  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();

  let fd: number | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let waited = false;

  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeLockOwner(Date.now()), 'utf8');
      break;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code ?? '') : '';
      if (code !== 'EEXIST') throw error;
      if (shouldReclaimLock(lockPath, staleAfterMs, Date.now())) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // ignore stale-lock cleanup races
        }
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for CLI dist build lock: ${lockPath} (${describeLockOwner(lockPath, Date.now())})`);
      }
      waited = true;
      await delay(pollIntervalMs);
    }
  }

  try {
    heartbeat = setInterval(() => {
      try {
        writeFileSync(lockPath, serializeLockOwner(Date.now()), 'utf8');
      } catch {
        // ignore heartbeat write races during teardown
      }
    }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
    return await fn({ waited });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore teardown races
      }
    }
  }
}
