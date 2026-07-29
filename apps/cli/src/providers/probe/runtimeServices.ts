import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import {
  createProviderEndpointFingerprintV1,
  createProviderErrorV1,
  createProviderProbeRequestFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  readOwnRecordValue,
  serializeModelVisibilityRefV1,
  type ProviderErrorV1,
  type ProviderCatalogRuntimeStateRecordV1,
  type ProviderMergedCatalogRowV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderProbeObservationIdentityV1,
  type ProviderRuntimeStateFileV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type { DaemonProviderDraftProbeRequestV1 } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import {
  resolveProviderConnectionForMachine,
  type ProviderContributionRegistryView,
  type ResolvedProviderConnectionRecord,
} from '@/providers/registry';
import {
  createProviderModelLoadCatalogPort,
  selectCurrentProviderCatalogRuntimeRecord,
} from '@/providers/modelManagement/catalog';
import type { ProviderModelLoadCatalogPort } from '@/providers/modelManagement/load';
import { projectProviderCatalogPresentation } from '@/providers/catalog';
import { createProviderRuntimeStateStore, type ProviderRuntimeStateStore } from '@/providers/runtimeState';
import { getActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
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
  type ProviderCatalogRefreshResult,
  type ProviderManagedCatalogRuntimePort,
  type ProviderProbeEndpoint,
} from './catalog';
import { createProviderProbeHttpClient } from './client';
import {
  createProviderProbeRpcHandler,
  createResolvedProviderProbeObservationIdentity,
  createResolvedProviderProbeRunner,
  createProviderSavedModelsRpcHandler,
  createProviderSavedProbeRpcHandler,
  ProviderProbeRpcResolutionError,
  type ProviderSavedModelsRpcResult,
  type ResolvedProviderProbeRpcRequest,
} from './rpc';
import {
  PROVIDER_HEALTH_REFRESH_TTL_MS,
  createProviderProbeScheduler,
} from './scheduler';
import {
  createProviderDraftProbeSchedulerKey,
  createProviderDraftProbeService,
} from './draft';
import { createProviderHealthProbeService } from './health';
import { selectProviderConnectionRuntimeSummary } from '@/providers/connections/runtimeSummary';
import type { ProviderConnectionRuntimeSummary } from '@/providers/connections/service';
import type { ProviderLocalCatalogFallbackResult } from './localCommand';
import type {
  ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import {
  resolveManagedProviderPurposeBindingSnapshot,
} from '@/providers/managed/resolvePurposeBindingSnapshot';

type SavedResolution = Readonly<{
  request: ResolvedProviderProbeRpcRequest;
  connection: ResolvedProviderConnectionRecord;
  providerSettings: ProviderSettingsV1;
}>;

type SavedResolutionResult =
  | Readonly<{ ok: true; value: SavedResolution }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

type SavedProbeMode = 'catalog' | 'health';

type RuntimeProviderIdentity = Readonly<{
  connectionId: string;
  machineId: string;
}>;

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
      catalogRuntimeRecord: ProviderCatalogRuntimeStateRecordV1 | null;
      catalogRuntimeKey: ProviderCatalogRuntimeStateRecordV1['key'] | null;
    }>;

export type RuntimeProviderServices = Readonly<{
  probe(
    rawInput: unknown,
    trigger?: 'manual_refresh' | 'enable',
  ): Promise<ProviderCatalogRefreshResult>;
  probeDraft(request: DaemonProviderDraftProbeRequestV1): Promise<ProviderCatalogRefreshResult>;
  models: ReturnType<typeof createProviderSavedModelsRpcHandler>;
  summary(identity: RuntimeProviderIdentity): Promise<
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
  ): Promise<RuntimeProviderCatalogContext>;
  resolvePresentationCatalogContext(
    identity: RuntimeProviderIdentity,
    runtimeStateOverride?: ProviderRuntimeStateFileV1,
  ): Promise<RuntimeProviderCatalogContext>;
  scheduleDemandRefresh(
    identity: RuntimeProviderIdentity,
    trigger: 'detail_open' | 'picker_open',
  ): void;
  runtimeStore: ProviderRuntimeStateStore;
}>;

function sourceCatalog(connection: ResolvedProviderConnectionRecord) {
  return connection.source.kind === 'contribution'
    ? connection.source.definition.catalog
    : connection.source.template.catalog;
}

function staticModels(catalog: ReturnType<typeof sourceCatalog>) {
  return 'staticModels' in catalog ? catalog.staticModels : [];
}

function expectedEndpointObservations(request: ResolvedProviderProbeRpcRequest) {
  if (request.managedSource) return [];
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
  machineId: string;
  featureGate?: Readonly<{ isEnabled(featureId: 'providers'): boolean }>;
  happyHomeDir?: string;
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
    }>): Promise<ProviderLocalCatalogFallbackResult>;
  }>;
  managedCatalogRuntime?: ProviderManagedCatalogRuntimePort<
    ProviderProbeHostAuthorizationTicket
  >;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
}>): RuntimeProviderServices {
  const happyHomeDir = input.happyHomeDir ?? configuration.happyHomeDir;
  const resolveRegistry = input.resolveRegistry ?? (input.registry
    ? () => input.registry!
    : async () => {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir });
        try {
          return resolveProviderContributionRegistryView(lease.registry.contributes);
        } finally {
          await lease.release();
        }
      });
  const getSnapshot = input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const client = input.client ?? createProviderProbeHttpClient({});
  const runtimeStore = input.runtimeStore ?? createProviderRuntimeStateStore({
    happyHomeDir,
    machineId: input.machineId,
  });
  const authorization = createRuntimeProviderProbeAuthorizationPort({
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
  });
  const modelLoadAuthorization = createRuntimeProviderModelLoadAuthorizationPort({
    resolveRegistry,
    getAccountSettingsSnapshot: getSnapshot,
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  const catalogService = createProviderCatalogService({
    client,
    authorization,
    runtimeStore,
    createObservationId: input.createObservationId ?? randomUUID,
    retryDelayMs: (failureCount) => Math.min(24 * 60 * 60_000, 30_000 * (2 ** Math.max(0, failureCount - 1))),
    ...(input.localCatalogFallback ? { localCatalogFallback: input.localCatalogFallback } : {}),
    ...(input.managedCatalogRuntime
      ? { managedCatalogRuntime: input.managedCatalogRuntime }
      : {}),
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
  });
  const providerFeatureDisabled = (identity: Readonly<{ connectionId: string; machineId: string }>) => ({
    status: 'error' as const,
    error: createProviderErrorV1('provider_feature_disabled', identity),
  });
  const isProviderFeatureEnabled = () => input.featureGate?.isEnabled('providers') === true;

  async function resolveConnectionContext(
    identity: Readonly<{ connectionId: string; machineId: string }>,
  ) {
    const snapshot = getSnapshot();
    if (!snapshot) {
      return { ok: false as const, error: createProviderErrorV1('provider_connection_not_found', identity) };
    }
    const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
    const registry = await resolveRegistry();
    const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
      connectionId: identity.connectionId,
      machineId: identity.machineId,
      providerSettings,
      registry,
      ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    });
    const resolution = resolveProviderConnectionForMachine({
      ...identity,
      accountSettings: snapshot.settings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    if (resolution.status !== 'resolved') {
      return { ok: false as const, error: providerConnectionResolutionError(resolution, identity.machineId) };
    }
    return {
      ok: true as const,
      value: {
        connection: resolution.record,
        providerSettings,
        accountSettings: snapshot.settings,
        registry,
        dnsEvidenceByEndpointUrl,
      },
    };
  }

  async function resolveSavedFromConnectionContext(
    identity: Readonly<{ connectionId: string; machineId: string }>,
    context: Extract<Awaited<ReturnType<typeof resolveConnectionContext>>, { ok: true }>['value'],
    mode: SavedProbeMode,
  ): Promise<SavedResolutionResult> {
    const {
      connection,
      providerSettings,
      accountSettings,
      registry,
      dnsEvidenceByEndpointUrl,
    } = context;
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
    if (connection.deployment.kind === 'managedLocal') {
      if (mode === 'health') {
        return {
          ok: true,
          value: {
            connection,
            providerSettings,
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
      const contribution = connection.source.kind === 'contribution'
        ? registry.providersByContributionKey.get(connection.source.contributionKey)
        : undefined;
      const probe = probes.length === 1 ? probes[0] : undefined;
      const endpointTemplate = probe && connection.source.kind === 'contribution'
        ? connection.source.definition.endpointTemplates.find(
            (candidate) => candidate.id === probe.endpointTemplateId,
          )
        : undefined;
      if (
        connection.source.kind !== 'contribution'
        || connection.source.provenance !== 'first_party'
        || contribution?.provenance !== 'first_party'
        || contribution.source.kind !== 'bundled'
        || !contribution.managed
        || !contribution.managedRuntimeAdapter
        || !probe
        || !endpointTemplate
        || !connection.deployment.facet.managedEndpoint.protocols.includes(
          endpointTemplate.protocol,
        )
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', identity),
        };
      }
      if (!input.resolveManagedPurposeBindingIntent) {
        return {
          ok: false,
          error: createProviderErrorV1(
            'provider_probe_authorization_invalid',
            identity,
          ),
        };
      }
      let purposeBindingResolution;
      try {
        purposeBindingResolution =
          await resolveManagedProviderPurposeBindingSnapshot({
          implementationIdentity:
            connection.deployment.implementationIdentity,
          facet: connection.deployment.facet,
          purposeBindingIntents:
            connection.deployment.purposeBindingIntents,
          resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
        });
      } catch {
        return {
          ok: false,
          error: createProviderErrorV1(
            'provider_probe_authorization_invalid',
            identity,
          ),
        };
      }
      const managedSource = {
        implementationIdentity: connection.deployment.implementationIdentity,
        managedFacet: connection.deployment.facet,
        purposeBindings: purposeBindingResolution,
        catalogSource: contribution.managedRuntimeAdapter.catalogSource,
        endpointTemplateId: endpointTemplate.id,
        protocol: endpointTemplate.protocol,
        publicHeaders: {},
        runtimeBinding: {
          contribution,
          runtimeAdapter: contribution.managedRuntimeAdapter,
        },
      } as const;
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
          managedFacet: managedSource.managedFacet,
          purposeBindings: managedSource.purposeBindings,
          catalogSource: managedSource.catalogSource,
          endpointTemplateId: managedSource.endpointTemplateId,
          protocol: managedSource.protocol,
          path: probe.path,
          parser: probe.parser,
          probeRequestFingerprint,
        },
        managedPurposeBindingSnapshot:
          purposeBindingResolution,
        accountSettings,
        providerSettings,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      if (!resolvedAuthorization.ok) {
        return { ok: false, error: resolvedAuthorization.error };
      }
      return {
        ok: true,
        value: {
          connection,
          providerSettings,
          request: {
            ...identity,
            endpoints: [],
            probes,
            managedSource,
            observationAuthorizationFingerprints: [
              resolvedAuthorization.observationAuthorizationFingerprint,
            ],
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
        providerSettings,
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
        request: {
          ...identity,
          endpoints,
          probes,
          ...(catalogFallback ? { catalogFallback } : {}),
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
  ): Promise<SavedResolutionResult> {
    const context = await resolveConnectionContext(identity);
    return context.ok
      ? resolveSavedFromConnectionContext(identity, context.value, mode)
      : context;
  }

  const projectResolvedCatalogContext = (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    resolved: SavedResolution,
    runtimeState: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
  ) => {
    const request = resolved.request;
    const catalogFingerprint = request.probes.length === 0
      ? null
      : createProviderCatalogRefreshFingerprint(request);
    const record = catalogFingerprint === null ? null : selectCurrentProviderCatalogRuntimeRecord({
      state: runtimeState,
      ...identity,
      catalogFingerprint,
      allowedObservationAuthorizationFingerprints: request.observationAuthorizationFingerprints,
    });
    return {
      status: 'success' as const,
      connection: resolved.connection,
      providerSettings: resolved.providerSettings,
      runtimeState,
      allowedObservationAuthorizationFingerprints: request.observationAuthorizationFingerprints,
      expectedEndpointObservations: expectedEndpointObservations(request),
      catalogRuntimeRecord: record,
      catalogRuntimeKey: record?.key ?? null,
    };
  };

  const resolveCatalogContext = async (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    runtimeStateOverride?: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
  ) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const resolved = await resolveSaved(identity);
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    const runtimeState = runtimeStateOverride ?? await runtimeStore.read();
    return projectResolvedCatalogContext(identity, resolved.value, runtimeState);
  };

  const resolvePresentationCatalogContext = async (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    runtimeStateOverride?: Awaited<ReturnType<ProviderRuntimeStateStore['read']>>,
  ) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const connectionContext = await resolveConnectionContext(identity);
    if (!connectionContext.ok) {
      return { status: 'error' as const, error: connectionContext.error };
    }
    const runtimeState = runtimeStateOverride ?? await runtimeStore.read();
    if (!connectionContext.value.connection.authorization.authorized) {
      return {
        status: 'success' as const,
        connection: connectionContext.value.connection,
        providerSettings: connectionContext.value.providerSettings,
        runtimeState,
        allowedObservationAuthorizationFingerprints: [] as const,
        expectedEndpointObservations: [] as const,
        catalogRuntimeRecord: null,
        catalogRuntimeKey: null,
      };
    }
    const resolved = await resolveSavedFromConnectionContext(identity, connectionContext.value, 'catalog');
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    return projectResolvedCatalogContext(identity, resolved.value, runtimeState);
  };

  const lowLevelProbe = createProviderProbeRpcHandler({
    resolveSaved: async (identity) => {
      const resolved = await resolveSaved(identity);
      if (!resolved.ok) throw new ProviderProbeRpcResolutionError(resolved.error);
      return resolved.value.request;
    },
    refresh: (request) => catalogService.refresh(request),
    schedule: (key, trigger, operation) => scheduler.runCatalog(key, trigger, operation),
  });

  const runResolvedHealthProbe = createResolvedProviderProbeRunner({
    refresh: (request) => request.probes.length === 1
      ? healthProbeService.refresh(request)
      : Promise.resolve({ status: 'not_supported' as const }),
    schedule: (key, trigger, operation) => scheduler.runHealth(key, trigger, operation),
  });

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

  const manualProbe = createProviderSavedProbeRpcHandler({
    machineId: input.machineId,
    probe: (identity) => isProviderFeatureEnabled()
      ? lowLevelProbe({ ...identity, kind: 'saved', trigger: 'manual_refresh' })
      : Promise.resolve(providerFeatureDisabled(identity)),
  });
  const enableProbe = createProviderSavedProbeRpcHandler({
    machineId: input.machineId,
    probe: (identity) => isProviderFeatureEnabled()
      ? lowLevelProbe({ ...identity, kind: 'saved', trigger: 'enable' })
      : Promise.resolve(providerFeatureDisabled(identity)),
  });
  const probe = (
    rawInput: unknown,
    trigger: 'manual_refresh' | 'enable' = 'manual_refresh',
  ) => trigger === 'enable' ? enableProbe(rawInput) : manualProbe(rawInput);

  const scheduleDemandRefresh = (
    identity: Readonly<{ connectionId: string; machineId: string }>,
    trigger: 'detail_open' | 'picker_open',
  ): void => {
    void (async () => {
      await lowLevelProbe({ ...identity, kind: 'saved', trigger });
      const resolved = await resolveSaved(identity, 'health');
      if (!resolved.ok || resolved.value.request.probes.length !== 1) return;
      if (await hasFreshExactHealthObservation(resolved.value.request)) return;
      await runResolvedHealthProbe(resolved.value.request, trigger);
    })().catch(() => undefined);
  };

  const modelLoadCatalog = createProviderModelLoadCatalogPort<unknown>({
    resolveSaved: async (identity) => {
      const resolved = await resolveSaved(identity);
      if (!resolved.ok) throw new ProviderProbeRpcResolutionError(resolved.error);
      return resolved.value.request;
    },
    runtimeStore,
    // The scheduler owns the shared operation lifetime. The model-load service
    // applies caller cancellation to that caller after the coalesced refresh.
    refresh: ({ signal: _callerSignal, modelId, refreshFrontier, ...request }) => scheduler.runCatalogAfter(
      createResolvedProviderProbeObservationIdentity(request),
      JSON.stringify(['post-model-load', modelId, refreshFrontier]),
      () => catalogService.refresh(request),
    ),
  });

  const models = createProviderSavedModelsRpcHandler({
    machineId: input.machineId,
    models: async (identity): Promise<ProviderSavedModelsRpcResult> => {
      const context = await resolveCatalogContext(identity);
      if (context.status === 'error') return context;
      scheduleDemandRefresh(identity, 'picker_open');
      const catalog = sourceCatalog(context.connection);
      const record = context.catalogRuntimeRecord;
      const projected = projectProviderCatalogPresentation({
        staticModels: staticModels(catalog),
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
          ...(row.descriptor.name ? { name: row.descriptor.name } : {}),
          source: sourceForRow(row),
          stale: rowCatalog.stale && row.sources.probe && !row.sources.manual && !row.sources.static,
          loadState,
          visibility: visibility(row.descriptor.id),
        })),
        ...projected.staleRows.map(({ row, loadState }) => ({
          id: row.descriptor.id,
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
    },
  });

  const probeDraft = (request: DaemonProviderDraftProbeRequestV1) => isProviderFeatureEnabled()
    ? scheduler.runCatalog(
        createProviderDraftProbeSchedulerKey(request),
        'manual_refresh',
        () => draftProbeService.probe(request),
      )
    : Promise.resolve(providerFeatureDisabled({
        connectionId: request.draftConnectionId,
        machineId: request.machineId,
      }));

  const summary = async (identity: Readonly<{ connectionId: string; machineId: string }>) => {
    if (!isProviderFeatureEnabled()) return providerFeatureDisabled(identity);
    const resolved = await resolveSaved(identity);
    if (!resolved.ok) return { status: 'error' as const, error: resolved.error };
    scheduleDemandRefresh(identity, 'detail_open');
    const state = await runtimeStore.read();
    const request = resolved.value.request;
    const probeObservationIdentity = createResolvedProviderProbeObservationIdentity(request);
    const expectedEndpoints = expectedEndpointObservations(request);
    const modelResult = await models(identity);
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
    resolveCatalogContext, resolvePresentationCatalogContext, scheduleDemandRefresh, runtimeStore,
  });
}
