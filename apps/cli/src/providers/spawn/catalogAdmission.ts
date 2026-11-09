import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderOperationLifetime } from '../operationLifetime';
import { waitForPendingProviderConnectionsCatalogRefreshForCli } from '../settings/hydrate';

/** Revalidation joins the catalog owner's pending observation, never another read. */
export async function readProviderSpawnCatalogSnapshot(input: Readonly<{
  readSnapshot: () => ActiveAccountSettingsSnapshot | null;
  expectedScopeKey: string;
  lifetime: ProviderOperationLifetime;
  connectionId: string | null;
  machineId: string;
}>): Promise<Readonly<
  | { ok: true; snapshot: ActiveAccountSettingsSnapshot }
  | { ok: false; error: ProviderErrorV1 }
>> {
  let snapshot = input.readSnapshot();
  if (snapshot?.scopeKey === input.expectedScopeKey && snapshot.providerConnectionsCatalog?.status === 'loading') {
    await waitForPendingProviderConnectionsCatalogRefreshForCli(input);
    snapshot = input.readSnapshot();
  }
  if (snapshot?.scopeKey !== input.expectedScopeKey || snapshot.providerConnectionsCatalog?.status !== 'ready') {
    return { ok: false, error: createProviderErrorV1('provider_settings_invalid', {
      connectionId: input.connectionId ?? undefined, machineId: input.machineId,
    }) };
  }
  return { ok: true, snapshot };
}
