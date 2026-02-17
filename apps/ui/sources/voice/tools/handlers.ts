import type { ActionId } from '@happier-dev/protocol';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol';

import { sync } from '@/sync/sync';
import { storage } from '@/sync/domains/state/storage';
import { trackPermissionResponse } from '@/track';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

  const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: resolveSessionServerIdFromCaches });

  const execute = async (toolName: string, parameters: unknown, ctx?: { serverId?: string | null }): Promise<string> => {
    const actionId = VOICE_TOOL_ACTION_ID_BY_TOOL_NAME[toolName];
    if (!actionId) return jsonError('unsupported_action', `unsupported_action:${toolName}`);
    const res = await executor.execute(actionId, parameters, {
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
      { serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
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
    const spec = getActionSpec('session.permission.respond');
    const parsed = spec.inputSchema.safeParse(parameters ?? {});
    if (!parsed.success) return jsonError('invalid_parameters', 'invalid_parameters');

    const data = asPlainObject(parsed.data);
    if (!data) return jsonError('invalid_parameters', 'invalid_parameters');

    const sessionIdParam = typeof data.sessionId === 'string' ? data.sessionId : null;
    const resolved = resolveSessionIdOrError(sessionIdParam);
    if (!resolved.ok) return jsonError('session_not_selected', resolved.error);
    const sessionId = resolved.sessionId;

    const session: any = storage.getState().sessions?.[sessionId] ?? null;
    const requests = session?.agentState?.requests as Record<string, unknown> | undefined;
    if (!requests || Object.keys(requests).length === 0) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'no_permission_request', 'no_permission_request');
      return jsonError('no_permission_request', 'no_permission_request', { sessionId });
    }

    const requestIds = Object.keys(requests);
    const requestId = (() => {
      const explicit = normalizeId(data.requestId);
      if (explicit) return explicit;
      if (requestIds.length === 1) return requestIds[0];
      return null;
    })();
    if (!requestId) {
      return jsonError('multiple_permission_requests', 'multiple_permission_requests', { sessionId, requestIds });
    }
    if (!Object.prototype.hasOwnProperty.call(requests, requestId)) {
      return jsonError('permission_request_not_found', 'permission_request_not_found', { sessionId, requestId });
    }

    const decision = data.decision === 'allow' || data.decision === 'deny' ? data.decision : null;
    if (!decision) return jsonError('invalid_parameters', 'invalid_parameters');

    const targetServerId = resolveSessionServerIdFromCaches(sessionId);
    const res = await executor.execute(
      'session.permission.respond',
      { sessionId, decision, requestId },
      { serverId: targetServerId, defaultSessionId: deps.resolveSessionId(null) },
    );

    if (!res.ok) {
      voiceActivityController.appendError(sessionId, resolveAdapterId(), 'permission_update_failed', 'permission_update_failed');
      return jsonError('permission_update_failed', 'permission_update_failed', { sessionId, requestId });
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

  const handlers: Record<string, (parameters: unknown) => Promise<string>> = {};

  for (const toolName of Object.keys(VOICE_TOOL_ACTION_ID_BY_TOOL_NAME)) {
    handlers[toolName] = async (parameters: unknown) => await execute(toolName, parameters);
  }

  // Voice surface overrides (extra UX behavior).
  handlers.sendSessionMessage = sendSessionMessage;
  handlers.processPermissionRequest = processPermissionRequest;

  return Object.freeze(handlers);
}
