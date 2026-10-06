import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamCredentialResourceTestApplicationRequestV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import type { TeamCredentialResourceTestApplicationRequestV1, TeamCredentialSourceBindingV1, TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol';
import {
  createTeamCredentialModelCatalogResolver,
  isSameTeamCredentialBrokerApplication,
  type TeamCredentialModelCatalogResolver,
} from './teamCredentialModelCatalog';

type Candidate = Readonly<{
  application: ProviderBrokerApplicationBindingV1;
  modelId: string;
  sourceRevision: string;
}>;

const SUPPORTED_RESOURCE_TEST_PROTOCOLS = new Set([
  'openai-responses',
  'openai-chat',
  'anthropic',
]);

function candidateKey(candidate: Readonly<Omit<Candidate, 'sourceRevision'>>): string {
  const application = candidate.application;
  return [
    application.agentTargetKey,
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

function applicationKey(application: ProviderBrokerApplicationBindingV1): string {
  return candidateKey({ application, modelId: '' });
}

/**
 * The canonical source catalog: one exact resolver per current application and
 * source revision of the resource's own source projection. It is what the
 * source can serve, independent of who is entitled to it — Team request policy
 * is intersected by the broker request-policy owner, and recipient entitlement
 * by the Home, never by reading a recipient catalog.
 */
function sourceCatalogsFromProjection(input: Readonly<{
  projection: DaemonProviderModelProjectionResponseV1,
  teamId: string;
  resourceId: string;
  resourceRevision: number;
}>): readonly TeamCredentialModelCatalogResolver[] {
  if (input.projection.status !== 'success') return [];
  const catalogs = new Map<string, {
    application: ProviderBrokerApplicationBindingV1;
    rows: TeamCredentialProviderModelCatalogEntryV1[];
  }>();
  for (const group of input.projection.groups) {
    if (!group.authorization.authorized || !group.sourceRevision) continue;
    for (const row of group.rows) {
      if (
        row.visibility !== 'visible'
        || row.catalog.stale
        || !row.application
        || !SUPPORTED_RESOURCE_TEST_PROTOCOLS.has(row.application.protocol)
        || row.ref.modelId !== row.descriptor.id
        || row.compatibility.result.status === 'incompatible'
        || (row.compatibility.result.status === 'experimental' && !row.compatibility.confirmed)
      ) continue;
      const key = `${candidateKey({ application: row.application, modelId: '' })}\0${group.sourceRevision}`;
      const catalog = catalogs.get(key) ?? { application: row.application, rows: [] };
      catalog.rows.push(TeamCredentialProviderModelCatalogEntryV1Schema.parse({
        selection: {
          kind: 'team_credential_provider_model',
          resourceId: input.resourceId,
          teamId: input.teamId,
          expectedResourceRevision: input.resourceRevision,
          agentTargetKey: row.application.agentTargetKey,
          modelId: row.descriptor.id,
          deliveryMode: 'brokered',
        },
        descriptor: row.descriptor,
        application: row.application,
        sourceRevision: group.sourceRevision,
        availability: 'available',
      }));
      catalogs.set(key, catalog);
    }
  }
  return [...catalogs.values()].flatMap((catalog) => {
    const resolver = createTeamCredentialModelCatalogResolver({
      resourceId: input.resourceId,
      resourceRevision: input.resourceRevision,
      application: catalog.application,
      rows: catalog.rows,
    });
    return resolver ? [resolver] : [];
  });
}

function candidatesFromProjection(input: Parameters<typeof sourceCatalogsFromProjection>[0]): readonly Candidate[] {
  return sourceCatalogsFromProjection(input).flatMap((resolver) => resolver.rows.map((row) => ({
    application: resolver.application,
    modelId: row.descriptor.id,
    sourceRevision: row.sourceRevision,
  })));
}

/** Canonical exact-source filter for every daemon model projection that starts
 * from a Team credential source. It never manufactures executable application
 * identity from source kind or source metadata. */
export function projectTeamCredentialSourceModelFilter(
  source: TeamCredentialSourceBindingV1,
): Readonly<Pick<
  DaemonProviderModelProjectionRequestV1,
  'providerConnection' | 'connectedAccountTarget'
>> {
  return source.kind === 'provider_connection'
    ? {
        providerConnection: {
          connectionId: source.connectionId,
          expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
        },
      }
    : { connectedAccountTarget: source.target };
}

/** Content-free exact-source eligibility derived from the same canonical
 * local model projector as catalog and resource Test. */
export async function resolveTeamCredentialBrokerEligibility(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  signal?: AbortSignal;
} & (
  | {
      application: ProviderBrokerApplicationBindingV1;
      modelId: string;
      sourceRevision: string;
    }
  | {
      scope: 'source_any';
      agentTargetKeys: readonly string[];
    }
)>): Promise<Readonly<
  | { status: 'eligible' }
  | { status: 'unavailable'; reason: 'source_unavailable' | 'application_unavailable' | 'model_unavailable' | 'source_changed' }
>> {
  input.signal?.throwIfAborted();
  if ('scope' in input) {
    const agentTargetKeys = [...new Set(input.agentTargetKeys)].sort();
    if (agentTargetKeys.length === 0) {
      return { status: 'unavailable', reason: 'application_unavailable' };
    }
    let sourceUnavailable = false;
    for (const agentTargetKey of agentTargetKeys) {
      input.signal?.throwIfAborted();
      const candidates = await projectCandidates({
        machineId: input.machineId,
        teamId: input.teamId,
        resourceId: input.resourceId,
        resourceRevision: input.expectedResourceRevision,
        source: input.source,
        agentTargetKey,
        projectModels: input.projectModels,
      }).catch(() => {
        sourceUnavailable = true;
        return [];
      });
      if (candidates.length > 0) return { status: 'eligible' };
    }
    return sourceUnavailable
      ? { status: 'unavailable', reason: 'source_unavailable' }
      : { status: 'unavailable', reason: 'model_unavailable' };
  }
  const candidates = await projectCandidates({
    machineId: input.machineId,
    teamId: input.teamId,
    resourceId: input.resourceId,
    resourceRevision: input.expectedResourceRevision,
    source: input.source,
    agentTargetKey: input.application.agentTargetKey,
    projectModels: input.projectModels,
  }).catch(() => null);
  if (candidates === null) return { status: 'unavailable', reason: 'source_unavailable' };
  const sameApplication = candidates.filter((candidate) => pluginJsonValuesEqual(candidate.application, input.application));
  if (sameApplication.length === 0) return { status: 'unavailable', reason: 'application_unavailable' };
  const sameModel = sameApplication.filter((candidate) => candidate.modelId === input.modelId);
  if (sameModel.length === 0) return { status: 'unavailable', reason: 'model_unavailable' };
  return sameModel.some((candidate) => candidate.sourceRevision === input.sourceRevision)
    ? { status: 'eligible' }
    : { status: 'unavailable', reason: 'source_changed' };
}

async function projectCandidates(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  resourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  agentTargetKey: string;
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
}>): Promise<readonly Candidate[]> {
  const projection = await input.projectModels({
    machineId: input.machineId,
    agentTargetKey: input.agentTargetKey,
    ...projectTeamCredentialSourceModelFilter(input.source),
    mode: 'picker',
  });
  return candidatesFromProjection({
    projection,
    teamId: input.teamId,
    resourceId: input.resourceId,
    resourceRevision: input.resourceRevision,
  });
}

/**
 * The broker's model catalog for one exact application of a resource: the
 * resource's own current source catalog from the canonical local projection.
 * The broker custodian is not necessarily an audience recipient of the
 * resource it serves, so this never consults a recipient catalog. An absent or
 * ambiguous (several current source revisions) catalog is unavailable.
 */
export async function resolveTeamCredentialSourceModelCatalog(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  resourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  application: ProviderBrokerApplicationBindingV1;
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  signal?: AbortSignal;
}>): Promise<TeamCredentialModelCatalogResolver | null> {
  input.signal?.throwIfAborted();
  const projection = await input.projectModels({
    machineId: input.machineId,
    agentTargetKey: input.application.agentTargetKey,
    ...projectTeamCredentialSourceModelFilter(input.source),
    mode: 'picker',
  });
  const matching = sourceCatalogsFromProjection({
    projection,
    teamId: input.teamId,
    resourceId: input.resourceId,
    resourceRevision: input.resourceRevision,
  }).filter((catalog) => isSameTeamCredentialBrokerApplication(catalog.application, input.application));
  const [only, ...ambiguous] = matching;
  return only && ambiguous.length === 0 ? only : null;
}

/** Enumerates the exact current source/application matrix for protocol-neutral
 * metadata reads. It deliberately returns no selected/default application. */
export async function resolveTeamCredentialResourceCatalogApplications(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  agentTargetKeys: readonly string[];
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  signal?: AbortSignal;
}>): Promise<readonly ProviderBrokerApplicationBindingV1[]> {
  const applications = new Map<string, ProviderBrokerApplicationBindingV1>();
  for (const agentTargetKey of [...new Set(input.agentTargetKeys)].sort()) {
    input.signal?.throwIfAborted();
    const candidates = await projectCandidates({
      machineId: input.machineId,
      teamId: input.teamId,
      resourceId: input.resourceId,
      resourceRevision: input.expectedResourceRevision,
      source: input.source,
      agentTargetKey,
      projectModels: input.projectModels,
    });
    for (const candidate of candidates) {
      applications.set(applicationKey(candidate.application), candidate.application);
    }
  }
  return Object.freeze([...applications.values()].sort((left, right) => (
    applicationKey(left) < applicationKey(right) ? -1 : applicationKey(left) > applicationKey(right) ? 1 : 0
  )));
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
 * Provider model projector used by picker and broker policy. The resource
 * source remains an exact filter; no Provider or Agent identity is persisted
 * or accepted from the public Action caller.
 */
export async function resolveTeamCredentialResourceTestCandidate(input: Readonly<{
  machineId: string;
  teamId: string;
  resourceId: string;
  expectedResourceRevision: number;
  source: TeamCredentialSourceBindingV1;
  agentTargetKeys: readonly string[];
  projectModels(request: DaemonProviderModelProjectionRequestV1): Promise<DaemonProviderModelProjectionResponseV1>;
  createRequestId(): string;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  application: ProviderBrokerApplicationBindingV1;
  request: TeamCredentialResourceTestApplicationRequestV1;
}> | null> {
  const targetKeys = [...new Set(input.agentTargetKeys)].sort();
  for (const agentTargetKey of targetKeys) {
    input.signal?.throwIfAborted();
    const candidates = await projectCandidates({
      machineId: input.machineId,
      teamId: input.teamId,
      resourceId: input.resourceId,
      resourceRevision: input.expectedResourceRevision,
      source: input.source,
      agentTargetKey,
      projectModels: input.projectModels,
    });
    const candidate = [...candidates].sort(compareCandidates)[0];
    if (candidate) {
      return Object.freeze({
        application: candidate.application,
        request: buildRequest({
          requestId: input.createRequestId(),
          teamId: input.teamId,
          resourceId: input.resourceId,
          candidate,
        }),
      });
    }
  }
  return null;
}
