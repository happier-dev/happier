import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProviderBrokerApplicationBindingV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { mergeSessionTeamCredentialBindingIntents,
  readTeamCredentialLaunchReadinessRefusal,
  resolvePurposeTeamCredentialBindingIntents, type PurposeTeamResourceSelectionForSession } from './spawnConnectedServicesDefaults';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
  type AgentSpawnPurposeContributions } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '@/providers/broker/applicationProjection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isSameTeamCredentialBrokerApplication } from '@/providers/broker/teamCredentialModelCatalog';
import { SessionTeamCredentialLaunchUnavailableError, projectTeamCredentialLaunchFailure } from './sessionTeamCredentialLaunchError';
import { selectSessionTeamCredentialProviderModel } from '@/providers/broker/sessionTeamCredentialProviderBinding';

export { readSessionTeamCredentialResourceCatalog } from './sessionTeamCredentialCatalog';
export { SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';
export { readSessionTeamCredentialProviderModels } from './sessionTeamCredentialProviderCatalog';

export type NormalizedSessionTeamCredentialLaunch = Readonly<{
  options: SpawnSessionOptions;
  teamModelRow: TeamCredentialResourceCatalogEntryV1['providerModels'][number] | null;
}>;

export async function normalizeSessionTeamCredentialLaunch(input: Readonly<{
  options: SpawnSessionOptions;
  agentId: string;
  agentTargetKey: string;
  executionMachineId?: string;
  contributions: AgentSpawnPurposeContributions & Pick<ResolvedContributionRegistry, 'providersByContributionKey'>;
  applications: readonly ProviderBrokerApplicationBindingV1[];
  readCatalog(): Promise<readonly TeamCredentialResourceCatalogEntryV1[]>;
}>): Promise<NormalizedSessionTeamCredentialLaunch> {
  const { options } = input;
  const connectedServices = options.connectedServices == null ? null
    : ConnectedServiceBindingsV2IngressSchema.safeParse(options.connectedServices);
  if (connectedServices && !connectedServices.success) throw new SessionTeamCredentialLaunchUnavailableError('invalid_request', 'connected_services');
  const explicitModelBinding = options.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model');
  const declarations = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
    agentId: input.agentId, contributions: input.contributions,
  });
  const selectedPurposes = (declarations?.authorizedPurposes ?? []).flatMap(scope => (
    scope.serviceRefs.flatMap(service => {
      const selection = connectedServices?.data.bindingsByServiceId[buildQualifiedPluginContributionKey(service)];
      return selection?.source === 'team_resource' ? [{ scope, selection }] : [];
    })
  ));
  if (selectedPurposes.length === 0 && (!explicitModelBinding || explicitModelBinding.resourceId === null)) {
    return { options, teamModelRow: null };
  }
  if (options.modelSelection && options.modelSelection.ref.agentTargetKey !== input.agentTargetKey) {
    throw new SessionTeamCredentialLaunchUnavailableError('provider_incompatible_with_agent', 'agent_target');
  }
  const resources = await input.readCatalog().catch(error => {
    throw projectTeamCredentialLaunchFailure(error, 'resource_catalog', 'provider_catalog_unavailable');
  });
  const fresh = !options.existingSessionId && !options.resume;
  const explicitModelResource = explicitModelBinding?.resourceId
    ? resources.find(candidate => candidate.id === explicitModelBinding.resourceId) : undefined;
  // Check the caller's identity/revision witness before projecting readiness:
  // an exhausted current resource must not disguise a genuinely stale choice.
  if (options.modelSelection?.ref.providerConnectionId == null
    && explicitModelBinding && explicitModelBinding.resourceId !== null
    && (!explicitModelResource
      || (explicitModelBinding.teamId !== undefined && explicitModelBinding.teamId !== explicitModelResource.teamId)
      || (fresh && explicitModelBinding.expectedResourceRevision !== explicitModelResource.resourceRevision))) {
    throw new SessionTeamCredentialLaunchUnavailableError(explicitModelResource ? 'resource_changed' : 'resource_unavailable', 'resource_selection');
  }
  const purposeSelections: PurposeTeamResourceSelectionForSession[] = selectedPurposes.map(({ scope, selection }) => {
    const resource = resources.find(candidate => candidate.id === selection.resourceId);
    if (!resource) throw new SessionTeamCredentialLaunchUnavailableError('resource_unavailable', 'resource_selection');
    return { purpose: scope.purpose, services: scope.serviceRefs, selection, teamId: resource.teamId };
  });
  let teamCredentialBindings = options.teamCredentialBindings;
  if (fresh && purposeSelections.length > 0) {
    try {
      teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: teamCredentialBindings,
        admitted: resolvePurposeTeamCredentialBindingIntents({
          teamResourceSelections: purposeSelections, teamCredentialResourceCatalog: { resources },
        }),
      });
    } catch (error) {
      throw projectTeamCredentialLaunchFailure(error, 'purpose_binding', 'resource_unavailable');
    }
  }
  const normalizedOptions = teamCredentialBindings ? { ...options, teamCredentialBindings } : options;
  // Explicit model-source choices win. Purpose-bound credentials for other
  // integrations cannot replace a native clear or a personal Provider route.
  if (explicitModelBinding?.resourceId === null || options.modelSelection?.ref.providerConnectionId != null) {
    return { options: normalizedOptions, teamModelRow: null };
  }
  const registry = { providersByContributionKey: input.contributions.providersByContributionKey };
  const consumer = declarations?.purposes[0]?.consumer;
  const relevanceApplications = consumer ? projectAgentProviderBrokerApplications({
    registry,
    agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: consumer }),
    acceptedProtocols: [...new Set([...registry.providersByContributionKey.values()]
      .flatMap(provider => provider.definition.endpointTemplates.map(endpoint => endpoint.protocol)))],
  }) : [];
  const modelSourceResources = new Set(selectedPurposes.flatMap(({ scope, selection }) => (
    relevanceApplications.some(application => (
      scope.serviceRefs.some(service => resolveManagedProviderBrokerPurpose({
        registry, application, service,
      }) !== null)
    )) ? [selection.resourceId] : []
  )));
  if (!explicitModelBinding && (!fresh || modelSourceResources.size === 0)) {
    return { options: normalizedOptions, teamModelRow: null };
  }
  if (!explicitModelBinding && modelSourceResources.size !== 1) throw new SessionTeamCredentialLaunchUnavailableError('invalid_request', 'model_source');
  const resourceId = explicitModelBinding?.resourceId ?? modelSourceResources.values().next().value;
  const model = options.modelSelection?.ref;
  if (!resourceId) throw new SessionTeamCredentialLaunchUnavailableError('resource_unavailable', 'resource_selection');
  if (!model) throw new SessionTeamCredentialLaunchUnavailableError('team_credential_model_selection_required', 'model_selection');
  const resource = explicitModelResource ?? resources.find(candidate => candidate.id === resourceId);
  if (!resource) throw new SessionTeamCredentialLaunchUnavailableError('resource_unavailable', 'resource_selection');
  const automatic = selectSessionTeamCredentialProviderModel({ resource, agentTargetKey: model.agentTargetKey,
    modelId: model.modelId, applications: input.applications });
  const deliveryMode = explicitModelBinding && explicitModelBinding.resourceId !== null
    ? explicitModelBinding.deliveryMode : automatic?.selection.deliveryMode ?? 'brokered';
  if (fresh && explicitModelBinding && resource.deliveryPolicy && resource.allowedRoutes
    && automatic && automatic.selection.deliveryMode !== deliveryMode) {
    throw new SessionTeamCredentialLaunchUnavailableError('team_credential_provider_selection_not_current', 'model_source');
  }
  const readinessRefusal = readTeamCredentialLaunchReadinessRefusal(resource, deliveryMode);
  if (readinessRefusal) throw new SessionTeamCredentialLaunchUnavailableError(readinessRefusal, 'readiness');
  const matchingRows = resource.providerModels.filter(candidate => (
    candidate.selection.resourceId === resourceId
    && candidate.selection.teamId === resource.teamId
    && candidate.selection.expectedResourceRevision === resource.resourceRevision
    && candidate.selection.deliveryMode === deliveryMode
    && candidate.selection.agentTargetKey === model.agentTargetKey
    && candidate.selection.modelId === model.modelId
    && input.applications.some(application => isSameTeamCredentialBrokerApplication(application, candidate.application))
  ));
  const row = automatic?.selection.deliveryMode === deliveryMode
    ? automatic : matchingRows.find(candidate => candidate.availability === 'available');
  if (!row) {
    const refusal = matchingRows.find(candidate => candidate.deliveryUnavailableReason)?.deliveryUnavailableReason;
    throw new SessionTeamCredentialLaunchUnavailableError(refusal
      ?? (matchingRows.length > 0 ? 'team_credential_provider_selection_not_current' : 'provider_model_not_found'), 'model_catalog');
  }
  if (!explicitModelBinding && !automatic) throw new SessionTeamCredentialLaunchUnavailableError('provider_compatibility_unverified', 'model_catalog');
  if (explicitModelBinding && explicitModelBinding.teamId === undefined) {
    teamCredentialBindings = teamCredentialBindings?.map(binding => binding.slot.kind === 'provider_model'
      ? { ...binding, teamId: row.selection.teamId } : binding);
  }
  if (!explicitModelBinding) teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
    explicit: teamCredentialBindings,
    admitted: [{ v: 1, slot: { kind: 'provider_model' }, resourceId,
      teamId: row.selection.teamId, expectedResourceRevision: row.selection.expectedResourceRevision, deliveryMode }],
  });
  if (fresh) teamCredentialBindings = teamCredentialBindings?.map(binding => binding.slot.kind === 'provider_model' && binding.resourceId !== null
    ? { ...binding, providerModelSelection: { agentTargetKey: row.selection.agentTargetKey, modelId: row.selection.modelId,
      ...(input.executionMachineId ? { application: row.application, executionMachineId: input.executionMachineId } : {}),
      ...(row.nativeSource ? { nativeSource: { sourceRevision: row.sourceRevision, providerTicket: row.nativeSource.providerTicket } } : {}),
    }, ...(row.selection.nativeDelivery ? { nativeDelivery: row.selection.nativeDelivery } : {}) } : binding);
  return { options: teamCredentialBindings ? { ...options, teamCredentialBindings } : options, teamModelRow: row };
}
