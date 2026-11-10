import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';

import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

/** Subscription membership only; binding policy and custody remain Collection-owned. */
export function createOutwardBindingObservation(
  context: BackgroundServiceContext,
  changed: (bindingIds: readonly string[]) => void,
) {
  const sessions = new Map<string, { bindingIds: Set<string>; activityBindings: Set<string>; activity?: 'active' | 'idle' | 'stopped'; dispose(): void }>();
  const discussions = new Map<string, Set<string>>();
  let discussionObservation: { dispose(): void } | undefined;
  return {
    async observe(sessionId: string, bindingId: string, observeActivity = false) {
      const existing = sessions.get(sessionId);
      if (existing) {
        existing.bindingIds.add(bindingId);
        if (observeActivity) existing.activityBindings.add(bindingId);
        else existing.activityBindings.delete(bindingId);
        return;
      }
      const session = await context.services.sessions.get(sessionId, { signal: context.signal });
      // Bindings can share a Session and complete their lookups concurrently.
      const incumbent = sessions.get(sessionId);
      if (incumbent) {
        incumbent.bindingIds.add(bindingId);
        if (observeActivity) incumbent.activityBindings.add(bindingId);
        return;
      }
      if (session === null || context.signal.aborted) return;
      const bindingIds = new Set([bindingId]);
      const activityBindings = new Set(observeActivity ? [bindingId] : []);
      const invalidate = () => changed([...bindingIds]);
      const observation = session.watch(event => {
        if (event.kind === 'activity') {
          const current = sessions.get(sessionId);
          if (current?.activity === event.activity.state) return;
          if (current) current.activity = event.activity.state;
          if (activityBindings.size > 0) changed([...activityBindings]);
          return;
        }
        invalidate();
      });
      // Input publication can settle after the Session's transcript arrival.
      // Its producer-set Session selector wakes only the same bound consumers.
      const inputs = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION).watch({
        index: CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1,
        prefix: [sessionId, CHANNEL_STATE_RECORD_KIND.ingressObligation],
        order: 'asc',
      }, invalidate);
      sessions.set(sessionId, { bindingIds, activityBindings, dispose() { observation.dispose(); inputs.dispose(); } });
    },
    activity(sessionId: string) { return sessions.get(sessionId)?.activity; },
    observeDiscussion(discussionId: string, bindingId: string) {
      const bindingIds = discussions.get(discussionId) ?? new Set<string>();
      bindingIds.add(bindingId);
      discussions.set(discussionId, bindingIds);
      discussionObservation ??= context.services.events.host.subscribe({
        eventId: '@happier/session/discussion-invalidated', scope: { kind: 'account' },
      }, event => {
        const affected = discussions.get(event.payload.discussionId);
        if (affected !== undefined) changed([...affected]);
      });
    },
    reconcile(observedBindings: ReadonlyMap<string, string>, observedDiscussions: ReadonlyMap<string, string>) {
      for (const [sessionId, observation] of sessions) {
        for (const bindingId of observation.bindingIds) {
          if (observedBindings.get(bindingId) !== sessionId) {
            observation.bindingIds.delete(bindingId);
            observation.activityBindings.delete(bindingId);
          }
        }
        if (observation.bindingIds.size === 0) { observation.dispose(); sessions.delete(sessionId); }
      }
      for (const [discussionId, bindingIds] of discussions) {
        for (const bindingId of bindingIds) {
          if (observedDiscussions.get(bindingId) !== discussionId) bindingIds.delete(bindingId);
        }
        if (bindingIds.size === 0) discussions.delete(discussionId);
      }
      if (discussions.size === 0) { discussionObservation?.dispose(); discussionObservation = undefined; }
    },
    dispose() {
      for (const observation of sessions.values()) observation.dispose();
      sessions.clear();
      discussions.clear();
      discussionObservation?.dispose();
      discussionObservation = undefined;
    },
  };
}
