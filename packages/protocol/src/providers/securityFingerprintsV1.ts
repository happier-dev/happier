import { EncryptedStringV1Schema, type EncryptedStringV1 } from '../crypto/settingsSecretStringsV1.js';
import type { ProviderWireProtocol } from './capabilities/v1.js';
import { ProviderWireProtocolSchema } from './capabilities/v1.js';
import type { ProviderCatalogProbeV1 } from './catalog/descriptorV1.js';
import { ProviderCatalogProbeV1Schema } from './catalog/descriptorV1.js';
import type { ProviderModelLoadDescriptorV1 } from './contributions/v1.js';
import { ProviderModelLoadDescriptorV1Schema } from './contributions/v1.js';
import type { ProviderCredentialDestinationV1, ProviderCredentialTransportV1 } from './credentials/v1.js';
import { ProviderCredentialTransportV1Schema } from './credentials/v1.js';
import { ProviderEndpointUrlSyntaxSchema } from './endpointUrlSchema.js';
import { createProviderFingerprintV1 } from './fingerprints.js';
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
  ProviderModelIdSchema,
} from './ids.js';
import {
  assessProviderEndpoint,
  buildProviderEndpointSetFingerprintInput,
  normalizeProviderCredentialHeaderName,
  normalizeProviderPublicHeaders,
  normalizeProviderQueryParameterName,
  type AssessedProviderEndpoint,
} from './safety/index.js';
import { ProviderAdapterBindingKeyV1Schema } from './sessions/adapterBindingKeyV1.js';

type ProviderSecurityEndpointV1 = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  url: string;
  publicHeaders?: Readonly<Record<string, string>>;
}>;

function positiveSchemaVersion(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function normalizeDestination(destination: ProviderCredentialDestinationV1): ProviderCredentialDestinationV1 {
  return destination.kind === 'httpHeader'
    ? { ...destination, name: normalizeProviderCredentialHeaderName(destination.name) }
    : { ...destination, name: normalizeProviderQueryParameterName(destination.name) };
}

function normalizeTransport(transport: ProviderCredentialTransportV1): ProviderCredentialTransportV1 {
  const parsed = ProviderCredentialTransportV1Schema.parse(transport);
  return {
    ...parsed,
    protocols: [...parsed.protocols].sort(),
    uses: [...parsed.uses].sort(),
    destination: normalizeDestination(parsed.destination),
  };
}

function normalizeEndpoint(endpoint: ProviderSecurityEndpointV1) {
  return {
    endpointTemplateId: ProviderLocalIdSchema.parse(endpoint.endpointTemplateId),
    protocol: ProviderWireProtocolSchema.parse(endpoint.protocol),
    url: ProviderEndpointUrlSyntaxSchema.parse(endpoint.url),
    publicHeaders: normalizeProviderPublicHeaders(endpoint.publicHeaders ?? {}),
  };
}

export function createProviderConnectionSecurityFingerprintV1(input: Readonly<{
  securityContractVersion: number;
  endpoints: readonly ProviderSecurityEndpointV1[];
  catalogProbes: readonly ProviderCatalogProbeV1[];
  availabilityProbe?: ProviderCatalogProbeV1;
  credentialTransports: readonly ProviderCredentialTransportV1[];
  modelLoad?: ProviderModelLoadDescriptorV1;
}>): string {
  const credentialTransports = input.credentialTransports.map(normalizeTransport).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return createProviderFingerprintV1('connection-security', {
    securityContractVersion: positiveSchemaVersion(input.securityContractVersion, 'Security contract version'),
    endpoints: input.endpoints.map(normalizeEndpoint),
    catalogProbes: input.catalogProbes.map((probe) => ProviderCatalogProbeV1Schema.parse(probe)),
    availabilityProbe: input.availabilityProbe
      ? ProviderCatalogProbeV1Schema.parse(input.availabilityProbe)
      : null,
    credentialTransports,
    modelLoad: input.modelLoad ? ProviderModelLoadDescriptorV1Schema.parse(input.modelLoad) : null,
  });
}

export function createProviderBindingSecurityFingerprintV1(input: Readonly<{
  agentTargetKey: string;
  connectionId: string;
  modelId: string;
  endpointTemplateId: string;
  endpointUrl: string;
  protocol: ProviderWireProtocol;
  publicHeaders: Readonly<Record<string, string>>;
  materialization: 'spawnEnv' | 'engineConfig' | 'configFile';
  adapterBindingKey?: string;
  credentialDestination?: ProviderCredentialDestinationV1;
  compatibilityFingerprint: string;
  adapterVersion: number;
}>): string {
  const adapterBindingKey = input.adapterBindingKey === undefined
    ? null
    : ProviderAdapterBindingKeyV1Schema.parse(input.adapterBindingKey);
  const compatibilityFingerprint = input.compatibilityFingerprint;
  if (!compatibilityFingerprint || compatibilityFingerprint !== compatibilityFingerprint.trim()) {
    throw new TypeError('Compatibility fingerprint must be canonical');
  }
  return createProviderFingerprintV1('binding-security', {
    agentTargetKey: ProviderAgentTargetKeySchema.parse(input.agentTargetKey),
    connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
    modelId: ProviderModelIdSchema.parse(input.modelId),
    endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
    endpointUrl: ProviderEndpointUrlSyntaxSchema.parse(input.endpointUrl),
    protocol: ProviderWireProtocolSchema.parse(input.protocol),
    publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
    materialization: input.materialization,
    adapterBindingKey,
    credentialDestination: input.credentialDestination ? normalizeDestination(input.credentialDestination) : null,
    compatibilityFingerprint,
    adapterVersion: positiveSchemaVersion(input.adapterVersion, 'Adapter version'),
  });
}

export function createProviderEndpointSetFingerprintV1(input: Readonly<{
  endpoints: readonly Readonly<{
    endpointTemplateId: string;
    endpoint: AssessedProviderEndpoint;
  }>[];
}>): string {
  const assessedEndpoints = input.endpoints.map(({ endpointTemplateId, endpoint }) => {
    const reassessed = assessProviderEndpoint(endpoint.normalizedUrl, {
      resolvedAddresses: endpoint.resolvedAddresses,
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
  return createProviderFingerprintV1(
    'endpoint-set',
    buildProviderEndpointSetFingerprintInput(assessedEndpoints),
  );
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
}>): string {
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
  return createProviderFingerprintV1('observation-authorization', {
    selectedSecretBindingId,
    selectedSecretRecordFingerprint,
    credential,
  });
}

export function createProviderCatalogFingerprintV1(input: Readonly<{
  probes: readonly Readonly<{
    probe: ProviderCatalogProbeV1;
    endpointUrl: string;
  }>[];
}>): string {
  return createProviderFingerprintV1('catalog', {
    probes: input.probes.map(({ probe, endpointUrl }) => ({
      probe: ProviderCatalogProbeV1Schema.parse(probe),
      endpointUrl: ProviderEndpointUrlSyntaxSchema.parse(endpointUrl),
    })),
  });
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
