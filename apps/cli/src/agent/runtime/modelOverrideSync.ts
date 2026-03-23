import type { Metadata } from '@/api/types';

import { computePendingModelOverrideApplication } from './permission/permissionModeFromMetadata';

export function createModelOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionModel: (modelId: string) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  let lastAppliedUpdatedAt = 0;
  let pending: { modelId: string; updatedAt: number } | null = null;
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

    applyingPromise = params.runtime
      .setSessionModel(next.modelId)
      .then(() => {
        // Only mark as applied after a successful runtime update so failures can be retried.
        lastAppliedUpdatedAt = next.updatedAt;
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
    const next = computePendingModelOverrideApplication({
      metadata: snapshot,
      lastAppliedUpdatedAt,
    });
    if (!next) return;

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
