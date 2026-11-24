import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { settingsDefaults } from '@/sync/domains/settings/settings';

export function readUsageAppCallsPriceOverrides(scope: ServerAccountScope) {
  const state = readRegisteredStorageState();
  return readAccountSettingsForScope({ scope, focusedScope: state?.settingsScope,
    focusedSettings: state?.settings ?? settingsDefaults }).usageModelPriceOverridesV1 ?? {};
}

export { listUsageAppEnvironments, readUsageAppCallsAccounting } from '@happier-dev/plugin-sdk/usage';
export type { UsageAppCallsExecute, UsageAppEnvironment } from '@happier-dev/plugin-sdk/usage';
