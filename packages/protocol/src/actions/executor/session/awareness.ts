import { SessionUpdatePostInputV1Schema, SessionUpdatePostOutputV1Schema } from '../../../sessions/relations/workerUpdateV1.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { completeActionResult } from '../resultProjection.js';
import { SessionManagerSetActionInputV1Schema, SessionManagerSetResultV1Schema } from '../../../sessions/follow/sessionManagerV1.js';
import { resolveServerIdForSession } from '../sessionScope.js';
import { SessionListActionInputV1Schema } from '../../actionSpecs.js';
import { resolveActionAgentStartContextV1 } from '../agentStartAdmission.js';
import { isAgentCaller } from '../callerContext.js';
import { readActionCallerLedSubtreeSessionIds } from '../sessionLedSubtree.js';
import { SessionListQueryV1Schema } from '../../../sessions/listing/query.js';
import { hasOwn } from '../../../inputs/inputRecords.js';
import { SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE, SESSION_LIST_AWARENESS_VIEW_V1, SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE, SessionListViewV1Schema, parseSessionAwarenessListResultV1, parseSessionListQueryActionResultV1 } from '../../../sessions/awareness/action.js';
import { normalizeId, readNullableString } from '../inputReading.js';
import { SessionAwarenessProjectionV1Schema } from '../../../sessions/awareness/projectionV1.js';
import type { ActionHomeEquivalence, CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';



export async function dispatchSessionAwareness(inv: Pick<CoreInvocation, 'actionId' | 'admittedInput' | 'deps' | 'ctx' | 'data'> & Readonly<{ sameHome: ActionHomeEquivalence }>): Promise<ActionExecuteResult | null> {
  const { actionId, admittedInput, deps, ctx, data } = inv;

        if (actionId === 'session.update.post') {
          const request = SessionUpdatePostInputV1Schema.safeParse(admittedInput);
          if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionUpdatePost) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.update.post' };
          const response = await deps.sessionUpdatePost({ context: ctx, ...request.data });
          const failure = readActionFailureEnvelope(response);
          if (failure) return failure;
          const output = SessionUpdatePostOutputV1Schema.safeParse(response);
          if (!output.success) return { ok: false, errorCode: 'session_update_invalid_response', error: 'session_update_invalid_response' };
          return completeActionResult(output.data);
        }
        if (actionId === 'session.manager.set') {
          const request = SessionManagerSetActionInputV1Schema.safeParse(admittedInput);
          if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionManagerSet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.manager.set' };
          const serverId = resolveServerIdForSession(deps, ctx, request.data.sessionId);
          const rawResponse = await deps.sessionManagerSet({
            ...request.data, context: ctx,
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const hostFailure = readActionFailureEnvelope(rawResponse);
          if (hostFailure) return hostFailure;
          const response = SessionManagerSetResultV1Schema.safeParse(rawResponse);
          if (!response.success) return { ok: false, errorCode: 'session_manager_invalid_response', error: 'session_manager_invalid_response' };
          const result = response.data;
          if (!result.ok) return {
            ok: false, errorCode: result.error, error: result.error,
            ...(result.error === 'manager_forbidden' ? { details: { reason: result.reason } } : {}),
          };
          if (result.sessionId !== request.data.sessionId || result.managerSessionId !== request.data.managerSessionId) {
            return { ok: false, errorCode: 'session_manager_invalid_response', error: 'session_manager_invalid_response' };
          }
          return completeActionResult(result);
        }

        if (actionId === 'session.list') {
          // Parse through the canonical Action input owner: `query` reaches the listing
          // dependency as a typed `SessionListQueryV1`, never as an untyped record cast.
          const listInput = SessionListActionInputV1Schema.safeParse(admittedInput);
          if (!listInput.success) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const listRequest = listInput.data;
          if (listRequest.project && ctx.serverId && !inv.sameHome(ctx.serverId, listRequest.project.serverId)) {
            return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
          }
          const requestedRoot = listRequest.underSessionId ?? listRequest.query?.underSessionId;
          if (ctx.sessionListAccess === 'current_session' && requestedRoot !== undefined) {
            const caller = await resolveActionAgentStartContextV1(deps, ctx, undefined, { purpose: 'session_scope' });
            if (requestedRoot !== ctx.defaultSessionId?.trim()
              || caller?.caller.kind !== 'session' || caller.caller.sessionId !== requestedRoot) {
              return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
            }
          }
          const callerSubtree = ctx.sessionListAccess === 'led_subtree'
            || (isAgentCaller(ctx) && ctx.sessionListAccess !== 'current_session');
          const root = requestedRoot ?? (callerSubtree ? ctx.defaultSessionId?.trim() : undefined);
          if (callerSubtree && requestedRoot && requestedRoot !== ctx.defaultSessionId?.trim()
            && !(await readActionCallerLedSubtreeSessionIds(deps, ctx))?.has(requestedRoot)) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.list' };
          }
          if (root && (listRequest.activeOnly || listRequest.resumableOnly)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const query = root
            ? SessionListQueryV1Schema.parse(listRequest.query
              ? { ...listRequest.query, underSessionId: root }
              : {
                  v: 1, storage: listRequest.archivedOnly ? 'archived' : 'active',
                  includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
                  underSessionId: root,
                  ...(listRequest.limit !== undefined ? { limit: listRequest.limit } : {}),
                  ...(listRequest.cursor ? { cursor: listRequest.cursor } : {}),
                })
            : listRequest.query;
          const res = await deps.sessionList({
            context: ctx,
            ...(listRequest.project ? { project: listRequest.project } : {}),
            ...(query !== undefined ? { query } : {}),
            ...(listRequest.view !== undefined ? { view: listRequest.view } : {}),
            ...(query === undefined && listRequest.limit !== undefined ? { limit: listRequest.limit } : {}),
            ...(query === undefined && hasOwn(data, 'cursor') ? { cursor: listRequest.cursor ?? null } : {}),
            ...(listRequest.includeLastMessagePreview !== undefined ? { includeLastMessagePreview: listRequest.includeLastMessagePreview } : {}),
            ...(query === undefined && listRequest.activeOnly !== undefined ? { activeOnly: listRequest.activeOnly } : {}),
            ...(query === undefined && listRequest.archivedOnly !== undefined ? { archivedOnly: listRequest.archivedOnly } : {}),
            ...(listRequest.includeSystem !== undefined ? { includeSystem: listRequest.includeSystem } : {}),
            ...(query === undefined && listRequest.resumableOnly !== undefined ? { resumableOnly: listRequest.resumableOnly } : {}),
            ...(listRequest.includeRows !== undefined ? { includeRows: listRequest.includeRows } : {}),
            ...(ctx.serverId !== undefined ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(res);
          if (failure) return failure;
          if (listRequest.project && (!res || typeof res !== 'object' || !('project' in res)
            || !res.project || typeof res.project !== 'object' || !('serverId' in res.project) || !('projectKey' in res.project)
            || res.project.serverId !== listRequest.project.serverId || res.project.projectKey !== listRequest.project.projectKey)) {
            return { ok: false, errorCode: 'session_list_project_filter_unsupported', error: 'session_list_project_filter_unsupported' };
          }
          if (
            query !== undefined
            && !parseSessionListQueryActionResultV1(res)
          ) {
            return {
              ok: false,
              errorCode: SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
              error: SESSION_LIST_QUERY_UPDATE_REQUIRED_ERROR_CODE,
            };
          }
          if (listRequest.view === SESSION_LIST_AWARENESS_VIEW_V1) {
            // A host that ignored `view` answers with an ordinary summary list. Refusing it here
            // is what stops an awareness caller from projecting a summary locally and reporting
            // success against an older host (AWI-09).
            if (!parseSessionAwarenessListResultV1(res)) {
              return {
                ok: false,
                errorCode: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
                error: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
              };
            }
          }
          return completeActionResult(res);
        }

        if (actionId === 'session.activity.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          // The admitted input already satisfied the Action's strict schema, so read the selector
          // through the same canonical owner rather than comparing local literals.
          const view = SessionListViewV1Schema.safeParse(data.view);
          const res = await deps.sessionActivityGet({
            context: ctx,
            sessionId,
            ...(view.success ? { view: view.data } : {}),
            ...(typeof data.windowSeconds === 'number' ? { windowSeconds: data.windowSeconds } : {}),
            ...(typeof ctx.serverId === 'string' ? { serverId: ctx.serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (view.success && view.data === SESSION_LIST_AWARENESS_VIEW_V1 && !readActionFailureEnvelope(res)) {
            // A host that ignored `view` answers with its activity digest. Refusing it keeps an
            // awareness caller from reading released booleans as the canonical projection (AWI-09).
            if (!SessionAwarenessProjectionV1Schema.safeParse(res).success) {
              return {
                ok: false,
                errorCode: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
                error: SESSION_LIST_AWARENESS_UNSUPPORTED_ERROR_CODE,
              };
            }
          }
          return completeActionResult(res);
        }

        if (actionId === 'session.messages.recent.get') {
          const sessionId = normalizeId(data.sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          if (!deps.sessionTranscriptGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.transcript.get' };
          }
          const includeUser = data.includeUser !== false;
          const includeAssistant = data.includeAssistant !== false;
          const roles: ('user' | 'assistant')[] = [];
          if (includeUser) roles.push('user');
          if (includeAssistant) roles.push('assistant');
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionTranscriptGet({
            context: ctx,
            sessionId,
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(hasOwn(data, 'cursor') ? { cursor: readNullableString(data.cursor) } : {}),
            roles,
            ...(hasOwn(data, 'maxCharsPerMessage') ? { maxCharsPerMessage: typeof data.maxCharsPerMessage === 'number' ? data.maxCharsPerMessage : null } : {}),
            ...(serverId ? { serverId } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return completeActionResult(res);
        }
  return null;
}
