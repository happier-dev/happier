import type { Credentials } from '@/persistence';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  resolveProviderContributionRegistryView,
  resolveProviderConnectionForMachine,
  type ProviderContributionRegistryView,
} from '@/providers/registry';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

import { createProviderConnectionRpcAdapter } from './rpcAdapter';
import {
  createProviderConnectionService,
  type ProviderConnectionRuntimeProjection,
  type ProviderConnectionRuntimeSummary,
} from './service';
import { projectProviderConnectionCompatibility } from './compatibility';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ProviderDiscoveryCandidateV1, ProviderLocalInstallationSummaryV1 } from '@happier-dev/protocol';
import type { ProviderConnectionView } from './service';

const EMPTY_RUNTIME_SUMMARY: ProviderConnectionRuntimeSummary = Object.freeze({
  health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [],
});

export type RuntimeProviderConnectionServices = Readonly<
  { service: ReturnType<typeof createProviderConnectionService> }
  & ReturnType<typeof createProviderConnectionRpcAdapter>
>;

/**
 * Daemon composition for provider-connection settings. Account-settings CAS,
 * DNS classification, security fingerprints, and grants remain daemon owned;
 * RPC and CLI callers submit intent only.
 */
export function createRuntimeProviderConnectionServices(input: Readonly<{
  machineId: string;
  credentials: Credentials;
  happyHomeDir: string;
  featureGate: Readonly<{ isEnabled(featureId: 'providers' | 'providers.localDiscovery' | 'localServices.managed'): boolean }>;
  runtimeSummary(input: Readonly<{ connectionId: string; machineId: string }>): Promise<
    | Readonly<{
        status: 'success';
        summary: ProviderConnectionRuntimeSummary;
        probeObservationIdentity: NonNullable<ProviderConnectionRuntimeProjection['probeObservationIdentity']>;
      }>
    | Readonly<{ status: 'error' }>
  >;
  now?: () => number;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveRegistry?: () => Promise<ProviderContributionRegistryView>;
  discoveryCandidates?: (input: Readonly<{
    machineId: string;
    registry: ProviderContributionRegistryView;
    connections: readonly ProviderConnectionView[];
  }>) => Promise<readonly ProviderDiscoveryCandidateV1[]>;
  localInstallations?: (input: Readonly<{
    machineId: string;
    registry: ProviderContributionRegistryView;
    candidates: readonly ProviderDiscoveryCandidateV1[];
  }>) => Promise<readonly ProviderLocalInstallationSummaryV1[]>;
  startManaged?: (input: Readonly<{
    machineId: string;
    contributionKey: string;
    pluginId: string;
    providerName: string;
    lookupNames: readonly string[];
    fixedArgs: readonly string[];
  }>) => Promise<Readonly<{ status: 'detecting' | 'running' }>>;
  refreshOnEnable?: (
    input: Readonly<{ connectionId: string; machineId: string }>,
    trigger: 'enable',
  ) => Promise<unknown>;
}>): RuntimeProviderConnectionServices {
  const resolveRegistry = input.resolveRegistry ?? (async () => resolveProviderContributionRegistryView(
    await resolveMergedContributionRegistry({ happyHomeDir: input.happyHomeDir }),
  ));
  const service = createProviderConnectionService({
    machineId: input.machineId,
    featureGate: input.featureGate,
    loadSnapshot: async () => {
      const current = getActiveAccountSettingsSnapshot();
      const active = current?.scopeKey === resolveAccountSettingsScopeKey(input.credentials)
        ? current
        : await refreshAccountSettingsForMinimumVersion({
          credentials: input.credentials,
          minSettingsVersion: null,
          mode: 'blocking',
        });
      return { accountSettings: active.settings, registry: await resolveRegistry() };
    },
    updateAccountSettings: async (mutate) => {
      const result = await updateAccountSettingsV2WithRetry({ credentials: input.credentials, mutate });
      const refreshed = await refreshAccountSettingsForMinimumVersion({
        credentials: input.credentials,
        minSettingsVersion: result.version,
        mode: 'blocking',
        forceRefresh: true,
      });
      return refreshed.settings;
    },
    collectDnsEvidence: ({ accountSettings, connectionId, machineId, registry }) =>
      collectProviderConnectionDnsEvidence({
        providerSettings: readProviderSettingsForCli(accountSettings).settings,
        connectionId, machineId, registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
      }),
    resolveConnection: ({ accountSettings, connectionId, machineId, registry, dnsEvidence }) =>
      resolveProviderConnectionForMachine({
        accountSettings, connectionId, machineId, registry,
        dnsEvidenceByEndpointUrl: dnsEvidence,
      }),
    runtimeSummary: async ({ connectionId, machineId }) => {
      const result = await input.runtimeSummary({ connectionId, machineId });
      return result.status === 'success'
        ? { summary: result.summary, probeObservationIdentity: result.probeObservationIdentity }
        : { summary: EMPTY_RUNTIME_SUMMARY, probeObservationIdentity: null };
    },
    acquireCompatibilityProjection: () => {
      // Settings may read current executable facts, but must never start runtime
      // activation for advisory compatibility presentation.
      const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: input.happyHomeDir });
      if (!lease) return null;
      return {
        project: (connection) => projectProviderConnectionCompatibility({ lease, connection }),
        release: lease.release,
      };
    },
    discoveryCandidates: input.discoveryCandidates ?? (async () => []),
    localInstallations: input.localInstallations ?? (async () => []),
    ...(input.startManaged ? { startManaged: input.startManaged } : {}),
    ...(input.refreshOnEnable ? { refreshOnEnable: input.refreshOnEnable } : {}),
    now: input.now ?? Date.now,
  });
  return Object.freeze({ service, ...createProviderConnectionRpcAdapter(service) });
}
