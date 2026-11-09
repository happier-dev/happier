import type { CliActionDepsParams, PendingAgentRequestKind } from '../actions/cliActionDeps/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { randomUUID } from 'node:crypto';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { type SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { buildSessionPermissionRespondRpcParamsV1, buildSessionUserActionAnswerMap, buildSessionUserActionAnswerDetails, SessionUserActionPassUpRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { parsePermissionIntentAlias, PermissionIntent } from '@happier-dev/agents';
import type { setSessionPermissionMode } from '@/session/services/setSessionPermissionMode';
import { type SessionResumeRequestV1 } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { resolveCurrentSessionCapabilityBinding } from '@/session/presentation/currentSessionUiBindings';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readSessionAgentState } from '../actions/cliActionDeps/sessionStateReaders';
import type { InactiveSessionResumeResult } from './requestInactiveSessionResume';

type ResolvedSessionTransport = Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, Readonly<{ ok: true }>>;
type PermissionActionDeps = Pick<ActionExecutorDeps, 'sessionPermissionRemoteAction' | 'sessionPermissionRespond' | 'sessionPermissionModeSet' | 'sessionNeedsYouRaise' | 'sessionUserActionAnswer'>;


function permissionRequestNotFoundResult(sessionId: string) {
  return {
    ok: false,
    errorCode: 'permission_request_not_found',
    errorMessage: 'permission_request_not_found',
    sessionId,
  } as const;
}

function isKnownCompletedRequestId(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  requestId: string;
  kind: PendingAgentRequestKind;
}> & SessionStoredContentCryptoContext): boolean {
  const agentState = readSessionAgentState(params);
  const completedRequests = agentState?.completedRequests;
  if (!completedRequests || typeof completedRequests !== 'object' || Array.isArray(completedRequests)) {
    return false;
  }

  const completed = (completedRequests as Record<string, unknown>)[params.requestId];
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) {
    return false;
  }

  const requestKind = (completed as Record<string, unknown>).kind;
  if (params.kind === 'user_action') return requestKind === 'user_action';
  return requestKind === 'permission' || typeof requestKind === 'undefined';
}
export function createCliPermissionActionDeps(
  params: CliActionDepsParams,
  { callSessionActionRpc, readSessionActionRpcOrigin, resolveServerRequestHeaders, resolveTransportForSession, resumeInactiveSessionTransport, withProjectHome }: Readonly<{
    callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
    readSessionActionRpcOrigin: (method: string, context: ActionExecutorContext) => SessionActionRpcOriginV1;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    resumeInactiveSessionTransport: (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    effectActionId: 'execution.run.start' | 'session.open' | 'session.user_action.answer';
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequest?: SessionResumeRequestV1;
  }>) => Promise<InactiveSessionResumeResult>;
    withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  }>,
): PermissionActionDeps {
  return {

    sessionPermissionRemoteAction: async (args) => {
      const rejectUnavailable = (
        code: 'canceled' | 'mediationStateUnavailable' | 'ownerMachineUnavailable',
      ) => args.actionId === 'session.permission.remote.pending.list'
        ? { ok: false as const, errorCode: code, error: code }
        : args.actionId === 'session.permission.remote.grants.list'
          ? { ok: false as const, errorCode: code, error: code }
        : { status: 'rejected' as const, code };

      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }

      // Permission state stays in the Session process. A daemon-hosted plugin
      // reaches that owner through the same Account-authenticated Session RPC.
      const binding = resolveCurrentSessionCapabilityBinding(args.input.sessionId);
      if (!binding) {
        const pluginCaller = args.caller.kind === 'plugin' && args.caller.contributionLocalId
          ? { pluginId: args.caller.pluginId, contributionLocalId: args.caller.contributionLocalId }
          : undefined;
        const mediated = pluginCaller && (args.actionId === 'session.permission.remote.pending.list'
          || args.actionId === 'session.permission.remote.respond' || args.actionId === 'session.user_action.remote.answer');
        const grantAdministration = args.caller.kind !== 'plugin'
          && (args.actionId === 'session.permission.remote.grants.list' || args.actionId === 'session.permission.remote.grants.revoke');
        if ((mediated || grantAdministration) && args.context && args.context.surface !== 'rpc'
          && !args.context.rpcSessionAuthorization && params.credentials) {
          const context = args.context;
          const credentials = params.credentials;
          const externalRequest = Boolean(context.externalActionCredential || context.externalActionExecutionAuthorization);
          if (externalRequest && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId)) {
            return rejectUnavailable('ownerMachineUnavailable');
          }
          return await withProjectHome(async () => {
            const transport = await resolveTransportForSession(args.input.sessionId, args.signal, { context, actionId: args.actionId });
            if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
            try {
              const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
              return await callSessionRpc({ ...transport, token: credentials.token, sessionId: transport.sessionId,
                method: `${transport.sessionId}:${args.actionId}`,
                request: mediated && pluginCaller ? createTargetedActionRpcRequestV1(args.input,
                  { kind: 'session', sessionId: transport.sessionId }, { pluginCaller }) : args.input,
                ...(mediated || context.authority !== 'present_user' ? { authorityCeiling: 'account_automation' as const } : {}),
                ...(externalRequest && params.externalActionMachineRequestPrivateKey && params.externalActionMachineInstallationId ? {
                  externalAction: { context, effectActionId: args.actionId, installationId: params.externalActionMachineInstallationId,
                    privateKey: params.externalActionMachineRequestPrivateKey },
                } : {}),
                ...(args.signal ? { signal: args.signal } : {}),
              });
            } catch (error) {
              const code = readRpcErrorCode(error);
              const unavailableOwner = mediated && (code === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE
                || code === 'target_unavailable'
                || isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error));
              const errorCode = unavailableOwner ? 'ownerMachineUnavailable' : code ?? (readRpcRequestDisposition(error) === 'outcomeUnknown'
                ? RPC_ERROR_CODES.OUTCOME_UNKNOWN : 'ownerMachineUnavailable');
              return { ok: false, errorCode, error: errorCode };
            }
          });
        }
        return rejectUnavailable('ownerMachineUnavailable');
      }
      const bindingIsStillCurrent = (): boolean => {
        if (args.signal?.aborted || binding.signal.aborted) return false;
        try {
          if (binding.isCurrent() !== true) return false;
        } catch {
          return false;
        }
        return resolveCurrentSessionCapabilityBinding(args.input.sessionId)?.scopeId === binding.scopeId;
      };
      if (!bindingIsStillCurrent()) {
        return rejectUnavailable('ownerMachineUnavailable');
      }

      const permissionHandler = binding.permissionHandler;
      if (!permissionHandler) {
        return rejectUnavailable('mediationStateUnavailable');
      }

      if (args.actionId === 'session.permission.remote.pending.list') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const list = permissionHandler.listMediatedPendingRequests;
        if (typeof list !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = list.call(permissionHandler, {
          mediatorPluginId: args.caller.pluginId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          ...('cursor' in args.input && args.input.cursor !== undefined
            ? { cursor: args.input.cursor }
            : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.permission.remote.respond') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const respond = permissionHandler.respondToMediatedPendingPermission;
        if (typeof respond !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await respond.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          idempotencyKey: args.input.idempotencyKey,
          actor: args.input.actor,
          decision: args.input.decision,
          scope: args.input.scope,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.user_action.remote.answer') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const answer = permissionHandler.respondToMediatedPendingUserAction;
        if (typeof answer !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await answer.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          answers: args.input.answers,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      const viewer = args.caller.kind === 'plugin'
        ? { kind: 'mediatorPlugin' as const, pluginId: args.caller.pluginId }
        // The admitted Account Action owns non-plugin callers. A Session
        // caller does not manufacture mediator identity or another grant owner.
        : { kind: 'host' as const };

      if (args.actionId === 'session.permission.remote.grants.list') {
        const listGrants = permissionHandler.listMediatedPermissionGrants;
        if (typeof listGrants !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await listGrants.call(permissionHandler, {
          viewer,
          limit: args.input.limit,
          ...(args.input.cursor !== undefined ? { cursor: args.input.cursor } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        if (!bindingIsStillCurrent()) {
          return rejectUnavailable('ownerMachineUnavailable');
        }
        return result ?? rejectUnavailable('mediationStateUnavailable');
      }

      const revoke = permissionHandler.revokeMediatedPermissionGrant;
      if (typeof revoke !== 'function') {
        return rejectUnavailable('mediationStateUnavailable');
      }
      const result = await revoke.call(permissionHandler, {
        turnId: args.input.turnId,
        requestId: args.input.requestId,
        grantId: args.input.grantId,
        caller: viewer,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }
      return bindingIsStillCurrent()
        ? result
        : rejectUnavailable('ownerMachineUnavailable');
    },

    sessionPermissionRespond: async ({
      sessionId,
      context,
      decision,
      nativeChoice,
      requestId,
      turnId,
      mode,
      reason,
      answers,
      allowedTools,
      updatedPermissions,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const externalRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalRequest && context
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.permission.respond', request)
        : undefined;
      if (externalRequest && (!context || !params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated', sessionId };
      }
      const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
      const transport = resolveAuthorizationHeaders
        ? await resolveSessionTransportContext({
            reason: 'session-action',
            credentials: params.credentials,
            idOrPrefix: sessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
          })
        : await resolveTransportForSession(sessionId, signal);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      try {
        const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
        const result = await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.permission.respond`,
          // A decision can await durable publication beyond the generic ACK budget.
          timeoutMs: null,
          ...(externalRequest && context && params.externalActionMachineRequestPrivateKey
            && params.externalActionMachineInstallationId ? { externalAction: {
              context, effectActionId: 'session.permission.respond',
              installationId: params.externalActionMachineInstallationId,
              privateKey: params.externalActionMachineRequestPrivateKey,
            } } : {}),
          request: buildSessionPermissionRespondRpcParamsV1({
            id: reqId,
            ...(nativeChoice === undefined ? {} : { nativeChoice }),
            ...(typeof turnId === 'string' && turnId.trim().length > 0 ? { turnId: turnId.trim() } : {}),
            decision,
            ...(mode === undefined ? {} : { mode }),
            ...(reason === undefined ? {} : { reason }),
            ...(answers === undefined ? {} : { answers }),
            ...(Array.isArray(allowedTools) ? { allowedTools: [...allowedTools] } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          }),
          ...(signal ? { signal } : {}),
        });
        // The Session RPC acknowledges applied decisions with void; Actions require explicit success.
        return result ?? { ok: true };
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? (readRpcRequestDisposition(error) === 'outcomeUnknown'
            ? RPC_ERROR_CODES.OUTCOME_UNKNOWN : 'permission_update_failed'),
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },

    sessionPermissionModeSet: async ({ context, callerInputConstraints, sessionId, permissionMode }) => {
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { parsePermissionIntentAlias } = await import("@happier-dev/agents");
      const parsed = parsePermissionIntentAlias(String(permissionMode ?? '').trim());
      if (!parsed) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      const externalRequest = Boolean(context?.externalActionCredential || context?.externalActionExecutionAuthorization);
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) =>
        resolveServerRequestHeaders(context, 'session.permission_mode.set', request);
      if (externalRequest && !resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' })) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { setSessionPermissionMode } = await import("@/session/services/setSessionPermissionMode");
      const mutate = () => setSessionPermissionMode({
        credentials,
        idOrPrefix: sessionId,
        permissionMode: parsed as PermissionIntent,
        updatedAt,
        ...(callerInputConstraints ? { callerInputConstraints } : {}),
        ...(externalRequest ? { resolveAuthorizationHeaders } : {}),
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, permissionMode: parsed, updatedAt };
    },
    sessionNeedsYouRaise: async ({ sessionId, input, context, signal }) => {
      try {
        // The bound host already owns this Session's request store. Keep its
        // private Agent origin rather than requiring unrelated Account transport.
        if (sessionId === params.sessionId && params.invokeBoundSessionRpc && context.authority !== 'present_user') {
          const origin = readSessionActionRpcOrigin(SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE, context);
          return await params.invokeBoundSessionRpc(SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE, input, signal, origin);
        }
        const transport = await resolveTransportForSession(sessionId, signal);
        if (!transport.ok) return { ok: false, errorCode: transport.code, errorMessage: transport.code };
        return await callSessionActionRpc(transport, SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE, input, context);
      } catch (error) {
        const errorCode = readRpcErrorCode(error) ?? 'question_request_failed';
        return { ok: false, errorCode, errorMessage: error instanceof Error ? error.message : errorCode };
      }
    },
    sessionUserActionAnswer: async ({
      sessionId,
      context,
      requestId,
      disposition,
      answers,
      decision,
      reason,
      updatedPermissions,
      allowedTools,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const externalRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalRequest && context
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.user_action.answer', request)
        : undefined;
      if (externalRequest && (!context || !params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated', sessionId };
      }
      const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
      const transport = resolveAuthorizationHeaders
        ? await resolveSessionTransportContext({
            reason: 'session-action',
            credentials: params.credentials,
            idOrPrefix: sessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
          })
        : await resolveTransportForSession(sessionId, signal);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      if (isKnownCompletedRequestId({
        ...transport,
        rawSession: transport.rawSession,
        requestId: reqId,
        kind: 'user_action',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }
      const normalizedAnswers = buildSessionUserActionAnswerMap(answers);
      const answerDetails = buildSessionUserActionAnswerDetails(answers);
      if (disposition !== 'pass_up' && !decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const legacyDecision =
        decision === 'reject'
          ? 'denied'
          : decision === 'request_changes'
            ? 'abort'
            : 'approved';
      try {
        const request = disposition === 'pass_up'
          ? SessionUserActionPassUpRpcParamsV1Schema.parse({ id: reqId, disposition,
              ...(reason ? { reason } : {}),
              ...(decision ? { decision } : {}),
              ...(Object.keys(normalizedAnswers).length ? { answers: normalizedAnswers } : {}),
              ...(updatedPermissions === undefined ? {} : { updatedPermissions }),
              ...(allowedTools === undefined ? {} : { allowedTools }),
              ...(execPolicyAmendment === undefined ? {} : { execPolicyAmendment }),
            })
          : buildSessionPermissionRespondRpcParamsV1({
              id: reqId,
              decision: legacyDecision,
              ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
              ...(Object.keys(answerDetails).length > 0 ? { answerDetails } : {}),
              ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
              ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
              ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
              ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
            });
        const resumed = await resumeInactiveSessionTransport({ transport,
          localId: context?.actionRequestId ?? `session.user_action.answer:${randomUUID()}`,
          effectActionId: 'session.user_action.answer', context, waitForReady: true,
          ...(signal ? { signal } : {}),
        });
        if (!resumed.ok) return { ok: false, errorCode: resumed.code, errorMessage: resumed.message, sessionId: transport.sessionId };
        const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
        const result = (context?.actionCaller?.kind === 'session' || context?.readSessionActionRpcOrigin)
          && context.authority !== 'present_user' && !externalRequest
          ? await callSessionActionRpc(transport, 'session.user_action.answer', request, context)
          : await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.user_action.answer`,
          timeoutMs: null,
          ...(externalRequest && context && params.externalActionMachineRequestPrivateKey
            && params.externalActionMachineInstallationId ? { externalAction: {
              context, effectActionId: 'session.user_action.answer',
              installationId: params.externalActionMachineInstallationId,
              privateKey: params.externalActionMachineRequestPrivateKey,
            } } : {}),
          request,
          ...(signal ? { signal } : {}),
        });
        return result ?? { ok: true };
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? (readRpcRequestDisposition(error) === 'outcomeUnknown'
            ? RPC_ERROR_CODES.OUTCOME_UNKNOWN : 'permission_update_failed'),
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
  };
}
