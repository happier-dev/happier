import {
  EncryptedStringV1Schema,
  type EncryptedStringV1,
} from '../crypto/settingsSecretStringSchemasV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposes.js';
import type {
  ConnectedAccountRequestAuthUseV1,
} from '../connect/connectedAccountRequestAuth.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../connect/connectedAccountPurposeBindings.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { z } from 'zod/mini';
import type { CapabilitySupport, ProviderWireProtocol } from './capabilities/v1.js';
import { CapabilitySupportSchema, ProviderWireProtocolSchema } from './capabilities/v1.js';
import type { ProviderCatalogProbeV1 } from './catalog/descriptorV1.js';
import {
  ProviderCatalogParserV1Schema,
  ProviderCatalogSourceRegistryVersionV1Schema,
  ProviderCatalogProbeV1Schema,
  type ProviderCatalogParserV1,
} from './catalog/descriptorV1.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from './catalog/limits.js';
import type {
  ProviderManagedRuntimeDeclarationV1,
  ProviderModelLoadDescriptorV1,
  ResolvedProviderManagedRuntimeDeclarationV1,
} from './contributions/v1.js';
import {
  ProviderManagedRuntimeDeclarationV1Schema,
  ProviderModelLoadDescriptorV1Schema,
  ProviderUsageSourceV1Schema,
  resolveProviderManagedRuntimeDeclarationV1,
} from './contributions/v1.js';
import type { ProviderCatalogCommandFallbackV1 } from './detection/v1.js';
import { ProviderCatalogCommandFallbackV1Schema } from './detection/v1.js';
import type { ProviderCredentialDestinationV1, ProviderCredentialTransportV1 } from './credentials/v1.js';
import { ProviderCredentialTransportV1Schema } from './credentials/v1.js';
import { compareProviderCanonicalStringsV1 } from './canonicalOrderV1.js';
import { ProviderEndpointUrlSyntaxSchema } from './endpointUrlSchema.js';
import {
  createProviderFingerprintV1,
  createProviderGrantFingerprintV2,
  ProviderCatalogFingerprintV1Schema,
  ProviderEndpointObservationFingerprintV1Schema,
  ProviderObservationAuthorizationFingerprintV1Schema,
  ProviderProbeObservationIdentityV1Schema,
  ProviderProbeRequestFingerprintV1Schema,
  type ProviderCatalogFingerprintV1,
  type ProviderEndpointObservationFingerprintV1,
  type ProviderObservationAuthorizationFingerprintV1,
  type ProviderProbeObservationIdentityV1,
  type ProviderProbeRequestFingerprintV1,
} from './fingerprints.js';
import {
  ProviderAccountGrantV1Schema,
  ProviderMachineGrantV1Schema,
  type ProviderAccountGrantV1,
  type ProviderMachineGrantV1,
} from './grants/v1.js';
import {
  ProviderAgentTargetKeySchema,
  ProviderConnectionIdSchema,
  ProviderLocalIdSchema,
  ProviderMachineIdSchema,
  ProviderModelIdSchema,
} from './ids.js';
import {
  normalizeProviderCredentialHeaderName,
  normalizeProviderPublicHeaders,
  normalizeProviderQueryParameterName,
} from './safety/headers.js';
import {
  assessProviderEndpoint,
  normalizeProviderEndpointUrlSyntax,
  buildProviderEndpointSetFingerprintInput,
  type AssessedProviderEndpoint,
} from './safety/url.js';
import { ProviderAdapterBindingKeyV1Schema } from './sessions/adapterBindingKeyV1.js';
import { ProviderOriginRelativePathSchema } from './originRelativePathSchema.js';
import { ProviderGatewayPlacementV1Schema, type ProviderGatewayPlacementV1 } from './connections/v1.js';
import { providerEndpointPolicySecurityFactsV1 } from './endpointPolicyV1.js';

type ProviderSecurityEndpointV1 = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  url: string | null;
  publicHeaders?: Readonly<Record<string, string>>;
}> & Parameters<typeof providerEndpointPolicySecurityFactsV1>[0];

/**
 * A managed connection has no durable realized URL, but its declared endpoint
 * identity — protocol and immutable public headers — still decides what the
 * host sends on the user's behalf. Those facts belong to the same machine grant
 * as every other effect-relevant declaration fact; only the realized loopback
 * port is excluded.
 */
export type ProviderManagedSecurityEndpointV1 = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  publicHeaders?: Readonly<Record<string, string>>;
}>;

function normalizeManagedEndpoint(endpoint: ProviderManagedSecurityEndpointV1) {
  return {
    endpointTemplateId: ProviderLocalIdSchema.parse(endpoint.endpointTemplateId),
    protocol: ProviderWireProtocolSchema.parse(endpoint.protocol),
    publicHeaders: normalizeProviderPublicHeaders(endpoint.publicHeaders ?? {}),
  };
}

function canonicalManagedConnectedAccountsV1(
  connectedAccounts: ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'],
): ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'] {
  // Purpose ids are unique within one consumer by schema, so purpose is the
  // complete canonical order key for security-relevant declaration facts.
  return connectedAccounts.map(({ title: _title, ...declaration }) => ({
    ...declaration,
    ...(declaration.materializationKinds !== undefined
      ? {
          materializationKinds: [...declaration.materializationKinds].sort(
            compareProviderCanonicalStringsV1,
          ),
        }
      : {}),
  })).sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
}

function canonicalManagedRequestAuthUsesV1(
  requestAuthUses: readonly ConnectedAccountRequestAuthUseV1[],
): readonly ConnectedAccountRequestAuthUseV1[] {
  return [...requestAuthUses].sort((left, right) =>
    compareProviderCanonicalStringsV1(left.purpose, right.purpose));
}

/**
 * Projects the declaration facts shared by every managed security boundary.
 * Each caller supplies its own domain separator and operation-specific facts;
 * this is the one place that resolves and canonicalizes the managed runtime
 * declaration itself.
 */
function projectManagedRuntimeDeclarationSecurityFactsV1(input: Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedRuntime:
    | ProviderManagedRuntimeDeclarationV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
}>) {
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
    implementationIdentity,
    managedRuntime: input.managedRuntime,
  });
  return {
    implementationIdentity,
    managedRuntime: {
      kind: 'managed' as const,
      ...(managedRuntime.sharing ? { sharing: managedRuntime.sharing } : {}),
      ...(managedRuntime.sourceEnvelopeTransport ? { sourceEnvelopeTransport: managedRuntime.sourceEnvelopeTransport } : {}),
      dependencies: [...managedRuntime.dependencies].sort(
        compareProviderCanonicalStringsV1,
      ),
      endpointTemplateIds: [...managedRuntime.endpointTemplateIds],
      connectedAccounts: canonicalManagedConnectedAccountsV1(
        managedRuntime.connectedAccounts,
      ),
      requestAuthUses: canonicalManagedRequestAuthUsesV1(
        managedRuntime.requestAuthUses,
      ),
    },
  };
}

export const PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1 = 1;

function positiveSchemaVersion(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function normalizeDestination(destination: ProviderCredentialDestinationV1): ProviderCredentialDestinationV1 {
  return destination.kind === 'httpHeader'
    ? { ...destination, name: normalizeProviderCredentialHeaderName(destination.name) }
    : { ...destination, name: normalizeProviderQueryParameterName(destination.name) };
}

export function createProviderCredentialDestinationFingerprintV1(
  destination: ProviderCredentialDestinationV1 | null,
): string {
  return createProviderFingerprintV1(
    'credential-destination',
    destination === null ? null : normalizeDestination(destination),
  );
}

function normalizeTransport(transport: ProviderCredentialTransportV1): ProviderCredentialTransportV1 {
  const parsed = ProviderCredentialTransportV1Schema.parse(transport);
  return {
    ...parsed,
    protocols: [...parsed.protocols].sort(),
    uses: [...parsed.uses].sort(),
    destination: normalizeDestination(parsed.destination),
    ...(parsed.additionalCredentials?.length ? { additionalCredentials: parsed.additionalCredentials.map(({slotId, destination}) => ({ slotId, destination: normalizeDestination(destination) })).sort((a,b) => compareProviderCanonicalStringsV1(a.slotId,b.slotId)) } : {}),
  };
}

function normalizeEndpoint(endpoint: ProviderSecurityEndpointV1) {
  return {
    endpointTemplateId: ProviderLocalIdSchema.parse(endpoint.endpointTemplateId),
    protocol: ProviderWireProtocolSchema.parse(endpoint.protocol),
    url: endpoint.url === null ? null : ProviderEndpointUrlSyntaxSchema.parse(endpoint.url),
    publicHeaders: normalizeProviderPublicHeaders(endpoint.publicHeaders ?? {}),
    ...providerEndpointPolicySecurityFactsV1(endpoint),
  };
}

function projectUsageSourceSecurityFacts(source: import('./contributions/v1.js').ProviderUsageSourceV1) {
  const parsed = ProviderUsageSourceV1Schema.parse(source);
  return { id: parsed.id, endpointTemplateId: parsed.endpointTemplateId, path: parsed.path, parser: parsed.parser,
    ...(parsed.billingCredential ? { billingCredential: { slotId: parsed.billingCredential.slotId,
      destination: parsed.billingCredential.destination } } : {}) };
}

export function createProviderConnectionSecurityFingerprintV1(input: Readonly<{
  securityContractVersion: number;
  endpoints: readonly ProviderSecurityEndpointV1[];
  catalogProbes: readonly ProviderCatalogProbeV1[];
  availabilityProbe?: ProviderCatalogProbeV1;
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  credentialTransports: readonly ProviderCredentialTransportV1[];
  modelLoad?: ProviderModelLoadDescriptorV1;
  usageSources?: readonly import('./contributions/v1.js').ProviderUsageSourceV1[];
  managedDeployment?: Readonly<{
    gatewayPlacement?: ProviderGatewayPlacementV1;
    implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
    managedRuntime:
      | ProviderManagedRuntimeDeclarationV1
      | ResolvedProviderManagedRuntimeDeclarationV1;
    /**
     * The URL-free declared endpoint facts selected by
     * `managedRuntime.endpointTemplateIds`. Required so a managed grant tracks
     * the protocol and public headers the host will actually send.
     */
    logicalEndpoints: readonly ProviderManagedSecurityEndpointV1[];
  }>;
}>): string {
  const credentialTransports = input.credentialTransports.map(normalizeTransport).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const normalizedSharedFacts = {
    securityContractVersion: positiveSchemaVersion(input.securityContractVersion, 'Security contract version'),
    catalogProbes: input.catalogProbes.map((probe) => ProviderCatalogProbeV1Schema.parse(probe)),
    availabilityProbe: input.availabilityProbe
      ? ProviderCatalogProbeV1Schema.parse(input.availabilityProbe)
      : null,
    catalogFallback: input.catalogFallback
      ? ProviderCatalogCommandFallbackV1Schema.parse(input.catalogFallback)
      : null,
    credentialTransports,
    modelLoad: input.modelLoad ? ProviderModelLoadDescriptorV1Schema.parse(input.modelLoad) : null,
    ...(input.usageSources?.length ? { usageSources: input.usageSources.map(projectUsageSourceSecurityFacts)
      .sort((left, right) => compareProviderCanonicalStringsV1(left.id, right.id)) } : {}),
  };
  if (input.managedDeployment === undefined) {
    return createProviderFingerprintV1('connection-security', {
      securityContractVersion: normalizedSharedFacts.securityContractVersion,
      endpoints: input.endpoints.map(normalizeEndpoint),
      catalogProbes: normalizedSharedFacts.catalogProbes,
      availabilityProbe: normalizedSharedFacts.availabilityProbe,
      catalogFallback: normalizedSharedFacts.catalogFallback,
      credentialTransports: normalizedSharedFacts.credentialTransports,
      modelLoad: normalizedSharedFacts.modelLoad,
      ...('usageSources' in normalizedSharedFacts ? { usageSources: normalizedSharedFacts.usageSources } : {}),
    });
  }
  if (input.endpoints.length !== 0) {
    throw new TypeError('Managed Provider connection security facts must not contain durable endpoints');
  }
  const managedDeclaration = projectManagedRuntimeDeclarationSecurityFactsV1({
    implementationIdentity: input.managedDeployment.implementationIdentity,
    managedRuntime: input.managedDeployment.managedRuntime,
  });
  return createProviderFingerprintV1('connection-security', {
    ...normalizedSharedFacts,
    deployment: {
      kind: 'managedLocal',
      ...(input.managedDeployment.gatewayPlacement?.kind === 'machine'
        ? { gatewayPlacement: ProviderGatewayPlacementV1Schema.parse(input.managedDeployment.gatewayPlacement) } : {}),
      implementationIdentity: managedDeclaration.implementationIdentity,
      logicalEndpoints: input.managedDeployment.logicalEndpoints
        .map(normalizeManagedEndpoint)
        .sort((left, right) => compareProviderCanonicalStringsV1(
          left.endpointTemplateId,
          right.endpointTemplateId,
        )),
      managedRuntime: managedDeclaration.managedRuntime,
    },
  });
}

/** New consent follows destinations and credential disclosure, not plugin observation declarations. */
export function createProviderConnectionSecurityFingerprintV2(
  input: Parameters<typeof createProviderConnectionSecurityFingerprintV1>[0],
): string {
  const credentialTransports = input.credentialTransports.map(normalizeTransport)
    .sort((left, right) => compareProviderCanonicalStringsV1(JSON.stringify(left), JSON.stringify(right)));
  // Usage paths/parsers are observation declarations. A separate billing slot
  // and its destination still change which credential the host discloses.
  const billingCredentialDestinations = [...new Map((input.usageSources ?? []).flatMap(source =>
    source.billingCredential ? [{ endpointTemplateId: source.endpointTemplateId,
      slotId: source.billingCredential.slotId, destination: normalizeDestination(source.billingCredential.destination) }] : [])
    .map(destination => [JSON.stringify(destination), destination])).entries()]
    .sort(([left], [right]) => compareProviderCanonicalStringsV1(left, right)).map(([, destination]) => destination);
  const sharedFacts = {
    securityContractVersion: positiveSchemaVersion(input.securityContractVersion, 'Security contract version'),
    credentialTransports,
    billingCredentialDestinations,
  };
  if (!input.managedDeployment) {
    return createProviderGrantFingerprintV2('connection-security', {
      ...sharedFacts, endpoints: input.endpoints.map(endpoint => {
        const { endpointTemplateId, protocol, url, publicHeaders } = normalizeEndpoint(endpoint);
        return { endpointTemplateId, protocol, url, publicHeaders };
      }).sort((left, right) => compareProviderCanonicalStringsV1(left.endpointTemplateId, right.endpointTemplateId)),
    });
  }
  if (input.endpoints.length !== 0) {
    throw new TypeError('Managed Provider connection security facts must not contain durable endpoints');
  }
  const declaration = projectManagedRuntimeDeclarationSecurityFactsV1(input.managedDeployment);
  return createProviderGrantFingerprintV2('connection-security', {
    ...sharedFacts,
    deployment: {
      kind: 'managedLocal',
      ...(input.managedDeployment.gatewayPlacement?.kind === 'machine'
        ? { gatewayPlacement: ProviderGatewayPlacementV1Schema.parse(input.managedDeployment.gatewayPlacement) } : {}),
      implementationIdentity: declaration.implementationIdentity,
      logicalEndpoints: input.managedDeployment.logicalEndpoints.map(normalizeManagedEndpoint)
        .sort((left, right) => compareProviderCanonicalStringsV1(left.endpointTemplateId, right.endpointTemplateId)),
      connectedAccounts: declaration.managedRuntime.connectedAccounts.map(account => ({
        purpose: account.purpose, service: account.service,
        ...(account.materializationKinds ? { materializationKinds: account.materializationKinds } : {}),
        ...(account.credentialKinds ? { credentialKinds: [...account.credentialKinds].sort(compareProviderCanonicalStringsV1) } : {}),
        ...(account.endpointTemplateIds ? { endpointTemplateIds: [...account.endpointTemplateIds].sort(compareProviderCanonicalStringsV1) } : {}),
      })),
      requestAuthUses: declaration.managedRuntime.requestAuthUses,
      ...(declaration.managedRuntime.sourceEnvelopeTransport
        ? { sourceEnvelopeTransport: declaration.managedRuntime.sourceEnvelopeTransport } : {}),
    },
  });
}

type ProviderBindingSecurityFingerprintV1Base = Readonly<{
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
  modelCapabilities: Readonly<{
    reasoningControls?: CapabilitySupport;
  }>;
  materialization: 'spawnEnv' | 'engineConfig' | 'configFile';
  adapterBindingKey?: string;
  credentialDestination?: ProviderCredentialDestinationV1;
  compatibilityFingerprint: string;
  adapterVersion: number;
}>;

type ProviderBindingExternalEndpointIdentityV1 = Readonly<{
  deployment?: Readonly<{ kind: 'external' }>;
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderWireProtocol;
  publicHeaders: Readonly<Record<string, string>>;
}>;

type ProviderBindingManagedEndpointIdentityV1 = Readonly<{
  deployment: Readonly<{
    kind: 'managedLocal';
    gatewayPlacement?: ProviderGatewayPlacementV1;
    implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
    managedRuntime:
      | ProviderManagedRuntimeDeclarationV1
      | ResolvedProviderManagedRuntimeDeclarationV1;
  }>;
  endpointTemplateId: string;
  endpointUrl?: never;
  protocol: ProviderWireProtocol;
  publicHeaders: Readonly<Record<string, string>>;
}>;

export function createProviderBindingSecurityFingerprintV1(
  input: ProviderBindingSecurityFingerprintV1Base & (
    | ProviderBindingExternalEndpointIdentityV1
    | ProviderBindingManagedEndpointIdentityV1
  ),
): string {
  const adapterBindingKey = input.adapterBindingKey === undefined
    ? null
    : ProviderAdapterBindingKeyV1Schema.parse(input.adapterBindingKey);
  const compatibilityFingerprint = input.compatibilityFingerprint;
  if (!compatibilityFingerprint || compatibilityFingerprint !== compatibilityFingerprint.trim()) {
    throw new TypeError('Compatibility fingerprint must be canonical');
  }
  const normalizedSharedFacts = {
    agentTargetKey: ProviderAgentTargetKeySchema.parse(input.agentTargetKey),
    connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
    modelId: ProviderModelIdSchema.parse(input.modelId),
    modelCapabilities: {
      reasoningControls: input.modelCapabilities.reasoningControls === undefined
        ? null
        : CapabilitySupportSchema.parse(input.modelCapabilities.reasoningControls),
    },
    materialization: input.materialization,
    adapterBindingKey,
    credentialDestination: input.credentialDestination ? normalizeDestination(input.credentialDestination) : null,
    compatibilityFingerprint,
    adapterVersion: positiveSchemaVersion(input.adapterVersion, 'Adapter version'),
  };
  if (input.deployment?.kind !== 'managedLocal') {
    return createProviderFingerprintV1('binding-security', {
      agentTargetKey: normalizedSharedFacts.agentTargetKey,
      connectionId: normalizedSharedFacts.connectionId,
      modelId: normalizedSharedFacts.modelId,
      endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
      endpointUrl: ProviderEndpointUrlSyntaxSchema.parse(input.endpointUrl),
      protocol: ProviderWireProtocolSchema.parse(input.protocol),
      publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
      materialization: normalizedSharedFacts.materialization,
      adapterBindingKey: normalizedSharedFacts.adapterBindingKey,
      credentialDestination: normalizedSharedFacts.credentialDestination,
      compatibilityFingerprint: normalizedSharedFacts.compatibilityFingerprint,
      adapterVersion: normalizedSharedFacts.adapterVersion,
    });
  }
  if ('endpointUrl' in input) {
    throw new TypeError('Managed Provider binding security facts must not contain a realized endpoint URL');
  }
  const managedDeclaration = projectManagedRuntimeDeclarationSecurityFactsV1({
    implementationIdentity: input.deployment.implementationIdentity,
    managedRuntime: input.deployment.managedRuntime,
  });
  return createProviderFingerprintV1('binding-security', {
    ...normalizedSharedFacts,
    endpointIdentity: {
      kind: 'managedLocal',
      ...(input.deployment.gatewayPlacement?.kind === 'machine'
        ? { gatewayPlacement: ProviderGatewayPlacementV1Schema.parse(input.deployment.gatewayPlacement) } : {}),
      implementationIdentity: managedDeclaration.implementationIdentity,
      managedRuntime: managedDeclaration.managedRuntime,
      endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
      protocol: ProviderWireProtocolSchema.parse(input.protocol),
      publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
    },
  });
}

function canonicalAssessedGrantEndpoints(input: Readonly<{
  endpoints: readonly Readonly<{
    endpointTemplateId: string;
    endpoint: AssessedProviderEndpoint;
  }>[];
}>) {
  return input.endpoints.map(({ endpointTemplateId, endpoint }) => {
    const reassessed = assessProviderEndpoint(endpoint.normalizedUrl, {
      ...(endpoint.resolvedAddresses.length ? { resolvedAddresses: endpoint.resolvedAddresses } : {}),
      purpose: 'configuration',
      privateNetworkConfirmed: true,
    });
    const claimed = {
      normalizedUrl: endpoint.normalizedUrl,
      origin: endpoint.origin,
      hostname: endpoint.hostname,
      protocol: endpoint.protocol,
      locality: endpoint.locality,
      scope: endpoint.scope,
      resolvedAddresses: endpoint.resolvedAddresses,
      nonPublicAddresses: endpoint.nonPublicAddresses,
    };
    if (JSON.stringify(claimed) !== JSON.stringify(reassessed)) {
      throw new TypeError('Endpoint-set fingerprints require the canonical assessed endpoint result');
    }
    return {
      endpointTemplateId: ProviderLocalIdSchema.parse(endpointTemplateId),
      endpoint: reassessed,
    };
  });
}

export function createProviderEndpointSetFingerprintV1(
  input: Parameters<typeof canonicalAssessedGrantEndpoints>[0],
): string {
  return createProviderFingerprintV1(
    'endpoint-set',
    buildProviderEndpointSetFingerprintInput(canonicalAssessedGrantEndpoints(input)),
  );
}

export function createProviderEndpointSetFingerprintV2(
  input: Parameters<typeof canonicalAssessedGrantEndpoints>[0],
): string {
  // No DNS or claimed assessment fields participate in destination-only consent.
  const endpoints = input.endpoints.map(({ endpointTemplateId, endpoint }) => ({
    endpointTemplateId: ProviderLocalIdSchema.parse(endpointTemplateId),
    normalizedUrl: normalizeProviderEndpointUrlSyntax(endpoint.normalizedUrl).normalizedUrl,
  }));
  return createProviderGrantFingerprintV2('endpoint-set', endpoints.sort((left, right) =>
    compareProviderCanonicalStringsV1(left.endpointTemplateId, right.endpointTemplateId)));
}

export function createProviderSavedSecretRecordFingerprintV1(input: Readonly<{
  secretId: string;
  persistedEncryptedEnvelope: EncryptedStringV1;
}>): string {
  const secretId = input.secretId;
  if (!secretId || secretId.length > 256 || secretId !== secretId.trim()) {
    throw new TypeError('Saved-secret id must be canonical');
  }
  return createProviderFingerprintV1('saved-secret-record', [
    secretId,
    EncryptedStringV1Schema.parse(input.persistedEncryptedEnvelope),
  ]);
}

export function createProviderObservationAuthorizationFingerprintV1(input: Readonly<{
  selectedSecretBindingId: string | null;
  selectedSecretRecordFingerprint: string | null;
  credential: Readonly<{
    transport: ProviderCredentialTransportV1;
    selectedProtocol: ProviderWireProtocol;
    selectedUse: 'probe' | 'runtime' | 'management';
  }> | null;
}>): ProviderObservationAuthorizationFingerprintV1 {
  if ((input.selectedSecretBindingId === null) !== (input.selectedSecretRecordFingerprint === null)) {
    throw new TypeError('Selected secret id and record fingerprint must be present together');
  }
  if (input.credential !== null && input.selectedSecretBindingId === null) {
    throw new TypeError('A credential transport requires a selected secret');
  }
  if (input.credential === null && input.selectedSecretBindingId !== null) {
    throw new TypeError('A selected secret requires an exact credential transport');
  }
  const selectedSecretBindingId = input.selectedSecretBindingId;
  if (selectedSecretBindingId !== null
    && (!selectedSecretBindingId || selectedSecretBindingId.length > 256 || selectedSecretBindingId !== selectedSecretBindingId.trim())) {
    throw new TypeError('Saved-secret id must be canonical');
  }
  const selectedSecretRecordFingerprint = input.selectedSecretRecordFingerprint;
  if (selectedSecretRecordFingerprint !== null
    && (!selectedSecretRecordFingerprint.startsWith('saved-secret-record:v1:')
      || selectedSecretRecordFingerprint.length > 256
      || selectedSecretRecordFingerprint !== selectedSecretRecordFingerprint.trim())) {
    throw new TypeError('Saved-secret record fingerprint must be canonical');
  }
  let credential: Readonly<{
    transportId: string;
    selectedProtocol: ProviderWireProtocol;
    selectedUse: 'probe' | 'runtime' | 'management';
    destination: ProviderCredentialDestinationV1;
  }> | null = null;
  if (input.credential) {
    const transport = normalizeTransport(input.credential.transport);
    const selectedProtocol = ProviderWireProtocolSchema.parse(input.credential.selectedProtocol);
    const selectedUse = input.credential.selectedUse;
    if (!transport.protocols.includes(selectedProtocol) || !transport.uses.includes(selectedUse)) {
      throw new TypeError('Selected credential protocol and use must belong to the transport');
    }
    credential = {
      transportId: transport.id,
      selectedProtocol,
      selectedUse,
      destination: transport.destination,
    };
  }
  return ProviderObservationAuthorizationFingerprintV1Schema.parse(createProviderFingerprintV1('observation-authorization', {
    selectedSecretBindingId,
    selectedSecretRecordFingerprint,
    credential,
  }));
}

export function createProviderProbeObservationIdentityV1(input: Readonly<{
  machineId: string;
  connectionId: string;
  catalogFingerprint: ProviderCatalogFingerprintV1 | null;
  observationAuthorizationFingerprints: readonly ProviderObservationAuthorizationFingerprintV1[];
  authorizationGrant: Readonly<{
    kind: 'account' | 'machine';
    fingerprint: string;
    confirmedAt: number;
  }>;
}>): ProviderProbeObservationIdentityV1 {
  const catalogFingerprint = input.catalogFingerprint === null
    ? null
    : ProviderCatalogFingerprintV1Schema.parse(input.catalogFingerprint);
  const observationAuthorizationFingerprints = input.observationAuthorizationFingerprints
    .map((fingerprint) => ProviderObservationAuthorizationFingerprintV1Schema.parse(fingerprint))
    .sort();
  if (observationAuthorizationFingerprints.length > PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes) {
    throw new TypeError('Probe observation authorization fingerprint set exceeds the catalog probe limit');
  }
  if (new Set(observationAuthorizationFingerprints).size !== observationAuthorizationFingerprints.length) {
    throw new TypeError('Probe observation authorization fingerprints must be unique');
  }
  if ((catalogFingerprint === null) !== (observationAuthorizationFingerprints.length === 0)) {
    throw new TypeError('Probe observation catalog and authorization facts must be present together');
  }
  const expectedGrantPrefix = `${input.authorizationGrant.kind}-grant:v1:`;
  const grantFingerprint = input.authorizationGrant.fingerprint;
  if (!grantFingerprint.startsWith(expectedGrantPrefix)
    || grantFingerprint.length > 256
    || grantFingerprint !== grantFingerprint.trim()) {
    throw new TypeError('Probe observation grant fingerprint must match its canonical grant kind');
  }
  if (!Number.isFinite(input.authorizationGrant.confirmedAt) || input.authorizationGrant.confirmedAt < 0) {
    throw new TypeError('Probe observation grant confirmation time must be finite and nonnegative');
  }
  return ProviderProbeObservationIdentityV1Schema.parse(createProviderFingerprintV1('probe-observation', {
    machineId: ProviderMachineIdSchema.parse(input.machineId),
    connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
    catalogFingerprint,
    observationAuthorizationFingerprints,
    authorizationGrant: {
      kind: input.authorizationGrant.kind,
      fingerprint: grantFingerprint,
      confirmedAt: input.authorizationGrant.confirmedAt,
    },
  }));
}

export const PROVIDER_PROBE_REQUEST_CONTRACT_V1 = Object.freeze({
  safetyContractVersion: 1,
  parserContractVersion: 1,
  maxDecodedResponseBytes: PROVIDER_CATALOG_LIMITS_V1.maxCatalogResponseBytes,
  maxModels: PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection,
  maxModelIdLength: PROVIDER_CATALOG_LIMITS_V1.maxModelIdLength,
  maxModelNameLength: PROVIDER_CATALOG_LIMITS_V1.maxModelNameLength,
  maxModelDescriptionLength: PROVIDER_CATALOG_LIMITS_V1.maxModelDescriptionLength,
} as const);

export function createProviderProbeRequestFingerprintV1(input: Readonly<{
  method: 'GET';
  endpointUrl: string;
  path: string;
  parser: ProviderCatalogParserV1;
  publicHeaders: Readonly<Record<string, string>>;
}>): ProviderProbeRequestFingerprintV1 {
  if (input.method !== 'GET') throw new TypeError('Provider catalog and availability probes must use GET');
  const endpointUrl = ProviderEndpointUrlSyntaxSchema.parse(input.endpointUrl);
  const path = ProviderOriginRelativePathSchema.parse(input.path);
  const parser = ProviderCatalogParserV1Schema.parse(input.parser);
  const exactRequestUrl = new URL(path, endpointUrl).toString();
  return ProviderProbeRequestFingerprintV1Schema.parse(createProviderFingerprintV1('probe-request', {
    method: 'GET',
    exactRequestUrl,
    path,
    parser,
    publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
    contract: PROVIDER_PROBE_REQUEST_CONTRACT_V1,
  }));
}

/**
 * Managed catalog requests have no durable or realized endpoint URL. Their
 * identity is the authorized public managed declaration, declared request,
 * and purpose-binding snapshot. Launch-local endpoints and client access are
 * intentionally absent.
 */
export function createProviderManagedProbeRequestFingerprintV1(input: Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedRuntime:
    | ProviderManagedRuntimeDeclarationV1
    | ResolvedProviderManagedRuntimeDeclarationV1;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  /** Required for every managed dynamic catalog declaration. */
  sourceRegistryVersion: string;
  method: 'GET';
  path: string;
  parser: ProviderCatalogParserV1;
  publicHeaders: Readonly<Record<string, string>>;
}>): ProviderProbeRequestFingerprintV1 {
  if (input.method !== 'GET') throw new TypeError('Provider catalog and availability probes must use GET');
  const managedDeclaration = projectManagedRuntimeDeclarationSecurityFactsV1({
    implementationIdentity: input.implementationIdentity,
    managedRuntime: input.managedRuntime,
  });
  const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
    input.purposeBindings,
  );
  const canonicalBindings = [...purposeBindings.bindings].sort((left, right) =>
    compareProviderCanonicalStringsV1(JSON.stringify(left), JSON.stringify(right)));
  const path = ProviderOriginRelativePathSchema.parse(input.path);
  const parser = ProviderCatalogParserV1Schema.parse(input.parser);
  const endpointTemplateId = ProviderLocalIdSchema.parse(
    input.endpointTemplateId,
  );
  const sourceRegistryVersion = ProviderCatalogSourceRegistryVersionV1Schema.parse(
    input.sourceRegistryVersion,
  );
  if (!managedDeclaration.managedRuntime.endpointTemplateIds.includes(endpointTemplateId)) {
    throw new TypeError(
      'Managed Provider catalog endpoint is outside the public declaration',
    );
  }
  return ProviderProbeRequestFingerprintV1Schema.parse(createProviderFingerprintV1('probe-request', {
    deployment: 'managedLocal',
    implementationIdentity: managedDeclaration.implementationIdentity,
    managedRuntime: managedDeclaration.managedRuntime,
    purposeBindings: { v: 1, bindings: canonicalBindings },
    endpointTemplateId,
    protocol: ProviderWireProtocolSchema.parse(input.protocol),
    sourceRegistryVersion,
    method: 'GET',
    path,
    parser,
    publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
    contract: PROVIDER_PROBE_REQUEST_CONTRACT_V1,
  }));
}

export function createProviderEndpointFingerprintV1(input: Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  probeRequestFingerprint: ProviderProbeRequestFingerprintV1;
}>): ProviderEndpointObservationFingerprintV1 {
  const probeRequestFingerprint = input.probeRequestFingerprint;
  ProviderProbeRequestFingerprintV1Schema.parse(probeRequestFingerprint);
  return ProviderEndpointObservationFingerprintV1Schema.parse(createProviderFingerprintV1('endpoint-observation', {
    endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
    protocol: ProviderWireProtocolSchema.parse(input.protocol),
    probeRequestFingerprint,
  }));
}

export function createProviderCatalogFingerprintV1(input: Readonly<{
  probeRequestFingerprints: readonly ProviderProbeRequestFingerprintV1[];
  catalogFallback?: Readonly<{
    descriptor: ProviderCatalogCommandFallbackV1;
    endpointUrl: string;
  }>;
  /**
   * A managed fallback is declaration-owned and deliberately excludes the
   * launch-local URL, which is neither durable catalog identity nor a grant.
   */
  managedCatalogFallback?: ProviderCatalogCommandFallbackV1;
}>): ProviderCatalogFingerprintV1 {
  if (input.probeRequestFingerprints.length < 1
    || input.probeRequestFingerprints.length > PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes) {
    throw new TypeError('Catalog observations require one to three ordered probe requests');
  }
  if (input.catalogFallback && input.managedCatalogFallback) {
    throw new TypeError('Catalog observations cannot mix external and managed command fallback identity');
  }
  const probeRequestFingerprints = input.probeRequestFingerprints.map((fingerprint) =>
    ProviderProbeRequestFingerprintV1Schema.parse(fingerprint));
  return ProviderCatalogFingerprintV1Schema.parse(createProviderFingerprintV1('catalog', {
    probeRequestFingerprints,
    ...(input.catalogFallback ? {
      catalogFallback: {
        descriptor: ProviderCatalogCommandFallbackV1Schema.parse(input.catalogFallback.descriptor),
        endpointUrl: ProviderEndpointUrlSyntaxSchema.parse(input.catalogFallback.endpointUrl),
      },
    } : {}),
    ...(input.managedCatalogFallback ? {
      managedCatalogFallback: ProviderCatalogCommandFallbackV1Schema.parse(
        input.managedCatalogFallback,
      ),
    } : {}),
  }));
}

export function createProviderAccountGrantFingerprintV1(input: ProviderAccountGrantV1): string {
  const grant = ProviderAccountGrantV1Schema.parse(input);
  return createProviderFingerprintV1('account-grant', {
    connectionId: grant.connectionId,
    connectionSecurityFingerprint: grant.connectionSecurityFingerprint,
  });
}

export function createProviderMachineGrantFingerprintV1(input: ProviderMachineGrantV1): string {
  const grant = ProviderMachineGrantV1Schema.parse(input);
  return createProviderFingerprintV1('machine-grant', {
    machineId: grant.machineId,
    connectionId: grant.connectionId,
    endpointSetFingerprint: grant.endpointSetFingerprint,
    connectionSecurityFingerprint: grant.connectionSecurityFingerprint,
  });
}
