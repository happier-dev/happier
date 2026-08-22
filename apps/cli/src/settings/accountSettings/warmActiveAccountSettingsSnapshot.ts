import type { StoredCredentials } from '@/persistence';
import { logger as defaultLogger } from '@/ui/logger';

import { getActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';
import { refreshAccountSettingsForMinimumVersion } from './refreshAccountSettingsForMinimumVersion';

type WarmLogger = Readonly<{
  debug: (message: string, error?: unknown) => void;
}>;

type WarmDeps = NonNullable<Parameters<typeof refreshAccountSettingsForMinimumVersion>[0]['deps']>;

/**
 * Best-effort population of the daemon's in-memory account-settings snapshot through the
 * canonical refresh owner (`refreshAccountSettingsForMinimumVersion`).
 *
 * Incident Jun-11 H-A: the snapshot used to stay NULL until the first spawn hint or
 * `account-settings-changed` hint, so after every daemon restart all
 * `getActiveAccountSettingsSnapshot()` consumers (switch continuity, resume prompts,
 * materializers) silently degraded. Call this at daemon startup and on machine-socket
 * (re)connect; when a scope-matching network/cache snapshot is already active it is a cheap
 * no-op. An empty fallback is not readiness and must remain retryable.
 *
 * Fail-open by design: a failure is logged and reported as `false`, never thrown — the
 * retryable settings-unavailable continuity outcome covers the window until a later
 * refresh succeeds.
 */
export async function warmActiveAccountSettingsSnapshotBestEffort(params: Readonly<{
  credentials: StoredCredentials;
  logger?: WarmLogger;
  deps?: Partial<WarmDeps>;
}>): Promise<boolean> {
  const logger = params.logger ?? defaultLogger;
  try {
    const getActiveSnapshot =
      params.deps?.getActiveSnapshot ?? getActiveAccountSettingsSnapshot;
    const activeSnapshot = getActiveSnapshot();
    const context = await refreshAccountSettingsForMinimumVersion({
      credentials: params.credentials,
      minSettingsVersion: null,
      mode: 'blocking',
      ...(activeSnapshot?.source === 'none' ? { forceRefresh: true } : {}),
      ...(params.deps ? { deps: params.deps } : {}),
    });
    if (context.source === 'none') {
      throw new Error('Account settings warm completed without an available snapshot');
    }
    return true;
  } catch (error) {
    logger.debug('[accountSettings] Failed to warm active account-settings snapshot (non-fatal)', error);
    return false;
  }
}
