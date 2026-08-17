import {
  ActionsSettingsV1Schema,
  getActionSpec,
  isActionEnabledByActionsSettings,
  listActionSpecs,
  normalizeSpawnSessionErrorDetail,
  type ActionId,
} from '@happier-dev/protocol';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE } from '@/sync/domains/session/input/types';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import {
  listPendingSessionRequests,
  type SessionPendingRequest,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
  resolveSessionListLookupSessionServerScopeFromState,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveAskUserQuestionDecisionAnswers } from '@/voice/requests/resolveAskUserQuestionDecisionAnswers';

type AgentRequestKind = SessionPendingRequest['kind'];
type PendingVoiceRequest = Readonly<{
  requestId: string;
  toolName: string;
  requestKind: AgentRequestKind;
}>;

export type VoiceToolEffectClass = 'read_only' | 'mutation' | 'external';

export type VoiceToolInvocationContext = Readonly<{
  signal?: AbortSignal;
  effectId?: string;
  callId?: string;
}>;

export type VoiceToolHandler = (parameters: unknown, context?: VoiceToolInvocationContext) => Promise<string>;

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readErrorCode(error: unknown): string | null {
  const record = asPlainObject(error);
  const code = record?.code ?? record?.errorCode;
  return typeof code === 'string' ? code : null;
}

type ToolOk = { ok: true } & Record<string, unknown>;
type ToolError = { ok: false; errorCode: string; errorMessage: string } & Record<string, unknown>;

function jsonOk(payload?: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...(payload ?? {}) } satisfies ToolOk);
}

function jsonError(errorCode: string, errorMessage?: string, payload?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: false,
    errorCode,
    errorMessage: (errorMessage ?? errorCode) || 'unknown_error',
    ...(payload ?? {}),
  } satisfies ToolError);
}

function jsonOkFromUnknown(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const carrier: any = value;
    if (typeof carrier.ok === 'boolean') return JSON.stringify(carrier);
    return jsonOk(carrier as Record<string, unknown>);
  }
  return jsonOk({ result: value });
}

function getNestedActionFailure(value: unknown): { errorCode: string; errorMessage: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const carrier: any = value;
  if (carrier.ok !== false) return null;
  return {
    errorCode: String(carrier.errorCode ?? 'unknown_error'),
    errorMessage: String(carrier.errorMessage ?? carrier.errorCode ?? 'unknown_error'),
  };
}

function asSession(value: unknown): Session | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Session
    : null;
}

function toPendingVoiceRequest(request: SessionPendingRequest): PendingVoiceRequest {
  return {
    requestId: request.id,
    toolName: request.tool,
    requestKind: request.kind,
  };
}

function getPendingRequestsForSession(sessionId: string, session: unknown): PendingVoiceRequest[] {
  const messages = readStoredSessionMessages(storage.getState() as any, sessionId);
  const candidateSession = asSession(session);
  if (!candidateSession) {
    return [];
  }

  return listPendingSessionRequests(candidateSession, messages).map(toPendingVoiceRequest);
}

function listMatchingPendingRequestsAcrossSessions(
  kind: AgentRequestKind,
  explicitRequestId: unknown,
): Array<Readonly<{ sessionId: string; requestId: string }>> {
  const explicit = normalizeId(explicitRequestId);
  const sessions = (storage.getState() as any)?.sessions ?? {};
  const matches: Array<Readonly<{ sessionId: string; requestId: string }>> = [];

  for (const [sessionId, session] of Object.entries(sessions)) {
    const normalizedSessionId = normalizeId(sessionId);
    if (!normalizedSessionId) continue;
    const requests = getPendingRequestsForSession(normalizedSessionId, session).filter((request) => request.requestKind === kind);
    for (const request of requests) {
      if (explicit && request.requestId !== explicit) continue;
      matches.push({ sessionId: normalizedSessionId, requestId: request.requestId });
    }
  }

  return matches.filter((entry) => entry.sessionId.length > 0);
}

const VOICE_TOOL_ACTION_ID_BY_TOOL_NAME: Readonly<Record<string, ActionId>> = (() => {
  const entries: Array<readonly [string, ActionId]> = [];
  for (const spec of listActionSpecs() as any[]) {
    if (!spec?.surfaces?.voice) continue;
    const name = String(spec?.bindings?.voiceClientToolName ?? '').trim();
    const id = String(spec?.id ?? '').trim();
    if (!name || !id) continue;
    entries.push([name, id as ActionId] as const);
  }
  return Object.freeze(Object.fromEntries(entries));
})();

export function resolveVoiceToolEffectClass(toolName: string): VoiceToolEffectClass {
  const actionId = VOICE_TOOL_ACTION_ID_BY_TOOL_NAME[toolName];
  if (!actionId) return 'external';
  const sideEffectClass = getActionSpec(actionId).sideEffectClass;
  if (sideEffectClass === 'none' || sideEffectClass === 'read') return 'read_only';
  if (sideEffectClass === 'external') return 'external';
  return 'mutation';
}

export function createVoiceToolHandlers(
  deps: Readonly<{ resolveSessionId: (explicitSessionId?: string | null) => string | null }>,
): Readonly<Record<string, VoiceToolHandler>> {
  const resolveSessionIdOrError = (
    explicitSessionId?: string | null,
  ): { ok: true; sessionId: string } | { ok: false; error: string } => {
    const sessionId = deps.resolveSessionId(explicitSessionId);
    if (!sessionId) return { ok: false, error: 'error (no active session)' };
    return { ok: true, sessionId };
  };

  const selectPendingRequestId = (
    sessionId: string,
    session: unknown,
    kind: AgentRequestKind,
    explicitRequestId: unknown,
  ): { ok: true; requestId: string } | { ok: false; errorCode: string; payload?: Record<string, unknown> } => {
    const requests = getPendingRequestsForSession(sessionId, session).filter((request) => request.requestKind === kind);
    const explicit = normalizeId(explicitRequestId);
    if (explicit) {
      const exists = requests.some((request) => request.requestId === explicit);
      if (!exists) {
        return { ok: false, errorCode: 'permission_request_not_found', payload: { requestId: explicit } };
      }
      return { ok: true, requestId: explicit };
    }
    if (requests.length === 1) {
      return { ok: true, requestId: requests[0]!.requestId };
    }
    if (requests.length > 1) {
      return {
        ok: false,
        errorCode: kind === 'user_action' ? 'multiple_user_action_requests' : 'multiple_permission_requests',
        payload: { requestIds: requests.map((request) => request.requestId) },
      };
    }
    return { ok: false, errorCode: 'no_permission_request' };
  };

  const resolvePendingRequestRecord = (
    sessionId: string,
    session: unknown,
    kind: AgentRequestKind,
    requestId: string,
  ) => {
    const candidateSession = asSession(session);
    if (!candidateSession) return null;
    const messages = readStoredSessionMessages(storage.getState() as any, sessionId);
    return listPendingSessionRequests(candidateSession, messages)
      .find((request) => request.kind === kind && request.id === requestId) ?? null;
  };

  const resolvePendingRequestSession = async (
    resolvedSessionId: string,
    kind: AgentRequestKind,
    explicitRequestId: unknown,
    opts?: Readonly<{ explicitSessionIdProvided?: boolean; allowCrossSessionFallback?: boolean }>,
  ): Promise<
    | { ok: true; sessionId: string; requestId: string }
    | { ok: false; errorCode: string; payload?: Record<string, unknown> }
  > => {
    const sessions = (storage.getState() as any)?.sessions ?? {};
    const resolvedSession = sessions?.[resolvedSessionId] ?? null;
    const selected = selectPendingRequestId(resolvedSessionId, resolvedSession, kind, explicitRequestId);
    if (selected.ok) {
      return { ok: true, sessionId: resolvedSessionId, requestId: selected.requestId };
    }

    if (selected.errorCode === 'no_permission_request') {
      const ensureVisible = (sync as any).ensureSessionVisibleForMessageRoute;
      if (typeof ensureVisible === 'function') {
        await Promise.resolve(ensureVisible(resolvedSessionId)).catch(() => {});
      }
      const refreshSessionMessages = (sync as any).refreshSessionMessages;
      if (typeof refreshSessionMessages === 'function') {
        await Promise.resolve(refreshSessionMessages(resolvedSessionId)).catch(() => {});
      }
      const hydratedSessions = (storage.getState() as any)?.sessions ?? {};
      const hydratedResolvedSession = hydratedSessions?.[resolvedSessionId] ?? null;
      const hydratedSelected = selectPendingRequestId(resolvedSessionId, hydratedResolvedSession, kind, explicitRequestId);
      if (hydratedSelected.ok) {
        return { ok: true, sessionId: resolvedSessionId, requestId: hydratedSelected.requestId };
      }
      if (hydratedSelected.errorCode !== 'no_permission_request') {
        return hydratedSelected;
      }

      if (typeof ensureVisible === 'function') {
        await Promise.resolve(ensureVisible(resolvedSessionId, { forceRefresh: true })).catch(() => {});
      }
      const refreshedSessions = (storage.getState() as any)?.sessions ?? {};
      const refreshedResolvedSession = refreshedSessions?.[resolvedSessionId] ?? null;
      const refreshedSelected = selectPendingRequestId(resolvedSessionId, refreshedResolvedSession, kind, explicitRequestId);
      if (refreshedSelected.ok) {
        return { ok: true, sessionId: resolvedSessionId, requestId: refreshedSelected.requestId };
      }
      if (refreshedSelected.errorCode !== 'no_permission_request') {
        return refreshedSelected;
      }
    }

    if (opts?.explicitSessionIdProvided === true || selected.errorCode !== 'no_permission_request') {
      return selected;
    }

    const matches = listMatchingPendingRequestsAcrossSessions(kind, explicitRequestId);
    if (matches.length === 0) {
      return selected;
    }

    if (opts?.allowCrossSessionFallback === false) {
      return {
        ok: false,
        errorCode: 'request_not_in_current_session',
        payload: { sessionIds: Array.from(new Set(matches.map((entry) => entry.sessionId))) },
      };
    }

    const uniqueSessionIds = Array.from(new Set(matches.map((entry) => entry.sessionId)));
    if (uniqueSessionIds.length !== 1) {
      return {
        ok: false,
        errorCode: kind === 'user_action' ? 'multiple_user_action_requests' : 'multiple_permission_requests',
        payload: { sessionIds: uniqueSessionIds, requestIds: matches.map((entry) => entry.requestId) },
      };
    }

    const fallbackSessionId = uniqueSessionIds[0]!;
    const fallbackSession = sessions?.[fallbackSessionId] ?? null;
    const fallbackSelected = selectPendingRequestId(fallbackSessionId, fallbackSession, kind, explicitRequestId);
    if (!fallbackSelected.ok) {
      return fallbackSelected;
    }

    return { ok: true, sessionId: fallbackSessionId, requestId: fallbackSelected.requestId };
  };

  const executor = createDefaultActionExecutor({
    resolveServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionId(sessionId) ?? null,
    resolveServerNameForSessionId: (sessionId: string) => resolveSessionListLookupSessionServerScopeFromState(storage.getState(), sessionId)?.serverName ?? null,
  });

  const execute = async (toolName: string, parameters: unknown, ctx?: { serverId?: string | null }): Promise<string> => {
    const actionId = VOICE_TOOL_ACTION_ID_BY_TOOL_NAME[toolName];
    if (!actionId) return jsonError('unsupported_action', `unsupported_action:${toolName}`);
    const res = await executor.execute(actionId, parameters, {
      surface: 'voice',
      defaultSessionId: deps.resolveSessionId(null),
      ...(ctx?.serverId ? { serverId: ctx.serverId } : {}),
    });
    if (!res.ok) {
      const details = asPlainObject(res.details);
      const errorDetail = normalizeSpawnSessionErrorDetail(details?.errorDetail);
      return jsonError(res.errorCode, res.error, {
        actionId,
        ...(errorDetail ? { errorDetail } : {}),
      });
    }
    return jsonOkFromUnknown(res.result);
  };

  const sendSessionMessage: VoiceToolHandler = async (parameters, context) => {
    const spec = getActionSpec('session.message.send');
    const parsed = spec.inputSchema.safeParse(parameters ?? {});
    if (!parsed.success) return jsonError('invalid_parameters', 'invalid_parameters');

    const data = asPlainObject(parsed.data);
    if (!data) return jsonError('invalid_parameters', 'invalid_parameters');

    const sessionIdParam = typeof data.sessionId === 'string' ? data.sessionId : null;
    const resolved = resolveSessionIdOrError(sessionIdParam);
    if (!resolved.ok) return jsonError('session_not_selected', resolved.error);

    const sessionId = resolved.sessionId;
    const session: any = storage.getState().sessions?.[sessionId] ?? null;
    if (!session) {
      return jsonError('session_not_found', 'session_not_found', { sessionId });
    }

    const actionSettings = ActionsSettingsV1Schema.safeParse(
      (storage.getState() as { settings?: { actionsSettingsV1?: unknown } }).settings?.actionsSettingsV1,
    );
    if (
      actionSettings.success
      && !isActionEnabledByActionsSettings('session.message.send', actionSettings.data, { surface: 'voice' })
    ) {
      return jsonError('action_disabled', 'action_disabled', { sessionId });
    }

    const targetServerId = resolvePreferredServerIdForSessionId(sessionId);
    const activeServerId = normalizeId(getActiveServerSnapshot().serverId);
    const isActiveServer = !targetServerId || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId);
    if (isActiveServer) {
      const encryption = (sync as unknown as { encryption?: { getSessionEncryption?: (id: string) => unknown } }).encryption?.getSessionEncryption?.(sessionId) ?? null;
      if (!encryption) {
        return jsonError('session_not_ready', 'session_not_ready', { sessionId });
      }
    }

    const message = typeof data.message === 'string' ? data.message : null;
    if (!message) return jsonError('invalid_parameters', 'invalid_parameters');

    if (context?.signal?.aborted) {
      return jsonError('tool_cancelled', 'tool_cancelled', { sessionId });
    }

    try {
      await sync.submitMessage(sessionId, message, undefined, undefined, {
        callerSurface: 'voice_turn',
        forceImmediate: true,
        hostAdmissionOrigin: 'voice',
      });
    } catch (error) {
      if (readErrorCode(error) === SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE) {
        return jsonError(
          SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE,
          SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE,
          { sessionId },
        );
      }
      throw error;
    }

    return jsonOk({ status: 'sent', sessionId });
  };

  const answerUserActionRequest = async (parameters: unknown): Promise<string> => {
    const rawParameters = asPlainObject(parameters ?? {});
    const spec = getActionSpec('session.user_action.answer');
    const parsed = spec.inputSchema.safeParse(parameters ?? {});
    if (!parsed.success) return jsonError('invalid_parameters', 'invalid_parameters');

    const data = asPlainObject(parsed.data);
    if (!data) return jsonError('invalid_parameters', 'invalid_parameters');
    const allowCrossSessionFallback = rawParameters?.currentSessionOnly === true ? false : true;

    const sessionIdParam = typeof data.sessionId === 'string' ? data.sessionId : null;
    const explicitSessionIdProvided = Boolean(normalizeId(sessionIdParam));
    const resolved = resolveSessionIdOrError(sessionIdParam);
    if (!resolved.ok) return jsonError('session_not_selected', resolved.error);
    const selected = await resolvePendingRequestSession(resolved.sessionId, 'user_action', data.requestId, {
      explicitSessionIdProvided,
      allowCrossSessionFallback,
    });
    if (!selected.ok) {
      return jsonError(selected.errorCode, selected.errorCode, { sessionId: resolved.sessionId, ...(selected.payload ?? {}) });
    }
    const sessionId = selected.sessionId;
    const answers = Array.isArray(data.answers)
      ? data.answers
          .map((entry) => asPlainObject(entry))
          .filter(Boolean)
          .map((entry) => ({
            question: typeof entry!.question === 'string' ? entry!.question.trim() : '',
            values: Array.isArray(entry!.values)
              ? entry!.values.filter((value): value is string => typeof value === 'string')
              // Released 0.2.2 preview ActionSpec compatibility. Remove with the
              // protocol `answer` reader after that mixed-version window closes.
              : typeof entry!.answer === 'string'
                ? [entry!.answer]
                : [],
          }))
          .filter((entry) => entry.question.length > 0 && entry.values.length > 0)
      : [];
    const decision = typeof data.decision === 'string' ? data.decision : null;
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const hasUpdatedPermissions = Object.prototype.hasOwnProperty.call(data, 'updatedPermissions');
    const requestId = selected.requestId;
    const session = ((storage.getState() as any)?.sessions ?? {})?.[sessionId] ?? null;
    const requestRecord = resolvePendingRequestRecord(sessionId, session, 'user_action', requestId);
    const directDecision =
      decision === 'approve'
        ? 'allow'
        : decision === 'reject'
          ? 'deny'
          : null;
    const derivedAnswers =
      answers.length === 0 && directDecision
        ? resolveAskUserQuestionDecisionAnswers(requestRecord, directDecision)
        : null;
    const answersPayload = answers.length > 0 ? answers : derivedAnswers;
    const decisionPayload = decision;
    if (answers.length === 0 && !decision && (!derivedAnswers || derivedAnswers.length === 0)) {
      return jsonError('invalid_parameters', 'invalid_parameters', { sessionId });
    }

    const targetServerId = resolvePreferredServerIdForSessionId(sessionId);
    const res = await executor.execute(
      'session.user_action.answer',
      {
        sessionId,
        requestId,
        ...(answersPayload ? { answers: answersPayload } : {}),
        ...(decisionPayload ? { decision: decisionPayload } : {}),
        ...(reason ? { reason } : {}),
        ...(hasUpdatedPermissions ? { updatedPermissions: data.updatedPermissions } : {}),
      },
      { surface: 'voice', serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
    );
    if (!res.ok) {
      return jsonError(res.errorCode ?? 'permission_update_failed', res.error ?? 'permission_update_failed', { sessionId, requestId });
    }
    const nestedFailure = getNestedActionFailure((res as any).result);
    if (nestedFailure) {
      return jsonError(nestedFailure.errorCode, nestedFailure.errorMessage, { sessionId, requestId });
    }

    return jsonOk({ status: 'done', sessionId, requestId });
  };

  const handlers: Record<string, VoiceToolHandler> = {};

  for (const toolName of Object.keys(VOICE_TOOL_ACTION_ID_BY_TOOL_NAME)) {
    handlers[toolName] = async (parameters) => await execute(toolName, parameters);
  }

  // Voice surface overrides (extra UX behavior).
  handlers.sendSessionMessage = sendSessionMessage;
  handlers.answerUserActionRequest = answerUserActionRequest;

  return Object.freeze(handlers);
}
