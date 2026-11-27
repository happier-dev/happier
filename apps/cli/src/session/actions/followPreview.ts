import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { evaluateFollowRulePreviewV1, type FollowRulePreviewCandidateV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import { projectSessionListFilterAfterHomeQueryV1, projectSessionListFilterHomeQueriesV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import { SESSION_LIST_PAGE_MAX_LIMIT, supportsSessionListProjectSelectionV1 } from '@happier-dev/protocol/sessions/listing/query';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import type { listSessions } from '@/session/services/listSessions';

type SessionListReader = (
  input: Parameters<NonNullable<ActionExecutorDeps['sessionList']>>[0],
  filterCandidates?: Parameters<typeof listSessions>[0]['filterCandidates'],
  workspaceRefs?: readonly WorkspaceRefV1[],
  sourceSessionId?: string,
) => ReturnType<NonNullable<ActionExecutorDeps['sessionList']>>;

/** Preview shares the listing owner, preserving exact-source and restricted-corpus admission. */
export function createSessionFollowPreview(params: Readonly<{
  serverId: string;
  serverHttpBaseUrl?: string;
  credentials: StoredCredentials;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  readWorkspaceRefs?: (input: Parameters<NonNullable<ActionExecutorDeps['sessionList']>>[0]) => Promise<readonly WorkspaceRefV1[]>;
  read: SessionListReader;
}>): NonNullable<ActionExecutorDeps['sessionFollowPreview']> {
  async function preview(
    { context, input, sourceSessionId, serverId: requestedServerId, signal }: Parameters<NonNullable<ActionExecutorDeps['sessionFollowPreview']>>[0],
    serverHttpBaseUrl: string,
  ): ReturnType<NonNullable<ActionExecutorDeps['sessionFollowPreview']>> {
    const [{ readAccountIdFromToken }, { readRequesterAccountActionContext }, { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId }] = await Promise.all([import('@/cloud/decodeJwtPayload'), import('@/daemon/sessionEncryption/requesterAccountActionContext'), import('@/server/serverProfiles')]);
    const { serverId, read } = params;
    if ((requestedServerId && !await isServerProfileHomeIdentity(serverId, requestedServerId))
      || (context.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId))) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    const homeServerId = await resolveServerProfileHomeIdentityId(serverId) ?? serverId;
    // Profile ids select credentials; portable Home ids qualify the shared predicates.
    const identifiers = new Set([...input.filter.homeServerIds,
      ...[...input.filter.audiences.include, ...input.filter.audiences.exclude].map(row => row.serverId),
      ...[...input.filter.tagIds.include, ...input.filter.tagIds.exclude].map(row => row.serverId),
      ...(input.filter.projects ? [...input.filter.projects.include, ...input.filter.projects.exclude].map(row => row.serverId) : [])]);
    const homes = new Map(await Promise.all([...identifiers].map(async identifier =>
      [identifier, await resolveServerProfileHomeIdentityId(identifier) ?? identifier] as const)));
    const filter = { ...input.filter,
      homeServerIds: input.filter.homeServerIds.map(id => homes.get(id)!),
      audiences: {
        include: input.filter.audiences.include.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        exclude: input.filter.audiences.exclude.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
      },
      tagIds: {
        include: input.filter.tagIds.include.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        exclude: input.filter.tagIds.exclude.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
      },
      ...(input.filter.projects ? { projects: {
        include: input.filter.projects.include.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
        exclude: input.filter.projects.exclude.map(row => ({ ...row, serverId: homes.get(row.serverId)! })),
      } } : {}),
    };
    const candidates: FollowRulePreviewCandidateV1[] = [];
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    const isAccountCurrent = () => requester ? requester.isCurrent() : params.isCredentialCurrent?.() ?? true;
    if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    const credentials = requester?.credentials ?? params.credentials;
    const viewerAccountId = readAccountIdFromToken(credentials.token) ?? undefined;
    const unservedHome = !sourceSessionId && filter.homeServerIds.some(home => home !== homeServerId);
    let coverage: 'complete' | 'partial' | 'unavailable' = unservedHome || filter.show !== 'sessions'
      || context.sessionListAccess === 'current_session' ? 'partial' : 'complete';
    if (filter.show === 'runs') return evaluateFollowRulePreviewV1({ filter, candidates, coverage: 'unavailable' });
    let projectFacet: 'query' | 'local' = 'local';
    if (!sourceSessionId && context.sessionListAccess !== 'current_session'
      && (filter.projects?.include.length || filter.projects?.exclude.length)) {
      const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: serverHttpBaseUrl, signal });
      if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      signal?.throwIfAborted();
      if (snapshot.status === 'ready' && supportsSessionListProjectSelectionV1(snapshot.features)) projectFacet = 'query';
    }
    let workspaceRefs: readonly WorkspaceRefV1[] | undefined;
    if (filter.projects && params.readWorkspaceRefs) {
      try { workspaceRefs = await params.readWorkspaceRefs({ context, signal }); }
      catch (error) { signal?.throwIfAborted(); coverage = 'partial'; }
    }
    // A selected Project asks the Home for every key its Sessions may carry (owner 11-08).
    const queries = projectSessionListFilterHomeQueriesV1(filter, { storage: 'active', includeInactive: true,
      mountedHomeServerIds: [homeServerId], limit: SESSION_LIST_PAGE_MAX_LIMIT, includeAttention: false, projectFacet, workspaceRefs,
      evaluator: 'daemonRule' });
    if (sourceSessionId) {
      const page = await read({ context, includeSystem: false, signal, query: { v: 1, storage: 'active', includeInactive: true,
        scope: 'all_accessible', attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: false } },
      { serverId: homeServerId, viewerAccountId, filters: [filter], collect: candidate => candidates.push(candidate) },
      workspaceRefs, sourceSessionId);
      const failure = readActionFailureEnvelope(page);
      if (failure) return failure;
      if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      signal?.throwIfAborted();
      return evaluateFollowRulePreviewV1({ filter, candidates, coverage: context.sessionListAccess === 'current_session'
        && context.defaultSessionId !== sourceSessionId ? 'unavailable' : 'complete' });
    }
    for (const home of queries) {
      const page = await read({ context, query: home.query, includeSystem: false, signal },
        { serverId: home.serverId, viewerAccountId, filters: [filter], collect: candidate => candidates.push(candidate) }, workspaceRefs);
      const failure = readActionFailureEnvelope(page);
      if (failure) return failure;
      if (typeof page !== 'object' || page === null) continue;
      if ('hasNext' in page && (page.hasNext || 'attentionHasNext' in page && page.attentionHasNext)
        || 'metadataUpgradeRequiredCount' in page && Number(page.metadataUpgradeRequiredCount) > 0) coverage = 'partial';
    }
    if (!await isAccountCurrent()) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    signal?.throwIfAborted();
    return evaluateFollowRulePreviewV1({ filter: projectSessionListFilterAfterHomeQueryV1(filter, homeServerId), candidates,
      coverage: queries.length === 0 && unservedHome ? 'unavailable' : coverage });
  }
  return input => {
    const serverHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    return runWithServerHttpBaseUrl(serverHttpBaseUrl, () => preview(input, serverHttpBaseUrl));
  };
}
