import { randomUUID } from 'node:crypto';

import type { TrackedSession } from '../types';

/**
 * Daemon-issued identity of one tracked Session.
 *
 * Minted once when the daemon starts tracking a Session and stable for its
 * whole tracked life, so several Sessions hosted by one process never share a
 * key. The hosting process is a field of the tracked Session (`pid`), never
 * its identity. The key is file-name safe: it also names the Session marker.
 *
 * - `session-<uuid>`: minted for every Session the daemon starts tracking (a
 *   spawn hands it to the runner in the Session environment and the runner
 *   echoes it in its session-started report; a Session first learned of from
 *   its report gets a fresh one).
 * - `pid-<pid>`: a marker written by an earlier daemon that named markers by
 *   runner pid; the legacy file name is the key, so those markers keep working.
 */
export type SessionTrackingKey = string & { readonly __brand: 'SessionTrackingKey' };

/** Session environment variable carrying the spawn key to the runner. */
export const SESSION_TRACKING_KEY_ENV = 'HAPPIER_SESSION_TRACKING_KEY';

const TRACKING_KEY_PATTERN = /^(?:session|pid)-[A-Za-z0-9_-]{1,160}$/u;

export function parseSessionTrackingKey(value: unknown): SessionTrackingKey | null {
  return typeof value === 'string' && TRACKING_KEY_PATTERN.test(value)
    ? value as SessionTrackingKey
    : null;
}

export function mintSessionTrackingKey(): SessionTrackingKey {
  return `session-${randomUUID()}` as SessionTrackingKey;
}

export function legacyPidSessionTrackingKey(pid: number): SessionTrackingKey {
  return `pid-${Math.trunc(pid)}` as SessionTrackingKey;
}

export type TrackedSessionMap = Map<SessionTrackingKey, TrackedSession>;
export type ReadonlyTrackedSessionMap = ReadonlyMap<SessionTrackingKey, TrackedSession>;

/** Starts (or replaces) custody of a tracked Session under its own key. */
export function trackSession(trackedSessions: TrackedSessionMap, tracked: TrackedSession): void {
  trackedSessions.set(tracked.trackingKey, tracked);
}

/** True while this exact tracked object still owns its key. */
export function isCurrentTrackedSession(
  trackedSessions: ReadonlyTrackedSessionMap,
  tracked: TrackedSession | null | undefined,
): boolean {
  return tracked != null && trackedSessions.get(tracked.trackingKey) === tracked;
}

/** Ends custody of this exact tracked object; a successor under the same key is kept. */
export function untrackSession(trackedSessions: TrackedSessionMap, tracked: TrackedSession): boolean {
  if (trackedSessions.get(tracked.trackingKey) !== tracked) return false;
  return trackedSessions.delete(tracked.trackingKey);
}

/**
 * Every Session hosted by one tracked process. Process-addressed facts (exit,
 * census, wrapper correlation) reach Sessions only through this scan.
 */
export function trackedSessionsForProcess(
  trackedSessions: ReadonlyTrackedSessionMap,
  pid: number,
): TrackedSession[] {
  const hosted: TrackedSession[] = [];
  for (const tracked of trackedSessions.values()) {
    if (tracked.pid === pid) hosted.push(tracked);
  }
  return hosted;
}

/**
 * The single Session of a one-Session process (every runner today). Returns
 * null when the process hosts none, so a process-addressed caller never acts
 * on an arbitrary Session of a multi-Session host.
 */
export function trackedSessionForSingleSessionProcess(
  trackedSessions: ReadonlyTrackedSessionMap,
  pid: number,
): TrackedSession | undefined {
  const hosted = trackedSessionsForProcess(trackedSessions, pid);
  return hosted.length === 1 ? hosted[0] : undefined;
}

/**
 * The Session a fact addressed by (process, Session id) belongs to: the Session with that id
 * running in that process (as its tracked pid or its runner pid), else the process's only Session.
 * A session host runs several Sessions on one pid, so its pid alone never picks one of them.
 */
export function trackedSessionOnProcess(
  trackedSessions: ReadonlyTrackedSessionMap,
  pid: number,
  sessionId: string | null | undefined,
): TrackedSession | undefined {
  if (sessionId) {
    for (const tracked of trackedSessions.values()) {
      if ((tracked.pid === pid || tracked.sessionRunnerPid === pid) && tracked.happySessionId === sessionId) return tracked;
    }
  }
  return trackedSessionForSingleSessionProcess(trackedSessions, pid);
}
