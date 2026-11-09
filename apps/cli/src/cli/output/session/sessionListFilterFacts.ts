import type { SessionListFilterFactsV1, SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { matchSessionListFilterV1, readSessionListStartedByV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readSessionMetadataViews } from '@/session/transport/encryption/sessionEncryptionContext';
import { projectCliSessionAwarenessFromPresentationV1, type CliSessionAwarenessParams } from './sessionAwareness';
import { fetchSessionOrganizationPlacementBatches } from '@/session/transport/http/sessionsHttp';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import type { SessionOrganizationPlacementV1 } from '@happier-dev/protocol';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

type PreparedSessionListFilterFacts = Readonly<{ workspaceRefs?: readonly WorkspaceRefV1[]; tagIds?: readonly string[]; folderId?: string | null }>;

/** Exact assignment-only reads, shared by preview batches and one-source rule evaluation. */
export async function readCliSessionListOrganizationAssignmentsV1(input: Readonly<{
  credentials: StoredCredentials; serverId: string; sessionIds: readonly string[];
  filters: readonly SessionListFilterV1[]; serverHttpBaseUrl?: string; signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<ReadonlyMap<string, SessionOrganizationPlacementV1> | undefined> {
  const homes = [...new Set(input.filters.flatMap(filter => [
    ...filter.tagIds.map(tag => tag.serverId),
    ...[...(filter.sections?.include ?? []), ...(filter.sections?.exclude ?? [])].map(section => section.serverId),
  ]))];
  if (!(await Promise.all(homes.map(home => isServerProfileHomeIdentity(input.serverId, home)))).some(admitted => admitted)) return undefined;
  const assignments = new Map<string, SessionOrganizationPlacementV1>();
  for await (const batch of fetchSessionOrganizationPlacementBatches({
    ...input, token: input.credentials.token,
  })) {
    if (!batch.ok) continue;
    for (const [sessionId, placement] of batch.placements) assignments.set(sessionId, placement);
  }
  return assignments;
}

/** Private supplemental facts belong to the captured evaluator, never the installed Account projection. */
export async function readCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; accountId: string; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => Promise<boolean>; filters: readonly SessionListFilterV1[];
}>): Promise<SessionListFilterFactsV1 | null> {
  if (input.signal.aborted || readAccountIdFromToken(input.credentials.token) !== input.accountId || !await input.isCurrent()) return null;
  const serverId = await resolveServerProfileHomeIdentityId(input.serverId) ?? input.serverId;
  const workspaceContext = { normalizeServerId: (id: string) => id === input.serverId ? serverId : id };
  const knownFacts = projectCliSessionListFilterFactsV1({ ...input, serverId, viewerAccountId: input.accountId, workspaceContext });
  // Other known conjunctive misses need no supplemental facts. Project membership
  // needs the census even for stamped keys: joining a checkout can change both
  // include and exclude matches, in either direction.
  const relevantFilters = input.filters.filter(filter => matchSessionListFilterV1(
    filter.projects ? { ...filter, projects: undefined } : filter, knownFacts) !== 'miss');
  const projectHomes = [...new Set(relevantFilters.flatMap(filter => filter.projects
    ? [...filter.projects.include, ...filter.projects.exclude].map(project => project.serverId) : []))];
  const projectsRequired = (await Promise.all(projectHomes.map(home => isServerProfileHomeIdentity(input.serverId, home))))
    .some(admitted => admitted);
  const [projects, tags] = await Promise.allSettled([
    projectsRequired ? readProjectAccountRows({ credentials: input.credentials, serverId, signal: input.signal,
      selection: { kinds: ['workspace-ref'], serverId },
      sessionCustody: { accountId: input.accountId, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
        isCurrent: input.isCurrent } }) : Promise.resolve(undefined),
    readCliSessionListOrganizationAssignmentsV1({ ...input, filters: relevantFilters, serverId, sessionIds: [input.row.id] }),
  ]);
  if (input.signal.aborted || !await input.isCurrent()) return null;
  // Profile aliases qualify caller filters, never stored Workspace identities.
  const workspaceRefs = projects.status === 'fulfilled' ? projects.value?.workspaceRefs.filter(ref => ref.serverId === serverId) : undefined;
  const placement = tags.status === 'fulfilled' ? tags.value?.get(input.row.id) : undefined;
  return { ...knownFacts, workspaceRefs: workspaceRefs ?? knownFacts.workspaceRefs,
    ...(placement === undefined ? {} : { tagIds: placement.tagIds,
      section: placement.folderId === null ? null : { serverId, sectionId: placement.folderId } }) };
}

/** Current authorized facts shared by list/preview and occurrence evaluation; never persisted. */
export function projectCliSessionListFilterFactsV1(input: CliSessionAwarenessParams & Readonly<{
  serverId: string; viewerAccountId?: string; workspaceRefs?: readonly WorkspaceRefV1[];
  workspaceContext?: SessionListFilterFactsV1['workspaceContext'];
  preparedFacts?: PreparedSessionListFilterFacts;
}>): SessionListFilterFactsV1 {
  const row = input.row;
  const views = readSessionMetadataViews({ credentials: input.credentials,
    accountEncryptionMode: input.accountEncryption.mode,
    recipientEnvelopeReadiness: input.accountEncryption.recipientEnvelopeReadiness, rawSession: row });
  const metadata = views.presentation.metadata;
  const ownerMetadata = readSessionAccessProjectionRoleV1(row) === 'owner' ? views.ownerMetadata : null;
  const linked = ownerMetadata ? resolveLinkedExternalSessionAuthorityV1(ownerMetadata) : null;
  const relevance = row.viewer?.relevance;
  const ownedByViewer = input.viewerAccountId !== undefined && row.ownerAccountId === input.viewerAccountId;
  const agentTarget = ownerMetadata ? resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata) : null;
  return {
    serverId: input.serverId, kind: 'session', managedSessions: row.managedSessions, receivedRuleCount: row.receivedRuleCount,
    startedBy: readSessionListStartedByV1({ origin: row.origin, ownerAccountId: row.ownerAccountId,
      viewerAccountId: input.viewerAccountId }),
    scopeMatches: {
      ...(relevance ? { my_work: relevance.relevant,
        involving_me: relevance.reasons.some(reason => reason === 'owned_by_me' || reason === 'responsible_for_me'
          || reason === 'shared_directly_with_me' || reason === 'authored_by_me'),
        assigned_to_me: relevance.reasons.includes('responsible_for_me') }
        : ownedByViewer ? { my_work: true, involving_me: true } : {}),
      ...(row.viewer?.follow ? { following: row.viewer.follow.follows } : {}),
    },
    ...(row.viewer?.attention ? { attentionRequired: row.viewer.attention.needsAttention } : {}),
    metadata, projectMetadata: ownerMetadata,
    projectKey: row.projectKey,
    ...(row.ownerAccountId ? { owner: { serverId: input.serverId, accountId: row.ownerAccountId } } : {}), updatedAt: row.updatedAt,
    ...(ownerMetadata ? { machine: typeof ownerMetadata.machineId === 'string' && ownerMetadata.machineId.trim()
      ? { serverId: input.serverId, machineId: ownerMetadata.machineId.trim() } : null } : {}),
    ...(agentTarget ? { agent: buildBackendTargetKeyV2(agentTarget) } : {}),
    status: readSessionAwarenessPresentationV1(projectCliSessionAwarenessFromPresentationV1(input, views.presentation)),
    ...(ownerMetadata ? { source: linked?.ok ? linked.transcriptStorage : 'persisted' } : {}),
    workspaceRefs: input.preparedFacts?.workspaceRefs ?? input.workspaceRefs,
    ...(input.workspaceContext ? { workspaceContext: input.workspaceContext } : {}),
    ...(input.preparedFacts?.tagIds === undefined ? {} : { tagIds: input.preparedFacts.tagIds }),
    ...(input.preparedFacts?.folderId === undefined ? {} : { section: input.preparedFacts.folderId === null
      ? null : { serverId: input.serverId, sectionId: input.preparedFacts.folderId } }),
  };
}
