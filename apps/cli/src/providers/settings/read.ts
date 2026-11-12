import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderSettingsReadResultV1 } from '@happier-dev/protocol';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { composeProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export type { ProviderSettingsReadResultV1 } from '@happier-dev/protocol';

/** The admitted catalog is the only Provider authority; preferences retain default intent. */
export function readProviderSettingsForCli(
  snapshot: Pick<ActiveAccountSettingsSnapshot, 'settings' | 'providerConnectionsCatalog' | 'rawSettings'>,
  options?: Readonly<{ purpose: 'display' }>,
): ProviderSettingsReadResultV1 {
  const catalog = snapshot.providerConnectionsCatalog;
  if (!catalog || catalog.status !== 'ready' && !(catalog.status === 'partial' && options?.purpose === 'display')) {
    throw Object.assign(new Error('Provider catalog authority is unavailable'), createProviderCatalogAdmissionError(catalog));
  }
  return {
    settings: composeProviderSettingsV1(catalog.catalog, snapshot.settings.providerDefaultModelSelectionsByAgentTargetKeyV1),
    diagnostics: catalog.status === 'partial' ? catalog.diagnostics : [],
  };
}

/** One classification for catalog preparation and retained admission refusals. */
export function createProviderCatalogAdmissionError(
  catalog: ProviderConnectionsCatalogSnapshotV1 | undefined,
  identity: Readonly<{ connectionId?: string; machineId?: string }> = {},
): ReturnType<typeof createProviderErrorV1> {
  const reason = catalog?.status === 'unavailable' ? catalog.reason : catalog?.status ?? 'not_loaded';
  const code = reason === 'scope-retired' ? 'provider_authorization_changed'
    : reason === 'invalid-stored-content' || reason === 'partial' ? 'provider_settings_invalid'
    : 'provider_catalog_unavailable';
  return createProviderErrorV1(code, { ...identity,
    failureCause: { phase: 'providers.catalog', errorClass: 'Error', errorCode: reason, httpStatus: null } });
}
