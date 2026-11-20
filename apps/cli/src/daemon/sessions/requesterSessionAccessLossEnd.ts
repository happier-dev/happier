import type { MachineAccessLossCustodyResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';

import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import type { TrackedSession } from '../types';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from './stopSessionContract';

type SessionEndOutcome = 'ended' | 'retained' | 'incomplete';

/**
 * Ends a withdrawn person's Sessions on this Machine at their natural boundary.
 * The Home's access-loss dispatch is the decision; this owner only waits for an
 * admitted turn to finish before using the ordinary Stop path. An idle Session
 * ends at once. A Session whose turn was still running is ended when it settles,
 * unless one read of the Home's answer at that boundary shows access was restored.
 * No polling or timer: the runner's own live-work pushes wake the wait.
 */
export function createRequesterSessionAccessLossEnd(
  ports: Readonly<{
    serverId: string;
    readSessions(): Iterable<TrackedSession>;
    /** The runner process reports its own live work. */
    readLiveWork(
      tracked: TrackedSession,
      signal: AbortSignal,
    ): Promise<SessionInputLiveWork>;
    /** Wakes on that runner's live-work change or a process-set change. */
    subscribeLiveWork(sessionId: string, listener: () => void): () => void;
    /** The Home's current answer for this requester's access, read once at a deferred boundary. */
    isRequesterAccessCurrent(
      tracked: TrackedSession,
      signal: AbortSignal,
    ): Promise<boolean>;
    /** The ordinary Stop owner for this exact runner, with the requester's metadata authority. */
    stopSession(tracked: TrackedSession): Promise<StopSessionResult>;
    /** Admitted turns outlive the access-loss RPC; only daemon shutdown cancels the wait. */
    lifetimeSignal: AbortSignal;
  }>,
) {
  // A reconnect census can re-dispatch the same loss while a turn is still running.
  const pending = new WeakMap<TrackedSession, Promise<SessionEndOutcome>>();
  const isTracked = (tracked: TrackedSession) =>
    [...ports.readSessions()].includes(tracked);
  const reachedBoundary = (work: SessionInputLiveWork) =>
    work.session === 'settled' &&
    work.input !== 'active' &&
    work.agents !== 'active';

  const endAtBoundary = async (
    tracked: TrackedSession,
    sessionId: string,
  ): Promise<SessionEndOutcome> => {
    const signal = ports.lifetimeSignal;
    let changed = false;
    let wake: (() => void) | null = null;
    const unsubscribe = ports.subscribeLiveWork(sessionId, () => {
      changed = true;
      wake?.();
    });
    const onAbort = () => wake?.();
    signal.addEventListener('abort', onAbort, { once: true });
    let waited = false;
    try {
      for (;;) {
        if (signal.aborted) return 'incomplete';
        if (!isTracked(tracked)) return 'ended';
        changed = false;
        const work = await ports
          .readLiveWork(tracked, signal)
          .catch((): SessionInputLiveWork => ({
            session: 'unknown',
            input: 'unknown',
          }));
        if (!isTracked(tracked)) return 'ended';
        if (reachedBoundary(work)) break;
        waited = true;
        if (!changed)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = null;
      }
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    }
    // The Home decided withdrawal at dispatch. Only a turn that outlived that
    // decision asks it once more, so restored access keeps the Session.
    if (
      waited &&
      (await ports.isRequesterAccessCurrent(tracked, signal).catch(() => false))
    )
      return 'retained';
    if (signal.aborted) return 'incomplete';
    if (!isTracked(tracked)) return 'ended';
    const result = await ports
      .stopSession(tracked)
      .catch((): StopSessionResult => ({
        status: 'incomplete',
        reason: 'runner_signal_incomplete',
      }));
    return isTerminalHostPhysicallyRetiredStopResult(result) ||
      result.status === 'not_found'
      ? 'ended'
      : 'incomplete';
  };

  return async (
    input: Readonly<{
      requesterAccountId: string;
      machineId: string;
      installationId: string;
      signal: AbortSignal;
    }>,
  ): Promise<MachineAccessLossCustodyResponseV1> => {
    const ends: Promise<SessionEndOutcome>[] = [];
    for (const tracked of ports.readSessions()) {
      const attribution =
        tracked.requesterWorkAttributionV1 ??
        tracked.spawnOptions?.requesterWorkAttributionV1;
      const sessionId = tracked.happySessionId;
      if (
        !sessionId ||
        !attribution ||
        attribution.accountId !== input.requesterAccountId ||
        attribution.serverId !== ports.serverId ||
        attribution.machineId !== input.machineId ||
        attribution.installationId !== input.installationId
      )
        continue;
      let end = pending.get(tracked);
      if (!end) {
        end = endAtBoundary(tracked, sessionId).catch((): SessionEndOutcome => 'incomplete');
        pending.set(tracked, end);
        void end.then((outcome) => {
          if (outcome !== 'ended') pending.delete(tracked);
        });
      }
      ends.push(end);
    }
    if (ends.length === 0) return { kind: 'settled' };
    // The access-loss RPC reports what has settled; a running turn keeps its own end.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (input.signal.aborted) resolve('aborted');
      else
        input.signal.addEventListener('abort', () => resolve('aborted'), {
          once: true,
        });
    });
    const outcomes = await Promise.race([Promise.all(ends), aborted]);
    return outcomes !== 'aborted' &&
      outcomes.every((outcome) => outcome !== 'incomplete')
      ? { kind: 'settled' }
      : { kind: 'incomplete' };
  };
}
