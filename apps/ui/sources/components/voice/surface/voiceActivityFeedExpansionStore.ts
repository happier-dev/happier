import { useSyncExternalStore } from 'react';

type ExpansionSnapshot = Readonly<{
  attemptId: string | null;
  expanded: boolean;
  handled: boolean;
  manuallySuppressed: boolean;
}>;

const DEFAULT_SNAPSHOT: ExpansionSnapshot = Object.freeze({
  attemptId: null,
  expanded: false,
  handled: false,
  manuallySuppressed: false,
});

let snapshot = DEFAULT_SNAPSHOT;
const listeners = new Set<() => void>();

function publish(next: ExpansionSnapshot): void {
  if (next.attemptId === snapshot.attemptId
    && next.expanded === snapshot.expanded
    && next.handled === snapshot.handled
    && next.manuallySuppressed === snapshot.manuallySuppressed) return;
  snapshot = Object.freeze(next);
  for (const listener of [...listeners]) listener();
}

export function getVoiceActivityFeedExpansionSnapshot(): ExpansionSnapshot {
  return snapshot;
}

export function subscribeToVoiceActivityFeedExpansion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceActivityFeedExpansion(): ExpansionSnapshot {
  return useSyncExternalStore(
    subscribeToVoiceActivityFeedExpansion,
    getVoiceActivityFeedExpansionSnapshot,
    getVoiceActivityFeedExpansionSnapshot,
  );
}

export function reconcileVoiceActivityFeedExpansion(input: Readonly<{
  attemptId: string | null;
  feedEnabled: boolean;
  autoExpand: boolean;
}>): void {
  if (input.attemptId === null) {
    if (!input.feedEnabled && snapshot.expanded) publish({ ...snapshot, expanded: false });
    return;
  }
  if (snapshot.attemptId !== input.attemptId) {
    publish({
      attemptId: input.attemptId,
      expanded: input.feedEnabled && input.autoExpand,
      handled: true,
      manuallySuppressed: false,
    });
    return;
  }
  if (!input.feedEnabled && snapshot.expanded) publish({ ...snapshot, expanded: false });
}

export function toggleVoiceActivityFeedExpansion(): void {
  publish({
    ...snapshot,
    expanded: !snapshot.expanded,
    manuallySuppressed: snapshot.expanded ? true : snapshot.manuallySuppressed,
  });
}

export function resetVoiceActivityFeedExpansionForTests(): void {
  snapshot = DEFAULT_SNAPSHOT;
  for (const listener of [...listeners]) listener();
}
