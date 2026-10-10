import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import { DaemonProviderModelProjectionResponseV1Schema, type DaemonProviderModelProjectionRequestV1, type DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { pluginJsonValuesEqual } from '@happier-dev/protocol';
import { createAccountConnectionModelProjectionRequest, projectProviderBrokerApplication } from '../broker/applicationProjection';
import { createProviderManagedRuntimeDeclarationEqualityKeyV1, resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { createProviderManagedProbeRequestFingerprintV1, createProviderProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import type { ProviderCatalogFingerprintV1, ProviderModelDescriptorV1, ProviderModelLoadStateV1, ProviderObservationAuthorizationFingerprintV1, ProviderRuntimeStateFileV1, ProviderSettingsV1, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';

import { selectCurrentProviderCatalogRuntimeRecord } from '../modelManagement/catalog';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import {
  resolveProviderConnectionForMachine,
  type ProviderContributionRegistryView,
  type ProviderEndpointDnsEvidence,
} from '../registry';
import {
  resolveProviderProbeAuthorization,
  type ResolveProviderSpawnAuthorizationInput,
} from './resolve';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '../managed/resolvePurposeBindingSnapshot';
import { createProviderCatalogRefreshFingerprint } from '../probe/catalog';
import type { SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';

export type ProviderRuntimeCatalogModelObservation = Readonly<{
  model: ProviderModelDescriptorV1;
  loadState: ProviderModelLoadStateV1;
}>;

export type ProviderRuntimeCatalogSelectionObservation = Readonly<{
  model: ProviderModelDescriptorV1 | null;
  loadState: ProviderModelLoadStateV1;
  additionalModels?: readonly ProviderModelDescriptorV1[];
}>;

/** Host-private exact Home/Account Machine RPC read; no credentials enter the
 * catalog domain and the containing Provider operation owns cancellation. */
export type ProviderRuntimeModelProjectionReader = (
  request: DaemonProviderModelProjectionRequestV1,
  signal: AbortSignal,
) => Promise<DaemonProviderModelProjectionResponseV1>;

type SelectProviderRuntimeCatalogModelInput = Readonly<{
  runtimeState: ProviderRuntimeStateFileV1;
  machineId: string;
  connectionId: string;
  catalogFingerprint: ProviderCatalogFingerprintV1 | string;
  currentObservationAuthorizationFingerprints: ReadonlySet<string>;
  modelId: string;
  additionalModelIds?: readonly string[];
}>;

export function selectProviderRuntimeCatalogSelectionObservation(
  input: SelectProviderRuntimeCatalogModelInput,
): ProviderRuntimeCatalogSelectionObservation | null {
  if (input.runtimeState.machineId !== input.machineId) return null;
  const record = selectCurrentProviderCatalogRuntimeRecord({
    state: input.runtimeState,
    machineId: input.machineId,
    connectionId: input.connectionId,
    catalogFingerprint: input.catalogFingerprint,
    allowedObservationAuthorizationFingerprints: [...input.currentObservationAuthorizationFingerprints],
  });
  if (!record || !('catalogObservationId' in record.state)) return null;
  const state = record.state;
  const additionalModelIds = input.additionalModelIds;
  const model = state.snapshot.models.find((candidate) => candidate.id === input.modelId);
  const modelLoadState = state.snapshot.stale === false
    && model !== undefined
    ? input.runtimeState.modelLoadStates.find((candidate) => (
        candidate.key.machineId === input.machineId
        && candidate.key.connectionId === input.connectionId
        && candidate.key.catalogObservationId === state.catalogObservationId
        && candidate.key.modelId === input.modelId
      ))?.loadState ?? 'unknown'
    : 'unknown';
  return {
    model: model
      ? ProviderModelDescriptorV1Schema.parse({
          ...model,
          name: model.name ?? model.id,
        })
      : null,
    loadState: modelLoadState,
    ...(additionalModelIds ? {
      additionalModels: state.snapshot.models
        .filter((candidate) => additionalModelIds.includes(candidate.id))
        .map((candidate) => ProviderModelDescriptorV1Schema.parse({
          ...candidate,
          name: candidate.name ?? candidate.id,
        })),
    } : {}),
  };
}

export function selectProviderRuntimeCatalogModelObservation(
  input: SelectProviderRuntimeCatalogModelInput,
): ProviderRuntimeCatalogModelObservation | null {
  const selected = selectProviderRuntimeCatalogSelectionObservation(input);
  return selected?.model
    ? { model: selected.model, loadState: selected.loadState }
    : null;
}

export function selectProviderRuntimeCatalogModel(
  input: SelectProviderRuntimeCatalogModelInput,
): ProviderModelDescriptorV1 | null {
  return selectProviderRuntimeCatalogModelObservation(input)?.model ?? null;
}

type ResolveProviderRuntimeCatalogModelInput = Readonly<{
  selection: ResolveProviderSpawnAuthorizationInput['selection'];
  machineId: string;
  accountSettings: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
  runtimeStateStore?: Pick<ProviderRuntimeStateStore, 'read'>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
  additionalModelIds?: readonly string[];
  readModelProjection?: ProviderRuntimeModelProjectionReader;
  signal?: AbortSignal;
}>;

export async function resolveProviderRuntimeCatalogSelectionObservation(
  input: ResolveProviderRuntimeCatalogModelInput,
): Promise<ProviderRuntimeCatalogSelectionObservation | null> {
  const connectionId = input.selection.ref.providerConnectionId;
  if (connectionId === null) return null;
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId: input.machineId,
    providerSettings: input.providerSettings,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (resolution.status !== 'resolved' || !resolution.record.authorization.authorized) return null;
  const record = resolution.record;
  const catalog = record.source.kind === 'contribution'
    ? record.source.definition.catalog
    : record.source.template.catalog;
  if (!('probes' in catalog) || catalog.probes.length === 0) return null;

  if (record.deployment.kind === 'managedLocal') {
    if (record.source.kind !== 'contribution') return null;
    const contributionSource = record.source;
    const managedDeployment = record.deployment;
    const contribution = input.registry.providersByContributionKey.get(
      contributionSource.contributionKey,
    );
    const sourceRegistryVersion = 'sourceRegistryVersion' in catalog
      ? catalog.sourceRegistryVersion
      : undefined;
    const catalogFallback = contributionSource.definition.discovery?.catalogFallback;
    const endpointTemplateIds = new Set(
      catalog.probes.map((probe) => probe.endpointTemplateId),
    );
    if (catalogFallback) endpointTemplateIds.add(catalogFallback.endpointTemplateId);
    const endpointTemplates = [...endpointTemplateIds].map((endpointTemplateId) =>
      contributionSource.definition.endpointTemplates.find(
        (candidate) => candidate.id === endpointTemplateId,
      ));
    const contributionManagedRuntime = contribution?.definition.managedRuntime
      ? resolveProviderManagedRuntimeDeclarationV1({
          implementationIdentity: contribution.identity,
          managedRuntime: contribution.definition.managedRuntime,
        })
      : null;
    if (
      !contribution
      || !contribution.definition.managedRuntime
      || !contributionManagedRuntime
      || sourceRegistryVersion === undefined
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
      return null;
    }
    let purposeBindings = input.managedPurposeBindingSnapshot;
    if (!purposeBindings) {
      if (!input.resolveManagedPurposeBindingIntent) return null;
      try {
        purposeBindings =
          await resolveManagedProviderPurposeBindingSnapshot({
            implementationIdentity: managedDeployment.implementationIdentity,
            connectedAccounts:
              managedDeployment.managedRuntime.connectedAccounts ?? [],
            purposeBindingIntents: managedDeployment.purposeBindingIntents,
            resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
          });
      } catch {
        return null;
      }
    }
    const placement = record.connection.gatewayPlacement;
    if (placement?.kind === 'machine' && placement.machineId !== input.machineId) {
      const unavailable = () => createProviderErrorV1('provider_endpoint_unavailable', {
        connectionId, machineId: placement.machineId,
      });
      if (managedDeployment.managedRuntime.sharing !== 'connectionMachine'
        || !input.readModelProjection || !input.signal) throw unavailable();
      input.signal.throwIfAborted();
      // The hub's canonical compatibility owner chooses the application. A
      // probe endpoint protocol cannot choose an Agent binding protocol.
      const response = DaemonProviderModelProjectionResponseV1Schema.parse(await input.readModelProjection(
        createAccountConnectionModelProjectionRequest({ machineId: placement.machineId,
          connectionId: record.connectionId, expectedConnectionSecurityFingerprint: record.connectionSecurityFingerprint,
          agentTargetKey: input.selection.ref.agentTargetKey, refreshPolicy: 'current_only' }), input.signal,
      ));
      input.signal.throwIfAborted();
      if (response.status === 'error') throw response.error;
      if (response.agentTargetKey !== input.selection.ref.agentTargetKey) throw unavailable();
      const group = response.groups.find(candidate => candidate.connectionId === connectionId
        && candidate.sourceAuthority?.connectionSecurityFingerprint === record.connectionSecurityFingerprint
        && pluginJsonValuesEqual(candidate.sourceAuthority.provider.identity, managedDeployment.implementationIdentity));
      if (!group) throw unavailable();
      if (!group.authorization.authorized) throw group.authorization.error;
      const requestedIds = new Set([input.selection.ref.modelId, ...(input.additionalModelIds ?? [])]);
      const selected = group.rows.filter(row => requestedIds.has(row.ref.modelId));
      const primary = selected.find(row => row.ref.modelId === input.selection.ref.modelId);
      if (!primary) throw createProviderErrorV1('provider_model_not_found', { connectionId, machineId: placement.machineId });
      for (const row of selected) {
        if (row.ref.agentTargetKey !== input.selection.ref.agentTargetKey || row.ref.providerConnectionId !== connectionId
          || row.descriptor.id !== row.ref.modelId || row.catalog.stale || !row.application) throw unavailable();
        if (row.compatibility.result.status === 'incompatible') {
          throw createProviderErrorV1('provider_incompatible_with_agent', { connectionId, machineId: placement.machineId });
        }
        const application = projectProviderBrokerApplication({ connection: record,
          agentTargetKey: input.selection.ref.agentTargetKey, protocol: row.compatibility.result.selectedProtocol,
          expectedApplication: row.application });
        if (!application || !pluginJsonValuesEqual(application, row.application)) throw unavailable();
      }
      return {
        model: ProviderModelDescriptorV1Schema.parse(primary.descriptor), loadState: primary.loadState,
        ...(input.additionalModelIds ? { additionalModels: selected.filter(row => input.additionalModelIds!.includes(row.ref.modelId))
          .map(row => ProviderModelDescriptorV1Schema.parse(row.descriptor)) } : {}),
      };
    }
    const managedSources = endpointTemplates.map((endpointTemplate) => ({
      implementationIdentity: managedDeployment.implementationIdentity,
      managedRuntime: managedDeployment.managedRuntime,
      purposeBindings,
      endpointTemplateId: endpointTemplate!.id,
      protocol: endpointTemplate!.protocol,
      sourceRegistryVersion,
      publicHeaders: endpointTemplate!.publicHeaders ?? {},
    } as const));
    if (!input.runtimeStateStore) return null;
    const managedSourceByEndpointTemplateId = new Map(
      managedSources.map((source) => [source.endpointTemplateId, source] as const),
    );
    const catalogFingerprint = createProviderCatalogRefreshFingerprint({
      endpoints: [],
      probes: catalog.probes,
      ...(catalogFallback ? { catalogFallback } : {}),
      managedSources,
    });
    const currentAuthorizations = new Set<ProviderObservationAuthorizationFingerprintV1>();
    for (const probe of catalog.probes) {
      const managedSource = managedSourceByEndpointTemplateId.get(probe.endpointTemplateId);
      if (!managedSource) return null;
      const requestFingerprint = createProviderManagedProbeRequestFingerprintV1({
        ...managedSource,
        method: 'GET',
        path: probe.path,
        parser: probe.parser,
      });
      const authorization = resolveProviderProbeAuthorization({
        request: {
          deployment: 'managedLocal',
          connectionId,
          machineId: input.machineId,
          implementationIdentity: record.deployment.implementationIdentity,
          managedRuntime: record.deployment.managedRuntime,
          purposeBindings,
          endpointTemplateId: managedSource.endpointTemplateId,
          protocol: managedSource.protocol,
          sourceRegistryVersion,
          path: probe.path,
          parser: probe.parser,
          probeRequestFingerprint: requestFingerprint,
        },
        managedPurposeBindingSnapshot: purposeBindings,
        accountSettings: input.accountSettings,
        savedSecretResources: input.savedSecretResources,
        providerSettings: input.providerSettings,
        registry: input.registry,
        dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      if (!authorization.ok) return null;
      currentAuthorizations.add(authorization.observationAuthorizationFingerprint);
    }
    return selectProviderRuntimeCatalogSelectionObservation({
      runtimeState: await input.runtimeStateStore.read(),
      machineId: input.machineId,
      connectionId,
      catalogFingerprint,
      currentObservationAuthorizationFingerprints: currentAuthorizations,
      modelId: input.selection.ref.modelId,
      ...(input.additionalModelIds ? { additionalModelIds: input.additionalModelIds } : {}),
    });
  }

  if (!input.runtimeStateStore) return null;
  const requestFingerprints = catalog.probes.map((probe) => {
    const endpoint = record.endpoints.find((candidate) => candidate.endpointTemplateId === probe.endpointTemplateId);
    if (!endpoint) throw new TypeError('Provider catalog probe endpoint is absent from the resolved connection');
    return {
      probe,
      endpoint,
      fingerprint: createProviderProbeRequestFingerprintV1({
        method: 'GET',
        endpointUrl: endpoint.normalizedUrl,
        path: probe.path,
        parser: probe.parser,
        publicHeaders: endpoint.publicHeaders,
      }),
    };
  });
  const catalogFallback = record.source.kind === 'contribution'
    ? record.source.definition.discovery?.catalogFallback
    : undefined;
  const catalogFingerprint = createProviderCatalogRefreshFingerprint({
    endpoints: record.endpoints,
    probes: catalog.probes,
    ...(catalogFallback ? { catalogFallback } : {}),
  });
  const currentAuthorizations = new Set<ProviderObservationAuthorizationFingerprintV1>();
  for (const request of requestFingerprints) {
    const authorization = resolveProviderProbeAuthorization({
      request: {
        connectionId,
        machineId: input.machineId,
        endpointTemplateId: request.endpoint.endpointTemplateId,
        endpointUrl: request.endpoint.normalizedUrl,
        protocol: request.endpoint.protocol,
        path: request.probe.path,
        parser: request.probe.parser,
        probeRequestFingerprint: request.fingerprint,
      },
      accountSettings: input.accountSettings,
      savedSecretResources: input.savedSecretResources,
      providerSettings: input.providerSettings,
      registry: input.registry,
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    if (authorization.ok) currentAuthorizations.add(authorization.observationAuthorizationFingerprint);
  }
  if (currentAuthorizations.size === 0) return null;
  return selectProviderRuntimeCatalogSelectionObservation({
    runtimeState: await input.runtimeStateStore.read(),
    machineId: input.machineId,
    connectionId,
    catalogFingerprint,
    currentObservationAuthorizationFingerprints: currentAuthorizations,
    modelId: input.selection.ref.modelId,
    ...(input.additionalModelIds ? { additionalModelIds: input.additionalModelIds } : {}),
  });
}

export async function resolveProviderRuntimeCatalogObservation(
  input: ResolveProviderRuntimeCatalogModelInput,
): Promise<ProviderRuntimeCatalogModelObservation | null> {
  const selected = await resolveProviderRuntimeCatalogSelectionObservation(input);
  return selected?.model
    ? { model: selected.model, loadState: selected.loadState }
    : null;
}

export async function resolveProviderRuntimeCatalogModel(
  input: ResolveProviderRuntimeCatalogModelInput,
): Promise<ProviderModelDescriptorV1 | null> {
  return (await resolveProviderRuntimeCatalogObservation(input))?.model ?? null;
}
