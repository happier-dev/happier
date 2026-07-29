import {
  ProviderModelDescriptorV1Schema,
  ProviderCredentialTransportV1Schema,
  SessionProviderBindingMetadataV1Schema,
  createProviderBindingSecurityFingerprintV1,
  createProviderErrorV1,
  mergeProviderCatalogV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  normalizeProviderEndpointUrlSyntax,
  providerCredentialFormatKind,
  readOwnRecordValue,
  readProviderSettingsFromAccountSettingsV1,
  type AgentProviderRequirementsV1,
  type ProviderBindingAuthorizationTicketV1,
  type ProviderCredentialTransportV1,
  type ProviderErrorV1,
  type ProviderModelLoadDescriptorV1,
  type ProviderModelDescriptorV1,
  type ProviderSettingsV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderProbeRequestFingerprintV1,
  type ProviderManagedCatalogSourceIdentityV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type {
  AgentProviderBindingPrepared,
  AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
  prepareLeasedAgentProviderBinding,
  readLeasedAgentProviderBindingAdapter,
} from '@/plugins/runtime/providerBindings/adapter';

import {
  resolveProviderConnectionForMachine,
} from '../registry/resolve';
import type {
  ProviderConnectionEndpointUnresolvedReason,
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
  ResolvedProviderConnectionRecord,
} from '../registry/types';
import {
  resolveProviderCredentialReference,
  type ProviderCredentialReference,
  type ProviderProbeHostCredentialReference,
} from './credentials';
import { mintProviderBindingAuthorizationTicket } from './ticket';
import type { ProviderProbeAuthorizationRequest } from '../probe/authorization';
import { resolveProviderSourceFacts, type ResolvedProviderSourceFacts } from '../registry/sourceFacts';
import { resolveProviderModelCompatibility } from '../catalog/compatibility';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedFirstPartyManagedProviderFacet } from '@/providers/managed/types';
import { projectProviderRuntimeBindingBasis } from './runtimeBindingBasis';

export type ManagedProviderBindingAuthorizationFacts = Readonly<{
  v: 1;
  agentTargetKey: string;
  selection: AgentProviderBindingResolvedFacts['selection'];
  contributionKey: string;
  endpoint: Readonly<{
    endpointTemplateId: string;
    protocol: AgentProviderBindingResolvedFacts['endpoint']['protocol'];
    publicHeaders: Readonly<Record<string, string>>;
  }>;
  runtimeCredentialTransport: ProviderCredentialTransportV1;
  compatibilityFingerprint: string;
}>;

type ProviderSpawnAuthorizationBase = Readonly<{
  ticket: ProviderBindingAuthorizationTicketV1;
  bindingSecurityFingerprint: string;
  observationAuthorizationFingerprint: string;
  prepared: AgentProviderBindingPrepared;
  support: AgentProviderRequirementsV1;
  adapterVersion: number;
  credentialReference: ProviderCredentialReference;
  sessionBindingMetadata: SessionProviderBindingMetadataV1;
}>;

export type ProviderSpawnAuthorization = ProviderSpawnAuthorizationBase & Readonly<
  | {
      deployment: Readonly<{ kind: 'external' }>;
      binding: AgentProviderBindingResolvedFacts;
    }
  | {
      deployment: Readonly<{
        kind: 'managedLocal';
        contribution: Extract<ResolvedProviderContribution, { provenance: 'first_party' }>;
        implementation: Readonly<
          Omit<
            Extract<
              ResolvedProviderConnectionRecord['deployment'],
              { kind: 'managedLocal' }
            >,
            'purposeBindingIntents'
          > & {
            purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
          }
        >;
      }>;
      binding: ManagedProviderBindingAuthorizationFacts;
      credentialReference: Readonly<{ kind: 'none' }>;
    }
>;

export type ProviderSpawnAuthorizationResult =
  | Readonly<{ ok: true; authorization: ProviderSpawnAuthorization }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export type ProviderExternalProbeHostAuthorizationTicket = Readonly<{
  deployment?: 'external';
  connectionId: ProviderBindingAuthorizationTicketV1['connectionId'];
  connectionRevision: number;
  machineId: string;
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  grantFingerprint: string;
  connectionScope: 'account' | 'machine';
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderProbeAuthorizationRequest['protocol'];
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
  selectedSecretBindingId: string | null;
  selectedSecretRecordFingerprint: string | null;
}>;

export type ProviderManagedProbeHostAuthorizationTicket = Readonly<{
  deployment: 'managedLocal';
  connectionId: ProviderBindingAuthorizationTicketV1['connectionId'];
  connectionRevision: number;
  machineId: string;
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  grantFingerprint: string;
  connectionScope: 'machine';
  contributionKey: string;
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedFacet: ResolvedFirstPartyManagedProviderFacet;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  catalogSource: ProviderManagedCatalogSourceIdentityV1;
  endpointTemplateId: string;
  protocol: ProviderProbeAuthorizationRequest['protocol'];
  path: string;
  parser: Extract<ProviderProbeAuthorizationRequest, { deployment: 'managedLocal' }>['parser'];
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
}>;

export type ProviderProbeHostAuthorizationTicket =
  | ProviderExternalProbeHostAuthorizationTicket
  | ProviderManagedProbeHostAuthorizationTicket;

export type ProviderProbeHostAuthorizationResult =
  | Readonly<{
      ok: true;
      ticket: ProviderProbeHostAuthorizationTicket;
      observationAuthorizationFingerprint: ProviderObservationAuthorizationFingerprintV1;
      credentialRef: ProviderProbeHostCredentialReference | null;
    }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

export type ProviderModelLoadHostRequest = Readonly<{
  connectionId: string;
  machineId: string;
  modelId: string;
}>;

export type ProviderModelLoadHostAuthorizationTicket = Readonly<{
  connectionId: ProviderBindingAuthorizationTicketV1['connectionId'];
  connectionRevision: number;
  machineId: string;
  modelId: string;
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  grantFingerprint: string;
  connectionScope: 'account' | 'machine';
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderCredentialTransportV1['protocols'][number];
  descriptor: ProviderModelLoadDescriptorV1;
  selectedSecretBindingId: string | null;
  selectedSecretRecordFingerprint: string | null;
}>;

export type ProviderModelLoadHostAuthorizationResult =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'error'; error: ProviderErrorV1 }>
  | Readonly<{
      status: 'authorized';
      authorization: Readonly<{
        ticket: ProviderModelLoadHostAuthorizationTicket;
        source: 'trusted_local_contribution';
        descriptor: ProviderModelLoadDescriptorV1;
        endpoint: Readonly<{
          endpointTemplateId: string;
          endpointUrl: string;
          endpointFingerprint: string;
          publicHeaders: Readonly<Record<string, string>>;
        }>;
        credentialRef: ProviderProbeHostCredentialReference | null;
      }>;
    }>;

export type ResolveProviderSpawnAuthorizationInput = Readonly<{
  selection: SessionModelSelectionV1;
  machineId: string;
  /** Exact persisted backend target identity (for example `backend:codex`). */
  agentTargetKey: string;
  /** Runtime/catalog agent id used only to look up the executable adapter. */
  agentId: string;
  accountSettings: unknown;
  providerSettings?: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderConnectionForMachine>[0]['localCandidateUrlsByConnectionId'];
  lease: PluginRuntimeRegistryLease;
  /** Exact current runtime-catalog observation; canonical static/manual rows retain precedence. */
  runtimeModelDescriptor?: ProviderModelDescriptorV1;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>;

function managedPurposeBindingSnapshotMatchesFacet(input: Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  facet: ResolvedFirstPartyManagedProviderFacet;
  snapshot: QualifiedConnectedAccountPurposeBindingsV1;
}>): boolean {
  const bindings = input.snapshot.bindings;
  if (bindings.length === 0) return false;
  const declarationsByPurpose = new Map(
    input.facet.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (declarationsByPurpose.size !== input.facet.connectedAccounts.length) return false;
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = JSON.stringify(binding.purpose);
    if (
      seen.has(key)
      || binding.purpose.consumer.pluginId !== input.implementationIdentity.pluginId
      || binding.purpose.consumer.localId !== input.implementationIdentity.localId
    ) {
      return false;
    }
    seen.add(key);
    const declaration = declarationsByPurpose.get(binding.purpose.purpose);
    const targetService = binding.target.kind === 'account'
      ? binding.target.account.service
      : binding.target.service;
    if (
      !declaration
      || declaration.service.pluginId !== targetService.pluginId
      || declaration.service.localId !== targetService.localId
    ) {
      return false;
    }
  }
  return input.facet.connectedAccounts.every((declaration) => (
    declaration.required !== true
    || bindings.some((binding) => binding.purpose.purpose === declaration.purpose)
  ));
}

export function resolveProviderProbeAuthorization(input: Readonly<{
  request: ProviderProbeAuthorizationRequest;
  accountSettings: unknown;
  providerSettings?: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>): ProviderProbeHostAuthorizationResult {
  const providerSettings = input.providerSettings
    ?? readProviderSettingsFromAccountSettingsV1(input.accountSettings).settings;
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.request.connectionId,
    machineId: input.request.machineId,
    accountSettings: input.accountSettings,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (resolution.status !== 'resolved') {
    return { ok: false, error: providerConnectionResolutionError(resolution, input.request.machineId) };
  }
  const record = resolution.record;
  const context = { connectionId: record.connectionId, machineId: input.request.machineId };
  if (!record.authorization.authorized) {
    return { ok: false, error: createProviderErrorV1(record.authorization.errorCode, context) };
  }
  if (input.request.deployment === 'managedLocal') {
    const contribution = record.source.kind === 'contribution'
      ? input.registry.providersByContributionKey.get(record.source.contributionKey)
      : undefined;
    const endpointTemplate = record.source.kind === 'contribution'
      ? record.source.definition.endpointTemplates.find(
          (candidate) => candidate.id === input.request.endpointTemplateId,
        )
      : undefined;
    const declaredProbe = record.source.kind === 'contribution'
      && 'probes' in record.source.definition.catalog
      ? record.source.definition.catalog.probes.find((candidate) => (
          candidate.endpointTemplateId === input.request.endpointTemplateId
          && candidate.path === input.request.path
          && candidate.parser === input.request.parser
        ))
      : undefined;
    if (
      record.deployment.kind !== 'managedLocal'
      || record.scope !== 'machine'
      || record.source.kind !== 'contribution'
      || record.source.provenance !== 'first_party'
      || contribution?.provenance !== 'first_party'
      || contribution.source.kind !== 'bundled'
      || !contribution.managed
      || !contribution.managedRuntimeAdapter
      || !endpointTemplate
      || !declaredProbe
      || endpointTemplate.protocol !== input.request.protocol
      || !record.deployment.facet.managedEndpoint.protocols.includes(input.request.protocol)
      || JSON.stringify(record.deployment.implementationIdentity)
        !== JSON.stringify(input.request.implementationIdentity)
      || JSON.stringify(record.deployment.facet)
        !== JSON.stringify(input.request.managedFacet)
      || JSON.stringify(input.managedPurposeBindingSnapshot)
        !== JSON.stringify(input.request.purposeBindings)
      || !input.managedPurposeBindingSnapshot
      || !managedPurposeBindingSnapshotMatchesFacet({
        implementationIdentity: record.deployment.implementationIdentity,
        facet: record.deployment.facet,
        snapshot: input.managedPurposeBindingSnapshot,
      })
      || JSON.stringify(contribution.managedRuntimeAdapter.catalogSource)
        !== JSON.stringify(input.request.catalogSource)
    ) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', context),
      };
    }
    const expectedProbeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
      implementationIdentity: record.deployment.implementationIdentity,
      managedFacet: record.deployment.facet,
      purposeBindings: input.request.purposeBindings,
      catalogSource: contribution.managedRuntimeAdapter.catalogSource,
      endpointTemplateId: endpointTemplate.id,
      protocol: endpointTemplate.protocol,
      method: 'GET',
      path: declaredProbe.path,
      parser: declaredProbe.parser,
      publicHeaders: {},
    });
    if (input.request.probeRequestFingerprint !== expectedProbeRequestFingerprint) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', context),
      };
    }
    return {
      ok: true,
      ticket: {
        deployment: 'managedLocal',
        connectionId: record.connectionId,
        connectionRevision: record.connection.revision,
        machineId: input.request.machineId,
        connectionSecurityFingerprint: record.connectionSecurityFingerprint,
        endpointSetFingerprint: record.endpointSetFingerprint,
        grantFingerprint: record.authorization.grantFingerprint,
        connectionScope: 'machine',
        contributionKey: record.source.contributionKey,
        implementationIdentity: record.deployment.implementationIdentity,
        managedFacet: record.deployment.facet,
        purposeBindings: input.request.purposeBindings,
        catalogSource: contribution.managedRuntimeAdapter.catalogSource,
        endpointTemplateId: endpointTemplate.id,
        protocol: endpointTemplate.protocol,
        path: declaredProbe.path,
        parser: declaredProbe.parser,
        probeRequestFingerprint: expectedProbeRequestFingerprint,
      },
      observationAuthorizationFingerprint:
        createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: null,
          selectedSecretRecordFingerprint: null,
          credential: null,
        }),
      credentialRef: null,
    };
  }
  if (record.deployment.kind === 'managedLocal') {
    return {
      ok: false,
      error: createProviderErrorV1('provider_probe_authorization_invalid', context),
    };
  }
  const normalizedRequestedUrl = normalizeProviderEndpointUrlSyntax(input.request.endpointUrl).normalizedUrl;
  const endpoint = record.endpoints.find((candidate) =>
    candidate.endpointTemplateId === input.request.endpointTemplateId
    && candidate.protocol === input.request.protocol
    && candidate.normalizedUrl === normalizedRequestedUrl);
  if (!endpoint) return { ok: false, error: createProviderErrorV1('provider_endpoint_unavailable', context) };
  const facts = resolveProviderSourceFacts(record);
  const declaredProbes = [
    ...('probes' in facts.catalog ? facts.catalog.probes : []),
    ...(record.source.kind === 'contribution' && record.source.definition.discovery
      ? [record.source.definition.discovery.availabilityProbe]
      : []),
  ];
  const declaredProbe = declaredProbes.find((probe) =>
    probe.endpointTemplateId === endpoint.endpointTemplateId
    && probe.path === input.request.path
    && probe.parser === input.request.parser);
  if (!declaredProbe) {
    return { ok: false, error: createProviderErrorV1('provider_probe_authorization_invalid', context) };
  }
  const expectedProbeRequestFingerprint = createProviderProbeRequestFingerprintV1({
    method: 'GET',
    endpointUrl: endpoint.normalizedUrl,
    path: declaredProbe.path,
    parser: declaredProbe.parser,
    publicHeaders: endpoint.publicHeaders,
  });
  if (input.request.probeRequestFingerprint !== expectedProbeRequestFingerprint) {
    return { ok: false, error: createProviderErrorV1('provider_probe_authorization_invalid', context) };
  }
  const probeTransports = facts.credential?.transports.filter((transport) =>
    transport.protocols.includes(endpoint.protocol) && transport.uses.includes('probe')) ?? [];
  const selectedTransport = probeTransports[0] ?? null;
  if (facts.credential && probeTransports.length !== 1) {
    return { ok: false, error: createProviderErrorV1('provider_credential_transport_unavailable', context) };
  }
  const credentialReferenceResult = facts.credential
    ? resolveProviderCredentialReference({
        providerSettings,
        accountSettings: input.accountSettings,
        connectionId: record.connectionId,
        machineId: input.request.machineId,
        credentialSlotId: facts.credential.slotId,
        required: facts.credential.required,
      })
    : { ok: true as const, reference: { kind: 'none' as const } };
  if (!credentialReferenceResult.ok) return credentialReferenceResult;
  const reference = credentialReferenceResult.reference;
  const observationAuthorizationFingerprint = createProviderObservationAuthorizationFingerprintV1({
    selectedSecretBindingId: reference.kind === 'apiKey' ? reference.secretId : null,
    selectedSecretRecordFingerprint: reference.kind === 'apiKey' ? reference.secretRecordFingerprint : null,
    credential: reference.kind === 'apiKey' && selectedTransport
      ? { transport: selectedTransport, selectedProtocol: endpoint.protocol, selectedUse: 'probe' }
      : null,
  });
  return {
    ok: true,
    ticket: {
      deployment: 'external',
      connectionId: record.connectionId,
      connectionRevision: record.connection.revision,
      machineId: input.request.machineId,
      connectionSecurityFingerprint: record.connectionSecurityFingerprint,
      endpointSetFingerprint: record.endpointSetFingerprint,
      grantFingerprint: record.authorization.grantFingerprint,
      connectionScope: record.scope,
      endpointTemplateId: endpoint.endpointTemplateId,
      endpointUrl: endpoint.normalizedUrl,
      protocol: endpoint.protocol,
      probeRequestFingerprint: input.request.probeRequestFingerprint,
      selectedSecretBindingId: reference.kind === 'apiKey' ? reference.secretId : null,
      selectedSecretRecordFingerprint: reference.kind === 'apiKey' ? reference.secretRecordFingerprint : null,
    },
    observationAuthorizationFingerprint,
    credentialRef: reference.kind === 'apiKey' && selectedTransport
      ? {
          connectionId: record.connectionId,
          machineId: input.request.machineId,
          reference,
          transport: selectedTransport,
          protocol: endpoint.protocol,
        }
      : null,
  };
}

/**
 * Resolves the one deliberately narrow provider-management capability. It
 * reuses the connection/grant/secret-reference owner but never accepts a
 * custom descriptor or treats an ordinary cloud contribution as trusted
 * local management authority.
 */
export function resolveProviderModelLoadAuthorization(input: Readonly<{
  request: ProviderModelLoadHostRequest;
  accountSettings: unknown;
  providerSettings?: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
}>): ProviderModelLoadHostAuthorizationResult {
  const providerSettings = input.providerSettings
    ?? readProviderSettingsFromAccountSettingsV1(input.accountSettings).settings;
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.request.connectionId,
    machineId: input.request.machineId,
    accountSettings: input.accountSettings,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (resolution.status !== 'resolved') {
    return { status: 'error', error: providerConnectionResolutionError(resolution, input.request.machineId) };
  }
  const record = resolution.record;
  if (
    record.deployment.kind !== 'external'
    || record.source.kind !== 'contribution'
    || record.source.definition.kind !== 'local'
    || !record.source.definition.modelLoad
  ) {
    return { status: 'unavailable' };
  }
  const context = { connectionId: record.connectionId, machineId: input.request.machineId };
  if (!record.authorization.authorized) {
    return { status: 'error', error: createProviderErrorV1(record.authorization.errorCode, context) };
  }
  const descriptor = record.source.definition.modelLoad;
  const endpoint = record.endpoints.find((candidate) =>
    candidate.endpointTemplateId === descriptor.endpointTemplateId);
  if (!endpoint) return { status: 'unavailable' };

  const credential = record.source.definition.credential;
  const managementTransports = credential?.transports.filter((transport) =>
    transport.protocols.includes(endpoint.protocol) && transport.uses.includes('management')) ?? [];
  if (credential && managementTransports.length !== 1) {
    return {
      status: 'error',
      error: createProviderErrorV1('provider_credential_transport_unavailable', context),
    };
  }
  const selectedTransport = managementTransports[0] ?? null;
  const credentialReferenceResult = credential
    ? resolveProviderCredentialReference({
        providerSettings,
        accountSettings: input.accountSettings,
        connectionId: record.connectionId,
        machineId: input.request.machineId,
        credentialSlotId: credential.slotId,
        required: credential.required,
      })
    : { ok: true as const, reference: { kind: 'none' as const } };
  if (!credentialReferenceResult.ok) {
    return { status: 'error', error: credentialReferenceResult.error };
  }
  const reference = credentialReferenceResult.reference;
  const ticket: ProviderModelLoadHostAuthorizationTicket = {
    connectionId: record.connectionId,
    connectionRevision: record.connection.revision,
    machineId: input.request.machineId,
    modelId: input.request.modelId,
    connectionSecurityFingerprint: record.connectionSecurityFingerprint,
    endpointSetFingerprint: record.endpointSetFingerprint,
    grantFingerprint: record.authorization.grantFingerprint,
    connectionScope: record.scope,
    endpointTemplateId: endpoint.endpointTemplateId,
    endpointUrl: endpoint.normalizedUrl,
    protocol: endpoint.protocol,
    descriptor,
    selectedSecretBindingId: reference.kind === 'apiKey' ? reference.secretId : null,
    selectedSecretRecordFingerprint: reference.kind === 'apiKey' ? reference.secretRecordFingerprint : null,
  };
  return {
    status: 'authorized',
    authorization: {
      ticket,
      source: 'trusted_local_contribution',
      descriptor,
      endpoint: {
        endpointTemplateId: endpoint.endpointTemplateId,
        endpointUrl: endpoint.normalizedUrl,
        // The connection-security fingerprint covers this exact endpoint and
        // model-load descriptor/path. Combined with connectionId/modelId it is
        // the stable single-flight identity expected by the load owner.
        endpointFingerprint: record.connectionSecurityFingerprint,
        publicHeaders: endpoint.publicHeaders,
      },
      credentialRef: reference.kind === 'apiKey' && selectedTransport
        ? {
            connectionId: record.connectionId,
            machineId: input.request.machineId,
            reference,
            transport: selectedTransport,
            protocol: endpoint.protocol,
          }
        : null,
    },
  };
}

export function providerConnectionResolutionError(
  resolution: Exclude<ReturnType<typeof resolveProviderConnectionForMachine>, { status: 'resolved' }>,
  machineId: string,
): ProviderErrorV1 {
  const context = { connectionId: resolution.connectionId, machineId };
  switch (resolution.status) {
    case 'missing':
    case 'deleted':
    case 'invalid':
      return createProviderErrorV1('provider_connection_not_found', context);
    case 'source_unavailable':
      return createProviderErrorV1('provider_contribution_unavailable', context);
    case 'endpoint_unresolved': {
      const _: ProviderConnectionEndpointUnresolvedReason = resolution.reason;
      return createProviderErrorV1('provider_endpoint_unavailable', context);
    }
  }
}

function selectedModel(input: Readonly<{
  modelId: string;
  record: ResolvedProviderConnectionRecord;
  facts: ResolvedProviderSourceFacts;
  providerSettings: ProviderSettingsV1;
  supportsFreeformModelIds: boolean;
  runtimeProbe?: ProviderModelDescriptorV1;
}>): ProviderModelDescriptorV1 | null {
  const runtimeProbe = input.runtimeProbe
    ? ProviderModelDescriptorV1Schema.parse(input.runtimeProbe)
    : null;
  if (runtimeProbe && runtimeProbe.id !== input.modelId) {
    throw new TypeError('Resolved provider model descriptor does not match the selection');
  }
  const manualModels = readOwnRecordValue(
    input.providerSettings.manualModelsByConnectionId,
    input.record.connectionId,
  ) ?? [];
  const merged = mergeProviderCatalogV1({
    staticModels: 'staticModels' in input.facts.catalog
      ? input.facts.catalog.staticModels
      : [],
    manualModels,
    probeState: {
      snapshot: runtimeProbe
        ? {
            models: [runtimeProbe],
            observedAt: 0,
            stale: false,
          }
        : null,
      staleProbeModels: [],
    },
  });
  const listed = merged.rows.find((row) => row.descriptor.id === input.modelId);
  if (listed) return listed.descriptor;
  if (input.facts.catalog.manualModelPolicy === 'allowed' && input.supportsFreeformModelIds) {
    return ProviderModelDescriptorV1Schema.parse({ id: input.modelId, name: input.modelId });
  }
  return null;
}

function destinationNameMatches(
  support: AgentProviderRequirementsV1['credentialSupport']['apiKeyTransports'][number],
  transport: ProviderCredentialTransportV1,
): boolean {
  if (support.destination.kind !== transport.destination.kind) return false;
  const names = support.destination.names;
  if (names === 'anyValidated') return true;
  if (transport.destination.kind === 'httpHeader') {
    return names.some((name) => name.toLowerCase() === transport.destination.name.toLowerCase());
  }
  return names.includes(transport.destination.name);
}

function selectRuntimeTransport(input: Readonly<{
  transports: readonly ProviderCredentialTransportV1[];
  protocol: AgentProviderBindingResolvedFacts['endpoint']['protocol'];
  support: AgentProviderRequirementsV1;
}>): ProviderCredentialTransportV1 | null {
  const matches = input.transports.filter((transport) =>
    transport.protocols.includes(input.protocol)
    && transport.uses.includes('runtime')
    && input.support.credentialSupport.apiKeyTransports.some((support) =>
      support.protocol === input.protocol
      && destinationNameMatches(support, transport)
      && support.destination.formats.includes(providerCredentialFormatKind(transport.destination.format))));
  if (matches.length > 1) throw new TypeError('Provider runtime credential transport is ambiguous');
  return matches[0] ?? null;
}

export function resolveProviderSpawnAuthorization(
  input: ResolveProviderSpawnAuthorizationInput,
): ProviderSpawnAuthorizationResult {
  const connectionId = input.selection.ref.providerConnectionId;
  if (connectionId === null || input.selection.ref.agentTargetKey !== input.agentTargetKey) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent') };
  }
  const providerSettings = input.providerSettings
    ?? readProviderSettingsFromAccountSettingsV1(input.accountSettings).settings;
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
  if (resolution.status !== 'resolved') {
    return { ok: false, error: providerConnectionResolutionError(resolution, input.machineId) };
  }
  const record = resolution.record;
  const errorContext = { connectionId, machineId: input.machineId };
  if (!record.authorization.authorized) {
    return { ok: false, error: createProviderErrorV1(record.authorization.errorCode, errorContext) };
  }

  let adapter: ReturnType<typeof readLeasedAgentProviderBindingAdapter>;
  try {
    adapter = readLeasedAgentProviderBindingAdapter({ lease: input.lease, agentId: input.agentId });
  } catch {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  }
  if (!adapter) return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  const facts = resolveProviderSourceFacts(record);
  const model = selectedModel({
    modelId: input.selection.ref.modelId,
    record,
    facts,
    providerSettings,
    supportsFreeformModelIds: adapter.support.supportsFreeformModelIds,
    ...(input.runtimeModelDescriptor
      ? { runtimeProbe: input.runtimeModelDescriptor }
      : {}),
  });
  if (!model) return { ok: false, error: createProviderErrorV1('provider_model_not_found', errorContext) };
  const compatibility = resolveProviderModelCompatibility({
    record,
    providerSettings,
    agentTargetKey: input.agentTargetKey,
    support: adapter.support,
    model,
    adapterVersion: adapter.adapter.adapterVersion,
  });
  const compatibilityResult = compatibility.result;
  if (compatibilityResult.status === 'incompatible') {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  }
  if (compatibilityResult.status === 'experimental' && !compatibility.confirmed) {
    return { ok: false, error: createProviderErrorV1('provider_compatibility_unverified', errorContext) };
  }
  if (record.deployment.kind === 'managedLocal') {
    const managedPurposeBindingSnapshot = input.managedPurposeBindingSnapshot;
    const contributionSource = record.source.kind === 'contribution'
      ? record.source
      : null;
    const contribution = input.registry.providersByContributionKey.get(
      contributionSource?.contributionKey ?? '',
    );
    const endpointTemplate = contributionSource
      ? contributionSource.definition.endpointTemplates.find(
          (candidate) => candidate.protocol === compatibilityResult.selectedProtocol,
        )
      : null;
    if (
      !contribution
      || contribution.provenance !== 'first_party'
      || contribution.source.kind !== 'bundled'
      || !contribution.managed
      || !contributionSource
      || !endpointTemplate
      || !record.deployment.facet.managedEndpoint.protocols.includes(
        compatibilityResult.selectedProtocol,
      )
      || !managedPurposeBindingSnapshot
      || !managedPurposeBindingSnapshotMatchesFacet({
        implementationIdentity: record.deployment.implementationIdentity,
        facet: record.deployment.facet,
        snapshot: managedPurposeBindingSnapshot,
      })
    ) {
      return { ok: false, error: createProviderErrorV1('provider_connection_invalid', errorContext) };
    }
    const runtimeCredentialTransport = ProviderCredentialTransportV1Schema.parse({
      id: 'managed-runtime-bearer',
      protocols: [compatibilityResult.selectedProtocol],
      uses: ['runtime'],
      destination: {
        kind: 'httpHeader',
        name: 'Authorization',
        format: 'bearer',
      },
    });
    if (!selectRuntimeTransport({
      transports: [runtimeCredentialTransport],
      protocol: compatibilityResult.selectedProtocol,
      support: adapter.support,
    })) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_credential_transport_unavailable', errorContext),
      };
    }
    let prepared: AgentProviderBindingPrepared;
    try {
      prepared = prepareLeasedAgentProviderBinding({
        lease: input.lease,
        agentId: input.agentId,
        input: {
          v: 1,
          agentTargetKey: input.agentTargetKey,
          connectionId,
        },
      });
    } catch {
      return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
    }
    const bindingSecurityFingerprint = createProviderBindingSecurityFingerprintV1({
      agentTargetKey: input.agentTargetKey,
      connectionId,
      modelId: model.id,
      modelCapabilities: {
        ...(model.capabilities?.reasoningControls
          ? { reasoningControls: model.capabilities.reasoningControls }
          : {}),
      },
      deployment: {
        kind: 'managedLocal',
        securityFacts: {
          implementationIdentity: record.deployment.implementationIdentity,
          managedEndpoint: record.deployment.facet.managedEndpoint,
          connectedAccounts: record.deployment.facet.connectedAccounts,
          requestAuthUses: record.deployment.facet.requestAuthUses,
        },
      },
      endpointTemplateId: endpointTemplate.id,
      protocol: compatibilityResult.selectedProtocol,
      publicHeaders: {},
      materialization: prepared.materialization,
      ...(prepared.adapterBindingKey ? { adapterBindingKey: prepared.adapterBindingKey } : {}),
      credentialDestination: runtimeCredentialTransport.destination,
      compatibilityFingerprint: compatibility.compatibilityFingerprint,
      adapterVersion: adapter.adapter.adapterVersion,
    });
    const binding: ManagedProviderBindingAuthorizationFacts = {
      v: 1,
      agentTargetKey: input.agentTargetKey,
      selection: { connectionId, model },
      contributionKey: contributionSource.contributionKey,
      endpoint: {
        endpointTemplateId: endpointTemplate.id,
        protocol: compatibilityResult.selectedProtocol,
        publicHeaders: {},
      },
      runtimeCredentialTransport,
      compatibilityFingerprint: compatibility.compatibilityFingerprint,
    };
    const ticket = mintProviderBindingAuthorizationTicket({
      connectionId,
      connectionRevision: record.connection.revision,
      machineId: input.machineId,
      connectionSecurityFingerprint: record.connectionSecurityFingerprint,
      bindingSecurityFingerprint,
      grantFingerprint: record.authorization.grantFingerprint,
      selectedSecretBindingId: null,
      selectedSecretRecordFingerprint: null,
    });
    const sessionBindingMetadata = SessionProviderBindingMetadataV1Schema.parse({
      v: 1,
      connectionId,
      contributionKey: contributionSource.contributionKey,
      connectionRevision: record.connection.revision,
      model,
      managedPurposeBindings: managedPurposeBindingSnapshot,
      protocol: compatibilityResult.selectedProtocol,
      materialization: prepared.materialization,
      ...(prepared.adapterBindingKey ? { adapterBindingKey: prepared.adapterBindingKey } : {}),
      compatibilityFingerprint: compatibility.compatibilityFingerprint,
      bindingSecurityFingerprint,
      displaySnapshot: {
        providerName: contributionSource.definition.name,
        connectionName: record.displayName,
        connectionRole: record.connection.role,
        connectionDisplayNameMode: record.connection.displayNameMode,
      },
    });
    const authorization: ProviderSpawnAuthorization = {
        deployment: {
          kind: 'managedLocal',
          contribution,
          implementation: {
            kind: 'managedLocal',
            implementationIdentity: record.deployment.implementationIdentity,
            facet: record.deployment.facet,
            purposeBindings: managedPurposeBindingSnapshot,
          },
        },
        ticket,
        bindingSecurityFingerprint,
        observationAuthorizationFingerprint: createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: null,
          selectedSecretRecordFingerprint: null,
          credential: null,
        }),
        binding,
        prepared,
        support: adapter.support,
        adapterVersion: adapter.adapter.adapterVersion,
        credentialReference: { kind: 'none' },
        sessionBindingMetadata,
    };
    return {
      ok: true,
      authorization: {
        ...authorization,
        sessionBindingMetadata: SessionProviderBindingMetadataV1Schema.parse({
          ...sessionBindingMetadata,
          runtimeBindingBasis:
            projectProviderRuntimeBindingBasis(authorization),
        }),
      },
    };
  }
  const endpoint = record.endpoints.find((candidate) => candidate.protocol === compatibilityResult.selectedProtocol);
  if (!endpoint) return { ok: false, error: createProviderErrorV1('provider_endpoint_unavailable', errorContext) };

  const credentialReferenceResult = facts.credential
    ? resolveProviderCredentialReference({
        providerSettings,
        accountSettings: input.accountSettings,
        connectionId,
        machineId: input.machineId,
        credentialSlotId: facts.credential.slotId,
        required: facts.credential.required,
      })
    : { ok: true as const, reference: { kind: 'none' as const } };
  if (!credentialReferenceResult.ok) return credentialReferenceResult;
  const runtimeCredentialTransport = credentialReferenceResult.reference.kind === 'apiKey'
    ? selectRuntimeTransport({
        transports: facts.credential?.transports ?? [],
        protocol: endpoint.protocol,
        support: adapter.support,
      })
    : null;
  if (credentialReferenceResult.reference.kind === 'apiKey' && !runtimeCredentialTransport) {
    return { ok: false, error: createProviderErrorV1('provider_credential_transport_unavailable', errorContext) };
  }

  let prepared: AgentProviderBindingPrepared;
  try {
    prepared = prepareLeasedAgentProviderBinding({
      lease: input.lease,
      agentId: input.agentId,
      input: {
        v: 1,
        agentTargetKey: input.agentTargetKey,
        connectionId,
        ...(facts.contributionKey
          ? {
              reservedBindingCandidate: {
                contributionKey: facts.contributionKey,
                endpointTemplateId: endpoint.endpointTemplateId,
                protocol: endpoint.protocol,
                normalizedUrl: endpoint.normalizedUrl,
              },
            }
          : {}),
      },
    });
  } catch {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', errorContext) };
  }
  const bindingSecurityFingerprint = createProviderBindingSecurityFingerprintV1({
    agentTargetKey: input.agentTargetKey,
    connectionId,
    modelId: model.id,
    modelCapabilities: {
      ...(model.capabilities?.reasoningControls
        ? { reasoningControls: model.capabilities.reasoningControls }
        : {}),
    },
    endpointTemplateId: endpoint.endpointTemplateId,
    endpointUrl: endpoint.normalizedUrl,
    protocol: endpoint.protocol,
    publicHeaders: endpoint.publicHeaders,
    materialization: prepared.materialization,
    ...(prepared.adapterBindingKey ? { adapterBindingKey: prepared.adapterBindingKey } : {}),
    ...(runtimeCredentialTransport ? { credentialDestination: runtimeCredentialTransport.destination } : {}),
    compatibilityFingerprint: compatibility.compatibilityFingerprint,
    adapterVersion: adapter.adapter.adapterVersion,
  });
  const binding: AgentProviderBindingResolvedFacts = {
    v: 1,
    agentTargetKey: input.agentTargetKey,
    selection: {
      connectionId,
      model,
    },
    contributionKey: facts.contributionKey,
    endpoint: {
      endpointTemplateId: endpoint.endpointTemplateId,
      normalizedUrl: endpoint.normalizedUrl,
      protocol: endpoint.protocol,
      publicHeaders: endpoint.publicHeaders,
    },
    runtimeCredentialTransport,
    compatibilityFingerprint: compatibility.compatibilityFingerprint,
  };
  const reference = credentialReferenceResult.reference;
  const ticket = mintProviderBindingAuthorizationTicket({
    connectionId,
    connectionRevision: record.connection.revision,
    machineId: input.machineId,
    connectionSecurityFingerprint: record.connectionSecurityFingerprint,
    bindingSecurityFingerprint,
    grantFingerprint: record.authorization.grantFingerprint,
    selectedSecretBindingId: reference.kind === 'apiKey' ? reference.secretId : null,
    selectedSecretRecordFingerprint: reference.kind === 'apiKey' ? reference.secretRecordFingerprint : null,
  });
  const sessionBindingMetadata = SessionProviderBindingMetadataV1Schema.parse({
    v: 1,
    connectionId,
    contributionKey: facts.contributionKey,
    connectionRevision: record.connection.revision,
    model,
    protocol: endpoint.protocol,
    materialization: prepared.materialization,
    ...(prepared.adapterBindingKey ? { adapterBindingKey: prepared.adapterBindingKey } : {}),
    compatibilityFingerprint: compatibility.compatibilityFingerprint,
    bindingSecurityFingerprint,
    displaySnapshot: {
      providerName: record.source.kind === 'contribution'
        ? record.source.definition.name
        : record.source.template.name,
      connectionName: record.displayName,
      connectionRole: record.connection.role,
      connectionDisplayNameMode: record.connection.displayNameMode,
    },
  });
  const authorization: ProviderSpawnAuthorization = {
      deployment: { kind: 'external' },
      ticket,
      bindingSecurityFingerprint,
      observationAuthorizationFingerprint: createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: ticket.selectedSecretBindingId,
        selectedSecretRecordFingerprint: ticket.selectedSecretRecordFingerprint,
        credential: runtimeCredentialTransport
          ? { transport: runtimeCredentialTransport, selectedProtocol: endpoint.protocol, selectedUse: 'runtime' }
          : null,
      }),
      binding,
      prepared,
      support: adapter.support,
      adapterVersion: adapter.adapter.adapterVersion,
      credentialReference: reference,
      sessionBindingMetadata,
  };
  return {
    ok: true,
    authorization: {
      ...authorization,
      sessionBindingMetadata: SessionProviderBindingMetadataV1Schema.parse({
        ...sessionBindingMetadata,
        runtimeBindingBasis:
          projectProviderRuntimeBindingBasis(authorization),
      }),
    },
  };
}
