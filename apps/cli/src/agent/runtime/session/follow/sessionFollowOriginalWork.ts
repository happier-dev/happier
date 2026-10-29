import { deriveSessionFollowOriginalOccurrenceKeyV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';

type Original = Extract<SessionFollowInputV1['original'], { sourceSessionId: string }>;
type Work = { original: Original; revision?: number; state: 'running' | 'held' | 'settled' | 'admitted';
  waitingFor?: 'source' | 'receiver'; sourceAvailable?: true; receiverAvailable?: true; rulesChanged?: true };

function isReleased(work: Work) {
  return work.state === 'settled' ? work.rulesChanged === true
    : work.state === 'held' && (work.rulesChanged === true || work.receiverAvailable === true
      || work.waitingFor === 'source' && work.sourceAvailable === true);
}

/** Scheduling custody for unconsumed originals, not source facts or delivery ACKs. */
export function createSessionFollowOriginalWork() {
  // Both indices reference the same per-pair work, never copied custody.
  const receivers = new Map<string, Map<string, Map<string, Work>>>();
  const sources = new Map<string, Map<string, Map<string, Work>>>();
  const keyOf = (original: Original) => deriveSessionFollowOriginalOccurrenceKeyV1(original);
  function* receiverWork(receiver: string) {
    for (const work of receivers.get(receiver)?.values() ?? []) yield* work.values();
  }
  const clear = () => { receivers.clear(); sources.clear(); };
  return {
    state(receiver: string, original: Original) {
      const key = keyOf(original);
      const work = key === null ? undefined : receivers.get(receiver)?.get(original.sourceSessionId)?.get(key);
      return work && !isReleased(work) ? work.state : undefined;
    },
    /** Any unfinished original can retry when its receiver's availability changes. */
    hasHeldReceiver(receiver: string) {
      for (const work of receiverWork(receiver)) {
        if (work.state === 'running' || work.state === 'held') return true;
      }
      return false;
    },
    start(receiver: string, original: Original, revision?: number) {
      const key = keyOf(original);
      if (key === null) return null;
      const source = original.sourceSessionId;
      let bySource = receivers.get(receiver);
      if (!bySource) { bySource = new Map(); receivers.set(receiver, bySource); }
      let work = bySource.get(source);
      if (!work) {
        work = new Map(); bySource.set(source, work);
        let byReceiver = sources.get(source);
        if (!byReceiver) { byReceiver = new Map(); sources.set(source, byReceiver); }
        byReceiver.set(receiver, work);
      }
      const previous = work.get(key);
      // A committed revision is a changed original, unlike another source's
      // arrival, a new sibling original, or an unchanged recovery pass.
      if (previous && !isReleased(previous) && (revision === undefined || previous.revision === revision)) return null;
      const next: Work = { original, ...(revision === undefined ? {} : { revision }), state: 'running' };
      work.set(key, next);
      return (outcome: 'held' | 'settled' | 'admitted', waitingFor: 'source' | 'receiver' = 'source') => {
        if (work.get(key) === next) { next.state = outcome; next.waitingFor = waitingFor; }
      };
    },
    available(receiver: string) {
      // Retain released demand through this push's other subscribers. The next
      // start consumes it once, including a push received before evaluation ends.
      for (const item of receiverWork(receiver)) {
        if (item.state === 'running' || item.state === 'held') item.receiverAvailable = true;
      }
    },
    rangeAvailable(receiver: string) {
      // Source-range/progress demand cannot prove receiver availability. A
      // failed admission stays held even when another source extends the range.
      for (const item of receiverWork(receiver)) {
        if (item.state === 'running' || item.state === 'held') item.sourceAvailable = true;
      }
    },
    sourceAvailable(sourceSessionId: string) {
      for (const work of sources.get(sourceSessionId)?.values() ?? []) for (const item of work.values()) {
        if (item.state === 'running' || item.state === 'held') {
          item.sourceAvailable = true;
        }
      }
    },
    observed(receiver: string, sourceSessionId: string, delivered: SessionFollowFrontierV1) {
      const bySource = receivers.get(receiver);
      const work = bySource?.get(sourceSessionId);
      for (const [key, item] of work ?? []) {
        const original = item.original;
        if (item.state === 'running') continue;
        if ('sourceMessage' in original ? original.sourceMessage.seq <= delivered.transcriptSeq
          : 'sourceRequests' in original ? original.sourceRequests.agentStateVersion <= delivered.agentStateVersion
          : delivered.turn?.id === original.sourceTurn.id && delivered.turn.status === original.sourceTurn.status) work!.delete(key);
      }
      if (work?.size === 0) {
        bySource!.delete(sourceSessionId);
        if (bySource!.size === 0) receivers.delete(receiver);
        const byReceiver = sources.get(sourceSessionId)!;
        byReceiver.delete(receiver);
        if (byReceiver.size === 0) sources.delete(sourceSessionId);
      }
    },
    changed(reset: boolean) {
      if (reset) { clear(); return; }
      // Real authoring changes may select a former miss. Already admitted
      // originals belong to Pending/Message custody, not another offer.
      for (const receiver of receivers.keys()) for (const item of receiverWork(receiver)) {
        if (item.state !== 'admitted') item.rulesChanged = true;
      }
    },
    dispose: clear,
  };
}
