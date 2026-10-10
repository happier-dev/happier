import { createProviderErrorV1, type ProviderSettingsReadResultV1 } from '@happier-dev/protocol';
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
    throw Object.assign(new Error('Provider catalog authority is unavailable'), createProviderErrorV1('provider_settings_invalid'));
  }
  return {
    settings: composeProviderSettingsV1(catalog.catalog, snapshot.settings.providerDefaultModelSelectionsByAgentTargetKeyV1),
    diagnostics: catalog.status === 'partial' ? catalog.diagnostics : [],
  };
}
