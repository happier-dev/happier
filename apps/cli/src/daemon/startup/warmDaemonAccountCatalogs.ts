import type { StoredCredentials } from '@/persistence';
import { refreshDaemonAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';

/** ACP hydration captures the Account lifetime established by settings warming. */
export async function warmDaemonAccountCatalogs(input: Readonly<{
  credentials: StoredCredentials;
  signal: AbortSignal;
  logger: NonNullable<Parameters<typeof warmActiveAccountSettingsSnapshotBestEffort>[0]['logger']>;
}>): Promise<void> {
  if (!await warmActiveAccountSettingsSnapshotBestEffort(input)) {
    throw new Error('Account settings warmup is unavailable');
  }
  await refreshDaemonAcpCatalog(input);
}
