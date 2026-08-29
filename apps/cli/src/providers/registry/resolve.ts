import {
  assessProviderEndpoint,
  createProviderAccountGrantFingerprintV1,
  createProviderConnectionSecurityFingerprintV1,
  createProviderEndpointSetFingerprintV1,
  createProviderMachineGrantFingerprintV1,
  normalizeProviderEndpointUrlSyntax,
  ProviderConnectionIdSchema,
  ProviderMachineIdSchema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
  readOwnRecordValue,
  resolveProviderManagedRuntimeDeclarationV1,
  resolveProviderGrantV1,
  type CustomProviderTemplateV1,
  type ProviderCatalogProbeV1,
  type ProviderCatalogCommandFallbackV1,
  type ProviderConnectionId,
  type ProviderConnectionV1,
  type ProviderContributionV1,
  type ProviderCredentialTransportV1,
  type ProviderEndpointTemplateV1,
  type ProviderManagedSecurityEndpointV1,
  type ProviderModelLoadDescriptorV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import { readProviderSettingsForCli } from '../settings/read';
import { getProviderContribution } from './lookup';
import type {
  ProviderConnectionResolution,
  ResolveProviderConnectionForMachineInput,
  ResolvedProviderConnectionAuthorization,
  ResolvedProviderConnectionEndpoint,
  ResolvedProviderConnectionRecord,
  ResolvedProviderConnectionSource,
} from './types';


class ProviderEndpointRealizationError extends Error {
  readonly code: 'local_candidate_required' | 'unknown_local_candidate';

  constructor(code: ProviderEndpointRealizationError['code'], message: string) {
    super(message);
    this.name = 'ProviderEndpointRealizationError';
    this.code = code;
  }
}

type RuntimeProviderFacts = Readonly<{
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  credentialTransports: readonly ProviderCredentialTransportV1[];
  catalogProbes: readonly ProviderCatalogProbeV1[];
  availabilityProbe?: NonNullable<ProviderContributionV1['discovery']>['availabilityProbe'];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  modelLoad?: ProviderModelLoadDescriptorV1;
}>;

function readCatalogProbes(
  catalog: ProviderContributionV1['catalog'] | CustomProviderTemplateV1['catalog'],
) {
  return 'probes' in catalog ? catalog.probes : [];
}

function factsFromContribution(definition: ProviderContributionV1): RuntimeProviderFacts {
  return {
    endpointTemplates: definition.endpointTemplates,
    credentialTransports: definition.credential?.transports ?? [],
    catalogProbes: readCatalogProbes(definition.catalog),
    ...(definition.discovery ? { availabilityProbe: definition.discovery.availabilityProbe } : {}),
    ...(definition.discovery?.catalogFallback ? { catalogFallback: definition.discovery.catalogFallback } : {}),
    ...(definition.modelLoad ? { modelLoad: definition.modelLoad } : {}),
  };
}

function factsFromCustom(template: CustomProviderTemplateV1): RuntimeProviderFacts {
  return {
    endpointTemplates: template.endpointTemplates,
    credentialTransports: template.credential?.transports ?? [],
    catalogProbes: readCatalogProbes(template.catalog),
  };
}

function readOverrideMap(
  overrides: ProviderConnectionV1['endpointOverrides'],
): ReadonlyMap<string, string> {
  return new Map((overrides ?? []).map((override) => [override.endpointTemplateId, override.baseUrl]));
}

function validateOverrideIds(
  connection: ProviderConnectionV1,
  endpointTemplateIds: ReadonlySet<string>,
): boolean {
  const accountOverrides = connection.endpointOverrides ?? [];
  const machineOverrides = Object.values(connection.endpointOverridesByMachineId ?? {}).flat();
  return [...accountOverrides, ...machineOverrides]
    .every((override) => endpointTemplateIds.has(override.endpointTemplateId));
}

function defaultEndpointUrl(template: ProviderEndpointTemplateV1): Readonly<{
  url: string;
  source: 'contribution' | 'contribution_local_candidate';
}> {
  if (template.baseUrl) {
    return {
      url: template.baseUrl,
      source: 'contribution',
    };
  }
  const candidates = template.localUrlCandidates ?? [];
  const candidate = candidates.length === 1 ? candidates[0] : null;
  if (!candidate && candidates.length > 1) {
    throw new ProviderEndpointRealizationError(
      'local_candidate_required',
      'A local provider endpoint candidate must be selected for this machine',
    );
  }
  if (!candidate) throw new TypeError('Provider endpoint template has no usable URL');
  return { url: candidate, source: 'contribution_local_candidate' };
}

function selectedLocalCandidateUrl(
  template: ProviderEndpointTemplateV1,
  selectedCandidate: string | undefined,
): Readonly<{ url: string; source: 'contribution' | 'contribution_local_candidate' }> {
  if (selectedCandidate === undefined) return defaultEndpointUrl(template);
  const normalizedCandidate = normalizeProviderEndpointUrlSyntax(selectedCandidate).normalizedUrl;
  if (!template.localUrlCandidates?.includes(normalizedCandidate)) {
    throw new ProviderEndpointRealizationError(
      'unknown_local_candidate',
      'Selected local provider endpoint is not declared by the contribution',
    );
  }
  return { url: normalizedCandidate, source: 'contribution_local_candidate' };
}

function resolveEndpoints(input: Readonly<{
  connection: ProviderConnectionV1;
  machineId: string;
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  custom: boolean;
  dnsEvidenceByEndpointUrl: ResolveProviderConnectionForMachineInput['dnsEvidenceByEndpointUrl'];
  localCandidateUrlsByEndpointTemplateId: ReadonlyMap<string, string> | undefined;
}>): readonly ResolvedProviderConnectionEndpoint[] {
  const accountOverrides = readOverrideMap(input.connection.endpointOverrides);
  const machineOverridesRaw = readOwnRecordValue(input.connection.endpointOverridesByMachineId, input.machineId) ?? [];
  const machineOverrides = readOverrideMap(machineOverridesRaw);
  return input.endpointTemplates.map((template) => {
    const machineOverride = machineOverrides.get(template.id);
    const accountOverride = accountOverrides.get(template.id);
    const fallback = machineOverride === undefined && accountOverride === undefined
      ? selectedLocalCandidateUrl(
        template,
        input.localCandidateUrlsByEndpointTemplateId?.get(template.id),
      )
      : null;
    const rawUrl = machineOverride ?? accountOverride ?? fallback?.url;
    if (!rawUrl) throw new TypeError('Provider endpoint template has no usable URL');
    const normalizedUrl = normalizeProviderEndpointUrlSyntax(rawUrl).normalizedUrl;
    const resolvedAddresses = input.dnsEvidenceByEndpointUrl.get(normalizedUrl);
    const assessed = assessProviderEndpoint(normalizedUrl, {
      ...(resolvedAddresses ? { resolvedAddresses } : {}),
      // This call classifies the endpoint and computes grant identity. Authorization is
      // decided separately below; setting this flag never authorizes provider use.
      privateNetworkConfirmed: true,
    });
    const source = machineOverride
      ? 'machine_override'
      : accountOverride
        ? 'account_override'
        : input.custom
          ? 'custom'
          : fallback?.source ?? 'contribution';
    return {
      endpointTemplateId: template.id,
      protocol: template.protocol,
      publicHeaders: template.publicHeaders ?? {},
      source,
      machineOverrideApplied: machineOverride !== undefined,
      normalizedUrl: assessed.normalizedUrl,
      locality: assessed.locality,
      endpointScope: assessed.scope,
      resolvedAddresses: assessed.resolvedAddresses,
      nonPublicAddresses: assessed.nonPublicAddresses,
    };
  });
}

function authorizationForRecord(
  settings: ProviderSettingsV1,
  record: Readonly<{
    scope: 'account' | 'machine';
    connectionId: ProviderConnectionId;
    machineId: string;
    connectionSecurityFingerprint: string;
    endpointSetFingerprint: string;
  }>,
): ResolvedProviderConnectionAuthorization {
  const resolution = resolveProviderGrantV1(settings, {
    scope: record.scope,
    connectionId: record.connectionId,
    machineId: record.machineId,
    connectionSecurityFingerprint: record.connectionSecurityFingerprint,
    endpointSetFingerprint: record.endpointSetFingerprint,
  });
  if (!resolution.authorized) {
    switch (resolution.errorCode) {
      case 'provider_connection_not_found':
        throw new TypeError('Provider connection disappeared during pure authorization resolution');
      case 'provider_connection_disabled':
      case 'provider_account_grant_stale':
      case 'provider_not_enabled_on_machine':
      case 'provider_machine_grant_stale':
        return { authorized: false, errorCode: resolution.errorCode };
    }
  }
  if (resolution.grantKind === 'account') {
    const grant = settings.accountGrants.find((candidate) => candidate.connectionId === record.connectionId);
    if (!grant) throw new TypeError('Authorized account grant disappeared during pure resolution');
    return {
      authorized: true,
      grantKind: 'account',
      grantFingerprint: createProviderAccountGrantFingerprintV1(grant),
      grantConfirmedAt: grant.confirmedAt,
    };
  }
  const grant = settings.machineGrants.find((candidate) =>
    candidate.connectionId === record.connectionId && candidate.machineId === record.machineId);
  if (!grant) throw new TypeError('Authorized machine grant disappeared during pure resolution');
  return {
    authorized: true,
    grantKind: 'machine',
    grantFingerprint: createProviderMachineGrantFingerprintV1(grant),
    grantConfirmedAt: grant.confirmedAt,
  };
}

function invalidResolution(
  connectionId: string,
  diagnostics: ProviderConnectionResolution['diagnostics'],
  reason: Extract<ProviderConnectionResolution, { status: 'invalid' }>['reason'],
): ProviderConnectionResolution {
  return { status: 'invalid', connectionId, reason, diagnostics };
}

function endpointUnresolved(
  connectionId: ProviderConnectionId,
  diagnostics: ProviderConnectionResolution['diagnostics'],
  reason: Extract<ProviderConnectionResolution, { status: 'endpoint_unresolved' }>['reason'],
): ProviderConnectionResolution {
  return { status: 'endpoint_unresolved', connectionId, reason, diagnostics };
}

function sameContributionIdentity(
  left: Readonly<{ pluginId: string; localId: string }>,
  right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function resolveManagedPurposeBindingIntents(
  connection: ProviderConnectionV1,
  deployment: Omit<Extract<
    ResolvedProviderConnectionRecord['deployment'],
    { kind: 'managedLocal' }
  >, 'purposeBindingIntents'>,
) {
  const defaults = connection.purposeBindingDefaults ?? {};
  const declarationsByPurpose = new Map(
    (deployment.managedRuntime.connectedAccounts ?? []).map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  for (const [purpose, target] of Object.entries(defaults)) {
    const declaration = declarationsByPurpose.get(purpose);
    const targetService = target.kind === 'account'
      ? target.account.service
      : target.service;
    if (!declaration || !sameContributionIdentity(declaration.service, targetService)) {
      return null;
    }
  }
  if ((deployment.managedRuntime.connectedAccounts ?? []).some(
    (declaration) => declaration.required === true && defaults[declaration.purpose] === undefined,
  )) {
    return null;
  }
  if (
    deployment.managedRuntime.connectedAccountPurposeBindingPolicy?.minimumBound === 1
    && Object.keys(defaults).length === 0
  ) {
    return null;
  }
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse({
    v: 1,
    bindings: Object.entries(defaults).map(([purpose, target]) => ({
      purpose: {
        consumer: deployment.implementationIdentity,
        purpose,
      },
      target,
    })),
  });
  return parsed.success ? parsed.data : null;
}

function resolveProviderConnectionFromSettings(
  input: Omit<ResolveProviderConnectionForMachineInput, 'accountSettings'>,
  settingsRead: ReturnType<typeof readProviderSettingsForCli>,
): ProviderConnectionResolution {
  const connectionIdResult = ProviderConnectionIdSchema.safeParse(input.connectionId);
  if (!connectionIdResult.success) return invalidResolution(input.connectionId, [], 'invalid_connection_id');
  const machineIdResult = ProviderMachineIdSchema.safeParse(input.machineId);
  if (!machineIdResult.success) return invalidResolution(input.connectionId, [], 'invalid_machine_id');
  const connectionId = connectionIdResult.data;
  const machineId = machineIdResult.data;
  const { settings, diagnostics } = settingsRead;
  const connection = settings.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) {
    const tombstone = settings.connectionTombstones.find((candidate) => candidate.id === connectionId);
    return tombstone
      ? { status: 'deleted', connectionId, tombstone, diagnostics }
      : { status: 'missing', connectionId, diagnostics };
  }

  let source: ResolvedProviderConnectionSource;
  let facts: RuntimeProviderFacts;
  let managedDeployment: Omit<Extract<
    ResolvedProviderConnectionRecord['deployment'],
    { kind: 'managedLocal' }
  >, 'purposeBindingIntents'> | null = null;
  let displayName = connection.displayName;
  if (connection.source.kind === 'contribution') {
    const resolvedContribution = getProviderContribution(input.registry, connection.source.contributionKey);
    if (!resolvedContribution) {
      return {
        status: 'source_unavailable',
        connectionId,
        contributionKey: connection.source.contributionKey,
        connection,
        diagnostics,
      };
    }
    source = {
      kind: 'contribution',
      contributionKey: connection.source.contributionKey,
      pluginId: resolvedContribution.pluginId,
      provenance: resolvedContribution.provenance,
      definition: resolvedContribution.definition,
    };
    facts = factsFromContribution(resolvedContribution.definition);
    if (connection.deployment.kind === 'managedLocal') {
      const declaredManagedRuntime =
        resolvedContribution.definition.managedRuntime;
      if (!declaredManagedRuntime) {
        return invalidResolution(
          connectionId,
          diagnostics,
          'managed_deployment_unavailable',
        );
      }
      const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: resolvedContribution.identity,
        managedRuntime: declaredManagedRuntime,
      });
      managedDeployment = {
        kind: 'managedLocal',
        implementationIdentity: resolvedContribution.identity,
        managedRuntime,
      };
    }
    if (connection.displayNameMode === 'automatic') displayName = resolvedContribution.definition.name;
  } else {
    source = { kind: 'custom', template: connection.source.template };
    facts = factsFromCustom(connection.source.template);
  }

  if (connection.deployment.kind === 'managedLocal') {
    if (!managedDeployment || source.kind !== 'contribution') {
      return invalidResolution(
        connectionId,
        diagnostics,
        'managed_deployment_unavailable',
      );
    }
    const purposeBindingIntents =
      resolveManagedPurposeBindingIntents(connection, managedDeployment);
    if (!purposeBindingIntents) {
      return invalidResolution(
        connectionId,
        diagnostics,
        'managed_purpose_bindings_invalid',
      );
    }
    const resolvedManagedDeployment = {
      ...managedDeployment,
      purposeBindingIntents,
    };
    // A managed connection has no durable URL, but the declared protocol and
    // immutable public headers of its selected endpoint templates still decide
    // what the host sends. They belong to the same machine grant.
    const managedLogicalEndpoints: ProviderManagedSecurityEndpointV1[] = [];
    for (const endpointTemplateId of resolvedManagedDeployment.managedRuntime.endpointTemplateIds) {
      const template = facts.endpointTemplates.find(
        (candidate) => candidate.id === endpointTemplateId,
      );
      if (!template) {
        return invalidResolution(
          connectionId,
          diagnostics,
          'managed_deployment_unavailable',
        );
      }
      managedLogicalEndpoints.push({
        endpointTemplateId: template.id,
        protocol: template.protocol,
        ...(template.publicHeaders ? { publicHeaders: template.publicHeaders } : {}),
      });
    }
    const connectionSecurityFingerprint = createProviderConnectionSecurityFingerprintV1({
      securityContractVersion: PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
      endpoints: [],
      catalogProbes: facts.catalogProbes,
      ...(facts.availabilityProbe ? { availabilityProbe: facts.availabilityProbe } : {}),
      ...(facts.catalogFallback ? { catalogFallback: facts.catalogFallback } : {}),
      credentialTransports: facts.credentialTransports,
      ...(facts.modelLoad ? { modelLoad: facts.modelLoad } : {}),
      managedDeployment: {
        implementationIdentity: resolvedManagedDeployment.implementationIdentity,
        managedRuntime: resolvedManagedDeployment.managedRuntime,
        logicalEndpoints: managedLogicalEndpoints,
      },
    });
    const endpointSetFingerprint = createProviderEndpointSetFingerprintV1({
      endpoints: [],
    });
    const recordWithoutAuthorization = {
      v: 1 as const,
      connectionId,
      machineId,
      connection,
      displayName,
      source,
      deployment: resolvedManagedDeployment,
      endpoints: [] as const,
      scope: 'machine' as const,
      connectionSecurityFingerprint,
      endpointSetFingerprint,
    };
    return {
      status: 'resolved',
      connectionId,
      record: {
        ...recordWithoutAuthorization,
        authorization: authorizationForRecord(settings, recordWithoutAuthorization),
      },
      diagnostics,
    };
  }

  const endpointTemplateIds = new Set(facts.endpointTemplates.map((endpoint) => endpoint.id));
  if (!validateOverrideIds(connection, endpointTemplateIds)) {
    return invalidResolution(connectionId, diagnostics, 'unknown_endpoint_override');
  }

  let endpoints: readonly ResolvedProviderConnectionEndpoint[];
  try {
    endpoints = resolveEndpoints({
      connection,
      machineId,
      endpointTemplates: facts.endpointTemplates,
      custom: source.kind === 'custom',
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      localCandidateUrlsByEndpointTemplateId: input.localCandidateUrlsByConnectionId?.get(connectionId),
    });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    const reason = code === 'dns_resolution_required'
      ? 'endpoint_resolution_required'
      : code === 'local_candidate_required'
        ? 'local_candidate_required'
        : 'endpoint_invalid';
    return endpointUnresolved(connectionId, diagnostics, reason);
  }

  const scope: ResolvedProviderConnectionRecord['scope'] = endpoints.some(
    (endpoint) => endpoint.machineOverrideApplied || endpoint.endpointScope === 'machine',
  )
    ? 'machine'
    : 'account';
  const connectionSecurityFingerprint = createProviderConnectionSecurityFingerprintV1({
    securityContractVersion: PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
    endpoints: endpoints.map((endpoint) => ({
      endpointTemplateId: endpoint.endpointTemplateId,
      protocol: endpoint.protocol,
      url: endpoint.normalizedUrl,
      publicHeaders: endpoint.publicHeaders,
    })),
    catalogProbes: facts.catalogProbes,
    ...(facts.availabilityProbe ? { availabilityProbe: facts.availabilityProbe } : {}),
    ...(facts.catalogFallback ? { catalogFallback: facts.catalogFallback } : {}),
    credentialTransports: facts.credentialTransports,
    ...(facts.modelLoad ? { modelLoad: facts.modelLoad } : {}),
  });
  const assessedByTemplateId = new Map(endpoints.map((endpoint) => [
    endpoint.endpointTemplateId,
    assessProviderEndpoint(endpoint.normalizedUrl, {
      ...(endpoint.resolvedAddresses.length > 0 ? { resolvedAddresses: endpoint.resolvedAddresses } : {}),
      privateNetworkConfirmed: true,
    }),
  ]));
  const endpointSetFingerprint = createProviderEndpointSetFingerprintV1({
    endpoints: facts.endpointTemplates.map((template) => ({
      endpointTemplateId: template.id,
      endpoint: assessedByTemplateId.get(template.id)!,
    })),
  });
  const recordWithoutAuthorization = {
    v: 1 as const,
    connectionId,
    machineId,
    connection,
    displayName,
    source,
    deployment: { kind: 'external' as const },
    endpoints,
    scope,
    connectionSecurityFingerprint,
    endpointSetFingerprint,
  };
  return {
    status: 'resolved',
    connectionId,
    record: {
      ...recordWithoutAuthorization,
      authorization: authorizationForRecord(settings, recordWithoutAuthorization),
    },
    diagnostics,
  };
}

export function resolveProviderConnectionForMachine(
  input: ResolveProviderConnectionForMachineInput,
): ProviderConnectionResolution {
  return resolveProviderConnectionFromSettings(input, readProviderSettingsForCli(input.accountSettings));
}

/**
 * Reuses the canonical connection resolver with one already-parsed settings
 * snapshot. Bulk consumers use this to avoid repeatedly parsing the same
 * Account settings while preserving the resolver's endpoint, grant, and
 * deployment decisions in one owner.
 */
export function resolveProviderConnectionForMachineFromSettingsRead(
  input: Omit<ResolveProviderConnectionForMachineInput, 'accountSettings'>,
  settingsRead: ReturnType<typeof readProviderSettingsForCli>,
): ProviderConnectionResolution {
  return resolveProviderConnectionFromSettings(input, settingsRead);
}
