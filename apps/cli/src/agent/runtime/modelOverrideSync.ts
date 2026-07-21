import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';

import { resolveModelOverrideFromMetadataSnapshot } from './permission/permissionModeFromMetadata';
import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';
import { isDefinitiveSessionControlApplyError } from './sessionControlApplyError';

export function createModelOverrideSynchronizer(params: Readonly<{
  session: {
    getMetadataSnapshot: () => Metadata | null;
    updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
  };
  runtime: { setSessionModel: (modelId: string) => Promise<void> };
  isStarted: () => boolean;
  autoApplyFromMetadata?: boolean;
  reportTerminalFailure?: (failure: Readonly<{ kind: 'model'; requested: string; error: unknown }>) => void;
  onDefinitiveRejection?: (command: Readonly<{ modelId: string; updatedAt: number }>) => void | Promise<void>;
}>): {
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
  flushPendingAfterStartWithOutcome: () => Promise<boolean>;
  rebindSession: (session: {
    getMetadataSnapshot: () => Metadata | null;
    updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
  }) => void;
} {
  type ModelCommand = { modelId: string; updatedAt: number };
  let session = params.session;
  let settledUpdatedAt = 0;
  let settledModelIdsAtUpdatedAt = new Set<string>();
  let pending: { modelId: string; updatedAt: number } | null = null;
  let applyingPromise: Promise<boolean> | null = null;
  let cleanupObligation: ModelCommand | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const isSameCommand = (left: ModelCommand | null, right: ModelCommand): boolean =>
    left?.updatedAt === right.updatedAt && left.modelId === right.modelId;

  const isSettled = (command: ModelCommand): boolean =>
    command.updatedAt < settledUpdatedAt
    || (command.updatedAt === settledUpdatedAt && settledModelIdsAtUpdatedAt.has(command.modelId));

  const markSettled = (command: ModelCommand): void => {
    if (command.updatedAt > settledUpdatedAt) {
      settledUpdatedAt = command.updatedAt;
      settledModelIdsAtUpdatedAt = new Set([command.modelId]);
      return;
    }
    if (command.updatedAt === settledUpdatedAt) settledModelIdsAtUpdatedAt.add(command.modelId);
  };

  const retryCleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    const obligation = cleanupObligation;
    if (!obligation || !session.updateMetadata) return Promise.resolve();

    cleanupPromise = session.updateMetadata((metadata) => {
      const current = resolveModelOverrideFromMetadataSnapshot({ metadata });
      if (!isSameCommand(current, obligation)) return metadata;
      return computeNextMetadataStringOverrideV1({
        metadata,
        overrideKey: 'modelOverrideV1',
        valueKey: 'modelId',
        value: '',
        updatedAt: obligation.updatedAt + 1,
      }) as Metadata;
    }).then(() => {
      if (isSameCommand(cleanupObligation, obligation)) cleanupObligation = null;
    }).catch((cleanupError) => {
      logger.debug('[modelOverrideSync] Provider rejected model and metadata cleanup failed; cleanup will retry on the next sync', cleanupError);
    }).finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  };

  const applyPendingIfPossible = (): Promise<boolean> => {
    if (applyingPromise) return applyingPromise;
    if (!pending) return Promise.resolve(true);
    if (!params.isStarted()) return Promise.resolve(true);

    const next = pending;
    if (isSettled(next)) {
      pending = null;
      return Promise.resolve(true);
    }

    applyingPromise = params.runtime
      .setSessionModel(next.modelId)
      .then(() => {
        // Only mark as applied after a successful runtime update so failures can be retried.
        markSettled(next);
        if (isSameCommand(pending, next)) pending = null;
        return true;
      })
      .catch(async (error) => {
        if (isDefinitiveSessionControlApplyError(error)) {
          markSettled(next);
          if (isSameCommand(pending, next)) pending = null;
          cleanupObligation = next;
          await retryCleanup();
          await params.onDefinitiveRejection?.(next);
          params.reportTerminalFailure?.({ kind: 'model', requested: next.modelId, error });
          return false;
        }
        // Best-effort only. Keep `pending` so the next sync attempt can retry.
        logger.debug('[modelOverrideSync] Failed to apply model override; will retry on next metadata sync', error);
        return false;
      })
      .finally(() => {
        applyingPromise = null;
        // If a newer override arrived while we were applying, attempt to apply it now.
        if (pending && !isSameCommand(pending, next) && !isSettled(pending) && params.isStarted()) {
          void applyPendingIfPossible();
        }
      });

    return applyingPromise;
  };

  const syncFromMetadata = (): void => {
    if (cleanupObligation) void retryCleanup();
    const next = resolveModelOverrideFromMetadataSnapshot({ metadata: session.getMetadataSnapshot() });
    if (!next || isSettled(next)) {
      pending = null;
      return;
    }

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
    if (cleanupObligation) await retryCleanup();
    if (!pending) return true;
    if (!params.isStarted()) return true;

    const next = pending;
    if (isSettled(next)) return true;
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
