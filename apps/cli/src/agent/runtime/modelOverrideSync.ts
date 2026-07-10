import type { Metadata } from '@/api/types';
import type { SessionModelSelectionIntentV1 } from '@happier-dev/protocol';

import { computePendingModelSelectionIntentApplication } from './permissions/modeFromMetadata';

export function createModelOverrideSynchronizer(params: Readonly<{
  agentTargetKey: string;
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionModel: (modelId: string) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  let lastAppliedUpdatedAt = 0;
  let pending: SessionModelSelectionIntentV1 | null = null;
  let applyingPromise: Promise<void> | null = null;

  const applyPendingIfPossible = (): Promise<void> => {
    if (applyingPromise) return applyingPromise;
    if (!pending) return Promise.resolve();
    if (!params.isStarted()) return Promise.resolve();

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) {
      pending = null;
      return Promise.resolve();
    }
    if (next.selection === null) {
      lastAppliedUpdatedAt = next.updatedAt;
      pending = null;
      return Promise.resolve();
    }

    applyingPromise = params.runtime
      .setSessionModel(next.selection.modelId)
      .then(() => {
        // Only mark as applied after a successful runtime update so failures can be retried.
        lastAppliedUpdatedAt = Math.max(lastAppliedUpdatedAt, next.updatedAt);
        if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
      })
      .catch(() => {
        // Best-effort only. Keep `pending` so the next sync attempt can retry.
      })
      .finally(() => {
        applyingPromise = null;
        // If a newer override arrived while we were applying, attempt to apply it now.
        if (pending && pending.updatedAt > next.updatedAt && params.isStarted()) {
          void applyPendingIfPossible();
        }
      });

    return applyingPromise;
  };

  const syncFromMetadata = (): void => {
    const snapshot = params.session.getMetadataSnapshot();
    const next = computePendingModelSelectionIntentApplication({
      metadata: snapshot,
      agentTargetKey: params.agentTargetKey,
      lastAppliedUpdatedAt,
    });
    if (!next) return;

    if (next.selection === null) {
      lastAppliedUpdatedAt = next.updatedAt;
      pending = null;
      return;
    }

    if (!params.isStarted()) {
      pending = next;
      return;
    }

    pending = next;
    void applyPendingIfPossible();
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (!pending) return;
    if (!params.isStarted()) return;

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) return;
    await applyPendingIfPossible();
  };

  return { syncFromMetadata, flushPendingAfterStart };
}
