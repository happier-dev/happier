import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { acquireSavedSecretMaterializerForOperation, type SavedSecretOperationReferenceV1 } from '@/settings/secrets/savedSecretCatalogRead';
import { resolveProviderSecretBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { randomUUID } from 'node:crypto';
import { projectProviderModelGenerationSettings } from '@happier-dev/protocol/models/descriptor';
import { lookup } from 'node:dns/promises';

import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderEndpointFingerprintV1, createProviderProbeRequestFingerprintV1, createProviderManagedProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readOwnRecordValue } from '@happier-dev/protocol/providers/ownRecordValue';
import { readContributedProviderCatalogParserIds } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createProviderManagedRuntimeDeclarationEqualityKeyV1, resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderErrorV1, ProviderCatalogRuntimeStateRecordV1, ProviderMergedCatalogRowV1, ProviderObservationAuthorizationFingerprintV1, ProviderProbeObservationIdentityV1, ProviderRuntimeStateFileV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderDraftProbeRequestV1, DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountScopedProviderCatalogReader, createAccountScopedProviderModelProjectionReader, type AccountScopedProviderReadInput } from '@/providers/modelManagement/remoteProjection';
import { createAccountConnectionModelProjectionRequest } from '@/providers/broker/applicationProjection';
import { isRemoteProviderGatewayPlacement } from '@/providers/managed/gatewayPlacement';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { readProviderModelNameCatalog, resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import {
  resolveProviderConnectionForMachine,
  resolveProviderConnectionForMachineFromSettingsRead,
  type ProviderContributionRegistryView,
  type ProviderEndpointDnsEvidence,
  type ResolvedProviderConnectionRecord,
} from '@/providers/registry';
import {
  createProviderModelLoadCatalogPort,
  selectCurrentProviderCatalogRuntimeRecord,
} from '@/providers/modelManagement/catalog';
import type { ProviderModelLoadCatalogPort } from '@/providers/modelManagement/load';
import { projectProviderCatalogPresentation } from '@/providers/catalog';
import { createProviderRuntimeStateStore, type ProviderRuntimeStateStore } from '@/providers/runtimeState';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli, refreshProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import type { SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import {
  awaitAbortableWithinProviderOperation,
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  createProviderOperationPhaseObserver,
  observeProviderOperationPhase,
  ProviderOperationAbandonedError,
} from '@/providers/operationLifetime';
import {
  providerConnectionResolutionError,
  resolveProviderProbeAuthorization,
  type ProviderProbeHostAuthorizationTicket,
} from '@/providers/spawn/resolve';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import {
  createRuntimeProviderModelLoadAuthorizationPort,
  createRuntimeProviderProbeAuthorizationPort,
  type RuntimeProviderModelLoadAuthorizationPort,
} from '@/providers/spawn/probePort';

import {
  createProviderCatalogRefreshFingerprint,
  createProviderCatalogService,
  type ContributedProviderCatalogParserBinding,
  type ContributedProviderCatalogParsers,
  type ProviderCatalogRefreshResult,
  type ProviderManagedCatalogRuntimePort,
  type ProviderProbeEndpoint,
} from './catalog';
import { createProviderProbeHttpClient } from './client';
import { createProviderManagedCatalogRuntimePort } from './managedRuntime';
import {
  createResolvedProviderProbeObservationIdentity,
  createResolvedProviderProbeRunner,
  createProviderSavedModelsRpcHandler,
  createProviderSavedProbeRpcHandler,
  ProviderProbeRpcResolutionError,
  type ProviderProbeWaiterLifetime,
  type ProviderSavedModelsRpcResult,
  type ResolvedProviderProbeRpcRequest,
} from './rpc';
import {
  PROVIDER_CATALOG_REFRESH_TTL_MS,
  PROVIDER_HEALTH_REFRESH_TTL_MS,
  createProviderProbeScheduler,
  ProviderProbeAdmissionCapacityError,
} from './scheduler';
import {
  createProviderDraftProbeSchedulerKey,
  createProviderDraftProbeService,
} from './draft';
import { createProviderHealthProbeService } from './health';
import { selectProviderConnectionRuntimeSummary } from '@/providers/connections/runtimeSummary';
import type {
  ProviderConnectionRuntimeSummary,
  ProviderConnectionRuntimeSummaryInput,
} from '@/providers/connections/service/types';
import type { ProviderLocalCatalogFallbackResult } from './localCommand';
import type { ProviderProbeOperationScope } from './authorization';
import { admitRuntimeProviderSavedSecret } from '@/providers/spawn/runtimeCredential';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { sameProviderConnectionsCatalogAuthority } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import type {
  ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import {
  providerManagedPurposeBindingError,
  resolveManagedProviderPurposeBindingSnapshot,
} from '@/providers/managed/resolvePurposeBindingSnapshot';

type SavedResolution = Readonly<{
  resolveSavedSecretMaterializer?: ProviderProbeOperationScope['resolveSavedSecretMaterializer'];
  savedSecretSnapshot?: ActiveAccountSettingsSnapshot;
  request: ResolvedProviderProbeRpcRequest;
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  accountSettingsBasis?: ProviderProbeOperationScope['accountSettingsBasis'];
}>;

type SavedResolutionResult =
  | Readonly<{ ok: true; value: SavedResolution }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

type SavedProbeMode = 'catalog' | 'health';

type RuntimeProviderIdentity = Readonly<{
  connectionId: string;
  machineId: string;
}>;

function catalogAdmissionError(catalog: ProviderConnectionsCatalogSnapshotV1, identity: RuntimeProviderIdentity): ProviderErrorV1 {
  return createProviderErrorV1(catalog.status === 'unavailable'
    && ['unreachable', 'cancelled', 'encryption-material-unavailable'].includes(catalog.reason)
    ? 'provider_catalog_unavailable' : 'provider_settings_invalid', identity);
}

/** Exact facts carried by a single live Provider operation. */
export type RuntimeProviderOperationScope = ProviderProbeOperationScope & Readonly<{
  /** Exact executable-registry generation admitted for this operation. */
  resolveContributedCatalogParsers?: ResolveContributedProviderCatalogParsers;
  /** Null is explicit Account custody without an issued transport reader. */
  accountReadScope?: AccountScopedProviderReadInput | null;
}>;

/** Exact Account settings basis for one bulk presentation pass. */
export type RuntimeProviderPresentationResolutionBasis = Readonly<{
  snapshot: ActiveAccountSettingsSnapshot;
  settingsRead: ReturnType<typeof readProviderSettingsForCli>;
  /** Display facts from the exact registry lease held by this presentation pass. */
  modelNameCatalog?: ReturnType<typeof readProviderModelNameCatalog>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
}>;

type RuntimeProviderSummaryInput =
  | RuntimeProviderIdentity
  | ProviderConnectionRuntimeSummaryInput;

export type RuntimeProviderCatalogContext =
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  | Readonly<{
      status: 'success';
      connection: ResolvedProviderConnectionRecord;
      providerSettings: ProviderSettingsV1;
      runtimeState: ProviderRuntimeStateFileV1;
      allowedObservationAuthorizationFingerprints: readonly ProviderObservationAuthorizationFingerprintV1[];
      expectedEndpointObservations: readonly Readonly<{
        endpointTemplateId: string;
        endpointFingerprint: string;
      }>[];
      catalogFingerprint: ReturnType<typeof createProviderCatalogRefreshFingerprint> | null;
      catalogRuntimeRecord: ProviderCatalogRuntimeStateRecordV1 | null;
      catalogRuntimeKey: ProviderCatalogRuntimeStateRecordV1['key'] | null;
      modelNameCatalog?: ReturnType<typeof readProviderModelNameCatalog>;
    }>;

/** Reproject observations without reopening the same immutable presentation
 * admission after demand refresh has spent its containing operation budget. */
export function projectProviderCatalogContextRuntimeState(
  context: Extract<RuntimeProviderCatalogContext, { status: 'success' }>,
  runtimeState: ProviderRuntimeStateFileV1,
): Extract<RuntimeProviderCatalogContext, { status: 'success' }> {
  const record = context.catalogFingerprint === null ? null : selectCurrentProviderCatalogRuntimeRecord({
    state: runtimeState,
    machineId: context.connection.machineId,
    connectionId: context.connection.connectionId,
    catalogFingerprint: context.catalogFingerprint,
    allowedObservationAuthorizationFingerprints: context.allowedObservationAuthorizationFingerprints,
  });
  return { ...context, runtimeState, catalogRuntimeRecord: record, catalogRuntimeKey: record?.key ?? null };
}

export type RuntimeProviderServices = Readonly<{
  probe(
    rawInput: unknown,
    trigger?: 'manual_refresh' | 'enable',
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ): Promise<ProviderCatalogRefreshResult>;
  probeDraft(
    request: DaemonProviderDraftProbeRequestV1,
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ): Promise<ProviderCatalogRefreshResult>;
  models: ReturnType<typeof createProviderSavedModelsRpcHandler>;
  summary(input: RuntimeProviderSummaryInput): Promise<
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
    | Readonly<{
        status: 'success';
        probeObservationIdentity: ProviderProbeObservationIdentityV1;
        summary: ProviderConnectionRuntimeSummary;
      }>
  >;
  modelLoadCatalog: ProviderModelLoadCatalogPort<unknown>;
  modelLoadAuthorization: RuntimeProviderModelLoadAuthorizationPort;
  resolveCatalogContext(
    identity: RuntimeProviderIdentity,
    runtimeStateOverride?: ProviderRuntimeStateFileV1,
    scope?: RuntimeProviderOperationScope,
  ): Promise<RuntimeProviderCatalogContext>;
  resolvePresentationCatalogContext(
    identity: RuntimeProviderIdentity,
    runtimeStateOverride?: ProviderRuntimeStateFileV1,
    scope?: RuntimeProviderOperationScope,
    settingsBasis?: RuntimeProviderPresentationResolutionBasis,
  ): Promise<RuntimeProviderCatalogContext>;
  readPlacedModelProjection(
    request: DaemonProviderModelProjectionRequestV1 & Readonly<{ sourceConnectionId: string }>,
    scope: RuntimeProviderOperationScope,
  ): Promise<DaemonProviderModelProjectionResponseV1 | null>;
  scheduleDemandRefresh(
    identity: RuntimeProviderIdentity,
    trigger: 'detail_open' | 'picker_open' | 'manual_refresh',
    scope?: RuntimeProviderOperationScope,
  ): Promise<ProviderErrorV1 | null>;
  runtimeStore: ProviderRuntimeStateStore;
  probeInfrastructure: Readonly<{
    client: ReturnType<typeof createProviderProbeHttpClient>;
    scheduler: ReturnType<typeof createProviderProbeScheduler>;
  }>;
}>;

/**
 * Acquires the exact catalog wire formats a Provider's plugin contributes.
 * Provider contributions activate on demand, so this reaches the authoritative
 * plugin runtime rather than reading a stale projection.
 */
export type ResolveContributedProviderCatalogParsers = (
  identity: Readonly<{ pluginId: string; localId: string }>,
) => Promise<ContributedProviderCatalogParserBinding | null>;

async function acquireContributedProviderCatalogParsers(
  happyHomeDir: string,
  identity: Readonly<{ pluginId: string; localId: string }>,
): Promise<ContributedProviderCatalogParserBinding | null> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir });
  try {
    const acquired = await lease.registry.acquireProviderCatalogParsers?.(identity);
    // Acquisition admits the parser once. A finite probe keeps its captured
    // implementation even if a later reload replaces the plugin.
    return acquired
      ? Object.freeze({
          pluginId: identity.pluginId,
          parsersByFormat: acquired.parsersByFormat,
        })
      : null;
  } finally {
    await lease.release();
  }
}

function sourceCatalog(connection: ResolvedProviderConnectionRecord) {
  return connection.source.kind === 'contribution'
    ? connection.source.definition.catalog
    : connection.source.template.catalog;
}

function staticModels(catalog: ReturnType<typeof sourceCatalog>) {
  return 'staticModels' in catalog ? catalog.staticModels : [];
}

function catalogMembershipPolicy(catalog: ReturnType<typeof sourceCatalog>) {
  return 'membershipPolicy' in catalog ? catalog.membershipPolicy : undefined;
}

function expectedEndpointObservations(request: ResolvedProviderProbeRpcRequest) {
  if (request.managedSources) return [];
  return request.probes.map((probe) => {
    const endpoint = request.endpoints.find((candidate) =>
      candidate.endpointTemplateId === probe.endpointTemplateId);
    if (!endpoint) throw new TypeError('Resolved provider probe endpoint is absent');
    const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
      method: 'GET',
      endpointUrl: endpoint.normalizedUrl,
      path: probe.path,
      parser: probe.parser,
      publicHeaders: endpoint.publicHeaders,
    });
    return {
      endpointTemplateId: endpoint.endpointTemplateId,
      endpointFingerprint: createProviderEndpointFingerprintV1({
        endpointTemplateId: endpoint.endpointTemplateId,
        protocol: endpoint.protocol,
        probeRequestFingerprint,
      }),
    };
  });
}

function sourceCatalogFallback(connection: ResolvedProviderConnectionRecord) {
  return connection.source.kind === 'contribution'
    ? connection.source.definition.discovery?.catalogFallback
    : undefined;
}

function sourceForRow(row: ProviderMergedCatalogRowV1): 'manual' | 'static' | 'probe' {
  return row.confidence === 'manual'
    ? 'manual'
    : row.confidence === 'verified_static'
      ? 'static'
      : 'probe';
}

/**
 * Daemon-owned provider probe/catalog composition. Callers supply only saved
 * connection and machine identity; every endpoint, probe, grant, credential,
 * and catalog fact is re-derived from current daemon state.
 */
export function createRuntimeProviderServices(input: Readonly<{
  secretSources?: TargetSecretSourcesV1;
  machineId: string;
  featureGate?: Readonly<{ isEnabled(featureId: 'providers'): boolean }>;
  happyHomeDir?: string;
  resolveSharedGateway?: import('@/plugins/runtime/invocation/services/managedServicesAdapter').ResolveSharedManagedProviderGatewayBinding;
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  runtimeStore?: ProviderRuntimeStateStore;
  client?: ReturnType<typeof createProviderProbeHttpClient>;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderConnectionForMachine>[0]['localCandidateUrlsByConnectionId'];
  createObservationId?: () => string;
  modelLoadEnabled?: () => boolean;
  localCatalogFallback?: Readonly<{
    run(input: Readonly<{
      descriptor: NonNullable<ReturnType<typeof sourceCatalogFallback>>;
      endpointUrl: string;
      contributedCatalogParsers?: ContributedProviderCatalogParsers;
      lifetime?: import('../operationLifetime').ProviderOperationLifetime;
    }>): Promise<ProviderLocalCatalogFallbackResult>;
  }>;
  managedCatalogRuntime?: ProviderManagedCatalogRuntimePort<
    ProviderProbeHostAuthorizationTicket
  >;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  resolveContributedCatalogParsers?: ResolveContributedProviderCatalogParsers;
  openTeamDirect?: Parameters<typeof createRuntimeProviderProbeAuthorizationPort>[0]['openTeamDirect'];
}>): RuntimeProviderServices {
  const happyHomeDir = input.happyHomeDir ?? configuration.happyHomeDir;
  const resolveRegistry = input.resolveRegistry ?? (input.registry
    ? () => input.registry!
    : async () => {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir });
        try {
          if (typeof lease.registry.generation !== 'number') {
            throw new TypeError('Authoritative Provider registry is missing its generation');
          }
          return resolveProviderContributionRegistryView(
            lease.registry.contributes,
            lease.registry.generation,
            lease.registry.readPluginOccurrenceId,
          );
        } finally {
          await lease.release();
        }
      });
  const resolveContributedCatalogParsers = input.resolveContributedCatalogParsers
    ?? ((identity: Readonly<{ pluginId: string; localId: string }>) =>
      acquireContributedProviderCatalogParsers(happyHomeDir, identity));
  const getSnapshot = input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const resolveManagedPurposeBindingIntent = input.resolveManagedPurposeBindingIntent;
  const client = input.client ?? createProviderProbeHttpClient({});
  const runtimeStore = input.runtimeStore ?? createProviderRuntimeStateStore({
    happyHomeDir,
    machineId: input.machineId,
  });
  const authorization = createRuntimeProviderProbeAuthorizationPort({
    secretSources: input.secretSources,
    resolveRegistry,
    getAccountSettingsSnapshot: getSnapshot,
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
    ...(input.resolveManagedPurposeBindingIntent
      ? {
          resolveManagedPurposeBindingIntent:
            input.resolveManagedPurposeBindingIntent,
        }
      : {}),
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
  });
  const modelLoadAuthorization = createRuntimeProviderModelLoadAuthorizationPort({
    secretSources: input.secretSources,
    resolveRegistry,
    getAccountSettingsSnapshot: getSnapshot,
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
  });
  const catalogService = createProviderCatalogService({
    client,
    authorization,
    runtimeStore,
    createObservationId: input.createObservationId ?? randomUUID,
    ...(input.localCatalogFallback ? { localCatalogFallback: input.localCatalogFallback } : {}),
    managedCatalogRuntime: input.managedCatalogRuntime ?? createProviderManagedCatalogRuntimePort({
      happyHomeDir,
      ...(input.resolveSharedGateway ? { resolveSharedGateway: input.resolveSharedGateway } : {}),
    }),
  });
  const healthProbeService = createProviderHealthProbeService({
    refresh: (request) => catalogService.refresh(request),
  });
  const scheduler = createProviderProbeScheduler();
  const draftProbeService = createProviderDraftProbeService({
    machineId: input.machineId,
    getAccountSettingsSnapshot: getSnapshot,
    resolveAddresses: input.resolveAddresses ?? (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)),
    client,
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
  });
  const providerFeatureDisabled = (identity: Readonly<{ connectionId: string; machineId: string }>) => ({
    status: 'error' as const,
    error: createProviderErrorV1('provider_feature_disabled', identity),
  });
  const providerProbeUnavailable = (
    identity: Readonly<{ connectionId: string; machineId: string }>,
  ): Readonly<{ status: 'error'; error: ProviderErrorV1 }> => ({
    status: 'error',
    error: createProviderErrorV1('provider_endpoint_unavailable', identity),
  });
  // Local probe admission being full is a host capacity fact: no endpoint
  // request was attempted, so explicit refresh and model-load confirmation
  // report it separately from an endpoint outage.
  const providerProbeCapacityExhausted = (
    identity: Readonly<{ connectionId: string; machineId: string }>,
  ): Readonly<{ status: 'error'; error: ProviderErrorV1 }> => ({
    status: 'error',
    error: createProviderErrorV1('provider_probe_capacity_exhausted', identity),
  });
  const isProviderFeatureEnabled = () => input.featureGate?.isEnabled('providers') === true;
  const withProviderFeatureCurrentness = (
    waiterLifetime: ProviderProbeWaiterLifetime = {},
  ): ProviderProbeWaiterLifetime => ({
    ...waiterLifetime,
    isCurrent: () => isProviderFeatureEnabled()
      && (waiterLifetime.isCurrent?.() ?? true),
  });

  const withOperationLifetime = (
    scope: RuntimeProviderOperationScope | undefined,
    signal?: AbortSignal,
  ): RuntimeProviderOperationScope => scope ?? {
      lifetime: createProviderOperationLifetime({
        ...(signal ? { signal } : {}),
        wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
      }),
    };

  const refreshAmbientCatalog = async (identity: RuntimeProviderIdentity, lifetime: RuntimeProviderOperationScope['lifetime']) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity).error;
    // An issued snapshot reader retains its caller's already-admitted basis.
    if (input.getAccountSettingsSnapshot) return null;
    const snapshot = getSnapshot();
    if (!snapshot?.scopeKey) return createProviderErrorV1('provider_connection_not_found', identity);
    try {
      const catalog = await awaitWithinProviderOperation(refreshProviderConnectionsCatalogForCli({
        expectedScopeKey: snapshot.scopeKey, signal: lifetime.signal,
      }), lifetime);
      return catalog.status === 'ready' ? null : catalogAdmissionError(catalog, identity);
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) return createProviderErrorV1('provider_catalog_unavailable', identity);
      throw error;
    }
  };

  async function resolveConnectionContext(
    identity: Readonly<{ connectionId: string; machineId: string }>,
    scope: RuntimeProviderOperationScope,
    settingsBasis?: RuntimeProviderPresentationResolutionBasis,
  ) {
    if (!isProviderFeatureEnabled()) {
      return { ok: false as const, error: providerFeatureDisabled(identity).error };
    }
    if (scope.isAccountCurrent && !await scope.isAccountCurrent()) {
      return { ok: false as const, error: createProviderErrorV1('provider_authorization_changed', identity) };
    }
    const readSnapshot = scope.getAccountSettingsSnapshot ?? getSnapshot;
    let snapshot = settingsBasis?.snapshot ?? readSnapshot();
    if (!isProviderFeatureEnabled()) {
      return { ok: false as const, error: providerFeatureDisabled(identity).error };
    }
    if (!snapshot) {
      return { ok: false as const, error: createProviderErrorV1('provider_connection_not_found', identity) };
    }
    if (!settingsBasis && !scope.accountSettingsBasis && snapshot?.providerConnectionsCatalog?.status !== 'ready') {
      if (scope.getAccountSettingsSnapshot) return { ok: false as const,
        error: createProviderErrorV1('provider_catalog_unavailable', identity) };
      if (!snapshot?.scopeKey) return { ok: false as const, error: createProviderErrorV1('provider_settings_invalid', identity) };
      let catalog;
      try {
        catalog = await awaitWithinProviderOperation(prepareProviderConnectionsCatalogForCli({
          expectedScopeKey: snapshot.scopeKey, signal: scope.lifetime.signal,
        }), scope.lifetime);
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) {
          return { ok: false as const, error: createProviderErrorV1('provider_catalog_unavailable', identity) };
        }
        throw error;
      }
      snapshot = readSnapshot();
      if (!isProviderFeatureEnabled()) return { ok: false as const, error: providerFeatureDisabled(identity).error };
      if (catalog.status !== 'ready') return { ok: false as const, error: catalogAdmissionError(catalog, identity) };
      if (!snapshot) return { ok: false as const, error: createProviderErrorV1('provider_authorization_changed', identity) };
    }
    const scopedAccountSettingsBasisIsCurrent = !settingsBasis
      && scope.accountSettingsBasis !== undefined
      && scope.accountSettingsBasis.scopeKey === snapshot?.scopeKey;
    if (!settingsBasis && scope.accountSettingsBasis && !scopedAccountSettingsBasisIsCurrent) {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', identity),
      };
    }
    // Nested phases consume the admitted model/settings facts. Only Account
    // identity and the caller's local cancellation can withdraw this work.
    const accountSettings = settingsBasis?.snapshot.settings
      ?? (scopedAccountSettingsBasisIsCurrent
        ? scope.accountSettingsBasis!.accountSettings
        : snapshot!.settings);
    const settingsRead = settingsBasis?.settingsRead
      ?? (scopedAccountSettingsBasisIsCurrent
        ? scope.accountSettingsBasis!.settingsRead
        : readProviderSettingsForCli(snapshot!));
    const admittedAccountSettingsBasis = settingsBasis
      ? scope.accountSettingsBasis
      : scopedAccountSettingsBasisIsCurrent
        ? scope.accountSettingsBasis
        : snapshot?.scopeKey
          ? {
              scopeKey: snapshot.scopeKey,
              settingsVersion: snapshot.settingsVersion,
              providerConnectionsCatalog: snapshot.providerConnectionsCatalog,
              accountSettings: snapshot.settings,
              settingsRead,
            }
          : undefined;
    const providerSettings = settingsRead.settings;
    let registry = scope.registry;
    if (!registry) {
      try {
        registry = await awaitWithinProviderOperation(
          Promise.resolve().then(() => resolveRegistry()),
          scope.lifetime,
        );
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            ok: false as const,
            error: createProviderErrorV1('provider_endpoint_unavailable', identity),
          };
        }
        throw error;
      }
    }
    if (!registry) {
      throw new TypeError('Provider contribution registry resolution returned no registry');
    }
    if (!isProviderFeatureEnabled()) {
      return { ok: false as const, error: providerFeatureDisabled(identity).error };
    }
    if (
      scope.dnsEvidenceByConnectionId
      && !scope.dnsEvidenceByConnectionId.has(identity.connectionId)
    ) {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', identity),
      };
    }
    let dnsEvidenceByEndpointUrl = scope.dnsEvidenceByConnectionId?.get(identity.connectionId);
    if (!scope.dnsEvidenceByConnectionId) {
      try {
        dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
          connectionId: identity.connectionId,
          machineId: identity.machineId,
          providerSettings,
          registry,
          ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
          admitResolution: scheduler.runDns,
          isCurrent: isProviderFeatureEnabled,
          lifetime: scope.lifetime,
        });
      } catch (error) {
        if (error instanceof ProviderProbeAdmissionCapacityError) {
          return {
            ok: false as const,
            error: createProviderErrorV1('provider_probe_capacity_exhausted', identity),
          };
        }
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            ok: false as const,
            error: createProviderErrorV1('provider_endpoint_unavailable', identity),
          };
        }
        throw error;
      }
    }
    if (!dnsEvidenceByEndpointUrl) {
      return {
        ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', identity),
      };
    }
    if (!isProviderFeatureEnabled()) {
      return { ok: false as const, error: providerFeatureDisabled(identity).error };
    }
    const resolution = resolveProviderConnectionForMachineFromSettingsRead({
      ...identity,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    }, settingsRead);
    if (resolution.status !== 'resolved') {
      return { ok: false as const, error: providerConnectionResolutionError(resolution, identity.machineId) };
    }
    return {
      ok: true as const,
      value: {
        connection: resolution.record,
        readSnapshot,
        accountReadScope: scope.accountReadScope,
        isAccountCurrent: scope.isAccountCurrent,
        savedSecretOperationContext: scope.savedSecretOperationContext,
        managedRuntimeAccount: scope.managedRuntimeAccount,
        snapshot,
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
          isCurrent: () => !scope.lifetime.signal?.aborted,
        }),
        providerSettings,
        settingsRead,
        accountSettings,
        savedSecretResources: snapshot?.savedSecretResources,
        resolveManagedPurposeBindingIntent: settingsBasis?.resolveManagedPurposeBindingIntent
          ?? scope.resolveManagedPurposeBindingIntent ?? (scope.getAccountSettingsSnapshot ? undefined : input.resolveManagedPurposeBindingIntent),
        registry,
        dnsEvidenceByEndpointUrl,
        ...(admittedAccountSettingsBasis
          ? { accountSettingsBasis: admittedAccountSettingsBasis }
          : {}),
        ...(scope.resolveContributedCatalogParsers
          ? {
              resolveContributedCatalogParsers:
                scope.resolveContributedCatalogParsers,
            }
          : {}),
        lifetime: scope.lifetime,
      },
    };
  }

  async function resolveSavedFromConnectionContext(
    identity: Readonly<{ connectionId: string; machineId: string }>,
    context: Omit<Extract<Awaited<ReturnType<typeof resolveConnectionContext>>, { ok: true }>['value'], 'readSnapshot' | 'snapshot'>,
    mode: SavedProbeMode,
    savedSecretResources = context.savedSecretResources,
    admitSelectedCredentials?: (additionalCredentials: Parameters<typeof admitRuntimeProviderSavedSecret>[0]['additionalCredentials']) => Promise<
      Readonly<{ ok: true; snapshot: ActiveAccountSettingsSnapshot }> | Readonly<{ ok: false; error: ProviderErrorV1 }>
    >,
  ): Promise<SavedResolutionResult> {
    const {
      connection,
      providerSettings,
      settingsRead,
      accountSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      resolveContributedCatalogParsers: operationParserResolver,
      accountSettingsBasis,
      lifetime,
      resolveManagedPurposeBindingIntent,
    } = context;
    let savedSecretMaterializer = context.savedSecretMaterializer;
    if (!isProviderFeatureEnabled()) {
      return { ok: false, error: providerFeatureDisabled(identity).error };
    }
    if (!connection.authorization.authorized) {
      return { ok: false, error: createProviderErrorV1(connection.authorization.errorCode, identity) };
    }
    const catalog = sourceCatalog(connection);
    const catalogProbes = 'probes' in catalog ? catalog.probes : [];
    // Availability checks must remain one exact plugin-declared request. Catalog
    // refresh keeps the provider's ordered probe/fallback behavior, while health
    // prefers the explicit availability request and never guesses between
    // multiple catalog probes.
    const availabilityProbe = connection.source.kind === 'contribution'
      ? connection.source.definition.discovery?.availabilityProbe
      : undefined;
    const selectedProbes = mode === 'health'
      ? availabilityProbe
        ? [availabilityProbe]
        : catalogProbes.length === 1 ? catalogProbes : []
      : catalogProbes.length > 0
        ? catalogProbes
        : availabilityProbe ? [availabilityProbe] : [];
    const probes = connection.deployment.kind === 'managedLocal' && mode === 'health'
      ? []
      : selectedProbes;
    const catalogFallback = mode === 'catalog' ? sourceCatalogFallback(connection) : undefined;
    // A declared catalog format the host does not bundle is implemented by the
    // declaring plugin. Resolve it once per request so both deployments reach
    // exactly the same implementation the declaration names.
    const contributedFormats = connection.source.kind === 'contribution'
      ? readContributedProviderCatalogParserIds(
          connection.source.definition as unknown as Readonly<Record<string, unknown>>,
        )
      : [];
    const needsContributedCatalogParsers = contributedFormats.length > 0
      && connection.source.kind === 'contribution'
      && (probes.some((probe) => contributedFormats.includes(probe.parser))
        // The command fallback declares a format from the same contributed
        // vocabulary, so a plugin whose only contributed format serves the
        // fallback must still reach its own implementation.
        || (catalogFallback ? contributedFormats.includes(catalogFallback.parser) : false));
    const contributedCatalogParsers = needsContributedCatalogParsers && connection.source.kind === 'contribution'
      ? await awaitWithinProviderOperation(
          (operationParserResolver ?? resolveContributedCatalogParsers)({
            pluginId: connection.source.pluginId,
            localId: connection.source.definition.id,
          }),
          lifetime,
        )
      : null;
    if (needsContributedCatalogParsers && (!contributedCatalogParsers || connection.source.kind !== 'contribution'
      || contributedCatalogParsers.pluginId !== connection.source.pluginId)) {
      return { ok: false, error: createProviderErrorV1('provider_contribution_unavailable', identity) };
    }
    if (connection.deployment.kind === 'managedLocal') {
      if (mode === 'health') {
        return {
          ok: true,
          value: {
            connection,
            providerSettings,
            registry,
            dnsEvidenceByEndpointUrl,
            ...(accountSettingsBasis ? { accountSettingsBasis } : {}),
            request: {
              ...identity,
              endpoints: [],
              probes: [],
              observationAuthorizationFingerprints: [],
              authorizationGrant: {
                kind: connection.authorization.grantKind,
                fingerprint: connection.authorization.grantFingerprint,
                confirmedAt: connection.authorization.grantConfirmedAt,
              },
            },
          },
        };
      }
      if (connection.source.kind !== 'contribution') {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', identity),
        };
      }
      const contributionSource = connection.source;
      const managedDeployment = connection.deployment;
      const contribution = registry.providersByContributionKey.get(
        contributionSource.contributionKey,
      );
      const sourceRegistryVersion = 'sourceRegistryVersion' in catalog
        ? catalog.sourceRegistryVersion
        : undefined;
      const managedEndpointTemplateIds = new Set(
        probes.map((probe) => probe.endpointTemplateId),
      );
      if (catalogFallback) {
        managedEndpointTemplateIds.add(catalogFallback.endpointTemplateId);
      }
      const endpointTemplates = [...managedEndpointTemplateIds].map(
        (endpointTemplateId) => contributionSource.definition.endpointTemplates.find(
          (candidate) => candidate.id === endpointTemplateId,
        ),
      );
      const contributionManagedRuntime =
        contribution?.definition.managedRuntime
          ? resolveProviderManagedRuntimeDeclarationV1({
              implementationIdentity: contribution.identity,
              managedRuntime: contribution.definition.managedRuntime,
            })
          : null;
      if (
        !contribution
        || !contribution.definition.managedRuntime
        || !contributionManagedRuntime
        || (catalog.source !== 'static' && (probes.length === 0 || sourceRegistryVersion === undefined))
        || endpointTemplates.some((endpointTemplate) => !endpointTemplate)
        || endpointTemplates.some((endpointTemplate) =>
          !managedDeployment.managedRuntime.endpointTemplateIds.includes(
            endpointTemplate!.id,
          ))
        || createProviderManagedRuntimeDeclarationEqualityKeyV1({
          implementationIdentity: contribution.identity,
          managedRuntime: contributionManagedRuntime,
        })
          !== createProviderManagedRuntimeDeclarationEqualityKeyV1({
            implementationIdentity: managedDeployment.implementationIdentity,
            managedRuntime: managedDeployment.managedRuntime,
          })
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', identity),
        };
      }
      if (!resolveManagedPurposeBindingIntent) {
        return {
          ok: false,
          error: createProviderErrorV1(
            'provider_connection_invalid',
            identity,
          ),
        };
      }
      let purposeBindingResolution;
      try {
        purposeBindingResolution =
          await observeProviderOperationPhase(lifetime, 'purpose_bindings', () =>
            awaitAbortableWithinProviderOperation(signal => resolveManagedProviderPurposeBindingSnapshot({
              implementationIdentity: managedDeployment.implementationIdentity,
              connectedAccounts: managedDeployment.managedRuntime.connectedAccounts ?? [],
              purposeBindingIntents: managedDeployment.purposeBindingIntents,
              resolveBindingIntent: resolveManagedPurposeBindingIntent,
              signal,
            }), lifetime));
      } catch (error) {
        return {
          ok: false,
          error: providerManagedPurposeBindingError(error, identity),
        };
      }
      if (!isProviderFeatureEnabled()) {
        return { ok: false, error: providerFeatureDisabled(identity).error };
      }
      // Static catalogs still admit the exact managed declaration and current
      // purpose bindings, but have no transport observation to authorize.
      // The catalog assembler remains the authority for their declared rows.
      if (catalog.source === 'static') {
        return {
          ok: true,
          value: {
            connection, providerSettings, registry, dnsEvidenceByEndpointUrl,
            ...(accountSettingsBasis ? { accountSettingsBasis } : {}),
            request: {
              ...identity, endpoints: [], probes: [], observationAuthorizationFingerprints: [],
              authorizationGrant: {
                kind: connection.authorization.grantKind,
                fingerprint: connection.authorization.grantFingerprint,
                confirmedAt: connection.authorization.grantConfirmedAt,
              },
            },
          },
        };
      }
      if (sourceRegistryVersion === undefined) {
        return { ok: false, error: createProviderErrorV1('provider_probe_authorization_invalid', identity) };
      }
      const managedSources = endpointTemplates.map((endpointTemplate) => ({
        implementationIdentity: managedDeployment.implementationIdentity,
        managedRuntime: managedDeployment.managedRuntime,
        purposeBindings: purposeBindingResolution,
        endpointTemplateId: endpointTemplate!.id,
        protocol: endpointTemplate!.protocol,
        sourceRegistryVersion,
        publicHeaders: endpointTemplate!.publicHeaders ?? {},
      } as const));
      const managedSourceByEndpointTemplateId = new Map(
        managedSources.map((source) => [source.endpointTemplateId, source] as const),
      );
      const authorizationFingerprints = new Set<ProviderObservationAuthorizationFingerprintV1>();
      for (const probe of probes) {
        const managedSource = managedSourceByEndpointTemplateId.get(probe.endpointTemplateId);
        if (!managedSource) {
          return {
            ok: false,
            error: createProviderErrorV1('provider_probe_authorization_invalid', identity),
          };
        }
        const probeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
          ...managedSource,
          method: 'GET',
          path: probe.path,
          parser: probe.parser,
        });
        const resolvedAuthorization = resolveProviderProbeAuthorization({
          request: {
            deployment: 'managedLocal',
            ...identity,
            implementationIdentity: managedSource.implementationIdentity,
            managedRuntime: managedSource.managedRuntime,
            purposeBindings: managedSource.purposeBindings,
            endpointTemplateId: managedSource.endpointTemplateId,
            protocol: managedSource.protocol,
            sourceRegistryVersion: managedSource.sourceRegistryVersion,
            path: probe.path,
            parser: probe.parser,
            probeRequestFingerprint,
          },
          managedPurposeBindingSnapshot: purposeBindingResolution,
          accountSettings,
          savedSecretMaterializer,
          providerSettings,
          settingsRead,
          registry,
          dnsEvidenceByEndpointUrl,
          ...(input.localCandidateUrlsByConnectionId
            ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
            : {}),
        });
        if (!resolvedAuthorization.ok) {
          return { ok: false, error: resolvedAuthorization.error };
        }
        authorizationFingerprints.add(
          resolvedAuthorization.observationAuthorizationFingerprint,
        );
      }
      return {
        ok: true,
        value: {
          connection,
          providerSettings,
          registry,
          dnsEvidenceByEndpointUrl,
          ...(accountSettingsBasis ? { accountSettingsBasis } : {}),
          request: {
            ...identity,
            endpoints: [],
            probes,
            managedSources,
            ...(contributedCatalogParsers ? { contributedCatalogParsers } : {}),
            observationAuthorizationFingerprints: [...authorizationFingerprints].sort(),
            authorizationGrant: {
              kind: connection.authorization.grantKind,
              fingerprint: connection.authorization.grantFingerprint,
              confirmedAt: connection.authorization.grantConfirmedAt,
            },
          },
        },
      };
    }
    const credential = connection.source.kind === 'contribution'
      ? connection.source.definition.credential
      : connection.source.template.credential;
    if (admitSelectedCredentials) {
      const protocols = new Set(probes.flatMap(probe => connection.endpoints
        .filter(endpoint => endpoint.endpointTemplateId === probe.endpointTemplateId).map(endpoint => endpoint.protocol)));
      const additionalCredentials = credential?.transports.filter(transport => transport.uses.includes('probe')
        && transport.protocols.some(protocol => protocols.has(protocol))).flatMap(transport => transport.additionalCredentials ?? []);
      const admission = await admitSelectedCredentials(additionalCredentials);
      if (!admission.ok) return admission;
      savedSecretResources = admission.snapshot.savedSecretResources;
      savedSecretMaterializer = createSavedSecretMaterializerFromSnapshotV1(admission.snapshot, {
        isCurrent: () => !lifetime.signal?.aborted,
      });
    }
    const endpoints: ProviderProbeEndpoint[] = connection.endpoints.map((endpoint) => ({
      endpointTemplateId: endpoint.endpointTemplateId,
      protocol: endpoint.protocol,
      normalizedUrl: endpoint.normalizedUrl,
      publicHeaders: endpoint.publicHeaders,
      credentialPolicy: credential === undefined
        ? 'none'
        : credential.required ? 'required' : 'optional',
    }));
    const authorizationFingerprints = new Set<ProviderObservationAuthorizationFingerprintV1>();
    for (const probe of probes) {
      const endpoint = connection.endpoints.find((candidate) => candidate.endpointTemplateId === probe.endpointTemplateId);
      if (!endpoint) throw new TypeError('Resolved provider probe endpoint is absent');
      const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
        method: 'GET',
        endpointUrl: endpoint.normalizedUrl,
        path: probe.path,
        parser: probe.parser,
        publicHeaders: endpoint.publicHeaders,
      });
      const resolvedAuthorization = resolveProviderProbeAuthorization({
        request: {
          ...identity,
          endpointTemplateId: endpoint.endpointTemplateId,
          endpointUrl: endpoint.normalizedUrl,
          protocol: endpoint.protocol,
          path: probe.path,
          parser: probe.parser,
          probeRequestFingerprint,
        },
        accountSettings,
        savedSecretResources,
        savedSecretMaterializer,
        providerSettings,
        settingsRead,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      if (!resolvedAuthorization.ok) return { ok: false, error: resolvedAuthorization.error };
      authorizationFingerprints.add(resolvedAuthorization.observationAuthorizationFingerprint);
    }
    return {
      ok: true,
      value: {
        connection,
        providerSettings,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(accountSettingsBasis ? { accountSettingsBasis } : {}),
        request: {
          ...identity,
          endpoints,
          probes,
          ...(catalogFallback ? { catalogFallback } : {}),
          ...(contributedCatalogParsers ? { contributedCatalogParsers } : {}),
          observationAuthorizationFingerprints: Object.freeze([...authorizationFingerprints].sort()),
          authorizationGrant: {
            kind: connection.authorization.grantKind,
            fingerprint: connection.authorization.grantFingerprint,
            confirmedAt: connection.authorization.grantConfirmedAt,
          },
        },
      },
    };
  }

  async function resolveSaved(
    identity: Readonly<{ connectionId: string; machineId: string }>,
    mode: SavedProbeMode = 'catalog',
    scope: RuntimeProviderOperationScope,
    admittedSnapshot?: ActiveAccountSettingsSnapshot,
  ): Promise<SavedResolutionResult> {
    if (!isProviderFeatureEnabled()) {
      return { ok: false, error: providerFeatureDisabled(identity).error };
    }
    const context = await resolveConnectionContext(identity, scope);
    if (!isProviderFeatureEnabled()) {
      return { ok: false, error: providerFeatureDisabled(identity).error };
    }
    if (!context.ok) return context;
    return resolveSavedFromAdmittedContext(identity, context.value, mode, scope, admittedSnapshot);
  }

  async function resolveSavedFromAdmittedContext(
    identity: RuntimeProviderIdentity,
    context: Extract<Awaited<ReturnType<typeof resolveConnectionContext>>, { ok: true }>['value'],
    mode: SavedProbeMode,
    scope: RuntimeProviderOperationScope,
    admittedSnapshot?: ActiveAccountSettingsSnapshot,
  ): Promise<SavedResolutionResult> {
    const snapshot = context.snapshot;
    if (!snapshot) return { ok: false, error: createProviderErrorV1('provider_authorization_changed', identity) };
    if (admittedSnapshot && admittedSnapshot.scopeKey !== snapshot.scopeKey) {
      return { ok: false, error: createProviderErrorV1('provider_authorization_changed', identity) };
    }
    let savedSecretSnapshot = admittedSnapshot ?? snapshot;
    let references: SavedSecretOperationReferenceV1[] = [];
    const resolved = await resolveSavedFromConnectionContext(identity, context, mode, savedSecretSnapshot.savedSecretResources,
      async additionalCredentials => {
        const definition = context.connection.source.kind === 'contribution'
          ? context.connection.source.definition : context.connection.source.template;
        references = definition.credential ? [definition.credential.slotId, ...(additionalCredentials ?? []).map(row => row.slotId)]
          .flatMap(slotId => {
            const ref = resolveProviderSecretBindingIdV1(context.providerSettings, identity.connectionId, identity.machineId, slotId);
            return ref ? [{ ref }] : [];
          }) : [];
        // Catalog and health in one operation share the authoritative catalog observation.
        if (admittedSnapshot) return { ok: true, snapshot: savedSecretSnapshot };
        const admission = await admitRuntimeProviderSavedSecret({
          connection: context.connection, providerSettings: context.providerSettings,
          snapshot: savedSecretSnapshot, getAccountSettingsSnapshot: scope.getAccountSettingsSnapshot ?? getSnapshot,
          lifetime: scope.lifetime, additionalCredentials,
          ...(scope.getAccountSettingsSnapshot ? { operationContext: scope.savedSecretOperationContext ?? null } : {}),
        });
        if (admission.ok) savedSecretSnapshot = admission.snapshot;
        return admission;
      });
    // This closure belongs to the admitted phase. Metadata resolution leaves it
    // unused; all authenticated requests in the phase share its acquisition.
    let materializer: ReturnType<typeof acquireSavedSecretMaterializerForOperation> | undefined;
    const resolveSavedSecretMaterializer = (signal?: AbortSignal) => materializer ??= acquireSavedSecretMaterializerForOperation({
      snapshot: savedSecretSnapshot,
      references,
      operationContext: scope.savedSecretOperationContext ?? undefined,
      secretSources: input.secretSources,
      signal,
      isCurrent: () => (scope.getAccountSettingsSnapshot ?? getSnapshot)()?.scopeKey === savedSecretSnapshot.scopeKey
        && !signal?.aborted,
    });
    return resolved.ok
      ? { ok: true, value: { ...resolved.value, savedSecretSnapshot, resolveSavedSecretMaterializer } }
      : resolved;
  }

  const projectResolvedCatalogContext = (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    resolved: SavedResolution,
    runtimeState: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
    modelNameCatalog = readProviderModelNameCatalog(resolved.registry),
  ) => {
    const request = resolved.request;
    const catalogFingerprint = request.probes.length === 0
      ? null
      : createProviderCatalogRefreshFingerprint(request);
    return projectProviderCatalogContextRuntimeState({
      status: 'success' as const,
      connection: resolved.connection,
      modelNameCatalog,
      providerSettings: resolved.providerSettings,
      runtimeState,
      allowedObservationAuthorizationFingerprints: request.observationAuthorizationFingerprints,
      expectedEndpointObservations: expectedEndpointObservations(request),
      catalogFingerprint,
      catalogRuntimeRecord: null,
      catalogRuntimeKey: null,
    }, runtimeState);
  };

  const resolveCatalogContext = async (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    runtimeStateOverride?: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
    scope?: RuntimeProviderOperationScope,
  ) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const resolved = await resolveSaved(identity, 'catalog', withOperationLifetime(scope));
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const runtimeState = runtimeStateOverride ?? await runtimeStore.read();
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    return projectResolvedCatalogContext(identity, resolved.value, runtimeState);
  };

  const resolvePresentationCatalogContext = async (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    runtimeStateOverride?: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
    scope?: RuntimeProviderOperationScope,
    settingsBasis?: RuntimeProviderPresentationResolutionBasis,
  ) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const connectionContext = await resolveConnectionContext(
      identity,
      withOperationLifetime(scope),
      settingsBasis,
    );
    if (!connectionContext.ok) {
      return { status: 'error' as const, error: connectionContext.error };
    }
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const runtimeState = runtimeStateOverride ?? await runtimeStore.read();
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    if (!connectionContext.value.connection.authorization.authorized) {
      return {
        status: 'success' as const,
        connection: connectionContext.value.connection,
        modelNameCatalog: settingsBasis?.modelNameCatalog
          ?? readProviderModelNameCatalog(connectionContext.value.registry),
        providerSettings: connectionContext.value.providerSettings,
        runtimeState,
        allowedObservationAuthorizationFingerprints: [] as const,
        expectedEndpointObservations: [] as const,
        catalogFingerprint: null,
        catalogRuntimeRecord: null,
        catalogRuntimeKey: null,
      };
    }
    let resolved;
    try {
      resolved = await resolveSavedFromConnectionContext(identity, connectionContext.value, 'catalog');
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          status: 'error' as const,
          error: createProviderErrorV1('provider_endpoint_unavailable', identity),
        };
      }
      throw error;
    }
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    return projectResolvedCatalogContext(identity, resolved.value, runtimeState, settingsBasis?.modelNameCatalog);
  };

  const runResolvedCatalogProbe = createResolvedProviderProbeRunner({
    refresh: (request, lifetime) => catalogService.refresh({
      ...request,
      ...(lifetime ? { wallDeadlineAtMs: lifetime.wallDeadlineAtMs } : {}),
    }),
    schedule: (key, trigger, operation, options) => scheduler.runCatalog(key, trigger, operation, options),
  });

  const runResolvedHealthProbe = createResolvedProviderProbeRunner({
    refresh: (request, lifetime) => request.probes.length === 1
      ? healthProbeService.refresh({
          ...request,
          ...(lifetime ? { wallDeadlineAtMs: lifetime.wallDeadlineAtMs } : {}),
        })
      : Promise.resolve({ status: 'not_supported' as const }),
    schedule: (key, trigger, operation, options) => scheduler.runHealth(key, trigger, operation, options),
  });

  async function readPlacedGatewayCatalog<T extends ProviderCatalogRefreshResult | ProviderSavedModelsRpcResult | DaemonProviderModelProjectionResponseV1>(
    identity: RuntimeProviderIdentity,
    context: Extract<Awaited<ReturnType<typeof resolveConnectionContext>>, { ok: true }>['value'],
    read: (reader: ReturnType<typeof createAccountScopedProviderCatalogReader> & Readonly<{
      project: ReturnType<typeof createAccountScopedProviderModelProjectionReader>;
    }>, target: RuntimeProviderIdentity, signal: AbortSignal) => Promise<T>,
  ): Promise<T | Readonly<{ status: 'error'; error: ProviderErrorV1 }> | null> {
    const { connection } = context;
    const placement = connection.connection.gatewayPlacement;
    if (connection.deployment.kind !== 'managedLocal'
      || !isRemoteProviderGatewayPlacement(placement, identity.machineId)) return null;
    if (!connection.authorization.authorized) return {
      status: 'error', error: createProviderErrorV1(connection.authorization.errorCode, identity),
    };
    if (connection.deployment.managedRuntime.sharing !== 'connectionMachine') return {
      status: 'error', error: createProviderErrorV1('provider_connection_invalid', identity),
    };
    if (context.accountReadScope === null) return {
      status: 'error', error: createProviderErrorV1('provider_authorization_changed', identity),
    };
    const admittedScope = {
      lifetime: context.lifetime, registry: context.registry,
      accountSettingsBasis: context.accountSettingsBasis,
      dnsEvidenceByConnectionId: new Map([[identity.connectionId, context.dnsEvidenceByEndpointUrl]]),
      getAccountSettingsSnapshot: context.readSnapshot,
      accountReadScope: context.accountReadScope,
      resolveManagedPurposeBindingIntent: context.resolveManagedPurposeBindingIntent,
      isAccountCurrent: context.isAccountCurrent,
      savedSecretOperationContext: context.savedSecretOperationContext,
      managedRuntimeAccount: context.managedRuntimeAccount,
    };
    // Resolve the hub's source from the peer's admitted catalog, including the
    // hub grant, through the same owner that authorizes a local probe.
    const hub = await resolveSaved({ ...identity, machineId: placement.machineId }, 'catalog', admittedScope);
    if (!hub.ok) return { status: 'error', error: hub.error };
    const readerInput = context.accountReadScope ?? (() => {
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      return {
        serverUrl: resolveServerHttpBaseUrl(), readCredentials: readStoredCredentials,
        readAccountSettingsSnapshot: async () => context.readSnapshot(),
        isCurrent: () => isProviderFeatureEnabled() && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken,
      };
    })();
    const reader = { ...createAccountScopedProviderCatalogReader(readerInput),
      project: createAccountScopedProviderModelProjectionReader(readerInput) };
    let result: T;
    try {
      result = await awaitAbortableWithinProviderOperation(signal => read(reader, {
        ...identity, machineId: placement.machineId,
      }, signal), context.lifetime);
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) return {
        status: 'error', error: createProviderErrorV1('provider_catalog_unavailable', identity),
      };
      throw error;
    }
    // A hub reply cannot authorize its requesting peer. Revalidate the exact
    // admitted catalog after transport before disclosing models to that peer.
    const current = await resolveConnectionContext(identity, admittedScope);
    if (!current.ok) return { status: 'error', error: current.error };
    if (!current.value.connection.authorization.authorized) return { status: 'error',
      error: createProviderErrorV1(current.value.connection.authorization.errorCode, identity) };
    if (result.status === 'success') {
      if ('connectionRevision' in result) {
        if (result.connectionRevision !== connection.connection.revision) return {
          status: 'error', error: createProviderErrorV1('provider_authorization_changed', identity),
        };
      } else if ('requestFingerprint' in result) {
        const request = hub.value.request;
        const fingerprints = request.probes.flatMap(probe => {
          const source = request.managedSources?.find(source => source.endpointTemplateId === probe.endpointTemplateId);
          return source ? [createProviderManagedProbeRequestFingerprintV1({ ...source, method: 'GET',
            path: probe.path, parser: probe.parser })] : [];
        });
        if (!fingerprints.includes(result.requestFingerprint)) return {
          status: 'error', error: createProviderErrorV1('provider_authorization_changed', identity),
        };
      } else if ('groups' in result && result.groups.some(group => (
        group.connectionId !== identity.connectionId
        || group.connectionRevision !== connection.connection.revision
        || group.sourceAuthority?.connectionSecurityFingerprint !== connection.connectionSecurityFingerprint
        || connection.deployment.kind !== 'managedLocal'
        || group.sourceAuthority?.provider.identity.pluginId !== connection.deployment.implementationIdentity.pluginId
        || group.sourceAuthority?.provider.identity.localId !== connection.deployment.implementationIdentity.localId
        || group.rows.some(row => row.ref.providerConnectionId !== identity.connectionId
          || row.ref.agentTargetKey !== result.agentTargetKey || row.descriptor.id !== row.ref.modelId)
      ))) {
        return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', identity) };
      }
    }
    return result;
  }

  const readPlacedModelProjection: RuntimeProviderServices['readPlacedModelProjection'] = async (request, scope) => {
    const identity = { connectionId: request.sourceConnectionId, machineId: request.machineId };
    const context = await resolveConnectionContext(identity, scope);
    if (!context.ok) return { status: 'error', error: context.error };
    return readPlacedGatewayCatalog(identity, context.value, (reader, target, signal) => reader.project({
      ...createAccountConnectionModelProjectionRequest({ machineId: target.machineId,
        connectionId: context.value.connection.connectionId,
        expectedConnectionSecurityFingerprint: context.value.connection.connectionSecurityFingerprint,
        agentTargetKey: request.agentTargetKey, refreshPolicy: request.refreshPolicy }),
      sourceCatalog: true, ...(request.forceRefresh ? { forceRefresh: true } : {}),
      ...(request.currentSelection ? { currentSelection: request.currentSelection } : {}),
      ...(request.favoriteSelections ? { favoriteSelections: request.favoriteSelections } : {}),
    }, signal));
  };

  async function probeSaved(
    identity: RuntimeProviderIdentity,
    trigger: 'manual_refresh' | 'enable',
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ): Promise<ProviderCatalogRefreshResult> {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const diagnostics = createProviderOperationPhaseObserver(waiterLifetime?.reportOperationDiagnostics);
    const operation = withOperationLifetime(undefined, waiterLifetime?.signal);
    const scope = { ...operation, lifetime: { ...operation.lifetime, diagnostics } };
    try {
      return await observeProviderOperationPhase(scope.lifetime, 'catalog', async () => {
        const unavailable = await refreshAmbientCatalog(identity, scope.lifetime);
        if (unavailable) return { status: 'error', error: unavailable };
        const context = await resolveConnectionContext(identity, scope);
        if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
        if (!context.ok) return { status: 'error', error: context.error };
        const remote = await readPlacedGatewayCatalog(identity, context.value,
          (reader, target, signal) => reader.probe(target, signal));
        if (remote) return remote;
        const resolved = await resolveSaved(identity, 'catalog', {
          ...scope, registry: context.value.registry,
          accountSettingsBasis: context.value.accountSettingsBasis,
          dnsEvidenceByConnectionId: new Map([[identity.connectionId, context.value.dnsEvidenceByEndpointUrl]]),
        });
        if (!resolved.ok) return { status: 'error', error: resolved.error };
        return await runResolvedCatalogProbe({ ...resolved.value.request, operationScope: {
          registry: resolved.value.registry,
          resolveSavedSecretMaterializer: resolved.value.resolveSavedSecretMaterializer,
          ...(resolved.value.accountSettingsBasis ? { accountSettingsBasis: resolved.value.accountSettingsBasis } : {}),
          dnsEvidenceByConnectionId: new Map([[identity.connectionId, resolved.value.dnsEvidenceByEndpointUrl]]),
          // Shared scheduler work retains the containing deadline, independently
          // of one waiter's cancellation interest.
          lifetime: { wallDeadlineAtMs: scope.lifetime.wallDeadlineAtMs, diagnostics },
        } }, trigger, withProviderFeatureCurrentness(waiterLifetime), scope.lifetime);
      });
    } finally { diagnostics.finish(); }
  }

  const hasFreshExactHealthObservation = async (
    request: ResolvedProviderProbeRpcRequest,
  ): Promise<boolean> => {
    const expectedEndpoint = request.probes.length === 1
      ? expectedEndpointObservations(request)[0] ?? null
      : null;
    const observationAuthorizationFingerprint = request.observationAuthorizationFingerprints.length === 1
      ? request.observationAuthorizationFingerprints[0]
      : null;
    if (!expectedEndpoint || !observationAuthorizationFingerprint) return false;
    const state = await runtimeStore.read();
    const record = state.endpointHealth.find((candidate) =>
      candidate.key.machineId === request.machineId
      && candidate.key.connectionId === request.connectionId
      && candidate.key.endpointTemplateId === expectedEndpoint.endpointTemplateId
      && candidate.key.endpointFingerprint === expectedEndpoint.endpointFingerprint
      && candidate.key.observationAuthorizationFingerprint === observationAuthorizationFingerprint);
    return record !== undefined
      && 'observedAt' in record.state
      && Date.now() < record.state.observedAt + PROVIDER_HEALTH_REFRESH_TTL_MS;
  };

  const hasFreshExactCatalogObservation = async (
    request: ResolvedProviderProbeRpcRequest,
  ): Promise<boolean> => {
    if (request.probes.length === 0) return false;
    const state = await runtimeStore.read();
    const record = selectCurrentProviderCatalogRuntimeRecord({
      state,
      machineId: request.machineId,
      connectionId: request.connectionId,
      catalogFingerprint: createProviderCatalogRefreshFingerprint(request),
      allowedObservationAuthorizationFingerprints: request.observationAuthorizationFingerprints,
    });
    const snapshot = record?.state.snapshot;
    return snapshot !== null
      && snapshot !== undefined
      && !snapshot.stale
      && Date.now() < snapshot.observedAt + PROVIDER_CATALOG_REFRESH_TTL_MS;
  };

  const manualProbe = createProviderSavedProbeRpcHandler({
    machineId: input.machineId,
    probe: (identity, waiterLifetime) => probeSaved(identity, 'manual_refresh', waiterLifetime),
  });
  const enableProbe = createProviderSavedProbeRpcHandler({
    machineId: input.machineId,
    probe: (identity, waiterLifetime) => probeSaved(identity, 'enable', waiterLifetime),
  });
  const probe = (
    rawInput: unknown,
    trigger: 'manual_refresh' | 'enable' = 'manual_refresh',
    waiterLifetime?: ProviderProbeWaiterLifetime,
  ) => trigger === 'enable'
    ? enableProbe(rawInput, waiterLifetime)
    : manualProbe(rawInput, waiterLifetime);

  /**
   * Runs one admitted demand refresh and reports its typed outcome: `null`
   * when the connection ends with a usable observation (fresh or newly
   * probed), and the existing typed Provider error when the refresh cannot
   * produce one. Awaited cold reads and explicit retries consume this outcome;
   * warm automatic callers may ignore it, exactly as before.
   */
  const scheduleDemandRefresh = async (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    trigger: 'detail_open' | 'picker_open' | 'manual_refresh',
    scope?: RuntimeProviderOperationScope,
  ): Promise<ProviderErrorV1 | null> => {
    let catalogUsable = false;
    try {
      if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity).error;
      const operationScope = withOperationLifetime(scope);
      const catalog = await resolveSaved(identity, 'catalog', operationScope);
      if (!catalog.ok) return catalog.error;
      if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity).error;
      const resolvedDnsEvidenceByConnectionId = operationScope.dnsEvidenceByConnectionId
        ?? new Map([[identity.connectionId, catalog.value.dnsEvidenceByEndpointUrl]]);
      const resolvedAccountSettingsBasis = operationScope.accountSettingsBasis
        ?? catalog.value.accountSettingsBasis;
      if (trigger === 'manual_refresh' || !await hasFreshExactCatalogObservation(catalog.value.request)) {
        if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity).error;
        const admittedScope: RuntimeProviderOperationScope = {
          ...operationScope,
          registry: catalog.value.registry,
          resolveSavedSecretMaterializer: catalog.value.resolveSavedSecretMaterializer,
          ...(operationScope.resolveContributedCatalogParsers
            ? { resolveContributedCatalogParsers: operationScope.resolveContributedCatalogParsers }
            : {}),
          ...(resolvedAccountSettingsBasis
            ? { accountSettingsBasis: resolvedAccountSettingsBasis }
            : {}),
          dnsEvidenceByConnectionId: resolvedDnsEvidenceByConnectionId,
          // The scheduler owns admitted catalog work independently of any one
          // picker waiter. Preserve this operation's already-started wall
          // deadline and exact registry projection, but not its cancellation.
          lifetime: { wallDeadlineAtMs: operationScope.lifetime.wallDeadlineAtMs },
        };
        const catalogRefresh = await runResolvedCatalogProbe(
          { ...catalog.value.request, operationScope: admittedScope },
          trigger,
          withProviderFeatureCurrentness(),
          admittedScope.lifetime,
        );
        if (catalogRefresh.status === 'error') return catalogRefresh.error;
      }
      // From here onward the projection has a usable catalog. Health remains an
      // independent row fact and must never turn that catalog into a failed
      // projection, even when health resolution, admission, or transport fails.
      catalogUsable = true;
      if (!isProviderFeatureEnabled()) return null;
      const health = await resolveSaved(identity, 'health', {
        ...operationScope,
        ...(resolvedAccountSettingsBasis
          ? { accountSettingsBasis: resolvedAccountSettingsBasis }
          : {}),
        dnsEvidenceByConnectionId: resolvedDnsEvidenceByConnectionId,
      }, catalog.value.savedSecretSnapshot);
      if (!health.ok || !isProviderFeatureEnabled() || health.value.request.probes.length !== 1) return null;
      if (await hasFreshExactHealthObservation(health.value.request)) return null;
      if (!isProviderFeatureEnabled()) return null;
      const admittedScope: RuntimeProviderOperationScope = {
        ...operationScope,
        registry: health.value.registry,
        resolveSavedSecretMaterializer: health.value.resolveSavedSecretMaterializer,
        ...(operationScope.resolveContributedCatalogParsers
          ? { resolveContributedCatalogParsers: operationScope.resolveContributedCatalogParsers }
          : {}),
        ...(resolvedAccountSettingsBasis
          ? { accountSettingsBasis: resolvedAccountSettingsBasis }
          : {}),
        dnsEvidenceByConnectionId: resolvedDnsEvidenceByConnectionId,
        lifetime: { wallDeadlineAtMs: operationScope.lifetime.wallDeadlineAtMs },
      };
      await runResolvedHealthProbe(
        { ...health.value.request, operationScope: admittedScope },
        trigger,
        withProviderFeatureCurrentness(),
        admittedScope.lifetime,
      );
      return null;
    } catch {
      return catalogUsable ? null : providerProbeUnavailable(identity).error;
    }
  };

  const modelLoadCatalog = createProviderModelLoadCatalogPort<unknown>({
    resolveSaved: async ({ connectionId, machineId, scope }) => {
      const resolved = await resolveSaved({ connectionId, machineId }, 'catalog', scope);
      if (!resolved.ok) throw new ProviderProbeRpcResolutionError(resolved.error);
      return resolved.value.request;
    },
    runtimeStore,
    refresh: ({ signal, modelId, refreshFrontier, operationScope, ...request }) => {
      // createProviderModelLoadCatalogPort always attaches the admitted scope.
      // Refuse a bypass rather than inventing a second authority or deadline.
      if (!operationScope) throw new TypeError('Provider model-load catalog refresh requires an operation scope');
      return scheduler.runCatalogAfter(
        createResolvedProviderProbeObservationIdentity(request),
        JSON.stringify(['post-model-load', modelId, refreshFrontier]),
        () => catalogService.refresh({
          ...request,
          operationScope,
          wallDeadlineAtMs: operationScope.lifetime.wallDeadlineAtMs,
        }),
        {
          signal,
          isCurrent: isProviderFeatureEnabled,
          unavailable: () => providerProbeUnavailable({
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
          localCapacityUnavailable: () => providerProbeCapacityExhausted({
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        },
      );
    },
  });

  const projectModels = (
    identity: RuntimeProviderIdentity,
    context: Extract<RuntimeProviderCatalogContext, { status: 'success' }>,
  ): ProviderSavedModelsRpcResult => {
    const catalog = sourceCatalog(context.connection);
    const record = context.catalogRuntimeRecord;
    const projected = projectProviderCatalogPresentation({
      modelNameCatalog: context.modelNameCatalog,
      staticModels: staticModels(catalog),
      ...(catalogMembershipPolicy(catalog)
        ? { membershipPolicy: catalogMembershipPolicy(catalog) }
        : {}),
      manualModels: readOwnRecordValue(
        context.providerSettings.manualModelsByConnectionId,
        identity.connectionId,
      ) ?? [],
      probeState: record
        ? { snapshot: record.state.snapshot, staleProbeModels: record.state.staleProbeModels }
        : { snapshot: null, staleProbeModels: [] },
      connectionId: identity.connectionId,
      machineId: identity.machineId,
      catalogRecord: record,
      loadRecords: context.runtimeState.modelLoadStates,
      probeConfidence: context.connection.deployment.kind === 'managedLocal'
        ? 'account_unverified'
        : 'probe',
    });
    const visibility = (modelId: string): 'visible' | 'hidden_all_agents' => {
      const key = serializeModelVisibilityRefV1({
        scope: 'allAgents', providerConnectionId: context.connection.connectionId, modelId,
      });
      return Object.prototype.hasOwnProperty.call(context.providerSettings.modelVisibilityByRef, key)
        ? 'hidden_all_agents'
        : 'visible';
    };
    const models = [
      ...projected.rows.map(({ row, catalog: rowCatalog, loadState }) => ({
        id: row.descriptor.id,
        descriptor: projectProviderModelGenerationSettings(row.descriptor, context.connection.connection.modelSettings?.[row.descriptor.id]),
        ...(row.descriptor.name ? { name: row.descriptor.name } : {}),
        source: sourceForRow(row),
        stale: rowCatalog.stale
          && row.sources.probe
          && !row.sources.manual
          && row.confidence !== 'verified_static',
        loadState,
        visibility: visibility(row.descriptor.id),
      })),
      ...projected.staleRows.map(({ row, loadState }) => ({
        id: row.descriptor.id,
        descriptor: projectProviderModelGenerationSettings(row.descriptor, context.connection.connection.modelSettings?.[row.descriptor.id]),
        ...(row.descriptor.name ? { name: row.descriptor.name } : {}),
        source: sourceForRow(row),
        stale: true,
        loadState,
        visibility: visibility(row.descriptor.id),
      })),
    ];
    return {
      status: 'success' as const,
      connectionId: identity.connectionId,
      connectionRevision: context.connection.connection.revision,
      manualModelPolicy: sourceCatalog(context.connection).manualModelPolicy,
      modelLoadAction: context.connection.source.kind !== 'contribution'
        || context.connection.source.definition.modelLoad === undefined
        ? 'descriptor_absent' as const
        : input.modelLoadEnabled?.() === true
          ? 'available' as const
          : 'feature_disabled' as const,
      models,
    };
  };

  const models = createProviderSavedModelsRpcHandler({
    machineId: input.machineId,
    models: async (identity, signal): Promise<ProviderSavedModelsRpcResult> => {
      const operationScope = withOperationLifetime(undefined, signal);
      const unavailable = await refreshAmbientCatalog(identity, operationScope.lifetime);
      if (unavailable) return { status: 'error', error: unavailable };
      const connection = await resolveConnectionContext(identity, operationScope);
      if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
      if (!connection.ok) return { status: 'error', error: connection.error };
      const remote = await readPlacedGatewayCatalog(identity, connection.value,
        (reader, target, signal) => reader.models(target, signal));
      if (remote) return remote;
      const context = await resolveCatalogContext(identity, undefined, {
        ...operationScope, registry: connection.value.registry,
        accountSettingsBasis: connection.value.accountSettingsBasis,
        dnsEvidenceByConnectionId: new Map([[identity.connectionId, connection.value.dnsEvidenceByEndpointUrl]]),
      });
      if (context.status === 'error') return context;
      void scheduleDemandRefresh(identity, 'picker_open', operationScope);
      return projectModels(identity, context);
    },
  });

  const probeDraft = (
    request: DaemonProviderDraftProbeRequestV1,
    waiterLifetime?: ProviderProbeWaiterLifetime,
    now: () => number = Date.now,
  ) => isProviderFeatureEnabled()
    ? scheduler.runCatalog(
        createProviderDraftProbeSchedulerKey(request),
        'manual_refresh',
        // Draft resolution and dispatch run inside the admitted slot and are
        // shared between waiters, so the slot carries the deadline only.
        async () => {
          const lifetime = { wallDeadlineAtMs: now() + PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs };
          const snapshot = getSnapshot();
          if (!snapshot?.scopeKey) return providerProbeUnavailable({ connectionId: request.draftConnectionId, machineId: request.machineId });
          try {
            const catalog = snapshot.providerConnectionsCatalog?.status === 'ready'
              ? snapshot.providerConnectionsCatalog
              : await awaitWithinProviderOperation(prepareProviderConnectionsCatalogForCli({ expectedScopeKey: snapshot.scopeKey }), lifetime);
            if (!isProviderFeatureEnabled()) return providerFeatureDisabled({ connectionId: request.draftConnectionId, machineId: request.machineId });
            if (catalog.status !== 'ready') return providerProbeUnavailable({ connectionId: request.draftConnectionId, machineId: request.machineId });
            return draftProbeService.probe(request, lifetime);
          } catch (error) {
            if (error instanceof ProviderOperationAbandonedError) return providerProbeUnavailable({ connectionId: request.draftConnectionId, machineId: request.machineId });
            throw error;
          }
        },
        {
          ...withProviderFeatureCurrentness(waiterLifetime),
          unavailable: () => providerProbeUnavailable({
            connectionId: request.draftConnectionId,
            machineId: request.machineId,
          }),
          localCapacityUnavailable: () => providerProbeCapacityExhausted({
            connectionId: request.draftConnectionId,
            machineId: request.machineId,
          }),
        },
      )
    : Promise.resolve(providerFeatureDisabled({
        connectionId: request.draftConnectionId,
        machineId: request.machineId,
      }));

  const summary = async (input: RuntimeProviderSummaryInput) => {
    const identity: RuntimeProviderIdentity = {
      connectionId: input.connectionId,
      machineId: input.machineId,
    };
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    // Connection description is a point-in-time projection. Reuse its exact
    // settings resolution instead of replacing it with the latest snapshot.
    const operationScope = 'resolution' in input
      ? {
          registry: input.registry,
          lifetime: input.lifetime,
        }
      : withOperationLifetime(undefined);
    const resolved = 'resolution' in input
      ? await (() => {
          const settingsRead = { settings: input.providerSettings, diagnostics: [] };
          return resolveSavedFromConnectionContext(identity, {
            connection: input.resolution.record,
            // The description owner already admitted this exact material basis.
            accountReadScope: undefined,
            isAccountCurrent: undefined,
            savedSecretOperationContext: undefined,
            managedRuntimeAccount: undefined,
            savedSecretMaterializer: input.savedSecretMaterializer,
            providerSettings: settingsRead.settings,
            settingsRead,
            accountSettings: input.accountSettings,
            savedSecretResources: input.savedSecretResources,
            resolveManagedPurposeBindingIntent,
            registry: input.registry,
            dnsEvidenceByEndpointUrl: input.dnsEvidence,
            lifetime: input.lifetime,
          }, 'catalog');
        })()
      : await resolveSaved(identity, 'catalog', operationScope);
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    void scheduleDemandRefresh(identity, 'detail_open', operationScope);
    const state = await runtimeStore.read();
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const request = resolved.value.request;
    const probeObservationIdentity = createResolvedProviderProbeObservationIdentity(request);
    const expectedEndpoints = expectedEndpointObservations(request);
    const modelResult = projectModels(
      identity,
      projectResolvedCatalogContext(identity, resolved.value, state),
    );
    return {
      status: 'success' as const,
      probeObservationIdentity,
      summary: selectProviderConnectionRuntimeSummary({
        ...identity,
        expectedEndpoints,
        allowedObservationAuthorizationFingerprints: request.observationAuthorizationFingerprints,
        endpointHealth: state.endpointHealth,
        modelCount: modelResult.status === 'success'
          ? modelResult.models.filter((row) => !row.stale).length
          : null,
      }),
    };
  };

  return Object.freeze({
    probe, probeDraft, models, summary, modelLoadCatalog, modelLoadAuthorization,
    resolveCatalogContext, resolvePresentationCatalogContext, readPlacedModelProjection, scheduleDemandRefresh, runtimeStore,
    probeInfrastructure: Object.freeze({ client, scheduler }),
  });
}
