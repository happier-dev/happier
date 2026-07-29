import type { Metadata } from '@/api/types';
import type {
  ProviderBoundModelRef,
  SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';

import { computePendingModelSelectionIntentApplication } from './permissions/modeFromMetadata';

export function createModelTransitionMetadataObserver(params: Readonly<{
  agentTargetKey: string;
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionModelSelection: (selection: ProviderBoundModelRef) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  let lastObservedUpdatedAt = 0;
  let pendingBeforeStart: SessionModelSelectionIntentV1 | null = null;
  const delegatedTransitions = new Set<Promise<void>>();

  const delegateToTransitionOwner = (
    next: SessionModelSelectionIntentV1,
  ): void => {
    lastObservedUpdatedAt = Math.max(lastObservedUpdatedAt, next.updatedAt);
    pendingBeforeStart = null;
    if (next.selection === null) return;

    let transition: Promise<void>;
    try {
      transition = params.runtime.setSessionModelSelection(next.selection);
    } catch {
      return;
    }
    let tracked!: Promise<void>;
    tracked = transition
      .catch(() => undefined)
      .finally(() => {
        delegatedTransitions.delete(tracked);
      });
    delegatedTransitions.add(tracked);
  };

  const syncFromMetadata = (): void => {
    const snapshot = params.session.getMetadataSnapshot();
    const next = computePendingModelSelectionIntentApplication({
      metadata: snapshot,
      agentTargetKey: params.agentTargetKey,
      lastAppliedUpdatedAt: lastObservedUpdatedAt,
    });
    if (!next) return;

    if (next.selection === null) {
      lastObservedUpdatedAt = next.updatedAt;
      pendingBeforeStart = null;
      return;
    }

    if (!params.isStarted()) {
      lastObservedUpdatedAt = next.updatedAt;
      pendingBeforeStart = next;
      return;
    }

    delegateToTransitionOwner(next);
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (!params.isStarted()) return;
    if (pendingBeforeStart) {
      delegateToTransitionOwner(pendingBeforeStart);
    }
    while (delegatedTransitions.size > 0) {
      await Promise.all([...delegatedTransitions]);
    }
  };

  return { syncFromMetadata, flushPendingAfterStart };
}
