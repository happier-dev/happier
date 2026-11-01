import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import type { TrackedSession } from '../types';
import type { LiveWorkItemV1, LiveWorkListenerV1, LiveWorkProducerV1 } from './managedActivity';
import type { createSpawnRequestCoalescer } from '../spawn/spawnRequestCoalescer';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { projectSessionLiveWorkItems } from '@/agent/runtime/session/input/sessionLiveWorkEligibility';

/** Queries the live host rather than deriving idle from a nullable turn marker or process presence. */
export function createSessionLiveWorkProducer(params: Readonly<{
  readSessions: () => readonly TrackedSession[];
  /** The daemon composition owns exact current requester-safe Session transport. */
  readActivity: (tracked: TrackedSession) => Promise<SessionInputLiveWork>;
  startup?: Pick<ReturnType<typeof createSpawnRequestCoalescer>, 'readInFlightRequests' | 'subscribeChanges'>;
}>): LiveWorkProducerV1 & Readonly<{ notifyChanged: LiveWorkListenerV1 }> {
  const listeners = new Set<LiveWorkListenerV1>();
  return {
    async read() {
      const sessions = params.readSessions();
      const observations = await Promise.all(sessions.map(async tracked => {
        const sessionId = tracked.happySessionId;
        let activity: SessionInputLiveWork = { session: 'unknown', input: 'unknown' };
        if (sessionId) {
          try { activity = await params.readActivity(tracked); } catch { /* Missing live coverage stays unknown. */ }
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
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribeStartup = params.startup?.subscribeChanges(listener);
      return () => { listeners.delete(listener); unsubscribeStartup?.(); };
    },
    notifyChanged(change) { for (const listener of listeners) listener(change); },
  };
}
