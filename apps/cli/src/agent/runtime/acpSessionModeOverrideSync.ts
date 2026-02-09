import type { Metadata } from '@/api/types';

import { computePendingAcpSessionModeOverrideApplication } from './permission/permissionModeFromMetadata';

export function createAcpSessionModeOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: { setSessionMode: (modeId: string) => Promise<void> };
  isStarted: () => boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
} {
  let lastAppliedUpdatedAt = 0;
  let pending: { modeId: string; updatedAt: number } | null = null;
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
        applying = false;
        if (pending && pending.updatedAt > lastAppliedUpdatedAt && params.isStarted()) {
          applyPendingIfPossible();
        }
      });
  };

  const syncFromMetadata = (): void => {
    const next = computePendingAcpSessionModeOverrideApplication({
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
      await params.runtime.setSessionMode(next.modeId);
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
