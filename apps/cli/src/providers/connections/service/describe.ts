import { PROVIDER_SETTINGS_LIMITS_V1 } from '@happier-dev/protocol/providers/settings/limits';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readOwnRecordValue } from '@happier-dev/protocol/providers/ownRecordValue';
import { resolveProviderGrantV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { projectAvailableProviderContributionsV1 } from '@happier-dev/protocol/providers/connections/sourceFactsV1';
import { describeAccountProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import type { ResolvedProviderManagedConnectedAccountPurposeDeclarationV1 } from '@happier-dev/protocol';

import {
  getProviderContribution,
} from '@/providers/registry/lookup';
import { redactProviderSettingsDiagnostic } from './settings';
import type {
  ProviderConnectionDescription,
  ProviderConnectionRuntimeSummary,
  ProviderConnectionServiceDeps,
  ProviderConnectionServiceResult,
  ProviderConnectionView,
} from './types';
import {
  createProviderOperationLifetime,
  type ProviderOperationLifetime,
} from '@/providers/operationLifetime';
import type { ProviderConnectionRegistryProjection } from './types';
import type { ProviderLocalInstallationReadResult } from '@/providers/discovery/installations';
import { isRemoteProviderGatewayPlacement } from '@/providers/managed/gatewayPlacement';

const EMPTY_RUNTIME_SUMMARY: ProviderConnectionRuntimeSummary = Object.freeze({
  health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [],
});
const EMPTY_RUNTIME_PROJECTION = Object.freeze({
  summary: EMPTY_RUNTIME_SUMMARY,
  probeObservationIdentity: null,
});

function projectManagedConnectedAccountPurpose(
  declaration: ResolvedProviderManagedConnectedAccountPurposeDeclarationV1,
) {
  return {
    purpose: declaration.purpose,
    service: declaration.service,
    ...(declaration.title === undefined ? {} : { title: declaration.title }),
    required: declaration.required === true,
    ...(declaration.materializationKinds !== undefined
      ? { materializationKinds: [...declaration.materializationKinds] }
      : {}),
  };
}

async function readAdvisoryProjection<T>(read: () => Promise<readonly T[]>): Promise<readonly T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

export async function describeProviderConnections(
  deps: ProviderConnectionServiceDeps,
  input: Readonly<{
    machineId: string;
    connectionId?: string;
    registryProjection?: ProviderConnectionRegistryProjection;
    lifetime?: ProviderOperationLifetime;
    admitSavedSecrets?: boolean;
  }>,
): Promise<ProviderConnectionServiceResult<ProviderConnectionDescription>> {
  if (!deps.featureGate.isEnabled('providers')) {
    return {
      status: 'error',
      error: createProviderErrorV1('provider_feature_disabled', {
        ...(input.connectionId ? { connectionId: input.connectionId } : {}), machineId: deps.machineId,
      }),
    };
  }
  if (input.machineId !== deps.machineId) {
    return {
      status: 'error',
      error: createProviderErrorV1('provider_not_enabled_on_machine', {
        ...(input.connectionId ? { connectionId: input.connectionId } : {}), machineId: input.machineId,
      }),
    };
  }

  // A standalone description is an admission boundary. Mutations pass their
  // already-started lifetime and registry projection so their final read never
  // restarts DNS or switches contribution generations.
  const lifetime = input.lifetime ?? createProviderOperationLifetime({});
  const snapshot = await deps.loadSnapshot(input.registryProjection,
    input.admitSavedSecrets ? { ...(input.connectionId ? { connectionId: input.connectionId } : {}) } : undefined,
    lifetime.signal);
  const read = { settings: snapshot.providerSettings, diagnostics: snapshot.providerSettingsDiagnostics ?? [] };
  if (read.diagnostics.some((diagnostic) => diagnostic.path === 'providerSettingsV1')) {
    return { status: 'error', error: createProviderErrorV1('provider_settings_invalid', { machineId: input.machineId }) };
  }
  const settings = read.settings;
  const accountDefinitions = [...snapshot.registry.providersByContributionKey].map(([contributionKey, contribution]) => ({
    contributionKey, definition: contribution.definition, provenance: contribution.provenance,
  }));
  const selected = input.connectionId
    ? settings.connections.filter((connection) => connection.id === input.connectionId)
    : settings.connections;
  // Compatibility is advisory presentation data. A broken plugin runtime must
  // not block Provider connection reads or mutations; resolution and
  // authorization below remain independently fail-closed.
  let compatibilityProjection: ReturnType<NonNullable<typeof deps.acquireCompatibilityProjection>> = null;
  try {
    compatibilityProjection = deps.acquireCompatibilityProjection?.() ?? null;
  } catch {
    compatibilityProjection = null;
  }
  let views: ProviderConnectionView[];
  try {
    views = await Promise.all(selected.map(async (connection): Promise<ProviderConnectionView> => {
      const contribution = connection.source.kind === 'contribution'
        ? getProviderContribution(snapshot.registry, connection.source.contributionKey)
        : null;
      const providerName = connection.source.kind === 'custom'
        ? connection.source.template.name
        : contribution?.definition.name ?? connection.displayName;
      const credentialDefinition = connection.source.kind === 'custom'
        ? connection.source.template.credential
        : contribution?.definition.credential;
      const catalogDefinition = connection.source.kind === 'custom'
        ? connection.source.template.catalog
        : contribution?.definition.catalog;
      const managedRuntimeDeclaration = contribution?.definition.managedRuntime
        ? resolveProviderManagedRuntimeDeclarationV1({
            implementationIdentity: contribution.identity,
            managedRuntime: contribution.definition.managedRuntime,
          })
        : null;
      const managedLocalOption =
        managedRuntimeDeclaration
          ? {
              targetMachineId: input.machineId,
              connectedAccountPurposes:
                managedRuntimeDeclaration.connectedAccounts.map(
                  projectManagedConnectedAccountPurpose,
                ),
              ...(managedRuntimeDeclaration.connectedAccountPurposeBindingPolicy === undefined
                ? {}
                : {
                    connectedAccountPurposeBindingPolicy:
                      managedRuntimeDeclaration.connectedAccountPurposeBindingPolicy,
                  }),
            }
          : null;
      const probeCapability: ProviderConnectionView['probeCapability'] = catalogDefinition
        && 'probes' in catalogDefinition && catalogDefinition.probes.length > 0
        ? 'catalog'
        : connection.source.kind === 'contribution' && contribution?.definition.discovery
          ? 'availability'
          : 'none';
      const credentialBindings = readOwnRecordValue(settings.secretBindingsByConnectionId, connection.id);
      const endpointTemplates = connection.source.kind === 'custom'
        ? connection.source.template.endpointTemplates
        : contribution?.definition.endpointTemplates ?? [];
      const accountOverrides = new Map((connection.endpointOverrides ?? [])
        .map((override) => [override.endpointTemplateId, override.baseUrl]));
      const machineOverrides = new Map((readOwnRecordValue(
        connection.endpointOverridesByMachineId,
        input.machineId,
      ) ?? []).map((override) => [override.endpointTemplateId, override.baseUrl]));
      const endpointHierarchy = (template: (typeof endpointTemplates)[number]) => {
        const defaultBaseUrl = template.baseUrl
          ?? ('localUrlCandidates' in template && template.localUrlCandidates?.length === 1
            ? template.localUrlCandidates[0]
            : null)
          ?? null;
        const accountOverrideBaseUrl = accountOverrides.get(template.id) ?? null;
        const machineOverrideBaseUrl = machineOverrides.get(template.id) ?? null;
        return { defaultBaseUrl, accountOverrideBaseUrl, machineOverrideBaseUrl };
      };
      const dnsEvidence = await deps.collectDnsEvidence({
        providerSettings: snapshot.providerSettings,
        connectionId: connection.id,
        machineId: input.machineId,
        registry: snapshot.registry,
        lifetime,
      });
      const resolution = deps.resolveConnection({
        providerSettings: snapshot.providerSettings,
        connectionId: connection.id,
        machineId: input.machineId,
        registry: snapshot.registry,
        dnsEvidence,
      });
      const resolved = resolution.status === 'resolved' ? resolution : null;
      const accountView = describeAccountProviderConnectionV1(settings, connection, accountDefinitions);
      const machineGrant = settings.machineGrants.find((grant) =>
        grant.connectionId === connection.id && grant.machineId === input.machineId);
      const machineGrantResolution = resolved
        ? resolveProviderGrantV1(settings, {
            scope: 'machine',
            connectionId: connection.id,
            machineId: input.machineId,
            connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
            endpointSetFingerprint: resolved.record.endpointSetFingerprint,
          })
        : null;
      const effectiveGrantResolution = resolved
        ? resolveProviderGrantV1(settings, {
            scope: resolved.record.scope,
            connectionId: connection.id,
            machineId: input.machineId,
            connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
            endpointSetFingerprint: resolved.record.endpointSetFingerprint,
          })
        : null;
      // Saved Account enablement is syntax-derived at the Account owner. DNS
      // readiness cannot revoke it; runtime admission still uses resolution.
      const accountState = accountView.grants.accountState;
      const machineState = machineGrantResolution?.state ?? (machineGrant ? 'stale' as const : 'absent' as const);
      const effectiveState = effectiveGrantResolution?.state
        ?? (resolution.status === 'endpoint_unresolved' && machineOverrides.size === 0
          ? accountState : 'absent' as const);
      const runtimeProjection = resolved && resolved.record.authorization.authorized
        ? await deps.runtimeSummary({
            connectionId: connection.id,
            machineId: input.machineId,
            accountSettings: snapshot.accountSettings,
            providerSettings: settings,
            savedSecretResources: snapshot.savedSecretResources,
            registry: snapshot.registry,
            dnsEvidence,
            resolution: resolved,
            lifetime,
          })
        : EMPTY_RUNTIME_PROJECTION;
      const gatewayRuntime = connection.deployment.kind === 'managedLocal'
        && managedRuntimeDeclaration && managedRuntimeDeclaration.connectedAccounts.length > 0
        ? isRemoteProviderGatewayPlacement(connection.gatewayPlacement, input.machineId)
          ? { status: 'not_checked' as const, reachability: 'not_checked' as const }
          : await deps.readSharedGatewayRuntime?.({ connectionId: connection.id, machineId: input.machineId })
            ?? { status: 'not_checked' as const, reachability: 'not_checked' as const }
        : null;
      const compatibility = resolved && compatibilityProjection
        ? [...compatibilityProjection.project(resolved.record)]
        : [];
      const resolvedManagedDeployment = resolved?.record.deployment.kind === 'managedLocal'
        ? resolved.record.deployment
        : null;
      const deployment: ProviderConnectionView['deployment'] = connection.deployment.kind === 'managedLocal'
        ? {
            kind: 'managedLocal',
            targetMachineId: input.machineId,
            effects: resolvedManagedDeployment
              ? {
                  implementationIdentity: resolvedManagedDeployment.implementationIdentity,
                  protocols: resolvedManagedDeployment.managedRuntime.endpointTemplateIds.map(
                    (endpointTemplateId) => {
                      const endpointTemplate = endpointTemplates.find(
                        (candidate) => candidate.id === endpointTemplateId,
                      );
                      if (!endpointTemplate) {
                        throw new Error(
                          `Resolved managed Provider endpoint template is unavailable: ${endpointTemplateId}`,
                        );
                      }
                      return endpointTemplate.protocol;
                    },
                  ),
                  connectedAccountPurposes:
                    resolvedManagedDeployment.managedRuntime.connectedAccounts.flatMap((declaration) => {
                      const binding = resolvedManagedDeployment.purposeBindingIntents.bindings.find((candidate) =>
                        candidate.purpose.consumer.pluginId
                          === resolvedManagedDeployment.implementationIdentity.pluginId
                        && candidate.purpose.consumer.localId
                          === resolvedManagedDeployment.implementationIdentity.localId
                        && candidate.purpose.purpose === declaration.purpose);
                      return binding
                        ? [{
                            ...projectManagedConnectedAccountPurpose(declaration),
                            target: binding.target,
                          }]
                        : [];
                    }),
                  ...(resolvedManagedDeployment.managedRuntime.connectedAccountPurposeBindingPolicy === undefined
                    ? {}
                    : {
                        connectedAccountPurposeBindingPolicy:
                          resolvedManagedDeployment.managedRuntime.connectedAccountPurposeBindingPolicy,
                      }),
                }
              : null,
          }
        : { kind: 'external' };
      const endpoints: ProviderConnectionView['endpoints'] =
        resolved?.record.deployment.kind === 'external'
          ? resolved.record.endpoints.map((endpoint) => {
              const template = endpointTemplates.find((candidate) =>
                candidate.id === endpoint.endpointTemplateId);
              const hierarchy = template
                ? endpointHierarchy(template)
                : { defaultBaseUrl: null, accountOverrideBaseUrl: null, machineOverrideBaseUrl: null };
              return {
                endpointTemplateId: endpoint.endpointTemplateId,
                protocol: endpoint.protocol,
                baseUrl: endpoint.normalizedUrl,
                effectiveSource: endpoint.source === 'machine_override'
                  ? 'machineOverride' as const
                  : endpoint.source === 'account_override'
                    ? 'accountOverride' as const
                    : 'template' as const,
                ...hierarchy,
              };
            })
          : connection.deployment.kind === 'external'
            ? endpointTemplates.flatMap((template) => {
                const hierarchy = endpointHierarchy(template);
                const baseUrl = hierarchy.machineOverrideBaseUrl
                  ?? hierarchy.accountOverrideBaseUrl
                  ?? hierarchy.defaultBaseUrl;
                if (!baseUrl) return [];
                return [{
                  endpointTemplateId: template.id,
                  protocol: template.protocol,
                  baseUrl,
                  effectiveSource: hierarchy.machineOverrideBaseUrl
                    ? 'machineOverride' as const
                    : hierarchy.accountOverrideBaseUrl
                      ? 'accountOverride' as const
                      : 'template' as const,
                  ...hierarchy,
                }];
              })
            : [];
      return {
        connectionId: connection.id,
        contributionKey: connection.source.kind === 'contribution' ? connection.source.contributionKey : null,
        provenance: connection.source.kind === 'custom'
          ? 'custom' as const
          : contribution?.provenance ?? 'first_party' as const,
        displayName: connection.displayName,
        providerName,
        icon: connection.source.kind === 'contribution' ? contribution?.definition.icon ?? null : null,
        ...(connection.source.kind === 'contribution' && contribution?.definition.websiteUrl
          ? { websiteUrl: contribution.definition.websiteUrl }
          : {}),
        role: connection.role,
        displayNameMode: connection.displayNameMode,
        sourceStatus: resolution.status === 'source_unavailable' ? 'unavailable' : 'available',
        probeCapability,
        manualModelPolicy: catalogDefinition?.manualModelPolicy ?? 'catalog-only',
        compatibility,
        grants: {
          accountEnabled: accountState === 'valid',
          enabledMachineIds: machineState === 'valid' ? [input.machineId] : [],
          accountState,
          machineState,
          effectiveState,
        },
        credential: connection.deployment.kind === 'external'
          && credentialDefinition
          ? {
              required: credentialDefinition.required,
              accountBound: Boolean(credentialBindings?.account?.[credentialDefinition.slotId]),
              boundMachineIds: Object.entries(credentialBindings?.byMachineId ?? {})
                .filter(([, slots]) => Boolean(slots[credentialDefinition.slotId]))
                .map(([machineId]) => machineId)
                .sort(),
              ...('keyUrl' in credentialDefinition && credentialDefinition.keyUrl
                ? { keyUrl: credentialDefinition.keyUrl }
                : {}),
            }
          : null,
        teamCredentialSourceOffer: resolved && credentialDefinition
          ? {
              connectionId: connection.id,
              connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
              credentialSlotId: credentialDefinition.slotId,
              label: connection.displayName,
            }
          : null,
        deployment,
        ...(connection.gatewayPlacement !== undefined
          ? { gatewayPlacement: connection.gatewayPlacement }
          : {}),
        ...(connection.claudeHelperModels !== undefined
          ? { claudeHelperModels: connection.claudeHelperModels }
          : {}),
        managedLocalOption,
        endpoints,
        scope: resolved?.record.scope ?? null,
        authorized: resolved?.record.authorization.authorized === true,
        authorizationError: resolved?.record.authorization.authorized === false
          ? createProviderErrorV1(resolved.record.authorization.errorCode, { connectionId: connection.id, machineId: input.machineId })
          : resolution.status === 'source_unavailable'
            ? createProviderErrorV1('provider_contribution_unavailable', { connectionId: connection.id, machineId: input.machineId })
            : resolution.status === 'endpoint_unresolved'
              ? createProviderErrorV1(
                  resolution.reason === 'endpoint_resolution_required'
                    ? 'provider_endpoint_unreachable'
                    : 'provider_connection_invalid',
                  { connectionId: connection.id, machineId: input.machineId },
                )
              : resolution.status === 'invalid' || resolution.status === 'missing' || resolution.status === 'deleted'
                ? createProviderErrorV1('provider_connection_not_found', { connectionId: connection.id, machineId: input.machineId })
                : null,
        revision: connection.revision,
        probeObservationIdentity: runtimeProjection.probeObservationIdentity,
        runtime: gatewayRuntime ? { ...runtimeProjection.summary, gateway: gatewayRuntime } : runtimeProjection.summary,
      };
    }));
  } finally {
    await compatibilityProjection?.release();
  }

  const available = projectAvailableProviderContributionsV1({ connections: settings.connections,
    definitions: [...snapshot.registry.providersByContributionKey].map(([contributionKey, entry]) => ({
      contributionKey, definition: entry.definition, provenance: entry.provenance,
    })),
  });
  const discoveryCandidatesReader = deps.discoveryCandidates;
  const allDiscoveryCandidates = deps.featureGate.isEnabled('providers.localDiscovery') && discoveryCandidatesReader
    ? await readAdvisoryProjection(() => discoveryCandidatesReader({
        machineId: input.machineId,
        registry: snapshot.registry,
        connections: views,
      }))
    : [];
  const discoveryCandidates = allDiscoveryCandidates;
  const localInstallationsReader = deps.localInstallations;
  let installationRead: ProviderLocalInstallationReadResult = {
    status: deps.featureGate.isEnabled('providers.localDiscovery') ? 'incomplete' : 'complete', installations: [],
  };
  if (deps.featureGate.isEnabled('providers.localDiscovery') && localInstallationsReader) {
    try {
      installationRead = await localInstallationsReader({
        machineId: input.machineId,
        registry: snapshot.registry,
        candidates: allDiscoveryCandidates,
        signal: lifetime.signal,
      });
    } catch {
      installationRead = { status: 'incomplete', installations: [] };
    }
  }
  const localInstallations = installationRead.installations.map((installation) => ({
    ...installation,
    managedStartAvailable: installation.managedStartAvailable
      && deps.startManagedProviderRuntime !== undefined,
  }));
  const deletedConnection = input.connectionId === undefined
    ? undefined
    : settings.connectionTombstones.find((entry) => entry.id === input.connectionId) ?? null;
  return {
    status: 'success', connections: views, available,
    discoveryCandidates: [...discoveryCandidates],
    discoveryCandidatesTruncated: false,
    localInstallations: [...localInstallations],
    localInstallationsStatus: installationRead.status,
    diagnostics: read.diagnostics
      .slice(0, PROVIDER_SETTINGS_LIMITS_V1.readDiagnostics)
      .map(redactProviderSettingsDiagnostic),
    diagnosticsTruncated: read.diagnostics.length > PROVIDER_SETTINGS_LIMITS_V1.readDiagnostics,
    availableTruncated: false,
    ...(input.connectionId !== undefined ? {
      deletedConnection: deletedConnection
        ? {
            connectionId: deletedConnection.id,
            contributionKey: deletedConnection.contributionKey,
            lastDisplayName: deletedConnection.lastDisplayName,
            deletedAt: deletedConnection.deletedAt,
          }
        : null,
    } : {}),
  };
}
