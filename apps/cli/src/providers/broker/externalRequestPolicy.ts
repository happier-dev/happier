import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import type { ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { ProviderBrokerExternalRequestPolicySnapshot } from './providerBrokerRequestHandler';
import { teamCredentialBrokerResourceAcceptsMachine } from './teamCredentialBrokerSourceOwner';
import { resolveTeamCredentialResourceSourceCatalogs } from './resourceTestCandidate';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';
import { createTeamCredentialExternalModelCatalog, type TeamCredentialModelCatalogResolver } from './teamCredentialModelCatalog';
import { classifyTeamCredentialRequestRouteV1, evaluateTeamCredentialRequestPolicyV1 } from './requestPolicyV1';

type SourceResource = Pick<TeamCredentialResourceSummaryV1,
  'id' | 'teamId' | 'revision' | 'enabled' | 'brokerPlacement' | 'source' | 'requestPolicy'>;

/** External listing and inference consume one source observation. A coding
 * Agent is a downstream worker, never an input to this route's model set. */
export async function resolveTeamCredentialExternalRequestPolicy(input: Readonly<{
  machineId: string;
  binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
  request: ManagedServiceRequest;
  readResource(resourceId: string, signal: AbortSignal): Promise<SourceResource | null>;
  readSourceModelCatalogs: RuntimeProviderModelManagementServices['readSourceModelCatalogs'];
}>): Promise<ProviderBrokerExternalRequestPolicySnapshot | null> {
  const signal = input.request.signal ?? new AbortController().signal;
  const resource = await input.readResource(input.binding.resourceId, signal);
  if (!teamCredentialBrokerResourceAcceptsMachine(resource, input.machineId)
    || resource.teamId !== input.binding.teamId) return null;
  const catalogs = await resolveTeamCredentialResourceSourceCatalogs({
    machineId: input.machineId, teamId: resource.teamId, resourceId: resource.id,
    expectedResourceRevision: resource.revision, source: resource.source,
    readSourceModelCatalogs: input.readSourceModelCatalogs, signal,
  }).catch(preserveBrokerSourceHealthFailure) ?? [];
  if (input.request.method === 'GET' && input.request.pathAndQuery === '/v1/models') {
    const catalog = createTeamCredentialExternalModelCatalog(catalogs);
    return catalog ? { kind: 'model_catalog', resourceRevision: resource.revision, policy: resource.requestPolicy,
      applications: catalog.applications, modelCatalog: { models: catalog.models, resolveCanonicalModelId: catalog.resolveCanonicalModelId } } : null;
  }
  const route = classifyTeamCredentialRequestRouteV1(input.request.pathAndQuery);
  const protocol = route?.kind === 'openai_responses' ? 'openai-responses'
    : route?.kind === 'openai_chat_completions' ? 'openai-chat'
      : route?.kind === 'anthropic_messages' ? 'anthropic' : null;
  const protocolCatalogs = catalogs.filter(catalog => catalog.application.protocol === protocol);
  if (protocolCatalogs.length === 0) return { kind: 'denied', reasonCode: 'route_not_allowed' };
  const policy = resource.requestPolicy ?? { allowedProtocolKinds: null, allowedModelIds: null, reasoningEffort: null };
  const evaluatedCatalogs: TeamCredentialModelCatalogResolver[] = [];
  let firstFailure: Extract<ReturnType<typeof evaluateTeamCredentialRequestPolicyV1>, { ok: false }> | null = null;
  for (const catalog of protocolCatalogs) {
    const evaluated = evaluateTeamCredentialRequestPolicyV1({ policy, request: input.request,
      resolveCanonicalModelId: catalog.resolveCanonicalModelId });
    if (evaluated.ok) evaluatedCatalogs.push(catalog);
    else firstFailure ??= evaluated;
  }
  if (evaluatedCatalogs.length === 0) return { kind: 'denied', reasonCode: firstFailure?.reasonCode ?? 'resource_unavailable' };
  if (evaluatedCatalogs.length !== 1) return { kind: 'denied', reasonCode: 'route_not_allowed' };
  const catalog = evaluatedCatalogs[0]!;
  return { kind: 'application', resourceRevision: resource.revision, policy: resource.requestPolicy, application: catalog.application,
    modelCatalog: { models: catalog.rows.map(row => ({ id: row.descriptor.id,
      ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }) })),
      resolveCanonicalModelId: catalog.resolveCanonicalModelId } };
}
