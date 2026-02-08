import type { Metadata } from '@/api/types';

import { computePendingModelOverrideApplication } from './permissionModeFromMetadata';

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
  let applying = false;

  const applyPendingIfPossible = (): void => {
    if (applying) return;
    if (!pending) return;
    if (!params.isStarted()) return;

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) {
      pending = null;
      return;
    }

    applying = true;
    params.runtime
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
        applying = false;
        // If a newer override arrived while we were applying, attempt to apply it now.
        if (pending && pending.updatedAt > lastAppliedUpdatedAt && params.isStarted()) {
          applyPendingIfPossible();
        }
      });
  };

  const syncFromMetadata = (): void => {
    const next = computePendingModelOverrideApplication({
      metadata: params.session.getMetadataSnapshot(),
      lastAppliedUpdatedAt,
    });
    if (!next) return;

    if (!params.isStarted()) {
      pending = next;
      return;
    }

    pending = next;
    applyPendingIfPossible();
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    if (applying) return;
    if (!pending) return;
    if (!params.isStarted()) return;

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) return;

    applying = true;
    try {
      await params.runtime.setSessionModel(next.modelId);
      lastAppliedUpdatedAt = next.updatedAt;
      if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
    } catch {
      // Best-effort only.
    } finally {
      applying = false;
      if (pending && pending.updatedAt > lastAppliedUpdatedAt && params.isStarted()) {
        applyPendingIfPossible();
      }
    }
  };

  return { syncFromMetadata, flushPendingAfterStart };
}
