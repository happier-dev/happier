import { logger } from '@/ui/logger';

import type { SessionTrackingKey } from './sessionTrackingKey';

/**
 * Per-Session resource cleanups are keyed by the tracked Session's
 * `trackingKey`, never by its hosting pid: one process may host several
 * Sessions, and a wrapper→runner pid promotion leaves the key unchanged.
 */
export type SpawnResourceCleanupByKey = Map<SessionTrackingKey, () => void | Promise<void>>;
export type SessionAttachCleanupByKey = Map<SessionTrackingKey, () => Promise<void>>;

export function registerSessionSpawnResourceCleanup(params: Readonly<{
  trackingKey: SessionTrackingKey;
  /** Existing operation kind; never a credential, path, or native error text. */
  label?: string;
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  isCurrentOwner: () => boolean;
  cleanup: () => void | Promise<void>;
}>): (() => void) | null {
  if (!params.isCurrentOwner()) return null;
  const previousCleanup =
    params.spawnResourceCleanupByKey.get(params.trackingKey) ?? null;
  let cleanupStarted = false;
  let cleanupCompleted = false;
  let cleanupPromise: Promise<void> | null = null;
  const registeredCleanup = async (): Promise<void> => {
    cleanupStarted = true;
    cleanupPromise ??= Promise.resolve().then(async () => {
      if (!cleanupCompleted) {
        try {
          await params.cleanup();
        } catch (error) {
          if (!params.label) throw error;
          throw new Error(`Session resource cleanup failed: ${params.label}`, { cause: error });
        }
        cleanupCompleted = true;
      }
      await previousCleanup?.();
    }).catch((error: unknown) => {
      // Retain failed custody for the next explicit attempt, while concurrent
      // callers join this attempt and completed stages stay retired.
      cleanupPromise = null;
      throw error;
    });
    await cleanupPromise;
  };
  params.spawnResourceCleanupByKey.set(params.trackingKey, registeredCleanup);
  if (!params.isCurrentOwner()) {
    if (
      params.spawnResourceCleanupByKey.get(params.trackingKey)
      === registeredCleanup
    ) {
      if (previousCleanup) {
        params.spawnResourceCleanupByKey.set(
          params.trackingKey,
          previousCleanup,
        );
      } else {
        params.spawnResourceCleanupByKey.delete(params.trackingKey);
      }
    }
    return null;
  }

  return () => {
    if (
      cleanupStarted
      || params.spawnResourceCleanupByKey.get(params.trackingKey)
        !== registeredCleanup
    ) {
      return;
    }
    if (previousCleanup) {
      params.spawnResourceCleanupByKey.set(params.trackingKey, previousCleanup);
    } else {
      params.spawnResourceCleanupByKey.delete(params.trackingKey);
    }
  };
}

export async function retireUpstreamAuthorityBeforeProcessStop(
  params: Readonly<{
    trackingKey: SessionTrackingKey;
    spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  }>,
): Promise<boolean> {
  const cleanup = params.spawnResourceCleanupByKey.get(params.trackingKey);
  if (!cleanup) return true;
  try {
    await cleanup();
  } catch (error) {
    logger.debug(
      '[DAEMON RUN] Failed to retire upstream authority before process stop',
      { trackingKey: params.trackingKey, error },
    );
    return false;
  }
  if (params.spawnResourceCleanupByKey.get(params.trackingKey) === cleanup) {
    params.spawnResourceCleanupByKey.delete(params.trackingKey);
  }
  return true;
}

export async function cleanupSessionResources(params: Readonly<{
  trackingKey: SessionTrackingKey;
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  sessionAttachCleanupByKey: SessionAttachCleanupByKey;
}>): Promise<boolean> {
  const { trackingKey, spawnResourceCleanupByKey, sessionAttachCleanupByKey } = params;

  const attachCleanup = sessionAttachCleanupByKey.get(trackingKey);
  const authorityRetired =
    await retireUpstreamAuthorityBeforeProcessStop({
      trackingKey,
      spawnResourceCleanupByKey,
    });
  if (!authorityRetired) return false;

  if (attachCleanup && sessionAttachCleanupByKey.get(trackingKey) === attachCleanup) {
    try {
      await attachCleanup();
      if (sessionAttachCleanupByKey.get(trackingKey) === attachCleanup) {
        sessionAttachCleanupByKey.delete(trackingKey);
      }
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to cleanup session attach file', error);
      return false;
    }
  }
  return true;
}
