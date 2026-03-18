import type { Metadata } from '@/api/types';

import { computePendingSessionModeOverrideApplication } from './permission/permissionModeFromMetadata';

export function createSessionModeOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionMode: (modeId: string) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  let lastAppliedUpdatedAt = 0;
  let pending: { modeId: string; updatedAt: number } | null = null;
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
      .setSessionMode(next.modeId)
      .then(() => {
        // Only advance lastAppliedUpdatedAt on success so failures can retry.
        lastAppliedUpdatedAt = next.updatedAt;
        if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
      })
      .catch(() => {
        // Best-effort only. Keep `pending` so next sync can retry.
      })
      .finally(() => {
        applyingPromise = null;
        if (pending && pending.updatedAt > next.updatedAt && params.isStarted()) {
          void applyPendingIfPossible();
        }
      });

    return applyingPromise;
  };

  const syncFromMetadata = (): void => {
    const snapshot = params.session.getMetadataSnapshot();
    const next = computePendingSessionModeOverrideApplication({
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

export const createAcpSessionModeOverrideSynchronizer = createSessionModeOverrideSynchronizer;
