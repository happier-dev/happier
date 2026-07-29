import { EncryptedStringV1Schema, type EncryptedStringV1 } from '../crypto/settingsSecretStringsV1.js';
import {
  ConnectedAccountPurposeDeclarationsV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
} from '../connect/connectedAccountPurposes.js';
import {
  ConnectedAccountRequestAuthUsesV1Schema,
  type ConnectedAccountRequestAuthUseV1,
} from '../connect/connectedAccountRequestAuth.js';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../connect/connectedAccountPurposeBindings.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { z } from 'zod';
import type { CapabilitySupport, ProviderWireProtocol } from './capabilities/v1.js';
import { CapabilitySupportSchema, ProviderWireProtocolSchema } from './capabilities/v1.js';
import type { ProviderCatalogProbeV1 } from './catalog/descriptorV1.js';
import { ProviderCatalogParserV1Schema, ProviderCatalogProbeV1Schema } from './catalog/descriptorV1.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from './catalog/limits.js';
import type { ProviderModelLoadDescriptorV1 } from './contributions/v1.js';
import { ProviderModelLoadDescriptorV1Schema } from './contributions/v1.js';
import type { ProviderCatalogCommandFallbackV1 } from './detection/v1.js';
import { ProviderCatalogCommandFallbackV1Schema } from './detection/v1.js';
import type { ProviderCredentialDestinationV1, ProviderCredentialTransportV1 } from './credentials/v1.js';
import { ProviderCredentialTransportV1Schema } from './credentials/v1.js';
import { compareProviderCanonicalStringsV1 } from './canonicalOrderV1.js';
import { ProviderEndpointUrlSyntaxSchema } from './endpointUrlSchema.js';
import {
  createProviderFingerprintV1,
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
  assessProviderEndpoint,
  buildProviderEndpointSetFingerprintInput,
  normalizeProviderCredentialHeaderName,
  normalizeProviderPublicHeaders,
  normalizeProviderQueryParameterName,
  type AssessedProviderEndpoint,
} from './safety/index.js';
import { ProviderAdapterBindingKeyV1Schema } from './sessions/adapterBindingKeyV1.js';
import { ProviderOriginRelativePathSchema } from './originRelativePathSchema.js';

type ProviderSecurityEndpointV1 = Readonly<{
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  url: string;
  publicHeaders?: Readonly<Record<string, string>>;
}>;

const ManagedProviderLocalServiceDeclarationV1Schema = z.object({
  id: z.string().trim().min(1).max(256),
  launch: z.object({
    kind: z.literal('packaged-runtime-binary'),
    directorySegments: z.array(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    ).min(1).max(8),
    executableBaseName: z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    privateConfigPathFlag: z.string()
      .regex(/^--[a-z0-9][a-z0-9-]*$/u),
  }).strict(),
  launchMode: z.object({
    kind: z.literal('assignAndInject'),
    portPolicy: z.object({
      kind: z.literal('allocated'),
      preferredPort: z.number().int().min(1).max(65_535).optional(),
      onCollision: z.enum(['fail', 'fallback']).optional(),
    }).strict(),
    environment: z.object({
      inject: z.array(z.string().trim().min(1).max(1_024)).optional(),
    }).strict().optional(),
  }).strict(),
  hostPolicy: z.object({
    kind: z.literal('loopback'),
    host: z.string().trim().min(1).max(256).optional(),
  }).strict(),
  name: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('derived'), base: z.string().trim().min(1).max(1_024) }).strict(),
    z.object({ strategy: z.literal('fixed'), name: z.string().trim().min(1).max(1_024) }).strict(),
  ]),
  healthCheck: z.object({
    kind: z.literal('http'),
    path: z.string().trim().min(1).max(1_024),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  restart: z.object({ kind: z.literal('never') }).strict(),
  cleanup: z.object({
    staleAfterMs: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const ManagedProviderEndpointSecurityFactsV1Schema = z.object({
  localService: ManagedProviderLocalServiceDeclarationV1Schema,
  protocols: z.array(ProviderWireProtocolSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.protocols).size !== value.protocols.length) {
    context.addIssue({
      code: 'custom',
      path: ['protocols'],
      message: 'Managed Provider protocols must be unique',
    });
  }
});
export type ManagedProviderEndpointSecurityFactsV1 = z.infer<
  typeof ManagedProviderEndpointSecurityFactsV1Schema
>;

export const ProviderManagedDeploymentSecurityFactsV1Schema = z.object({
  implementationIdentity: PluginContributionIdentityV1Schema,
  managedEndpoint: ManagedProviderEndpointSecurityFactsV1Schema,
  connectedAccounts: ConnectedAccountPurposeDeclarationsV1Schema,
  requestAuthUses: ConnectedAccountRequestAuthUsesV1Schema,
}).strict().superRefine((value, context) => {
  const declarationsByPurpose = new Map(
    value.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  const declaredPurposes = new Set(declarationsByPurpose.keys());
  const requestAuthPurposes = new Set(
    value.requestAuthUses.map((use) => use.purpose),
  );
  if (
    declaredPurposes.size !== requestAuthPurposes.size
    || [...declaredPurposes].some((purpose) => !requestAuthPurposes.has(purpose))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['requestAuthUses'],
      message: 'Managed Provider request-auth uses must exactly match declared connected-account purposes',
    });
  }
  for (const [index, use] of value.requestAuthUses.entries()) {
    const declaration = declarationsByPurpose.get(use.purpose);
    if (
      declaration !== undefined
      && declaration.materializationKinds?.includes(use.materialization.kind) !== true
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestAuthUses', index, 'materialization', 'kind'],
        message: 'Managed Provider request-auth materialization kind must be explicitly declared by its connected-account purpose',
      });
    }
  }
});
export type ProviderManagedDeploymentSecurityFactsV1 = Readonly<{
  implementationIdentity: z.infer<typeof PluginContributionIdentityV1Schema>;
  managedEndpoint: ManagedProviderEndpointSecurityFactsV1;
  connectedAccounts: ReadonlyArray<
    z.infer<typeof ConnectedAccountPurposeDeclarationsV1Schema>[number]
  >;
  requestAuthUses: readonly ConnectedAccountRequestAuthUseV1[];
}>;

function canonicalManagedConnectedAccountsV1(
  connectedAccounts: ProviderManagedDeploymentSecurityFactsV1['connectedAccounts'],
): ProviderManagedDeploymentSecurityFactsV1['connectedAccounts'] {
  // Purpose ids are unique within one consumer by schema, so purpose is the
  // complete canonical order key while the full declaration remains identity.
  return connectedAccounts.map((declaration) => ({
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
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  credentialTransports: readonly ProviderCredentialTransportV1[];
  modelLoad?: ProviderModelLoadDescriptorV1;
  managedDeployment?: ProviderManagedDeploymentSecurityFactsV1;
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
    });
  }
  if (input.endpoints.length !== 0) {
    throw new TypeError('Managed Provider connection security facts must not contain durable endpoints');
  }
  const managedDeployment = ProviderManagedDeploymentSecurityFactsV1Schema.parse(
    input.managedDeployment,
  );
  return createProviderFingerprintV1('connection-security', {
    ...normalizedSharedFacts,
    deployment: {
      kind: 'managedLocal',
      implementationIdentity: managedDeployment.implementationIdentity,
      managedEndpoint: {
        ...managedDeployment.managedEndpoint,
        protocols: [...managedDeployment.managedEndpoint.protocols].sort(),
      },
      connectedAccounts: canonicalManagedConnectedAccountsV1(
        managedDeployment.connectedAccounts,
      ),
      requestAuthUses: canonicalManagedRequestAuthUsesV1(
        managedDeployment.requestAuthUses,
      ),
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
    securityFacts: ProviderManagedDeploymentSecurityFactsV1;
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
  return createProviderFingerprintV1('binding-security', {
    ...normalizedSharedFacts,
    endpointIdentity: {
      kind: 'managedLocal',
      securityFacts: (() => {
        const securityFacts = ProviderManagedDeploymentSecurityFactsV1Schema.parse(
          input.deployment.securityFacts,
        );
        return {
          ...securityFacts,
          managedEndpoint: {
            ...securityFacts.managedEndpoint,
            protocols: [...securityFacts.managedEndpoint.protocols].sort(),
          },
          connectedAccounts: canonicalManagedConnectedAccountsV1(
            securityFacts.connectedAccounts,
          ),
          requestAuthUses: canonicalManagedRequestAuthUsesV1(
            securityFacts.requestAuthUses,
          ),
        };
      })(),
      endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
      protocol: ProviderWireProtocolSchema.parse(input.protocol),
      publicHeaders: normalizeProviderPublicHeaders(input.publicHeaders),
    },
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
  parser: 'openai-models' | 'ollama-tags' | 'lmstudio-native-models';
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

export type ProviderManagedCatalogSourceIdentityV1 = Readonly<{
  kind: 'transientModelEndpoint';
  contractVersion: string;
  sdkVersion: string;
}>;

function canonicalManagedCatalogSourceVersion(value: string, name: string): string {
  if (value.length < 1 || value.length > 256 || value !== value.trim()) {
    throw new TypeError(`${name} must be a canonical non-empty string`);
  }
  return value;
}

/**
 * Managed catalog requests have no durable or realized endpoint URL. Their
 * identity is the authorized bundled implementation, immutable wrapper
 * contract, declared request, and purpose-binding snapshot. Launch-local
 * ports and downstream bearers are intentionally absent.
 */
export function createProviderManagedProbeRequestFingerprintV1(input: Readonly<{
  implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
  managedFacet: Readonly<{
    managedEndpoint: ManagedProviderEndpointSecurityFactsV1;
    connectedAccounts: ReadonlyArray<Readonly<
      z.infer<typeof ConnectedAccountPurposeDeclarationsV1Schema>[number]
    >>;
    requestAuthUses: readonly ConnectedAccountRequestAuthUseV1[];
  }>;
  purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
  catalogSource: ProviderManagedCatalogSourceIdentityV1;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  method: 'GET';
  path: string;
  parser: 'openai-models' | 'ollama-tags' | 'lmstudio-native-models';
  publicHeaders: Readonly<Record<string, string>>;
}>): ProviderProbeRequestFingerprintV1 {
  if (input.method !== 'GET') throw new TypeError('Provider catalog and availability probes must use GET');
  const implementationIdentity = PluginContributionIdentityV1Schema.parse(
    input.implementationIdentity,
  );
  const managedFacet = ProviderManagedDeploymentSecurityFactsV1Schema.parse({
    implementationIdentity,
    managedEndpoint: input.managedFacet.managedEndpoint,
    connectedAccounts: input.managedFacet.connectedAccounts,
    requestAuthUses: input.managedFacet.requestAuthUses,
  });
  const purposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
    input.purposeBindings,
  );
  const canonicalBindings = [...purposeBindings.bindings].sort((left, right) =>
    compareProviderCanonicalStringsV1(JSON.stringify(left), JSON.stringify(right)));
  const path = ProviderOriginRelativePathSchema.parse(input.path);
  const parser = ProviderCatalogParserV1Schema.parse(input.parser);
  if (input.catalogSource.kind !== 'transientModelEndpoint') {
    throw new TypeError('Managed Provider catalog source kind is invalid');
  }
  return ProviderProbeRequestFingerprintV1Schema.parse(createProviderFingerprintV1('probe-request', {
    deployment: 'managedLocal',
    implementationIdentity,
    managedFacet: {
      managedEndpoint: managedFacet.managedEndpoint,
      connectedAccounts: canonicalManagedConnectedAccountsV1(
        managedFacet.connectedAccounts,
      ),
      requestAuthUses: canonicalManagedRequestAuthUsesV1(
        managedFacet.requestAuthUses,
      ),
    },
    purposeBindings: { v: 1, bindings: canonicalBindings },
    catalogSource: {
      kind: 'transientModelEndpoint',
      contractVersion: canonicalManagedCatalogSourceVersion(
        input.catalogSource.contractVersion,
        'Managed Provider catalog contract version',
      ),
      sdkVersion: canonicalManagedCatalogSourceVersion(
        input.catalogSource.sdkVersion,
        'Managed Provider catalog SDK version',
      ),
    },
    endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
    protocol: ProviderWireProtocolSchema.parse(input.protocol),
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
}>): ProviderCatalogFingerprintV1 {
  if (input.probeRequestFingerprints.length < 1
    || input.probeRequestFingerprints.length > PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes) {
    throw new TypeError('Catalog observations require one to three ordered probe requests');
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
