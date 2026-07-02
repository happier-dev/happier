import type { Credentials } from '@/persistence';
import { logger as defaultLogger } from '@/ui/logger';

import { refreshAccountSettingsForMinimumVersion } from './refreshAccountSettingsForMinimumVersion';

type WarmLogger = Readonly<{
  warn: (message: string, error?: unknown) => void;
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
 * (re)connect; when a scope-matching snapshot is already active it is a cheap no-op.
 *
 * Fail-open by design: a failure is logged and reported as `false`, never thrown — the
 * retryable settings-unavailable continuity outcome covers the window until a later
 * refresh succeeds.
 */
export async function warmActiveAccountSettingsSnapshotBestEffort(params: Readonly<{
  credentials: Credentials;
  logger?: WarmLogger;
  deps?: Partial<WarmDeps>;
}>): Promise<boolean> {
  const logger = params.logger ?? defaultLogger;
  try {
    await refreshAccountSettingsForMinimumVersion({
      credentials: params.credentials,
      minSettingsVersion: null,
      mode: 'blocking',
      ...(params.deps ? { deps: params.deps } : {}),
    });
    return true;
  } catch (error) {
    logger.warn('[accountSettings] Failed to warm active account-settings snapshot (non-fatal)', error);
    return false;
  }
}
