import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import type { TrackedSession } from '../types';
import type { LiveWorkItemV1, LiveWorkListenerV1, LiveWorkProducerV1 } from './managedActivity';
import type { createSpawnRequestCoalescer } from '../spawn/spawnRequestCoalescer';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { projectSessionLiveWorkItems } from '@/agent/runtime/session/input/sessionLiveWorkEligibility';

/** A runner's live work carried in its own `/session-activity-changed` push, ordered per runner process. */
export type PushedSessionLiveWork = Readonly<{ runnerPid: number; revision: number; activity: SessionInputLiveWork }>;

/** Queries the live host rather than deriving idle from a nullable turn marker or process presence. */
export function createSessionLiveWorkProducer(params: Readonly<{
  readSessions: () => readonly TrackedSession[];
  /** The daemon composition owns exact current requester-safe Session transport. */
  readActivity: (tracked: TrackedSession) => Promise<SessionInputLiveWork>;
  startup?: Pick<ReturnType<typeof createSpawnRequestCoalescer>, 'readInFlightRequests' | 'subscribeChanges'>;
}>): LiveWorkProducerV1 & Readonly<{
  notifyChanged: LiveWorkListenerV1;
  /**
   * A runner's change. Its pushed live work applies without a read; a content-free change, or a push
   * the daemon cannot attribute to the tracked runner process, is a gap that rereads that runner.
   */
  notifySessionChanged(sessionId: string | null, pushed?: PushedSessionLiveWork): void;
  subscribe(listener: LiveWorkListenerV1, sessionId?: string): () => void;
}> {
  const listeners = new Set<Readonly<{ listener: LiveWorkListenerV1; sessionId?: string }>>();
  // Runners push their live work after every change (`subscribeLiveWork` →
  // `/session-activity-changed`), which a passive refresh applies without a read. Content-free
  // pushes invalidate, and a passive refresh rereads only those runners; failed/unknown
  // observations are never retained.
  const retained = new WeakMap<TrackedSession, Readonly<{ sessionId: string; activity: SessionInputLiveWork; pushed?: true }>>();
  // Not cleared by reads: a delayed older push never replaces a newer one from the same process.
  const pushedRevisions = new WeakMap<TrackedSession, Readonly<{ runnerPid: number; revision: number }>>();
  const invalidatedSessionIds = new Set<string>();
  let invalidatedAll = true;
  const notifyListeners = (sessionId: string | null) => {
    for (const subscription of listeners) {
      if (sessionId === null || subscription.sessionId === undefined || subscription.sessionId === sessionId) {
        subscription.listener();
      }
    }
  };
  const invalidate = (sessionId: string | null) => {
    if (sessionId === null) invalidatedAll = true;
    else invalidatedSessionIds.add(sessionId);
    notifyListeners(sessionId);
  };
  return {
    async read(scope) {
      const sessions = params.readSessions();
      // Explicit confirmations and unattributed (structural) changes read every runner.
      const rereadAll = scope !== 'changed' || invalidatedAll;
      const invalidated = new Set(invalidatedSessionIds);
      invalidatedAll = false;
      invalidatedSessionIds.clear();
      const observations = await Promise.all(sessions.map(async tracked => {
        const sessionId = tracked.happySessionId;
        let activity: SessionInputLiveWork = { session: 'unknown', input: 'unknown' };
        if (sessionId) {
          const previous = retained.get(tracked);
          if (!rereadAll && previous?.sessionId === sessionId && !invalidated.has(sessionId)) {
            return { tracked, sessionId, activity: previous.activity };
          }
          retained.delete(tracked);
          try {
            const read = await params.readActivity(tracked);
            // A push that arrived during the read is at least as new as the reply.
            const pushed = retained.get(tracked);
            if (pushed?.pushed && pushed.sessionId === sessionId) activity = pushed.activity;
            else {
              activity = read;
              retained.set(tracked, { sessionId, activity });
            }
          } catch { /* Missing live coverage stays unknown. */ }
        }
        return { tracked, sessionId, activity };
      }));
      const observationBySession = new Map(observations.map(observation => [observation.tracked, observation]));
      // Reconcile the current process set after network reads: neither a retired
      // occurrence's reply nor an omitted new process can prove the successor idle.
      const sessionItems = params.readSessions().flatMap(tracked => {
        const observed = observationBySession.get(tracked);
        const activity: SessionInputLiveWork = observed && observed.sessionId === tracked.happySessionId
          ? observed.activity : { session: 'unknown' as const, input: 'unknown' as const };
        const attribution = tracked.requesterWorkAttributionV1 ?? { kind: 'unknown' as const };
        const metadata = tracked.happySessionMetadataFromLocalWebhook;
        const candidatePath = metadata?.path ?? tracked.spawnOptions?.directory;
        const machineId = tracked.requesterWorkAttributionV1?.machineId ?? metadata?.machineId;
        const workspacePath = candidatePath && machineId
          ? resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath }).machinePath
          : candidatePath;
        const workspace = workspacePath ? { workspacePath } : {};
        return projectSessionLiveWorkItems(activity).map(item => ({
          ...item, ownerRef: tracked, attribution, ...workspace,
        } satisfies LiveWorkItemV1));
      });
      const items: LiveWorkItemV1[] = [
        ...(params.startup?.readInFlightRequests() ?? []).map(ownerRef => ({
          category: 'setup' as const, ownerRef, attribution: { kind: 'unknown' as const }, state: 'active' as const,
        })),
        ...sessionItems,
      ];
      return { items, coverage: items.some(item => item.state === 'unknown') ? 'unknown' as const : 'complete' as const };
    },
    subscribe(listener, sessionId?: string) {
      const subscription = { listener, sessionId };
      listeners.add(subscription);
      const unsubscribeStartup = params.startup?.subscribeChanges(listener);
      return () => { listeners.delete(subscription); unsubscribeStartup?.(); };
    },
    /** Unattributed edges (process set, transport) reread every runner. */
    notifyChanged(change) {
      invalidatedAll = true;
      for (const { listener } of listeners) listener(change);
    },
    notifySessionChanged(sessionId, pushed) {
      const tracked = pushed && sessionId !== null ? params.readSessions().find(candidate =>
        candidate.happySessionId === sessionId && candidate.pid === pushed.runnerPid) : undefined;
      if (!pushed || !tracked || sessionId === null) {
        invalidate(sessionId);
        return;
      }
      const previous = pushedRevisions.get(tracked);
      if (previous?.runnerPid === pushed.runnerPid && previous.revision >= pushed.revision) return;
      pushedRevisions.set(tracked, { runnerPid: pushed.runnerPid, revision: pushed.revision });
      retained.set(tracked, { sessionId, activity: pushed.activity, pushed: true });
      notifyListeners(sessionId);
    },
  };
}
