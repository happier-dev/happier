import type { TrackedSession } from '../types';
import { readSessionRunnerLockStatus, type SessionRunnerLockStatus } from '../sessionRunnerLock';

import { findHappyProcessByPid } from '../doctor';
import { hashProcessCommand } from '../sessionRegistry';

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getProcessCommandHashDefault(pid: number): Promise<string | null> {
  const proc = await findHappyProcessByPid(pid).catch(() => null);
  if (!proc?.command) return null;
  return hashProcessCommand(proc.command);
}

function trackedSessionMatchesSessionId(tracked: TrackedSession, sessionId: string): boolean {
  const trackedHappySessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  const trackedExistingSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  return trackedHappySessionId === sessionId || trackedExistingSessionId === sessionId;
}

function isValidCommandHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function isLockActive(params: {
  sessionId: string;
  isPidAlive: (pid: number) => boolean;
  getProcessCommandHash: (pid: number) => Promise<string | null>;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<boolean> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status || !status.ok) return false;

  const pid = status.lock.pid;
  if (!params.isPidAlive(pid)) return false;

  if (isValidCommandHash(status.lock.processCommandHash)) {
    const currentHash = await params.getProcessCommandHash(pid).catch(() => null);
    // Fail-closed: do not treat a lock as stale based solely on a command hash mismatch.
    // Command-line reads can be truncated or inconsistent across platforms. A false mismatch
    // could allow a duplicate runner to start for the same session.
  }

  // Fail-closed: a lock with a live PID is treated as active unless we can prove it's stale.
  return true;
}

async function isTrackedSessionActive(params: {
  sessionId: string;
  tracked: TrackedSession;
  isPidAlive: (pid: number) => boolean;
  getProcessCommandHash: (pid: number) => Promise<string | null>;
}): Promise<boolean> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return false;

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;

  if (!params.isPidAlive(pidToCheck)) return false;

  // If the daemon has a live ChildProcess handle, treat the runner as active even if process inspection is flaky.
  // This avoids spawning duplicates due to transient ps/command-line inspection failures.
  if (childPid) return true;

  // If we have a command hash, require it to match when we can read the current command.
  // If we cannot inspect the current command, fail-closed (treat as active) to prevent duplicates.
  if (isValidCommandHash(params.tracked.processCommandHash)) {
    const currentHash = await params.getProcessCommandHash(pidToCheck).catch(() => null);
    // Fail-closed: do not treat a tracked session as inactive based solely on a command hash mismatch.
    // This avoids spawning duplicates due to transient/partial command-line inspection.
  }

  return true;
}

export async function isSessionRunnerActive(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  isPidAlive?: (pid: number) => boolean;
  getProcessCommandHash?: (pid: number) => Promise<string | null>;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const isPidAlive = params.isPidAlive ?? isPidAliveDefault;
  const getProcessCommandHash = params.getProcessCommandHash ?? getProcessCommandHashDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of params.trackedSessions) {
    if (await isTrackedSessionActive({ sessionId, tracked, isPidAlive, getProcessCommandHash })) return true;
  }

  return await isLockActive({ sessionId, isPidAlive, getProcessCommandHash, readSessionRunnerLockStatus: readLockStatus });
}
