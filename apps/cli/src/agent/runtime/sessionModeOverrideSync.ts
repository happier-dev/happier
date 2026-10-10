import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import { computePendingSessionModeOverrideApplication } from './permission/permissionModeFromMetadata';

export function createSessionModeOverrideSynchronizer(params: Readonly<{
  session: { getMetadataSnapshot: () => Metadata | null };
  runtime: {
    setSessionMode: (modeId: string) => Promise<void>;
    clearSessionModeOverride?: () => Promise<void>;
  };
  isStarted: () => boolean;
  autoApplyFromMetadata?: boolean;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
  flushPendingAfterStartWithOutcome: () => Promise<boolean>;
  rebindSession: (session: { getMetadataSnapshot: () => Metadata | null }) => void;
} {
  let session = params.session;
  let lastAppliedUpdatedAt = 0;
  let pending: { modeId: string; updatedAt: number } | null = null;
  let applyingPromise: Promise<boolean> | null = null;
  let lastAttemptedUpdatedAt = 0;
  let lastAttemptNumber = 0;

  const applyPendingIfPossible = (): Promise<boolean> => {
    if (applyingPromise) return applyingPromise;
    if (!pending) return Promise.resolve(true);
    if (!params.isStarted()) return Promise.resolve(true);

    const next = pending;
    const attempt =
      next.updatedAt === lastAttemptedUpdatedAt
        ? lastAttemptNumber + 1
        : 1;
    if (next.updatedAt <= lastAppliedUpdatedAt) {
      pending = null;
      return Promise.resolve(true);
    }
    lastAttemptedUpdatedAt = next.updatedAt;
    lastAttemptNumber = attempt;
    logger.debug('[SessionModeOverrideSync] Applying session mode override', {
      modeId: next.modeId,
      updatedAt: next.updatedAt,
      attempt,
    });

    // Runtimes without a clear hook preserve their existing provider policy.
    const apply = next.modeId === ''
      ? params.runtime.clearSessionModeOverride?.() ?? Promise.resolve()
      : params.runtime.setSessionMode(next.modeId);
    applyingPromise = apply
      .then(() => {
        // Only advance lastAppliedUpdatedAt on success so failures can retry.
        lastAppliedUpdatedAt = next.updatedAt;
        if (pending && pending.updatedAt <= lastAppliedUpdatedAt) pending = null;
        return true;
      })
      .catch(() => {
        // Provider errors and mode identifiers may contain private launch inputs.
        logger.infoFile('[SessionModeOverrideSync] Failed to apply session mode override; will retry on next sync', {
          updatedAt: next.updatedAt,
          attempt,
        });
        return false;
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
    const snapshot = session.getMetadataSnapshot();
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
    if (params.autoApplyFromMetadata !== false) {
      void applyPendingIfPossible();
    }
  };

  const flushPendingAfterStartWithOutcome = async (): Promise<boolean> => {
    if (applyingPromise) return await applyingPromise;
    if (!pending) return true;
    if (!params.isStarted()) return true;

    const next = pending;
    if (next.updatedAt <= lastAppliedUpdatedAt) return true;
    return await applyPendingIfPossible();
  };

  const flushPendingAfterStart = async (): Promise<void> => {
    await flushPendingAfterStartWithOutcome();
  };

  return {
    syncFromMetadata,
    flushPendingAfterStart,
    flushPendingAfterStartWithOutcome,
    rebindSession: (nextSession) => { session = nextSession; },
  };
}

export const createAcpSessionModeOverrideSynchronizer = createSessionModeOverrideSynchronizer;
