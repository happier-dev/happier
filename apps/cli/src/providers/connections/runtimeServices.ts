import type { StoredCredentials } from '@/persistence';
import { isDeepStrictEqual } from 'node:util';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliAccountProviderActionExecuteV1 } from './accountActions';
import {
  resolveProviderContributionRegistryView,
  resolveProviderConnectionForMachine,
  type ProviderContributionRegistryView,
} from '@/providers/registry';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createCliProviderConnectionsStore } from '@/providers/settings/catalogStore';
import { refreshActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { promoteSavedSecretWithProviderConnectionsCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
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
 * Daemon composition for provider connections. Canonical row CAS,
 * Account mutations delegate to the same Protocol semantics as standalone CLI
 * Actions. DNS, machine grants, discovery and executable state stay here.
 */
export function createRuntimeProviderConnectionServices(input: Readonly<{
  machineId: string;
  credentials: StoredCredentials;
  happyHomeDir: string;
  resolveSharedGateway?: import('@/plugins/runtime/invocation/services/managedServicesAdapter').ResolveSharedManagedProviderGatewayBinding;
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
            registry: resolveProviderContributionRegistryView(
              lease.registry.contributes,
              lease.registry.generation,
              lease.registry.readPluginOccurrenceId,
            ),
            generation: String(lease.registry.generation),
          });
        } finally {
          await lease.release();
        }
      };
  const startManagedProviderRuntime = input.startManagedProviderRuntime
    ?? createPublicManagedProviderRuntimeStartOperation({
      ...(input.resolveSharedGateway ? { resolveSharedGateway: input.resolveSharedGateway } : {}),
      machineId: input.machineId,
      happyHomeDir: input.happyHomeDir,
    });
  // The injected registry and start functions are test seams. Production
  // explicit starts retain the actual canonical lease from admission through
  // runtime execution rather than combining their projections with a later
  // registry acquisition.
  const useAuthoritativeManagedStartLease = !input.resolveRegistry
    && !input.startManagedProviderRuntime;
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const executeAccount = async (request: ProviderActionRequestV1,
    preparedSavedSecret?: Parameters<typeof createCliAccountProviderActionExecuteV1>[0]['preparedSavedSecret']) => {
    if (!input.featureGate.isEnabled('providers')) return { ok: false as const, errorCode: 'provider_feature_disabled',
      error: 'provider_feature_disabled', details: createProviderErrorV1('provider_feature_disabled', { machineId: input.machineId }) };
    if ('machineId' in request.input && request.input.machineId !== input.machineId) {
      return { ok: false as const, errorCode: 'provider_not_enabled_on_machine', error: 'provider_not_enabled_on_machine',
        details: createProviderErrorV1('provider_not_enabled_on_machine', { machineId: request.input.machineId }) };
    }
    return createCliAccountProviderActionExecuteV1({ credentials: input.credentials, serverHttpBaseUrl,
      preparedSavedSecret, now: input.now,
      readDefinitions: async () => [...(await loadRegistryProjection()).registry.providersByContributionKey]
        .map(([contributionKey, contribution]) => ({ contributionKey, definition: contribution.definition,
          provenance: contribution.provenance })),
    })(request, { surface: 'cli' });
  };
  const service = createProviderConnectionService({
    accountProviderActionExecute: executeAccount,
    machineId: input.machineId,
    featureGate: input.featureGate,
    loadSnapshot: async (registryProjection) => {
      const current = getActiveAccountSettingsSnapshot();
      let active = current?.scopeKey === resolveAccountSettingsScopeKey(input.credentials)
        ? current
        : await refreshAccountSettingsForMinimumVersion({
          credentials: input.credentials,
          minSettingsVersion: null,
          mode: 'blocking',
        });
      const capturedStore = createCliProviderConnectionsStore({ credentials: input.credentials });
      if (!active.providerConnectionsCatalog || active.providerConnectionsCatalog.status === 'loading'
        || active.providerConnectionsCatalog.status === 'unavailable') {
        await refreshActiveProviderConnectionsCatalog({ credentials: input.credentials });
        capturedStore.assertCurrent();
        const refreshed = getActiveAccountSettingsSnapshot();
        if (!refreshed || refreshed.scopeKey !== active.scopeKey) throw createProviderErrorV1('provider_settings_invalid');
        active = refreshed;
      }
      const providerRead = readProviderSettingsForCli(active, { purpose: 'display' });
      const projection = registryProjection ?? await loadRegistryProjection();
      capturedStore.assertCurrent();
      return {
        accountSettings: active.settings,
        providerSettings: providerRead.settings,
        providerSettingsDiagnostics: providerRead.diagnostics,
        rawAccountSettings: active.rawSettings ?? active.settings,
        registry: projection.registry,
        ...(projection.generation ? { registryGeneration: projection.generation } : {}),
        ...(active.savedSecretResources ? { savedSecretResources: active.savedSecretResources } : {}),
        ...(active.savedSecretCatalogState ? { savedSecretCatalogState: active.savedSecretCatalogState } : {}),
      };
    },
    updateProviderSettings: async (mutate, options) => {
      const store = createCliProviderConnectionsStore({ credentials: input.credentials });
      const captured = await store.readCatalog();
      if (captured.status !== 'ready') throw createProviderErrorV1('provider_settings_invalid');
      const active = getActiveAccountSettingsSnapshot();
      store.assertCurrent();
      if (!active) throw createProviderErrorV1('provider_settings_invalid');
      const basis = composeProviderSettingsV1(captured.catalog, active.settings.providerDefaultModelSelectionsByAgentTargetKeyV1);
      const next = mutate(basis);
      const { catalog } = splitProviderSettingsV1(next);
      if (isDeepStrictEqual(catalog, captured.catalog)) return basis;
      try {
        if (options?.preparedSavedSecret) {
          const result = await promoteSavedSecretWithProviderConnectionsCatalog({
            credentials: input.credentials, preparedSavedSecret: options.preparedSavedSecret,
            providerConnections: { expectedRevision: captured.revision, catalog },
          });
          if (result.status !== 'applied') {
            const code = result.status === 'outcome_unknown' ? 'provider_rpc_mutation_outcome_unknown'
              : result.status === 'conflict' ? 'provider_connection_changed'
              : result.status === 'unavailable' ? 'provider_secret_unavailable' : 'provider_connection_invalid';
            throw createProviderErrorV1(code, { machineId: input.machineId });
          }
        } else {
          const result = await store.mutateCatalog({ expectedRevision: captured.revision, catalog });
          if (result.status === 'conflict' || result.status === 'settings-conflict') {
            throw createProviderErrorV1('provider_connection_changed', { machineId: input.machineId });
          }
          if (result.status === 'invalid-reference') throw createProviderErrorV1('provider_secret_missing', { machineId: input.machineId });
          if (result.status !== 'updated') throw createProviderErrorV1('provider_settings_invalid');
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'outcome_unknown') {
          throw createProviderErrorV1('provider_rpc_mutation_outcome_unknown', { machineId: input.machineId });
        }
        throw error;
      }
      await refreshActiveProviderConnectionsCatalog({ credentials: input.credentials }, { afterChange: true });
      return next;
    },
    collectDnsEvidence: ({ providerSettings, connectionId, machineId, registry, lifetime }) =>
      collectProviderConnectionDnsEvidence({
        providerSettings,
        connectionId, machineId, registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime,
      }),
    resolveConnection: ({ providerSettings, connectionId, machineId, registry, dnsEvidence }) =>
      resolveProviderConnectionForMachine({
        providerSettings, connectionId, machineId, registry,
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
