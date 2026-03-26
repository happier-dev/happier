import type { ActionId } from '@happier-dev/protocol';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { trackPermissionResponse } from '@/track';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAgentRequestKind, type AgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { listPendingPermissionRequests, listPendingUserActionRequests } from '@/utils/sessions/sessionUtils';
import { resolveAskUserQuestionDecisionAnswers } from '@/voice/requests/resolveAskUserQuestionDecisionAnswers';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function getPendingSessionRequests(session: unknown): Array<Readonly<{
  requestId: string;
  toolName: string;
  requestKind: AgentRequestKind;
}>> {
  const requests = (session as any)?.agentState?.requests as Record<string, unknown> | undefined;
  if (!requests || typeof requests !== 'object') return [];
  const out: Array<Readonly<{ requestId: string; toolName: string; requestKind: AgentRequestKind }>> = [];
  for (const [requestId, raw] of Object.entries(requests)) {
    const normalizedId = normalizeId(requestId);
    const toolName = typeof (raw as any)?.tool === 'string' ? String((raw as any).tool).trim() : '';
    if (!normalizedId || !toolName) continue;
    out.push({
      requestId: normalizedId,
      toolName,
      requestKind: resolveAgentRequestKind({ toolName, requestKind: (raw as any)?.kind }),
    });
  }
  return out;
}

function getPendingRequestsForSession(sessionId: string, session: unknown): Array<Readonly<{
  requestId: string;
  toolName: string;
  requestKind: AgentRequestKind;
}>> {
  const candidateSession = session && typeof session === 'object'
    ? session as Parameters<typeof listPendingPermissionRequests>[0]
    : null;
  if (!candidateSession) {
    return getPendingSessionRequests(session);
  }

  const permissionRequests = (() => {
    try {
      return listPendingPermissionRequests(candidateSession);
    } catch {
      return [];
    }
  })();
  const userActionRequests = (() => {
    try {
      return listPendingUserActionRequests(candidateSession);
    } catch {
      return [];
    }
  })();
  const resolved = [
    ...permissionRequests.map((request) => ({
      requestId: request.id,
      toolName: request.tool,
      requestKind: request.kind,
    })),
    ...userActionRequests.map((request) => ({
      requestId: request.id,
      toolName: request.tool,
      requestKind: request.kind,
    })),
  ];

  if (resolved.length > 0) {
    return resolved;
  }

  return getPendingSessionRequests(session);
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
    if (!spec?.surfaces?.voice_tool) continue;
    const name = String(spec?.bindings?.voiceClientToolName ?? '').trim();
    const id = String(spec?.id ?? '').trim();
    if (!name || !id) continue;
    entries.push([name, id as ActionId] as const);
  }
  return Object.freeze(Object.fromEntries(entries));
})();

export function createVoiceToolHandlers(
  deps: Readonly<{ resolveSessionId: (explicitSessionId?: string | null) => string | null }>,
): Readonly<Record<string, (parameters: unknown) => Promise<string>>> {
  const resolveAdapterId = () => {
    const settings: any = storage.getState().settings;
    return (settings?.voice?.providerId ?? 'unknown') as string;
  };

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
    session: unknown,
    kind: AgentRequestKind,
    requestId: string,
  ) => {
    const candidateSession = session && typeof session === 'object'
      ? session as Parameters<typeof listPendingPermissionRequests>[0]
      : null;
    if (!candidateSession) return null;
    const requests = kind === 'user_action'
      ? listPendingUserActionRequests(candidateSession)
      : listPendingPermissionRequests(candidateSession);
    return requests.find((request) => request.id === requestId) ?? null;
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

  const resolveSessionServerIdFromCaches = (sessionId: string): string | null => {
    const state: any = storage.getState();
    const byServer = state?.sessionListViewDataByServerId ?? {};
    for (const [serverId, items] of Object.entries(byServer)) {
      if (!Array.isArray(items)) continue;
      for (const item of items as any[]) {
        if (!item || item.type !== 'session') continue;
        if (item?.session?.id === sessionId) return String(serverId);
      }
    }
    return null;
  };

  const resolveSessionServerNameFromCaches = (sessionId: string): string | null => {
    const state: any = storage.getState();
    const byServer = state?.sessionListViewDataByServerId ?? {};
    for (const items of Object.values(byServer)) {
      if (!Array.isArray(items)) continue;
      for (const item of items as any[]) {
        if (!item || item.type !== 'session') continue;
        if (item?.session?.id !== sessionId) continue;
        const serverName = normalizeId(item?.serverName);
        if (serverName) return serverName;
      }
    }
    return null;
  };

  const executor = createDefaultActionExecutor({
    resolveServerIdForSessionId: resolveSessionServerIdFromCaches,
    resolveServerNameForSessionId: resolveSessionServerNameFromCaches,
  });

  const execute = async (toolName: string, parameters: unknown, ctx?: { serverId?: string | null }): Promise<string> => {
    const actionId = VOICE_TOOL_ACTION_ID_BY_TOOL_NAME[toolName];
    if (!actionId) return jsonError('unsupported_action', `unsupported_action:${toolName}`);
    const res = await executor.execute(actionId, parameters, {
      surface: 'voice_tool',
      defaultSessionId: deps.resolveSessionId(null),
      ...(ctx?.serverId ? { serverId: ctx.serverId } : {}),
    });
    if (!res.ok) return jsonError(res.errorCode, res.error, { actionId });
    return jsonOkFromUnknown(res.result);
  };

  const sendSessionMessage = async (parameters: unknown): Promise<string> => {
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
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'session_not_found', 'session_not_found');
      return jsonError('session_not_found', 'session_not_found', { sessionId });
    }

    const targetServerId = resolveSessionServerIdFromCaches(sessionId);
    const activeServerId = normalizeId(getActiveServerSnapshot().serverId);
    const isActiveServer = !targetServerId || targetServerId === activeServerId;
    if (isActiveServer) {
      const encryption = (sync as unknown as { encryption?: { getSessionEncryption?: (id: string) => unknown } }).encryption?.getSessionEncryption?.(sessionId) ?? null;
      if (!encryption) {
        voiceActivityController.appendError(sessionId, resolveAdapterId(), 'session_not_ready', 'session_not_ready');
        return jsonError('session_not_ready', 'session_not_ready', { sessionId });
      }
    }

    const message = typeof data.message === 'string' ? data.message : null;
    if (!message) return jsonError('invalid_parameters', 'invalid_parameters');

    const res = await executor.execute(
      'session.message.send',
      { sessionId, message },
      { surface: 'voice_tool', serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
    );
    if (!res.ok) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'send_failed', 'send_failed');
      return jsonError(res.errorCode ?? 'send_failed', res.error ?? 'send_failed', { sessionId });
    }

    const inner: any = res.result;
    if (inner && typeof inner === 'object' && (inner as any).ok === false) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'send_failed', 'send_failed');
      return jsonError(String((inner as any).errorCode ?? 'send_failed'), String((inner as any).errorMessage ?? 'send_failed'), { sessionId });
    }

    voiceActivityController.appendActionExecuted(
      sessionId,
      resolveAdapterId(),
      'sendSessionMessage',
      `Sent to session: ${String(message).slice(0, 200)}`,
    );
    return jsonOk({ status: 'sent', sessionId });
  };

  const processPermissionRequest = async (parameters: unknown): Promise<string> => {
    const rawParameters = asPlainObject(parameters ?? {});
    const spec = getActionSpec('session.permission.respond');
    const parsed = spec.inputSchema.safeParse(parameters ?? {});
    if (!parsed.success) return jsonError('invalid_parameters', 'invalid_parameters');

    const data = asPlainObject(parsed.data);
    if (!data) return jsonError('invalid_parameters', 'invalid_parameters');
    const allowCrossSessionFallback = rawParameters?.currentSessionOnly === true ? false : true;

    const sessionIdParam = typeof data.sessionId === 'string' ? data.sessionId : null;
    const explicitSessionIdProvided = Boolean(normalizeId(sessionIdParam));
    const resolved = resolveSessionIdOrError(sessionIdParam);
    if (!resolved.ok) return jsonError('session_not_selected', resolved.error);
    const selected = await resolvePendingRequestSession(resolved.sessionId, 'permission', data.requestId, {
      explicitSessionIdProvided,
      allowCrossSessionFallback,
    });
    if (!selected.ok) {
      if (selected.errorCode === 'no_permission_request') {
        voiceActivityController.appendError(resolved.sessionId, resolveAdapterId(), 'no_permission_request', 'no_permission_request');
      }
      return jsonError(selected.errorCode, selected.errorCode, { sessionId: resolved.sessionId, ...(selected.payload ?? {}) });
    }
    const sessionId = selected.sessionId;
    const requestId = selected.requestId;

    const decision = data.decision === 'allow' || data.decision === 'deny' ? data.decision : null;
    if (!decision) return jsonError('invalid_parameters', 'invalid_parameters');

    const targetServerId = resolveSessionServerIdFromCaches(sessionId);
    const res = await executor.execute(
      'session.permission.respond',
      { sessionId, decision, requestId },
      { surface: 'voice_tool', serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
    );

    if (!res.ok) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'permission_update_failed', 'permission_update_failed');
      return jsonError('permission_update_failed', 'permission_update_failed', { sessionId, requestId });
    }
    const nestedFailure = getNestedActionFailure((res as any).result);
    if (nestedFailure) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), nestedFailure.errorCode, nestedFailure.errorMessage);
      return jsonError(nestedFailure.errorCode, nestedFailure.errorMessage, { sessionId, requestId });
    }

    trackPermissionResponse(decision === 'allow');
    voiceActivityController.appendActionExecuted(
      sessionId,
      resolveAdapterId(),
      'processPermissionRequest',
      `${decision === 'allow' ? 'Allowed' : 'Denied'} permission request: ${requestId}`,
    );
    return jsonOk({ status: 'done', sessionId, requestId });
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
      if (selected.errorCode === 'no_permission_request') {
        voiceActivityController.appendError(resolved.sessionId, resolveAdapterId(), 'no_permission_request', 'no_permission_request');
      }
      return jsonError(selected.errorCode, selected.errorCode, { sessionId: resolved.sessionId, ...(selected.payload ?? {}) });
    }
    const sessionId = selected.sessionId;
    const answers = Array.isArray(data.answers)
      ? data.answers
          .map((entry) => asPlainObject(entry))
          .filter(Boolean)
          .map((entry) => ({
            question: typeof entry!.question === 'string' ? entry!.question.trim() : '',
            answer: typeof entry!.answer === 'string' ? entry!.answer.trim() : '',
          }))
          .filter((entry) => entry.question.length > 0 && entry.answer.length > 0)
      : [];
    const decision = typeof data.decision === 'string' ? data.decision : null;
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const hasUpdatedPermissions = Object.prototype.hasOwnProperty.call(data, 'updatedPermissions');
    const requestId = selected.requestId;
    const session = ((storage.getState() as any)?.sessions ?? {})?.[sessionId] ?? null;
    const requestRecord = resolvePendingRequestRecord(session, 'user_action', requestId);
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

    const targetServerId = resolveSessionServerIdFromCaches(sessionId);
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
      { surface: 'voice_tool', serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
    );
    if (!res.ok) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'permission_update_failed', 'permission_update_failed');
      return jsonError(res.errorCode ?? 'permission_update_failed', res.error ?? 'permission_update_failed', { sessionId, requestId });
    }
    const nestedFailure = getNestedActionFailure((res as any).result);
    if (nestedFailure) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), nestedFailure.errorCode, nestedFailure.errorMessage);
      return jsonError(nestedFailure.errorCode, nestedFailure.errorMessage, { sessionId, requestId });
    }

    voiceActivityController.appendActionExecuted(
      sessionId,
      resolveAdapterId(),
      'answerUserActionRequest',
      `Answered user action request: ${requestId}`,
    );
    return jsonOk({ status: 'done', sessionId, requestId });
  };

  const handlers: Record<string, (parameters: unknown) => Promise<string>> = {};

  for (const toolName of Object.keys(VOICE_TOOL_ACTION_ID_BY_TOOL_NAME)) {
    handlers[toolName] = async (parameters: unknown) => await execute(toolName, parameters);
  }

  // Voice surface overrides (extra UX behavior).
  handlers.sendSessionMessage = sendSessionMessage;
  handlers.processPermissionRequest = processPermissionRequest;
  handlers.answerUserActionRequest = answerUserActionRequest;

  return Object.freeze(handlers);
}
