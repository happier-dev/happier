import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { AccountSettings, ActionExecutorDeps } from '@happier-dev/protocol';

import type { resolveExternalActionServerRequestHeaders, ExternalActionHomeBinding } from '@/api/externalActionExecutionAuthorization';
import type { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { listSessions, resolveAdmittedSessionListQueryAdmission, SessionListAdmittedQueryUnsupportedError } from '@/session/services/listSessions';
import type { fetchSessionById, fetchSessionRuntimeManagedSubtreeQueryPage } from '@/session/transport/http/sessionsHttp';
import type { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import type { summarizeSessionRecord } from '@/cli/output/session/sessionSummary';
import type { projectCliSessionAwarenessFromMaterialV1, projectCliSessionAwarenessUnavailableMaterialV1 } from '@/cli/output/session/sessionAwareness';
import type { SessionTransportEncryptionMaterial } from '@/session/transport/encryption/sessionEncryptionContext';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionFollowPreview } from './followPreview';
import type { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import type { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

/** The one typed answer for a query arm an admitted one-Session corpus cannot serve. */
function unsupportedSessionListQueryArmsResult(arms: readonly string[]) {
  return {
    ok: false as const,
    errorCode: 'unsupported_action' as const,
    error: 'unsupported_action:session.list',
    details: { unsupportedQueryArms: arms },
  };
}

/**
 * The restricted runtime reads its exact Session or a server-proved Under-self
 * page. Account listing, private query facets, settings and encryption
 * currentness remain unreachable.
 */
export function createRestrictedCurrentSessionListActionDependency(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  material: SessionTransportEncryptionMaterial;
}>): NonNullable<ActionExecutorDeps['sessionList']> {
  return async (input) => {
    if (input.project) return { ok: false, errorCode: 'session_list_project_filter_unsupported', error: 'session_list_project_filter_unsupported' };
    const underSelf = input.query?.underSessionId === params.sessionId;
    if (input.query?.underSessionId !== undefined && !underSelf) {
      return unsupportedSessionListQueryArmsResult(['underSessionId']);
    }
    const [{ runWithServerHttpBaseUrl }, { resolveAdmittedSessionListQueryAdmission }, { fetchSessionRuntimeManagedSubtreeQueryPage, fetchSessionById }, { buildCliSessionRowModel }, { summarizeSessionRecord }, { isServerProfileHomeIdentity }] = await Promise.all([import("@/api/client/serverHttpBaseUrl"), import("@/session/services/listSessions"), import("@/session/transport/http/sessionsHttp"), import("@/cli/output/session/buildCliSessionRowModel"), import("@/cli/output/session/sessionSummary"), import("@/server/serverProfiles")]);
    if (
      input.context.serverId != null
      && !await isServerProfileHomeIdentity(params.serverId, input.context.serverId)
    ) {
      return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    if (
      input.context.sessionListAccess !== 'current_session'
      || input.context.defaultSessionId !== params.sessionId
    ) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
    }
    if (input.activeOnly === true && input.archivedOnly === true) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    if (!underSelf && input.cursor != null && input.cursor.length > 0) {
      if (input.view === 'awareness') {
        return buildSessionAwarenessListResultV1({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        });
      }
      return {
        sessions: [],
        nextCursor: null,
        hasNext: false,
        ...(input.includeRows === true ? { rows: [] } : {}),
      };
    }

    const query = input.query;
    const page = underSelf && query
      ? await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => fetchSessionRuntimeManagedSubtreeQueryPage({
          token: params.credentials.token, query, ...(input.signal ? { signal: input.signal } : {}),
        }))
      : null;
    const detail = page ? null : await fetchSessionById({
      reason: 'session-action',
      token: params.credentials.token,
      sessionId: params.sessionId,
      serverUrl: params.serverHttpBaseUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const admission = !underSelf && input.query && detail
      ? resolveAdmittedSessionListQueryAdmission(input.query, detail)
      : null;
    if (admission?.kind === 'unsupported') {
      return unsupportedSessionListQueryArmsResult(admission.arms);
    }
    const queryMatches = admission === null || admission.kind === 'match';
    const accountEncryptionMode = params.material.mode;
    const entries = (queryMatches ? page?.sessions ?? (detail ? [detail] : []) : []).flatMap(rawSession => {
      // The current Session key is never a worker's key. Encrypted workers stay
      // locked unless their own material is admitted by the existing key owner.
      const credentials = rawSession.id === params.sessionId ? params.credentials
        : { token: params.credentials.token, encryption: null };
      const row = buildCliSessionRowModel({
        credentials,
        rawSession,
        accountEncryptionMode,
        accountSettings: null,
      });
      const presentationMatches = (input.includeSystem === true || row.isSystem !== true)
        && (input.activeOnly !== true || row.active === true)
        && (input.archivedOnly !== true || row.archivedAt !== null)
        && (input.resumableOnly !== true || (
          row.vendorResume.eligible === true
          && row.archivedAt === null
          && row.active !== true
        ));
      return presentationMatches ? [{ rawSession, row, credentials }] : [];
    });
    const continuation = page ? { nextCursor: page.nextCursor, hasNext: page.hasNext,
      attentionNextCursor: page.attentionNextCursor, attentionHasNext: page.attentionHasNext,
      ...(page.metadataUpgradeRequiredCount !== undefined ? { metadataUpgradeRequiredCount: page.metadataUpgradeRequiredCount } : {}) }
      : { nextCursor: null, hasNext: false };

    if (input.view === 'awareness') {
      const { projectCliSessionAwarenessFromMaterialV1, projectCliSessionAwarenessUnavailableMaterialV1 } = await import("@/cli/output/session/sessionAwareness");
      const awarenessPage = {
        sessions: entries.map(({ rawSession }) => rawSession.encryptionMode === 'plain' || rawSession.id === params.sessionId
          ? projectCliSessionAwarenessFromMaterialV1({
              row: rawSession,
              material: rawSession.encryptionMode === 'plain' ? { mode: 'plain' } : params.material,
              nowMs: Date.now(),
            })
          : projectCliSessionAwarenessUnavailableMaterialV1({ row: rawSession, nowMs: Date.now() })),
        ...continuation,
      };
      return input.query
        ? buildSessionAwarenessListResultV1({
            ...awarenessPage,
            attentionNextCursor: page?.attentionNextCursor ?? null,
            attentionHasNext: page?.attentionHasNext ?? false,
          })
        : buildSessionAwarenessListResultV1(awarenessPage);
    }

    const result = {
      sessions: entries.map(({ rawSession, row, credentials }) => ({
        ...summarizeSessionRecord({ credentials, accountEncryptionMode, session: rawSession }),
        agentId: row.agentId,
        vendorResumeEligible: row.vendorResume.eligible,
        ...(row.vendorResume.eligible ? {} : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
      })),
      ...continuation,
      ...(input.includeRows === true ? { rows: entries.map(entry => entry.row) } : {}),
    };
    return input.query
      ? markSessionListQueryResultV1({
          ...result,
          attentionNextCursor: page?.attentionNextCursor ?? null,
          attentionHasNext: page?.attentionHasNext ?? false,
        })
      : result;
  };
}

/** One CLI/daemon adapter from the shared Action contract to Session listing. */
export function createSessionListActionDeps(params: Readonly<{
  readWorkspaceRefs?: (input: Parameters<NonNullable<ActionExecutorDeps['sessionList']>>[0]) => Promise<readonly WorkspaceRefV1[]>;
  credentials: StoredCredentials;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  resolveAccountSettings?: () => AccountSettings | null;
  serverHttpBaseUrl?: string;
}> & ExternalActionHomeBinding): Pick<ActionExecutorDeps, 'sessionFollowPreview'> & Required<Pick<ActionExecutorDeps, 'sessionList' | 'sessionRead'>> {
  const serverId = params.serverId ?? configuration.activeServerId;
  const read = async ({
    project,
    context,
    serverId: requestedServerId,
    query,
    view,
    limit,
    cursor,
    activeOnly,
    archivedOnly,
    includeSystem,
    resumableOnly,
    includeRows,
    includeLastMessagePreview,
    signal,
  }: Parameters<NonNullable<ActionExecutorDeps['sessionList']>>[0], filterCandidates?: Parameters<typeof listSessions>[0]['filterCandidates'],
  workspaceRefs?: readonly WorkspaceRefV1[], sourceSessionId?: string,
  exactRead?: Parameters<NonNullable<ActionExecutorDeps['sessionRead']>>[0]) => {
    const normalizedActiveOnly = activeOnly === true;
    const normalizedArchivedOnly = archivedOnly === true;
    const [{ resolveExternalActionServerRequestHeaders }, { readRequesterAccountActionContext }, { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId }] = await Promise.all([import("@/api/externalActionExecutionAuthorization"), import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/server/serverProfiles")]);
    if ((requestedServerId && !await isServerProfileHomeIdentity(serverId, requestedServerId))
      || (context?.serverId && !await isServerProfileHomeIdentity(serverId, context.serverId))) {
      return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    if (project && !await isServerProfileHomeIdentity(serverId, project.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    const qualifiedProject = project ? { ...project, serverId: await resolveServerProfileHomeIdentityId(serverId) ?? serverId } : undefined;
    if (normalizedActiveOnly && normalizedArchivedOnly) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    const requestedRoot = exactRead?.underSessionId ?? query?.underSessionId;
    if (context.sessionListAccess === 'current_session' && requestedRoot !== undefined
      && requestedRoot !== context.defaultSessionId) {
      return unsupportedSessionListQueryArmsResult(['underSessionId']);
    }
    const allowedSessionIds = sourceSessionId ? context?.sessionListAccess === 'current_session'
      && context.defaultSessionId !== sourceSessionId ? [] : [sourceSessionId] : context?.sessionListAccess === 'current_session'
      && typeof context?.defaultSessionId === 'string'
      && context.defaultSessionId.trim().length > 0
      && query?.underSessionId !== context.defaultSessionId
      ? [context.defaultSessionId.trim()]
      : undefined;
    const resolveAuthorizationHeaders = (request: Readonly<{
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
    }>) => {
      const resolved = resolveExternalActionServerRequestHeaders({
        context,
        // Scope/start admission observes the caller's subtree under the
        // original Action. It does not originate a second session.list root.
        effectActionId: context?.externalActionExecutionAuthorization?.binding.actionId ?? 'session.list',
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        daemonToken: params.credentials.token,
        serverIdentityId: params.serverIdentityId,
        ...(params.externalActionMachineRequestPrivateKey
          ? { privateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { installationId: params.externalActionMachineInstallationId }
          : {}),
      });
      return resolved.ok ? resolved.headers : null;
    };
    if (!resolveAuthorizationHeaders({
      method: 'GET',
      path: '/v1/account/encryption/currentness',
    })) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const externalActionAccountSettings = context?.externalActionExecutionAuthorization
      && params.resolveAccountSettings
      ? params.resolveAccountSettings()
      : undefined;
    const requester = filterCandidates ? readRequesterAccountActionContext(context.externalActionExecutionAuthorization) : null;
    if (filterCandidates && context.externalActionExecutionAuthorization && (!requester || !await requester.isCurrent())) {
      return { ok: false as const, errorCode: 'follow_rule_account_scope_unavailable', error: 'follow_rule_account_scope_unavailable' };
    }
    const run = async () => {
      if (exactRead) {
        const { fetchSessionSnapshotsBatch } = await import('@/session/transport/http/sessionsHttp');
        const parts = await fetchSessionSnapshotsBatch({ token: params.credentials.token,
          sessionIds: exactRead.sessionIds, underSessionId: exactRead.underSessionId,
          accessProjectionVersion: 1, includeTurns: false, includeMessages: false,
          resolveAuthorizationHeaders, ...(signal ? { signal } : {}) });
        return { results: [...parts.values()] };
      }
      const { listSessions } = await import("@/session/services/listSessions");
      return await listSessions({
      ...(qualifiedProject ? { project: qualifiedProject, workspaceRefs: await params.readWorkspaceRefs?.({ context, project: qualifiedProject, signal }) } : {}),
      ...(filterCandidates ? { filterCandidates, workspaceRefs, accountSettings: params.resolveAccountSettings?.() ?? null } : {}),
      credentials: requester?.credentials ?? params.credentials,
      resolveAuthorizationHeaders,
      ...(externalActionAccountSettings !== undefined
        ? { accountSettings: externalActionAccountSettings }
        : {}),
      ...(view ? { view } : {}),
      ...(query ? { query } : {}),
      ...(!query
        ? {
            activeOnly: normalizedActiveOnly,
            archivedOnly: normalizedArchivedOnly,
            ...(typeof limit === 'number' ? { limit } : {}),
            ...(typeof cursor === 'string' && cursor.trim().length > 0 ? { cursor: cursor.trim() } : {}),
          }
        : {}),
      includeSystem: includeSystem === true,
      resumableOnly: resumableOnly === true,
      includeRows: includeRows === true,
      includeLastMessagePreview: includeLastMessagePreview === true,
      ...(signal ? { signal } : {}),
      ...(allowedSessionIds ? { allowedSessionIds } : {}),
    });
    };
    try {
      // Scope observation is a preparation read, not the Action effect. Retain
      // its admitted lifetime through transient Home failures before the scope
      // guard classifies an unavailable observation as an unsupported corpus.
      const [{ runWithServerHttpBaseUrl }, { readRequesterHomeWithinActionLifetime }] = await Promise.all([import("@/api/client/serverHttpBaseUrl"), import("@/daemon/sessionEncryption/requesterCurrentness")]);
      return await readRequesterHomeWithinActionLifetime(() => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run)
        : run(), signal);
    } catch (error) {
      // The admitted one-Session corpus cannot answer every query arm; that is a
      // typed contract answer, not a transport failure.
      const { SessionListAdmittedQueryUnsupportedError } = await import("@/session/services/listSessions");
      if (error instanceof SessionListAdmittedQueryUnsupportedError) {
        return unsupportedSessionListQueryArmsResult(error.arms);
      }
      throw error;
    }
  };
  return {
    sessionList: read,
    sessionRead: args => read({ context: args.context, serverId: args.serverId, signal: args.signal },
      undefined, undefined, undefined, args),
    sessionFollowPreview: createSessionFollowPreview({ ...params, serverId, read }),
  };
}
