import type { StoredCredentials } from '@/persistence';
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
import {
  updateAccountSettingsV2WithRetry,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

import {
  requireProviderConnectionAccountSettingsMutationSuccess,
} from './accountSettingsMutationRefusal';

import { createProviderConnectionRpcAdapter } from './rpcAdapter';
import { createPublicManagedProviderRuntimeStartOperation } from './publicManagedRuntimeStart';
import {
  createProviderConnectionService,
  type ProviderConnectionRuntimeProjection,
  type ProviderConnectionRegistryProjection,
  type ProviderConnectionRuntimeSummary,
  type ProviderConnectionRuntimeSummaryInput,
} from './service';
import { projectProviderConnectionCompatibility } from './compatibility';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
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
  credentials: StoredCredentials;
  happyHomeDir: string;
  featureGate: Readonly<{ isEnabled(featureId: 'providers' | 'providers.localDiscovery'): boolean }>;
  runtimeSummary(input: ProviderConnectionRuntimeSummaryInput): Promise<
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
  startManagedProviderRuntime?: NonNullable<
    Parameters<typeof createProviderConnectionService>[0]['startManagedProviderRuntime']
  >;
  resolveManagedPurposeBindingIntent?: Parameters<
    typeof createProviderConnectionService
  >[0]['resolveManagedPurposeBindingIntent'];
  refreshOnEnable?: (
    input: Readonly<{ connectionId: string; machineId: string }>,
    trigger: 'enable',
  ) => Promise<unknown>;
}>): RuntimeProviderConnectionServices {
  const loadRegistryProjection = input.resolveRegistry
    ? async (): Promise<ProviderConnectionRegistryProjection> => Object.freeze({
        registry: await input.resolveRegistry!(),
      })
    : async (): Promise<ProviderConnectionRegistryProjection> => {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir,
        });
        try {
          if (typeof lease.registry.generation !== 'number') {
            throw new Error('Authoritative Provider registry is missing its immutable generation tag');
          }
          return Object.freeze({
            registry: resolveProviderContributionRegistryView(lease.registry.contributes),
            generation: String(lease.registry.generation),
          });
        } finally {
          await lease.release();
        }
      };
  const startManagedProviderRuntime = input.startManagedProviderRuntime
    ?? createPublicManagedProviderRuntimeStartOperation({
      machineId: input.machineId,
      happyHomeDir: input.happyHomeDir,
    });
  // The injected registry and start functions are test seams. Production
  // explicit starts retain the actual canonical lease from admission through
  // runtime execution rather than combining their projections with a later
  // registry acquisition.
  const useAuthoritativeManagedStartLease = !input.resolveRegistry
    && !input.startManagedProviderRuntime;
  const service = createProviderConnectionService({
    machineId: input.machineId,
    featureGate: input.featureGate,
    loadSnapshot: async (registryProjection) => {
      const current = getActiveAccountSettingsSnapshot();
      const active = current?.scopeKey === resolveAccountSettingsScopeKey(input.credentials)
        ? current
        : await refreshAccountSettingsForMinimumVersion({
          credentials: input.credentials,
          minSettingsVersion: null,
          mode: 'blocking',
        });
      const projection = registryProjection ?? await loadRegistryProjection();
      return {
        accountSettings: active.settings,
        rawAccountSettings: active.rawSettings ?? active.settings,
        registry: projection.registry,
        ...(projection.generation ? { registryGeneration: projection.generation } : {}),
      };
    },
    updateAccountSettings: async (mutate) => {
      const result = requireProviderConnectionAccountSettingsMutationSuccess(
        await updateAccountSettingsV2WithRetry({ credentials: input.credentials, mutate }),
        { machineId: input.machineId },
      );
      const refreshed = await refreshAccountSettingsForMinimumVersion({
        credentials: input.credentials,
        minSettingsVersion: result.version,
        mode: 'blocking',
        forceRefresh: true,
      });
      return refreshed.settings;
    },
    collectDnsEvidence: ({ accountSettings, connectionId, machineId, registry, lifetime }) =>
      collectProviderConnectionDnsEvidence({
        providerSettings: readProviderSettingsForCli(accountSettings).settings,
        connectionId, machineId, registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime,
      }),
    resolveConnection: ({ accountSettings, connectionId, machineId, registry, dnsEvidence }) =>
      resolveProviderConnectionForMachine({
        accountSettings, connectionId, machineId, registry,
        dnsEvidenceByEndpointUrl: dnsEvidence,
      }),
    runtimeSummary: async (request) => {
      const result = await input.runtimeSummary(request);
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
    ...(useAuthoritativeManagedStartLease
      ? {
          acquireManagedProviderRuntimeRegistryLease: () =>
            acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: input.happyHomeDir }),
        }
      : {}),
    startManagedProviderRuntime,
    ...(input.resolveManagedPurposeBindingIntent
      ? { resolveManagedPurposeBindingIntent: input.resolveManagedPurposeBindingIntent }
      : {}),
    ...(input.refreshOnEnable ? { refreshOnEnable: input.refreshOnEnable } : {}),
    now: input.now ?? Date.now,
  });
  return Object.freeze({ service, ...createProviderConnectionRpcAdapter(service) });
}
