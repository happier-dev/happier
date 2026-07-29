import {
  ProviderModelDescriptorV1Schema,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  type ProviderCatalogFingerprintV1,
  type ProviderModelDescriptorV1,
  type ProviderModelLoadStateV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderRuntimeStateFileV1,
  type ProviderSettingsV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

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

export type ProviderRuntimeCatalogModelObservation = Readonly<{
  model: ProviderModelDescriptorV1;
  loadState: ProviderModelLoadStateV1;
}>;

type SelectProviderRuntimeCatalogModelInput = Readonly<{
  runtimeState: ProviderRuntimeStateFileV1;
  machineId: string;
  connectionId: string;
  catalogFingerprint: ProviderCatalogFingerprintV1 | string;
  currentObservationAuthorizationFingerprints: ReadonlySet<string>;
  modelId: string;
}>;

export function selectProviderRuntimeCatalogModelObservation(
  input: SelectProviderRuntimeCatalogModelInput,
): ProviderRuntimeCatalogModelObservation | null {
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
  const model = state.snapshot.models.find((candidate) => candidate.id === input.modelId);
  if (!model) return null;
  const modelLoadState = state.snapshot.stale === false
    ? input.runtimeState.modelLoadStates.find((candidate) => (
        candidate.key.machineId === input.machineId
        && candidate.key.connectionId === input.connectionId
        && candidate.key.catalogObservationId === state.catalogObservationId
        && candidate.key.modelId === input.modelId
      ))?.loadState ?? 'unknown'
    : 'unknown';
  return {
    model: ProviderModelDescriptorV1Schema.parse({
      ...model,
      name: model.name ?? model.id,
    }),
    loadState: modelLoadState,
  };
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
  providerSettings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
  runtimeStateStore: Pick<ProviderRuntimeStateStore, 'read'>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>;

export async function resolveProviderRuntimeCatalogObservation(
  input: ResolveProviderRuntimeCatalogModelInput,
): Promise<ProviderRuntimeCatalogModelObservation | null> {
  const connectionId = input.selection.ref.providerConnectionId;
  if (connectionId === null) return null;
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId: input.machineId,
    accountSettings: input.accountSettings,
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
    if (
      record.source.kind !== 'contribution'
      || record.source.provenance !== 'first_party'
      || catalog.probes.length !== 1
    ) {
      return null;
    }
    const contribution = input.registry.providersByContributionKey.get(
      record.source.contributionKey,
    );
    const runtimeAdapter = contribution?.provenance === 'first_party'
      && contribution.source.kind === 'bundled'
      ? contribution.managedRuntimeAdapter
      : undefined;
    const probe = catalog.probes[0]!;
    const endpointTemplate = record.source.definition.endpointTemplates.find(
      (candidate) => candidate.id === probe.endpointTemplateId,
    );
    if (
      !contribution
      || contribution.provenance !== 'first_party'
      || contribution.source.kind !== 'bundled'
      || !contribution.managed
      || !runtimeAdapter
      || !endpointTemplate
      || !record.deployment.facet.managedEndpoint.protocols.includes(
        endpointTemplate.protocol,
      )
    ) {
      return null;
    }
    let purposeBindings = input.managedPurposeBindingSnapshot;
    if (!purposeBindings) {
      if (!input.resolveManagedPurposeBindingIntent) return null;
      try {
        purposeBindings =
          await resolveManagedProviderPurposeBindingSnapshot({
            implementationIdentity: record.deployment.implementationIdentity,
            facet: record.deployment.facet,
            purposeBindingIntents: record.deployment.purposeBindingIntents,
            resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
          });
      } catch {
        return null;
      }
    }
    const managedSource = {
      implementationIdentity: record.deployment.implementationIdentity,
      managedFacet: record.deployment.facet,
      purposeBindings,
      catalogSource: runtimeAdapter.catalogSource,
      endpointTemplateId: endpointTemplate.id,
      protocol: endpointTemplate.protocol,
      publicHeaders: {},
    } as const;
    const requestFingerprint =
      createProviderManagedProbeRequestFingerprintV1({
        ...managedSource,
        method: 'GET',
        path: probe.path,
        parser: probe.parser,
      });
    const catalogFingerprint = createProviderCatalogRefreshFingerprint({
      endpoints: [],
      probes: [probe],
      managedSource,
    });
    const authorization = resolveProviderProbeAuthorization({
      request: {
        deployment: 'managedLocal',
        connectionId,
        machineId: input.machineId,
        implementationIdentity:
          record.deployment.implementationIdentity,
        managedFacet: record.deployment.facet,
        purposeBindings,
        catalogSource: runtimeAdapter.catalogSource,
        endpointTemplateId: endpointTemplate.id,
        protocol: endpointTemplate.protocol,
        path: probe.path,
        parser: probe.parser,
        probeRequestFingerprint: requestFingerprint,
      },
      managedPurposeBindingSnapshot: purposeBindings,
      accountSettings: input.accountSettings,
      providerSettings: input.providerSettings,
      registry: input.registry,
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? {
            localCandidateUrlsByConnectionId:
              input.localCandidateUrlsByConnectionId,
          }
        : {}),
    });
    if (!authorization.ok) return null;
    return selectProviderRuntimeCatalogModelObservation({
      runtimeState: await input.runtimeStateStore.read(),
      machineId: input.machineId,
      connectionId,
      catalogFingerprint,
      currentObservationAuthorizationFingerprints: new Set([
        authorization.observationAuthorizationFingerprint,
      ]),
      modelId: input.selection.ref.modelId,
    });
  }

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
  return selectProviderRuntimeCatalogModelObservation({
    runtimeState: await input.runtimeStateStore.read(),
    machineId: input.machineId,
    connectionId,
    catalogFingerprint,
    currentObservationAuthorizationFingerprints: currentAuthorizations,
    modelId: input.selection.ref.modelId,
  });
}

export async function resolveProviderRuntimeCatalogModel(
  input: ResolveProviderRuntimeCatalogModelInput,
): Promise<ProviderModelDescriptorV1 | null> {
  return (await resolveProviderRuntimeCatalogObservation(input))?.model ?? null;
}
