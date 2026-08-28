import {
  AgentProviderRequirementsV1Schema,
  ProviderBoundModelRefSchema,
  ProviderModelDescriptorV1Schema,
  ProviderCredentialTransportV1Schema,
  SessionProviderBindingMetadataV1Schema,
  createProviderBindingSecurityFingerprintV1,
  createProviderErrorV1,
  createProviderManagedRuntimeBindingEqualityKeyV1,
  mergeProviderCatalogV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderManagedProbeRequestFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  normalizeProviderEndpointUrlSyntax,
  readOwnRecordValue,
  readProviderSettingsFromAccountSettingsV1,
  resolveProviderCatalogReferenceV1,
  resolveProviderManagedRuntimeDeclarationV1,
  selectProviderRuntimeCredentialTransportV1,
  type AgentProviderRequirementsV1,
  type ProviderBindingAuthorizationTicketV1,
  type ProviderCredentialTransportV1,
  type ProviderErrorV1,
  type ProviderModelLoadDescriptorV1,
  type ProviderModelDescriptorV1,
  type ProviderSettingsV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderProbeRequestFingerprintV1,
  type ResolvedProviderManagedRuntimeDeclarationV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type {
  AgentProviderBindingPrepared,
  AgentProviderBindingResolvedFacts,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import {
  prepareLeasedAgentProviderBinding,
  readLeasedAgentProviderBindingAdapter,
} from '@/plugins/runtime/providerBindings/adapter';

import {
  resolveProviderConnectionForMachine,
  resolveProviderConnectionForMachineFromSettingsRead,
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
import type {
  ResolvedManagedProviderRuntime,
  ResolvedContributionRegistry,
  ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
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
        contribution: ResolvedProviderContribution;
        implementation: Readonly<
          Omit<
            Extract<
              ResolvedProviderConnectionRecord['deployment'],
              { kind: 'managedLocal' }
            >,
            'purposeBindingIntents'
          > & {
            runtime: ResolvedManagedProviderRuntime;
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
  managedRuntime: ResolvedProviderManagedRuntimeDeclarationV1;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  endpointTemplateId: string;
  protocol: ProviderProbeAuthorizationRequest['protocol'];
  sourceRegistryVersion: string;
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
  /** Exact selected-model descriptor from the current runtime catalog snapshot. */
  runtimeModelDescriptor?: ProviderModelDescriptorV1;
  /** True when the exact current catalog has a successful snapshot, including an empty one. */
  runtimeCatalogSnapshotExists?: boolean;
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
  /** Exact current activation-owned runtime acquired by the runtime registry. */
  managedProviderRuntime?: ResolvedManagedProviderRuntime;
}>;

function managedPurposeBindingSnapshotMatchesDeclarations(input: Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  connectedAccounts: readonly Readonly<{
    purpose: string;
    service: Readonly<{ pluginId: string; localId: string }>;
    required?: boolean;
  }>[];
  snapshot: QualifiedConnectedAccountPurposeBindingsV1;
}>): boolean {
  const bindings = input.snapshot.bindings;
  const declarationsByPurpose = new Map(
    input.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (declarationsByPurpose.size !== input.connectedAccounts.length) return false;
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
  return input.connectedAccounts.every((declaration) => (
    declaration.required !== true
    || bindings.some((binding) => binding.purpose.purpose === declaration.purpose)
  ));
}

export function resolveProviderProbeAuthorization(input: Readonly<{
  request: ProviderProbeAuthorizationRequest;
  accountSettings: unknown;
  providerSettings?: ProviderSettingsV1;
  /** A caller-owned point-in-time parse for one bulk Provider projection. */
  settingsRead?: ReturnType<typeof readProviderSettingsFromAccountSettingsV1>;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderSpawnAuthorizationInput['localCandidateUrlsByConnectionId'];
  managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
}>): ProviderProbeHostAuthorizationResult {
  const settingsRead = input.settingsRead
    ?? readProviderSettingsFromAccountSettingsV1(input.accountSettings);
  const providerSettings = input.providerSettings ?? settingsRead.settings;
  const resolution = resolveProviderConnectionForMachineFromSettingsRead({
    connectionId: input.request.connectionId,
    machineId: input.request.machineId,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  }, settingsRead);
  if (resolution.status !== 'resolved') {
    return { ok: false, error: providerConnectionResolutionError(resolution, input.request.machineId) };
  }
  const record = resolution.record;
  const context = { connectionId: record.connectionId, machineId: input.request.machineId };
  if (!record.authorization.authorized) {
    return { ok: false, error: createProviderErrorV1(record.authorization.errorCode, context) };
  }
  if (input.request.deployment === 'managedLocal') {
    const managedPurposeBindingSnapshot =
      input.managedPurposeBindingSnapshot;
    const contribution = record.source.kind === 'contribution'
      ? input.registry.providersByContributionKey.get(record.source.contributionKey)
      : undefined;
    const sourceRegistryVersion = contribution
      && 'sourceRegistryVersion' in contribution.definition.catalog
      ? contribution.definition.catalog.sourceRegistryVersion
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
    const contributionManagedRuntime = contribution?.definition.managedRuntime
      ? resolveProviderManagedRuntimeDeclarationV1({
          implementationIdentity: contribution.identity,
          managedRuntime: contribution.definition.managedRuntime,
        })
      : null;
    if (
      record.deployment.kind !== 'managedLocal'
      || record.scope !== 'machine'
      || record.source.kind !== 'contribution'
      || !contribution
      || !contribution.definition.managedRuntime
      || !contributionManagedRuntime
      || sourceRegistryVersion === undefined
      || !endpointTemplate
      || !declaredProbe
      || input.request.sourceRegistryVersion !== sourceRegistryVersion
      || endpointTemplate.protocol !== input.request.protocol
      || !record.deployment.managedRuntime.endpointTemplateIds.includes(
        endpointTemplate.id,
      )
      || !managedPurposeBindingSnapshot
      || !managedPurposeBindingSnapshotMatchesDeclarations({
        implementationIdentity: record.deployment.implementationIdentity,
        connectedAccounts:
          record.deployment.managedRuntime.connectedAccounts ?? [],
        snapshot: managedPurposeBindingSnapshot,
      })
    ) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', context),
      };
    }
    const requestManagedBindingKey =
      createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity: input.request.implementationIdentity,
        managedRuntime: input.request.managedRuntime,
        purposeBindings: input.request.purposeBindings,
      });
    const recordManagedBindingKey =
      createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity: record.deployment.implementationIdentity,
        managedRuntime: record.deployment.managedRuntime,
        purposeBindings: input.request.purposeBindings,
      });
    const contributionManagedBindingKey =
      createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity: contribution.identity,
        managedRuntime: contributionManagedRuntime,
        purposeBindings: input.request.purposeBindings,
      });
    const snapshotManagedBindingKey =
      createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity: record.deployment.implementationIdentity,
        managedRuntime: record.deployment.managedRuntime,
        purposeBindings: managedPurposeBindingSnapshot,
      });
    if (
      recordManagedBindingKey !== requestManagedBindingKey
      || contributionManagedBindingKey !== requestManagedBindingKey
      || snapshotManagedBindingKey !== requestManagedBindingKey
    ) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', context),
      };
    }
    const expectedProbeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
      implementationIdentity: record.deployment.implementationIdentity,
      managedRuntime: record.deployment.managedRuntime,
      purposeBindings: input.request.purposeBindings,
      endpointTemplateId: endpointTemplate.id,
      protocol: endpointTemplate.protocol,
      sourceRegistryVersion,
      method: 'GET',
      path: declaredProbe.path,
      parser: declaredProbe.parser,
      publicHeaders: endpointTemplate.publicHeaders ?? {},
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
        managedRuntime: record.deployment.managedRuntime,
        purposeBindings: input.request.purposeBindings,
        endpointTemplateId: endpointTemplate.id,
        protocol: endpointTemplate.protocol,
        sourceRegistryVersion,
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

/**
 * One catalog-reference decision for both the definitive pre-launch phase and
 * the eventual authorization.  A launch may add a current runtime observation;
 * the pre-launch phase intentionally has no such observation and therefore
 * rejects only a model the static/manual catalog already proves invalid.
 */
function resolveProviderCatalogModel(input: Readonly<{
  modelId: string;
  connectionId: string;
  catalog: ResolvedProviderSourceFacts['catalog'];
  providerSettings: ProviderSettingsV1;
  supportsFreeformModelIds: boolean;
  runtimeProbe?: ProviderModelDescriptorV1;
  runtimeCatalogSnapshotExists: boolean;
}>): ProviderModelDescriptorV1 | null {
  const runtimeProbe = input.runtimeProbe
    ? ProviderModelDescriptorV1Schema.parse(input.runtimeProbe)
    : null;
  if (runtimeProbe && runtimeProbe.id !== input.modelId) {
    throw new TypeError('Resolved provider model descriptor does not match the selection');
  }
  const manualModels = readOwnRecordValue(
    input.providerSettings.manualModelsByConnectionId,
    input.connectionId,
  ) ?? [];
  const merged = mergeProviderCatalogV1({
    staticModels: 'staticModels' in input.catalog
      ? input.catalog.staticModels
      : [],
    manualModels,
    probeState: {
      snapshot: input.runtimeCatalogSnapshotExists
        ? {
            models: runtimeProbe ? [runtimeProbe] : [],
            observedAt: 0,
            stale: false,
          }
        : null,
      staleProbeModels: [],
    },
    ...('membershipPolicy' in input.catalog
      && input.catalog.membershipPolicy
      ? { membershipPolicy: input.catalog.membershipPolicy }
      : {}),
  });
  // Catalog membership is not the authority over whether a Provider model is
  // real. The Protocol reference resolver owns that decision — including the
  // two-sided freeform policy — so spawn authorization cannot become a second,
  // stricter answer to the same question the picker already asked.
  const resolution = resolveProviderCatalogReferenceV1({
    modelId: input.modelId,
    activeRows: merged.rows,
    staleRows: merged.staleRows,
    manualModelPolicy: input.catalog.manualModelPolicy,
    agentSupportsFreeformModelIds: input.supportsFreeformModelIds,
  });
  if (resolution.status === 'listed') return resolution.row.descriptor;
  if (resolution.status === 'not_currently_listed') {
    return ProviderModelDescriptorV1Schema.parse(resolution.descriptor);
  }
  return null;
}

function selectedModel(input: Readonly<{
  modelId: string;
  record: ResolvedProviderConnectionRecord;
  facts: ResolvedProviderSourceFacts;
  providerSettings: ProviderSettingsV1;
  supportsFreeformModelIds: boolean;
  runtimeProbe?: ProviderModelDescriptorV1;
  runtimeCatalogSnapshotExists: boolean;
}>): ProviderModelDescriptorV1 | null {
  return resolveProviderCatalogModel({
    modelId: input.modelId,
    connectionId: input.record.connectionId,
    catalog: input.facts.catalog,
    providerSettings: input.providerSettings,
    supportsFreeformModelIds: input.supportsFreeformModelIds,
    ...(input.runtimeProbe ? { runtimeProbe: input.runtimeProbe } : {}),
    runtimeCatalogSnapshotExists: input.runtimeCatalogSnapshotExists,
  });
}

export type ProviderSpawnDefinitiveRejectionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

/**
 * Side-effect-free subset of provider launch authority.
 *
 * This owns only facts that the current Account settings and cold plugin
 * manifest prove locally.  It deliberately does not resolve endpoints, DNS,
 * grants, activation, runtime observations, credentials, or materialization:
 * those retain their normal launch-time owners and may still fail after a
 * Session cutover.
 */
export function resolveProviderSpawnDefinitiveRejection(input: Readonly<{
  selection: unknown;
  agentTargetKey: string;
  agentId: string;
  accountSettings: unknown;
  registry: Pick<
    ResolvedContributionRegistry,
    'agentDefinitionsById' | 'providersByContributionKey'
  >;
}>): ProviderSpawnDefinitiveRejectionResult {
  const selection = ProviderBoundModelRefSchema.safeParse(input.selection);
  if (!selection.success) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent') };
  }
  if (selection.data.agentTargetKey !== input.agentTargetKey) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent') };
  }
  const connectionId = selection.data.providerConnectionId;
  if (connectionId === null) return { ok: true };

  const providerSettings = readProviderSettingsFromAccountSettingsV1(input.accountSettings).settings;
  const connection = providerSettings.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_connection_not_found', { connectionId }),
    };
  }

  // The cold source projection: a contribution connection resolves its manifest
  // through the registry, a custom one carries its own template.  Only a
  // contribution can declare the managed runtime a managedLocal deployment needs.
  let catalog: ResolvedProviderContribution['definition']['catalog'];
  if (connection.source.kind === 'contribution') {
    const source = input.registry.providersByContributionKey?.get(connection.source.contributionKey);
    if (!source) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_contribution_unavailable', { connectionId }),
      };
    }
    if (connection.deployment.kind === 'managedLocal' && !source.definition.managedRuntime) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', { connectionId }),
      };
    }
    catalog = source.definition.catalog;
  } else {
    if (connection.deployment.kind === 'managedLocal') {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', { connectionId }),
      };
    }
    catalog = connection.source.template.catalog;
  }

  const rawSupport = input.registry.agentDefinitionsById.get(input.agentId)
    ?.definition.providerRequirements;
  if (rawSupport === undefined) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', { connectionId }) };
  }
  const support = AgentProviderRequirementsV1Schema.safeParse(rawSupport);
  if (!support.success) {
    return { ok: false, error: createProviderErrorV1('provider_incompatible_with_agent', { connectionId }) };
  }

  // The cold manifest is the complete set of model ids only when the Provider
  // declares no runtime probe.  A probe-capable Provider can report a model the
  // manifest never listed, so an unlisted id is not proven invalid here and the
  // launch owner decides it against the live catalog observation instead.
  if (!('probes' in catalog)) {
    const model = resolveProviderCatalogModel({
      modelId: selection.data.modelId,
      connectionId,
      catalog,
      providerSettings,
      supportsFreeformModelIds: support.data.supportsFreeformModelIds,
      runtimeCatalogSnapshotExists: false,
    });
    if (!model) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_model_not_found', { connectionId }),
      };
    }
  }
  return { ok: true };
}

export function resolveProviderSpawnAuthorization(
  input: ResolveProviderSpawnAuthorizationInput,
): ProviderSpawnAuthorizationResult {
  // The cold definitive-rejection phase is deliberately not re-run here.  It
  // answers the same questions from strictly less evidence — no resolved
  // connection record, no runtime catalog observation, and the lease registry
  // rather than this call's own — so consulting it would make it a second,
  // stricter authority over facts this owner resolves below.
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
    runtimeCatalogSnapshotExists:
      input.runtimeCatalogSnapshotExists === true
      || input.runtimeModelDescriptor !== undefined,
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
    const managedProviderRuntime = input.managedProviderRuntime;
    if (
      !contribution
      || !contributionSource
      || !endpointTemplate
      || contribution.definition.managedRuntime?.kind !== 'managed'
      || contribution.identity.pluginId
        !== record.deployment.implementationIdentity.pluginId
      || contribution.identity.localId
        !== record.deployment.implementationIdentity.localId
      || !record.deployment.managedRuntime.endpointTemplateIds.includes(
        endpointTemplate.id,
      )
      || !managedProviderRuntime
      || managedProviderRuntime.isCurrent() !== true
      || !managedPurposeBindingSnapshot
      || !managedPurposeBindingSnapshotMatchesDeclarations({
        implementationIdentity: record.deployment.implementationIdentity,
        connectedAccounts: record.deployment.managedRuntime.connectedAccounts,
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
    if (!selectProviderRuntimeCredentialTransportV1({
      transports: [runtimeCredentialTransport],
      protocol: compatibilityResult.selectedProtocol,
      agent: adapter.support,
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
        implementationIdentity: record.deployment.implementationIdentity,
        managedRuntime: record.deployment.managedRuntime,
      },
      endpointTemplateId: endpointTemplate.id,
      protocol: compatibilityResult.selectedProtocol,
      publicHeaders: endpointTemplate.publicHeaders ?? {},
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
        publicHeaders: endpointTemplate.publicHeaders ?? {},
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
            managedRuntime: record.deployment.managedRuntime,
            runtime: managedProviderRuntime,
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
    ? selectProviderRuntimeCredentialTransportV1({
        transports: facts.credential?.transports ?? [],
        protocol: endpoint.protocol,
        agent: adapter.support,
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
