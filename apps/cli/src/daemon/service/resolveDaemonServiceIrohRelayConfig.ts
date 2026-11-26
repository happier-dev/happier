import {
  IROH_RELAY_POLICY_ENV_KEY,
  IROH_RELAY_URLS_ENV_KEY,
  readIrohRelayConfigFromEnv,
  type IrohRelayEnvConfig,
} from '@happier-dev/iroh-native/node';
import { IrohRelayUrlsV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';

import { readInstalledDaemonServiceEnvValue } from './discoverInstalledDaemonServiceEntries';
import type { DaemonServicePlatform } from './plan';
import type { OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { configuration } from '@/configuration';

function resolveHomeMachineRelayFallback(
  homeMachineRelayUrls: readonly string[] | undefined,
  fallback: IrohRelayEnvConfig,
): IrohRelayEnvConfig {
  if (!homeMachineRelayUrls || homeMachineRelayUrls.length === 0) return fallback;
  const parsed = IrohRelayUrlsV1Schema.safeParse(homeMachineRelayUrls);
  if (!parsed.success) return fallback;
  const sorted = [...parsed.data].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze({
    relayPolicy: 'automatic',
    relayUrls: Object.freeze(sorted),
    explicitlyConfigured: false,
  });
}

export function resolveDaemonServiceIrohRelayConfig(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  organizationPolicy?: OrganizationPolicyLoadResult;
  installedService?: Readonly<{
    platform: DaemonServicePlatform;
    path: string;
  }>;
  homeMachineRelayUrls?: readonly string[];
}>): IrohRelayEnvConfig {
  const organizationPolicy = params.organizationPolicy ?? configuration.organizationPolicy;
  const forced = organizationPolicy.status === 'loaded' ? organizationPolicy.policy.relays : undefined;
  if (forced) {
    return { relayPolicy: forced.policy, relayUrls: forced.urls ?? [], explicitlyConfigured: true };
  }
  const requested = readIrohRelayConfigFromEnv(params.processEnv);
  if (requested.explicitlyConfigured) {
    return requested;
  }

  if (params.installedService) {
    const installed = readIrohRelayConfigFromEnv({
      [IROH_RELAY_POLICY_ENV_KEY]: readInstalledDaemonServiceEnvValue({
        ...params.installedService,
        key: IROH_RELAY_POLICY_ENV_KEY,
      }) ?? undefined,
      [IROH_RELAY_URLS_ENV_KEY]: readInstalledDaemonServiceEnvValue({
        ...params.installedService,
        key: IROH_RELAY_URLS_ENV_KEY,
      }) ?? undefined,
    });
    if (installed.explicitlyConfigured) {
      return installed;
    }
  }

  return resolveHomeMachineRelayFallback(params.homeMachineRelayUrls, requested);
}
