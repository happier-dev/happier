import {
  IROH_RELAY_POLICY_ENV_KEY,
  IROH_RELAY_URLS_ENV_KEY,
  readIrohRelayConfigFromEnv,
  type IrohRelayEnvConfig,
} from '@happier-dev/iroh-native/node';

import { readInstalledDaemonServiceEnvValue } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServicePlatform } from './plan';
import type { OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { configuration } from '@/configuration';

export function resolveDaemonServiceIrohRelayConfig(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  organizationPolicy?: OrganizationPolicyLoadResult;
  installedService?: Readonly<{
    platform: DaemonServicePlatform;
    path: string;
  }>;
}>): IrohRelayEnvConfig {
  const organizationPolicy = params.organizationPolicy ?? configuration.organizationPolicy;
  const forced = organizationPolicy.status === 'loaded' ? organizationPolicy.policy.relays : undefined;
  if (forced) {
    return { relayPolicy: forced.policy, relayUrls: forced.urls ?? [], explicitlyConfigured: true };
  }
  const requested = readIrohRelayConfigFromEnv(params.processEnv);
  if (requested.explicitlyConfigured || !params.installedService) {
    return requested;
  }

  return readIrohRelayConfigFromEnv({
    [IROH_RELAY_POLICY_ENV_KEY]: readInstalledDaemonServiceEnvValue({
      ...params.installedService,
      key: IROH_RELAY_POLICY_ENV_KEY,
    }) ?? undefined,
    [IROH_RELAY_URLS_ENV_KEY]: readInstalledDaemonServiceEnvValue({
      ...params.installedService,
      key: IROH_RELAY_URLS_ENV_KEY,
    }) ?? undefined,
  });
}
