import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { configuration } from '@/configuration';

import { findHappyProcessByPid } from './doctor';
import {
  processGenerationMatches,
  processGenerationProvesReuse,
  readProcessIdentityByPid,
} from './processIdentity';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from './processRunState';
import { hashProcessCommand } from './sessionRegistry';

type LockPayload = Readonly<{
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  processCommandHash?: string;
  processStartTimeMs?: number;
  processInstanceFingerprint?: string;
}>;

type ProcessExitEmitter = Readonly<{
  once: (event: 'exit', listener: () => void) => unknown;
  off: (event: 'exit', listener: () => void) => unknown;
}>;

export type SessionRunnerProcessPresence = 'absent' | 'present' | 'recoverable_stopped' | 'unknown';

export type SessionRunnerProcessInstanceFingerprintReader = (
  pid: number,
  expectedFingerprint: string,
) => string | null;

function isValidProcessCommandHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Canonical lock-holder evidence decision shared by acquisition and resume fencing. */
export function classifySessionRunnerProcessPresence(params: Readonly<{
  runState: ProcessRunState | null;
  storedProcessStartTimeMs?: number;
  observedProcessStartTimeMs?: number;
  storedProcessInstanceFingerprint?: string;
  observedProcessInstanceFingerprint?: string;
  storedProcessCommandHash?: string;
  observedProcessCommandHash?: string;
}>): SessionRunnerProcessPresence {
  if (params.runState === 'dead' || params.runState === 'zombie') return 'absent';
  if (params.runState === null) return 'unknown';

  if (processGenerationProvesReuse(params.storedProcessStartTimeMs, params.observedProcessStartTimeMs)) {
    return 'absent';
  }
  const storedFingerprint = String(params.storedProcessInstanceFingerprint ?? '').trim();
  const observedFingerprint = String(params.observedProcessInstanceFingerprint ?? '').trim();
  if (storedFingerprint && observedFingerprint && storedFingerprint !== observedFingerprint) {
    return 'absent';
  }

  if (params.runState !== 'stopped') return 'present';
  if (processGenerationMatches(params.storedProcessStartTimeMs, params.observedProcessStartTimeMs)) {
    return 'recoverable_stopped';
  }
  if (storedFingerprint && observedFingerprint === storedFingerprint) {
    return 'recoverable_stopped';
  }
  if (
    isValidProcessCommandHash(params.storedProcessCommandHash)
    && params.observedProcessCommandHash === params.storedProcessCommandHash
  ) {
    return 'recoverable_stopped';
  }
  return 'unknown';
}

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

function killWedgedPidDefault(pid: number): void {
  // SIGKILL works on a SIGSTOPped process; this prevents a later SIGCONT from reviving a
  // wedged runner after its lock has been handed to a replacement.
  process.kill(pid, 'SIGKILL');
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
    const processStartTimeMsRaw = parsed?.processStartTimeMs;
    const processStartTimeMs = typeof processStartTimeMsRaw === 'number'
      && Number.isInteger(processStartTimeMsRaw)
      && processStartTimeMsRaw >= 0
      ? processStartTimeMsRaw
      : undefined;
    const processInstanceFingerprint = typeof parsed?.processInstanceFingerprint === 'string'
      ? parsed.processInstanceFingerprint.trim() || undefined
      : undefined;
    if (!sessionId) return null;
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return {
      sessionId,
      pid: Math.floor(pid),
      acquiredAtMs: Math.floor(acquiredAtMs),
      ...(processCommandHash ? { processCommandHash } : {}),
      ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
      ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
    };
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

function releaseSessionRunnerLockSync(params: Readonly<{
  lockPath: string;
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
}>): void {
  try {
    const existing = safeParseLockPayload(readFileSync(params.lockPath, 'utf8'));
    if (
      existing?.sessionId !== params.sessionId
      || existing.pid !== params.pid
      || existing.acquiredAtMs !== params.acquiredAtMs
    ) return;
    unlinkSync(params.lockPath);
  } catch {
    // Best-effort. A surviving lock is adjudicated by the stale-holder classifier.
  }
}

function createAcquiredSessionRunnerLock(params: Readonly<{
  happyHomeDir: string;
  lockPath: string;
  sessionId: string;
  pid: number;
  acquiredAtMs: number;
  processExitEmitter: ProcessExitEmitter;
}>): Extract<AcquireSessionRunnerLockResult, { ok: true }> {
  let released = false;
  const ownsCurrentProcess = params.pid === process.pid;
  const onProcessExit = (): void => {
    if (released) return;
    released = true;
    releaseSessionRunnerLockSync(params);
  };
  if (ownsCurrentProcess) params.processExitEmitter.once('exit', onProcessExit);

  return {
    ok: true,
    sessionId: params.sessionId,
    pid: params.pid,
    acquiredAtMs: params.acquiredAtMs,
    lockPath: params.lockPath,
    release: async () => {
      if (released) return;
      released = true;
      if (ownsCurrentProcess) params.processExitEmitter.off('exit', onProcessExit);
      await releaseSessionRunnerLock({
        happyHomeDir: params.happyHomeDir,
        sessionId: params.sessionId,
        pid: params.pid,
        acquiredAtMs: params.acquiredAtMs,
      }).catch(() => {});
    },
  };
}

export async function acquireSessionRunnerLock(params: Readonly<{
  sessionId: string;
  pid?: number;
  nowMs?: number;
  happyHomeDir?: string;
  readProcessRunState?: (pid: number) => Promise<ProcessRunState>;
  getCurrentProcessCommandHash?: (pid: number) => Promise<string | null>;
  readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  killWedgedPid?: (pid: number) => void;
  processExitEmitter?: ProcessExitEmitter;
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
  const readProcessIdentity = params.readProcessIdentityByPid ?? readProcessIdentityByPid;
  const processIdentity = await readProcessIdentity(pid).catch(() => null);
  const processStartTimeMs = Number.isInteger(processIdentity?.processStartTimeMs)
    && (processIdentity?.processStartTimeMs ?? -1) >= 0
    ? processIdentity!.processStartTimeMs
    : undefined;

  const payload: LockPayload = {
    sessionId,
    pid,
    acquiredAtMs: nowMs,
    ...(processCommandHash ? { processCommandHash } : {}),
    ...(processStartTimeMs !== undefined ? { processStartTimeMs } : {}),
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const processExitEmitter = params.processExitEmitter ?? process;

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
      return createAcquiredSessionRunnerLock({
        happyHomeDir,
        lockPath,
        sessionId,
        pid,
        acquiredAtMs: nowMs,
        processExitEmitter,
      });
    }
  } catch (e) {
    return { ok: false, reason: 'io_error', errorMessage: e instanceof Error ? e.message : String(e) };
  }

  // Existing lock. If it's held by a live servable Happy session process, deny; otherwise break stale and retry once.
  let existing: LockPayload | null = null;
  try {
    existing = safeParseLockPayload(await readFile(lockPath, 'utf8'));
  } catch {
    existing = null;
  }

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const killWedgedPid = params.killWedgedPid ?? killWedgedPidDefault;
  const readProcessInstanceFingerprint = params.readProcessInstanceFingerprint
    ?? ((pidToRead, expectedFingerprint) => readProcessInstanceFingerprintSync(pidToRead, { expectedFingerprint }));
  const readHolderRunState = async (pid: number): Promise<ProcessRunState> =>
    await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');

  if (existing && existing.sessionId !== sessionId) {
    if (existing.pid && (await readHolderRunState(existing.pid)) !== 'dead') {
      return { ok: false, reason: 'already_running', heldByPid: existing.pid };
    }
    // payload mismatch but process isn't alive: treat as stale/invalid and overwrite.
    existing = null;
  }

  if (existing?.pid) {
    const holderState = await readHolderRunState(existing.pid);
    const shouldReadIdentity = holderState !== 'dead' && holderState !== 'zombie'
      && existing.processStartTimeMs !== undefined;
    const observedIdentity = shouldReadIdentity
      ? await readProcessIdentity(existing.pid).catch(() => null)
      : null;
    const observedFingerprint = existing.processInstanceFingerprint
      && holderState !== 'dead' && holderState !== 'zombie'
      ? readProcessInstanceFingerprint(existing.pid, existing.processInstanceFingerprint)
      : null;
    const observedCommandHash = holderState === 'stopped'
      && existing.processStartTimeMs === undefined
      && !existing.processInstanceFingerprint
      ? await getCurrentProcessCommandHash(existing.pid).catch(() => null)
      : null;
    const presence = classifySessionRunnerProcessPresence({
      runState: holderState,
      storedProcessStartTimeMs: existing.processStartTimeMs,
      observedProcessStartTimeMs: observedIdentity?.processStartTimeMs,
      storedProcessInstanceFingerprint: existing.processInstanceFingerprint,
      observedProcessInstanceFingerprint: observedFingerprint ?? undefined,
      storedProcessCommandHash: existing.processCommandHash,
      observedProcessCommandHash: observedCommandHash ?? undefined,
    });

    if (presence === 'recoverable_stopped') {
      try {
        killWedgedPid(existing.pid);
      } catch {
        return { ok: false, reason: 'already_running', heldByPid: existing.pid };
      }
    } else if (presence !== 'absent') {
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
    return createAcquiredSessionRunnerLock({
      happyHomeDir,
      lockPath,
      sessionId,
      pid,
      acquiredAtMs: nowMs,
      processExitEmitter,
    });
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
