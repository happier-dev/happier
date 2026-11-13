import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { TeamCredentialResourceTestApplicationRequestV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import type { TeamCredentialResourceTestApplicationRequestV1, TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams';
import type { TeamCredentialSourceModelProjectionFailureV1 } from '@happier-dev/protocol/rpc/providers';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderSourceModelCatalogRequest, ProviderSourceModelCatalogResult } from '@/providers/modelManagement/sourceCatalog';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import {
  createTeamCredentialModelCatalogResolver,
  type TeamCredentialModelCatalogResolver,
} from './teamCredentialModelCatalog';

type Candidate = Readonly<{
  application: ProviderBrokerSourceApplicationBindingV1;
  modelId: string;
}>;

const SUPPORTED_RESOURCE_TEST_PROTOCOLS = new Set([
  'openai-responses',
  'openai-chat',
  'anthropic',
]);

function candidateKey(candidate: Candidate): string {
  const application = candidate.application;
  return [
    application.implementationIdentity.pluginId,
    application.implementationIdentity.localId,
    application.endpointTemplateId,
    application.protocol,
    candidate.modelId,
  ].join('\0');
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const leftKey = candidateKey(left);
  const rightKey = candidateKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function isTeamCredentialSourceModelProjectionFailureV1(
  caught: unknown,
): caught is Pick<TeamCredentialSourceModelProjectionFailureV1, 'status' | 'reason'> {
  return !(caught instanceof Error) && typeof caught === 'object' && caught !== null
    && 'status' in caught && caught.status === 'unavailable'
    && 'reason' in caught && (
      caught.reason === 'response_invalid' || caught.reason === 'projection_unavailable'
      || caught.reason === 'not_granted' || caught.reason === 'incompatible'
      || caught.reason === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
    );
}

/** Content-free exact-source eligibility derived from the same canonical
 * local model projector as catalog and resource Test. */
export async function resolveTeamCredentialBrokerEligibility(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  readSourceModelCatalogs(request: ProviderSourceModelCatalogRequest, signal?: AbortSignal): Promise<ProviderSourceModelCatalogResult>;
  signal?: AbortSignal;
  application: ProviderBrokerSourceApplicationBindingV1;
  modelId: string;
  sourceRevision: string;
}>): Promise<Readonly<
  | { status: 'eligible' }
  | { status: 'unavailable'; reason: 'source_unavailable' | 'application_unavailable' | 'model_unavailable' | 'source_changed'
      | typeof CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired }
>> {
  input.signal?.throwIfAborted();
  const source = await input.readSourceModelCatalogs({
    machineId: input.machineId, source: input.source, application: input.application, refreshPolicy: 'current_only',
  }, input.signal).catch(caught => withActionFailureCauseDiagnostic({
    status: 'unavailable' as const,
    reason: isTeamCredentialSourceModelProjectionFailureV1(caught)
      && caught.reason === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired ? caught.reason
      : isTeamCredentialSourceModelProjectionFailureV1(caught) && caught.reason === 'incompatible'
        ? 'application_unavailable' as const : 'source_unavailable' as const,
  }, caught, 'provider.broker_eligibility'));
  if (source.status === 'unavailable') return source;
  if (source.status === 'error') return withActionFailureCauseDiagnostic({ status: 'unavailable' as const, reason: source.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
    ? source.error.code : 'source_unavailable' as const }, source.error, 'provider.broker_eligibility');
  const sameApplication = source.catalogs.filter(catalog => pluginJsonValuesEqual(catalog.application, input.application));
  if (sameApplication.length === 0) return { status: 'unavailable', reason: 'application_unavailable' };
  const sameModel = sameApplication.filter(catalog => catalog.rows.some(row => row.descriptor.id === input.modelId));
  if (sameModel.length === 0) return { status: 'unavailable', reason: 'model_unavailable' };
  return sameModel.some(catalog => catalog.sourceRevision === input.sourceRevision)
    ? { status: 'eligible' }
    : { status: 'unavailable', reason: 'source_changed' };
}

/** External clients consume source applications directly, without a worker
 * projection or a scan of the broker Machine's registered Agents. */
export async function resolveTeamCredentialResourceSourceCatalogs(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  application?: ProviderBrokerSourceApplicationBindingV1;
  refreshPolicy?: 'current_only';
  readSourceModelCatalogs(request: ProviderSourceModelCatalogRequest, signal?: AbortSignal): Promise<ProviderSourceModelCatalogResult>;
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialModelCatalogResolver[]> {
  input.signal?.throwIfAborted();
  const source = await input.readSourceModelCatalogs({ machineId: input.machineId, source: input.source,
    application: input.application, refreshPolicy: input.refreshPolicy }, input.signal);
  if (source.status !== 'success') throw { status: 'unavailable', reason: source.error.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
    ? source.error.code : 'projection_unavailable', error: source.error };
  return source.catalogs.flatMap(catalog => {
    if (!SUPPORTED_RESOURCE_TEST_PROTOCOLS.has(catalog.application.protocol)) return [];
    const resolver = createTeamCredentialModelCatalogResolver({ resourceId: input.resourceId,
      resourceRevision: input.expectedResourceRevision, application: catalog.application,
      rows: catalog.rows.map(row => ({
        descriptor: row.descriptor, application: catalog.application, sourceRevision: catalog.sourceRevision,
        ...(row.sourceFacts ? { sourceFacts: row.sourceFacts } : {}),
        compatibility: { ...row.compatibility, confirmed: false }, availability: 'available' as const,
      })),
    });
    return resolver ? [resolver] : [];
  });
}

/** Exact application consumers require one unambiguous source catalog. */
export async function resolveTeamCredentialBrokerSourceCatalog(
  input: Parameters<typeof resolveTeamCredentialResourceSourceCatalogs>[0],
) {
  const catalogs = await resolveTeamCredentialResourceSourceCatalogs(input);
  return catalogs.length === 1 ? catalogs[0]! : null;
}

function buildRequest(input: Readonly<{
  requestId: string;
  teamId: string;
  resourceId: string;
  candidate: Candidate;
}>): TeamCredentialResourceTestApplicationRequestV1 {
  const { protocol } = input.candidate.application;
  const route = protocol === 'openai-responses'
    ? 'responses' as const
    : protocol === 'openai-chat'
      ? 'chat_completions' as const
      : 'messages' as const;
  const pathAndQuery = protocol === 'openai-responses'
    ? '/v1/responses'
    : protocol === 'openai-chat'
      ? '/v1/chat/completions'
      : '/v1/messages';
  const body = protocol === 'openai-responses'
    ? { model: input.candidate.modelId, input: 'Reply with OK.', max_output_tokens: 16 }
    : protocol === 'openai-chat'
      ? {
          model: input.candidate.modelId,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_completion_tokens: 16,
        }
      : {
          model: input.candidate.modelId,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 16,
        };
  return TeamCredentialResourceTestApplicationRequestV1Schema.parse({
    v: 1,
    kind: 'resource_test',
    requestId: input.requestId,
    teamId: input.teamId,
    resourceId: input.resourceId,
    route,
    method: 'POST',
    pathAndQuery,
    headers: protocol === 'anthropic'
      ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json' },
    bodyBase64: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  });
}

/**
 * Resolves one deterministic resource-test candidate from the same current
 * source catalog used by broker policy. The resource
 * source remains an exact filter; no Provider or Agent identity is persisted
 * or accepted from the public Action caller.
 */
export async function resolveTeamCredentialResourceTestCandidate(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  refreshPolicy?: 'current_only';
  readSourceModelCatalogs(request: ProviderSourceModelCatalogRequest, signal?: AbortSignal): Promise<ProviderSourceModelCatalogResult>;
  createRequestId(): string;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  application: ProviderBrokerSourceApplicationBindingV1;
  request: TeamCredentialResourceTestApplicationRequestV1;
}> | null> {
  const catalogs = await resolveTeamCredentialResourceSourceCatalogs(input);
  const candidates = catalogs.flatMap(catalog => catalog.rows.map(row => ({ application: catalog.application,
    modelId: row.descriptor.id })));
  const candidate = candidates.sort(compareCandidates)[0];
  return candidate ? Object.freeze({ application: candidate.application, request: buildRequest({
    requestId: input.createRequestId(), teamId: input.teamId, resourceId: input.resourceId, candidate,
  }) }) : null;
}
