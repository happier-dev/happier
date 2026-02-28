import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';

import { findHappyProcessByPid } from './doctor';
import { hashProcessCommand } from './sessionRegistry';

type LockPayload = Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  processCommandHash?: string;
}>;

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sessionRunnerLocksDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'tmp', 'session-runner-locks');
}

function resolveMaxLockBasenameChars(): number {
  const raw = (process.env.HAPPIER_SESSION_RUNNER_LOCK_MAX_BASENAME_CHARS ?? '').trim();
  if (!raw) return 120;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 120;
  return Math.min(240, Math.max(32, parsed));
}

function resolveLockFileBasename(sessionId: string): string {
  const maxChars = resolveMaxLockBasenameChars();
  // Prefer human-readable filenames when safe; otherwise fall back to a stable hash to avoid path injection.
  if (/^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId.length <= maxChars) return sessionId;
  return `sha-${sha256Hex(sessionId)}`;
}

export function sessionRunnerLockPathForSessionId(params: Readonly<{ happyHomeDir?: string; sessionId: string }>): string | null {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return null;
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  if (!happyHomeDir) return null;
  return join(sessionRunnerLocksDir(happyHomeDir), `${resolveLockFileBasename(sessionId)}.json`);
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getCurrentProcessCommandHashDefault(pid: number): Promise<string | null> {
  const proc = await findHappyProcessByPid(pid).catch(() => null);
  if (!proc?.command) return null;
  return hashProcessCommand(proc.command);
}

function safeParseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw);
    const sessionId = normalizeSessionId(parsed?.sessionId);
    const pid = Number(parsed?.pid);
    const acquiredAtMs = Number(parsed?.acquiredAtMs);
    const processCommandHashRaw = typeof parsed?.processCommandHash === 'string' ? parsed.processCommandHash : '';
    const processCommandHash = /^[a-f0-9]{64}$/.test(processCommandHashRaw) ? processCommandHashRaw : undefined;
    if (!sessionId) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return { sessionId, pid: Math.floor(pid), acquiredAtMs: Math.floor(acquiredAtMs), ...(processCommandHash ? { processCommandHash } : {}) };
  } catch {
    return null;
  }
}

export type AcquireSessionRunnerLockResult =
  | Readonly<{
      ok: true;
      sessionId: string;
      pid: number;
      acquiredAtMs: number;
      lockPath: string;
      release: () => Promise<void>;
    }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' }>
  | Readonly<{ ok: false; reason: 'already_running'; heldByPid: number }>
  | Readonly<{ ok: false; reason: 'io_error'; errorMessage: string }>;

export async function acquireSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid?: number;
  nowMs?: number;
  happyHomeDir?: string;
  isPidAlive?: (pid: number) => boolean;
  getCurrentProcessCommandHash?: (pid: number) => Promise<string | null>;
}>): Promise<AcquireSessionRunnerLockResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };

  const pid = typeof params.pid === 'number' && Number.isFinite(params.pid) && params.pid > 0 ? Math.floor(params.pid) : process.pid;
  const nowMsRaw = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const nowMs = Math.max(1, Math.floor(nowMsRaw));

  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  try {
    await mkdir(sessionRunnerLocksDir(happyHomeDir), { recursive: true });
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  const getCurrentProcessCommandHash = params.getCurrentProcessCommandHash ?? getCurrentProcessCommandHashDefault;
  const processCommandHashRaw = await getCurrentProcessCommandHash(pid).catch(() => null);
  const processCommandHash = typeof processCommandHashRaw === 'string' && /^[a-f0-9]{64}$/.test(processCommandHashRaw) ? processCommandHashRaw : null;

  const payload: LockPayload = {
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    ...(processCommandHash ? { processCommandHash } : {}),
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';

  const tryCreate = async (): Promise<boolean> => {
    try {
      await writeFile(lockPath, serialized, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  };

  try {
    const created = await tryCreate();
    if (created) {
      return {
        ok: true,
        sessionId,
        pid,
        acquiredAtMs: nowMs,
        lockPath,
        release: async () => {
          await releaseSessionRunnerLock({ happyHomeDir, sessionId, pid, acquiredAtMs: nowMs }).catch(() => {});
        },
      };
    }
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  // Existing lock. If it's held by a live safe Happy session process, deny; otherwise break stale and retry once.
  let existing: LockPayload | null = null;
  try {
    existing = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch {
    existing = null;
  }

  const isPidAlive = params.isPidAlive ?? isPidAliveDefault;

  if (existing && existing.sessionId !== sessionId) {
    if (existing.pid && isPidAlive(existing.pid)) {
      return { ok: false, reason: 'already_running', heldByPid: existing.pid };
    }
    // payload mismatch but process isn't alive: treat as stale/invalid and overwrite.
    existing = null;
  }

  if (existing?.pid && isPidAlive(existing.pid)) {
    if (existing.processCommandHash) {
      const currentHash = await getCurrentProcessCommandHash(existing.pid).catch(() => null);
      // If we can prove this PID is now a different process, treat the lock as stale and break it.
      if (typeof currentHash === 'string' && /^[a-f0-9]{64}$/.test(currentHash) && currentHash !== existing.processCommandHash) {
        // continue below to break the lock
      } else {
        // Fail-closed: if the lock PID is alive and we cannot prove it's stale, deny.
        return { ok: false, reason: 'already_running', heldByPid: existing.pid };
      }
    } else {
      // Fail-closed: without a command hash, we can't safely distinguish PID reuse.
      return { ok: false, reason: 'already_running', heldByPid: existing.pid };
    }
  }

  try {
    await unlink(lockPath);
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  try {
    const createdAfterBreak = await tryCreate();
    if (!createdAfterBreak) {
      // Someone else raced us; best-effort read to report a PID.
      const raced = await readSessionRunnerLockStatus({ happyHomeDir, sessionId }).catch(() => null);
      if (raced && raced.ok) {
        return { ok: false, reason: 'already_running', heldByPid: raced.lock.pid };
      }
      return { ok: false, reason: 'io_error', errorMessage: 'Lock acquisition raced and could not read existing lock' };
    }
    return {
      ok: true,
      sessionId,
      pid,
      acquiredAtMs: nowMs,
      lockPath,
      release: async () => {
        await releaseSessionRunnerLock({ happyHomeDir, sessionId, pid, acquiredAtMs: nowMs }).catch(() => {});
      },
    };
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

export type ReleaseSessionRunnerLockResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' }>
  | Readonly<{ ok: false; reason: 'not_found' }>
  | Readonly<{ ok: false; reason: 'not_owner' }>
  | Readonly<{ ok: false; reason: 'io_error'; errorMessage: string }>;

export async function releaseSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  happyHomeDir?: string;
}>): Promise<ReleaseSessionRunnerLockResult> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  let existing: LockPayload | null = null;
  try {
    existing = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  if (!existing) return { ok: false, reason: 'not_owner' };
  if (existing.sessionId !== sessionId) return { ok: false, reason: 'not_owner' };
  if (existing.pid !== params.pid) return { ok: false, reason: 'not_owner' };
  if (existing.acquiredAtMs !== params.acquiredAtMs) return { ok: false, reason: 'not_owner' };

  try {
    await unlink(lockPath);
    return { ok: true };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

export type SessionRunnerLockStatus =
  | Readonly<{ ok: true; lock: LockPayload }>
  | Readonly<{ ok: false; reason: 'invalid_session_id' | 'not_found' | 'invalid' | 'io_error'; errorMessage?: string }>;

export async function readSessionRunnerLockStatus(params: Readonly<{ sessionId: string; happyHomeDir?: string }>): Promise<SessionRunnerLockStatus> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return { ok: false, reason: 'invalid_session_id' };
  const happyHomeDir = String(params.happyHomeDir ?? configuration.happyHomeDir).trim();
  const lockPath = sessionRunnerLockPathForSessionId({ happyHomeDir, sessionId });
  if (!lockPath) return { ok: false, reason: 'invalid_session_id' };

  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = safeParseLockPayload(raw);
    if (!parsed) return { ok: false, reason: 'invalid' };
    if (parsed.sessionId !== sessionId) return { ok: false, reason: 'invalid' };
    return { ok: true, lock: parsed };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }
}
