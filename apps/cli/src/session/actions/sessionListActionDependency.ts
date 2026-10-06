import { buildSessionAwarenessListResultV1, markSessionListQueryResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import type { AccountSettings, ActionExecutorDeps } from '@happier-dev/protocol';

import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import {
  listSessions,
  resolveAdmittedSessionListQueryAdmission,
  SessionListAdmittedQueryUnsupportedError,
} from '@/session/services/listSessions';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { summarizeSessionRecord } from '@/cli/output/session/sessionSummary';
import { projectCliSessionAwarenessFromMaterialV1 } from '@/cli/output/session/sessionAwareness';
import type { SessionTransportEncryptionMaterial } from '@/session/transport/encryption/sessionEncryptionContext';

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
 * The restricted runtime's exact current-Session list reader. It deliberately
 * uses only the detail route admitted by the restricted server token; Account
 * listing, query, settings and encryption-currentness remain unreachable.
 */
export function createRestrictedCurrentSessionListActionDependency(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  material: SessionTransportEncryptionMaterial;
}>): ActionExecutorDeps['sessionList'] {
  return async (input) => {
    if (input.query?.underSessionId !== undefined) {
      return unsupportedSessionListQueryArmsResult(['underSessionId']);
    }
    if (
      input.context.serverId !== undefined
      && input.context.serverId !== params.serverId
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
    if (input.cursor != null && input.cursor.length > 0) {
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

    const rawSession = await fetchSessionById({
      token: params.credentials.token,
      sessionId: params.sessionId,
      serverUrl: params.serverHttpBaseUrl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const admission = input.query && rawSession
      ? resolveAdmittedSessionListQueryAdmission(input.query, rawSession)
      : null;
    if (admission?.kind === 'unsupported') {
      return unsupportedSessionListQueryArmsResult(admission.arms);
    }
    const queryMatches = admission === null || admission.kind === 'match';
    const accountEncryptionMode = params.material.mode;
    const row = rawSession && queryMatches
      ? buildCliSessionRowModel({
          credentials: params.credentials,
          rawSession,
          accountEncryptionMode,
          accountSettings: null,
        })
      : null;
    const presentationMatches = row !== null
      && (input.includeSystem === true || row.isSystem !== true)
      && (input.activeOnly !== true || row.active === true)
      && (input.archivedOnly !== true || row.archivedAt !== null)
      && (input.resumableOnly !== true || (
        row.vendorResume.eligible === true
        && row.archivedAt === null
        && row.active !== true
      ));

    if (input.view === 'awareness') {
      const page = {
        sessions: rawSession && presentationMatches
          ? [projectCliSessionAwarenessFromMaterialV1({
              row: rawSession,
              material: params.material,
              nowMs: Date.now(),
            })]
          : [],
        nextCursor: null,
        hasNext: false,
      };
      return input.query
        ? buildSessionAwarenessListResultV1({
            ...page,
            attentionNextCursor: null,
            attentionHasNext: false,
          })
        : buildSessionAwarenessListResultV1(page);
    }

    const result = {
      sessions: rawSession && row && presentationMatches
        ? [{
            ...summarizeSessionRecord({
              credentials: params.credentials,
              accountEncryptionMode,
              session: rawSession,
            }),
            agentId: row.agentId,
            vendorResumeEligible: row.vendorResume.eligible,
            ...(row.vendorResume.eligible
              ? {}
              : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
          }]
        : [],
      nextCursor: null,
      hasNext: false,
      ...(input.includeRows === true ? { rows: row && presentationMatches ? [row] : [] } : {}),
    };
    return input.query
      ? markSessionListQueryResultV1({
          ...result,
          attentionNextCursor: null,
          attentionHasNext: false,
        })
      : result;
  };
}

/** One CLI/daemon adapter from the shared Action contract to Session listing. */
export function createSessionListActionDependency(params: Readonly<{
  credentials: StoredCredentials;
  resolveAccountSettings?: () => AccountSettings | null;
  serverHttpBaseUrl?: string;
}> & ExternalActionHomeBinding): ActionExecutorDeps['sessionList'] {
  const serverId = params.serverId ?? configuration.activeServerId;
  return async ({
    context,
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
  }) => {
    const normalizedActiveOnly = activeOnly === true;
    const normalizedArchivedOnly = archivedOnly === true;
    if (context?.serverId && context.serverId !== serverId) {
      return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    }
    if (normalizedActiveOnly && normalizedArchivedOnly) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    const allowedSessionIds = context?.sessionListAccess === 'current_session'
      && typeof context?.defaultSessionId === 'string'
      && context.defaultSessionId.trim().length > 0
      ? [context.defaultSessionId.trim()]
      : undefined;
    const resolveAuthorizationHeaders = (request: Readonly<{
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
    }>) => {
      const resolved = resolveExternalActionServerRequestHeaders({
        context,
        effectActionId: 'session.list',
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
    const run = async () => await listSessions({
      credentials: params.credentials,
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
    try {
      return params.serverHttpBaseUrl
        ? await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run)
        : await run();
    } catch (error) {
      // The admitted one-Session corpus cannot answer every query arm; that is a
      // typed contract answer, not a transport failure.
      if (error instanceof SessionListAdmittedQueryUnsupportedError) {
        return unsupportedSessionListQueryArmsResult(error.arms);
      }
      throw error;
    }
  };
}
