import type { SessionLifecycleStateReason } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { MachineAccessLossCustodyResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';

import { logger } from '@/ui/logger';
import type { LiveWorkItemV1 } from '../lifecycle/managedActivity';
import type { TrackedSession } from '../types';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from './stopSessionContract';

type SessionEndOutcome = 'ended' | 'retained' | 'incomplete';

/** Closed codes only; exception text may carry paths or content. */
const readCauseCode = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
};

/**
 * Ends a withdrawn person's Sessions on this Machine at their natural boundary.
 * The Home's access-loss dispatch is the decision; this owner only waits for an
 * admitted turn to finish before using the ordinary Stop path. An idle Session
 * ends at once. A Session whose turn was still running is ended when it settles,
 * unless one read of the Home's answer at that boundary shows access was restored.
 * No polling or timer: the runner's own live-work pushes wake the wait.
 * Withdrawal also retires the person's requester authority on this Machine, so
 * neither the boundary read nor the Stop may depend on it (live finding 11-20).
 */
export function createRequesterSessionAccessLossEnd(
  ports: Readonly<{
    serverId: string;
    readSessions(): Iterable<TrackedSession>;
    /** The daemon's live-work producer: the runner's own pushed work, read without requester authority. */
    readLiveWorkItems(): Promise<readonly LiveWorkItemV1[]>;
    /** Wakes on that runner's live-work change or a process-set change. */
    subscribeLiveWork(sessionId: string, listener: () => void): () => void;
    /** The Home's current answer for this requester's access, read once at a deferred boundary. */
    isRequesterAccessCurrent(
      tracked: TrackedSession,
      signal: AbortSignal,
    ): Promise<boolean>;
    /** The ordinary Stop owner for this exact runner; it borrows requester authority only where it remains. */
    stopSession(tracked: TrackedSession, reason: SessionLifecycleStateReason): Promise<StopSessionResult>;
    /** Admitted turns outlive the access-loss RPC; only daemon shutdown cancels the wait. */
    lifetimeSignal: AbortSignal;
  }>,
) {
  // A reconnect census can re-dispatch the same loss while a turn is still running.
  const pending = new Map<string, Promise<SessionEndOutcome>>();
  // The same Session may move to a successor runner object; follow the Session, not the object.
  const readTracked = (sessionId: string, accountId: string) => [...ports.readSessions()].find(candidate =>
    candidate.happySessionId === sessionId
    && (candidate.requesterWorkAttributionV1 ?? candidate.spawnOptions?.requesterWorkAttributionV1)?.accountId === accountId);
  const reachedBoundary = (items: readonly LiveWorkItemV1[], tracked: TrackedSession) => {
    const state = (category: LiveWorkItemV1['category']) =>
      items.find(item => item.ownerRef === tracked && item.category === category)?.state;
    return state('session') === 'settled' && state('input') !== 'active' && state('agents') !== 'active';
  };
  const incomplete = (sessionId: string, phase: string, reason?: string): SessionEndOutcome => {
    logger.warn('[DAEMON RUN] Access-loss Session end incomplete', { sessionId, phase, ...(reason ? { reason } : {}) });
    return 'incomplete';
  };

  const endAtBoundary = async (sessionId: string, accountId: string): Promise<SessionEndOutcome> => {
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
        if (signal.aborted) return incomplete(sessionId, 'boundary', 'daemon_stopping');
        changed = false;
        const items = await ports.readLiveWorkItems().catch((): readonly LiveWorkItemV1[] => []);
        const tracked = readTracked(sessionId, accountId);
        if (!tracked) return 'ended';
        if (reachedBoundary(items, tracked)) break;
        if (!waited) logger.infoFile('[DAEMON RUN] Access-loss Session end waits for its turn', { sessionId });
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
    const atBoundary = readTracked(sessionId, accountId);
    if (!atBoundary) return 'ended';
    if (waited && (await ports.isRequesterAccessCurrent(atBoundary, signal).catch(() => false))) return 'retained';
    if (signal.aborted) return incomplete(sessionId, 'stop', 'daemon_stopping');
    let result: StopSessionResult;
    try { result = await ports.stopSession(atBoundary, 'machine_access_withdrawn'); }
    catch (error) { return incomplete(sessionId, 'stop', readCauseCode(error)); }
    return isTerminalHostPhysicallyRetiredStopResult(result) || result.status === 'not_found'
      ? 'ended'
      : incomplete(sessionId, 'stop', result.status === 'incomplete' ? result.reason : result.status);
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
      let end = pending.get(sessionId);
      if (!end) {
        end = endAtBoundary(sessionId, attribution.accountId)
          .catch((error: unknown) => incomplete(sessionId, 'boundary', readCauseCode(error)));
        pending.set(sessionId, end);
        void end.then(() => { pending.delete(sessionId); });
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
