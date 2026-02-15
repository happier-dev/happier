import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';

export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

export type ActionExecutorContext = Readonly<{
  /**
   * Used when ActionSpec input permits an optional sessionId and the caller
   * wants to default to a current/active session.
   */
  defaultSessionId?: string | null;

  /**
   * Optional explicit server routing hint. When omitted, deps may resolve serverId
   * from local caches given a sessionId.
   */
  serverId?: string | null;
}>;

export type ActionExecutorDeps = Readonly<{
  // Execution runs (session-scoped RPC)
  executionRunStart: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunList: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunGet: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunSend: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunStop: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;
  executionRunAction: (sessionId: string, request: any, opts?: Readonly<{ serverId?: string | null }>) => Promise<unknown>;

  // Session navigation/spawn (client-side)
  sessionOpen: (args: Readonly<{ sessionId: string }>) => Promise<unknown>;
  sessionSpawnNew: (args: Readonly<{ tag?: string; path?: string; host?: string; initialMessage?: string }>) => Promise<unknown>;

  // Session messaging (socket message event, server-scoped)
  sessionSendMessage: (args: Readonly<{ sessionId: string; message: string; serverId?: string | null }>) => Promise<unknown>;

  // Permission response (session RPC, server-scoped)
  sessionPermissionRespond: (args: Readonly<{
    sessionId: string;
    decision: 'allow' | 'deny';
    requestId?: string | null;
    serverId?: string | null;
  }>) => Promise<unknown>;

  // Voice panel targeting + session query tools
  sessionTargetPrimarySet: (args: Readonly<{ sessionId: string | null }>) => Promise<unknown>;
  sessionTargetTrackedSet: (args: Readonly<{ sessionIds: readonly string[] }>) => Promise<unknown>;
  sessionList: (args: Readonly<{ limit?: number; cursor?: string | null; includeLastMessagePreview?: boolean }>) => Promise<unknown>;
  sessionActivityGet: (args: Readonly<{ sessionId: string; windowSeconds?: number }>) => Promise<unknown>;
  sessionRecentMessagesGet: (args: Readonly<{
    sessionId: string;
    defaultSessionId?: string | null;
    limit?: number;
    cursor?: string | null;
    includeUser?: boolean;
    includeAssistant?: boolean;
    maxCharsPerMessage?: number | null;
  }>) => Promise<unknown>;

  // Global voice controls
  resetGlobalVoiceAgent: () => Promise<void> | void;

  // Optional policy hook for fail-closed action disablement.
  isActionEnabled?: (actionId: ActionId) => boolean;

  // Server routing resolver (optional)
  resolveServerIdForSessionId?: (sessionId: string) => string | null;
}>;

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function resolveSessionIdFromInput(input: any, ctx: ActionExecutorContext): string | null {
  const sessionId = normalizeId(input?.sessionId);
  if (sessionId) return sessionId;
  const fallback = normalizeId(ctx.defaultSessionId);
  return fallback || null;
}

function resolveServerIdForSession(deps: ActionExecutorDeps, ctx: ActionExecutorContext, sessionId: string): string | null {
  const explicit = normalizeId(ctx.serverId);
  if (explicit) return explicit;
  return deps.resolveServerIdForSessionId ? deps.resolveServerIdForSessionId(sessionId) : null;
}

type FanoutResultItem = Readonly<{
  key: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  error?: string;
}>;

async function fanoutStarts(params: Readonly<{
  keys: readonly string[];
  startOne: (key: string) => Promise<unknown>;
}>): Promise<readonly FanoutResultItem[]> {
  const results = await Promise.all(
    params.keys.map(async (key): Promise<FanoutResultItem> => {
      try {
        const result = await params.startOne(key);
        if (result && typeof result === 'object' && (result as any).ok === false) {
          return {
            key,
            ok: false,
            error: typeof (result as any).error === 'string' ? String((result as any).error) : 'execution_run_failed',
            ...(typeof (result as any).errorCode === 'string' ? { errorCode: String((result as any).errorCode) } : {}),
          };
        }
        return { key, ok: true, result };
      } catch (error) {
        return { key, ok: false, error: error instanceof Error ? error.message : 'execution_run_failed' };
      }
    }),
  );
  return results;
}

export function createActionExecutor(deps: ActionExecutorDeps): Readonly<{
  execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
}> {
  const isActionEnabled = deps.isActionEnabled ?? ((_id: ActionId) => true);

  return {
    execute: async (actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult> => {
      const ctx: ActionExecutorContext = context ?? {};

      if (!isActionEnabled(actionId)) {
        return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
      }

      const spec = getActionSpec(actionId);
      const parsed = (spec.inputSchema as any).safeParse(input ?? {});
      if (!parsed.success) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }

      try {
        // Switch by actionId; keep substrate generic.
        if (actionId === 'review.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;

          const engineIds: readonly string[] = Array.isArray((parsed.data as any).engineIds) ? (parsed.data as any).engineIds : [];
          const instructions = String((parsed.data as any).instructions ?? '').trim();
          const intentInputBase = { ...(parsed.data as any) };

          const results = await fanoutStarts({
            keys: engineIds,
            startOne: async (engineId) =>
              deps.executionRunStart(
                sessionId,
                {
                  intent: 'review',
                  backendId: engineId,
                  instructions,
                  permissionMode: (parsed.data as any).permissionMode ?? 'read_only',
                  retentionPolicy: 'ephemeral',
                  runClass: 'bounded',
                  ioMode: 'request_response',
                  intentInput: { ...intentInputBase, engineId },
                },
                opts,
              ),
          });

          return { ok: true, result: { intent: 'review', sessionId, results } };
        }

        if (actionId === 'plan.start' || actionId === 'delegate.start' || actionId === 'voice_agent.start') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;

          const backendIds: readonly string[] = Array.isArray((parsed.data as any).backendIds) ? (parsed.data as any).backendIds : [];
          const instructions = String((parsed.data as any).instructions ?? '').trim();
          const intent: 'plan' | 'delegate' | 'voice_agent' =
            actionId === 'plan.start' ? 'plan' : actionId === 'delegate.start' ? 'delegate' : 'voice_agent';
          const permissionModeDefault = intent === 'delegate' ? 'default' : 'read_only';

          const results = await fanoutStarts({
            keys: backendIds,
            startOne: async (backendId) =>
              deps.executionRunStart(
                sessionId,
                {
                  intent,
                  backendId,
                  instructions,
                  permissionMode: (parsed.data as any).permissionMode ?? permissionModeDefault,
                  retentionPolicy: (parsed.data as any).retentionPolicy ?? 'ephemeral',
                  runClass: (parsed.data as any).runClass ?? 'bounded',
                  ioMode: (parsed.data as any).ioMode ?? 'request_response',
                  intentInput: { ...(parsed.data as any), backendId },
                },
                opts,
              ),
          });

          return { ok: true, result: { intent, sessionId, results } };
        }

        if (actionId === 'execution.run.list') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunList(sessionId, {}, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.get') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunGet(sessionId, { runId: (parsed.data as any).runId, includeStructured: (parsed.data as any).includeStructured === true }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunSend(sessionId, { runId: (parsed.data as any).runId, message: (parsed.data as any).message, resume: (parsed.data as any).resume }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.stop') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunStop(sessionId, { runId: (parsed.data as any).runId }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'execution.run.action') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const opts = serverId ? { serverId } : undefined;
          const res = await deps.executionRunAction(sessionId, { runId: (parsed.data as any).runId, actionId: (parsed.data as any).actionId, input: (parsed.data as any).input }, opts);
          return { ok: true, result: res };
        }

        if (actionId === 'session.open') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionOpen({ sessionId });
          return { ok: true, result: res };
        }

        if (actionId === 'session.spawn_new') {
          const res = await deps.sessionSpawnNew({
            ...(((parsed.data as any).tag) ? { tag: String((parsed.data as any).tag) } : {}),
            ...(((parsed.data as any).path) ? { path: String((parsed.data as any).path) } : {}),
            ...(((parsed.data as any).host) ? { host: String((parsed.data as any).host) } : {}),
            ...(((parsed.data as any).initialMessage) ? { initialMessage: String((parsed.data as any).initialMessage) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.message.send') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionSendMessage({ sessionId, message: (parsed.data as any).message, ...(serverId ? { serverId } : {}) });
          return { ok: true, result: res };
        }

        if (actionId === 'session.permission.respond') {
          const sessionId = resolveSessionIdFromInput(parsed.data, ctx);
          if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
          const serverId = resolveServerIdForSession(deps, ctx, sessionId);
          const res = await deps.sessionPermissionRespond({
            sessionId,
            decision: (parsed.data as any).decision,
            requestId: Object.prototype.hasOwnProperty.call(parsed.data, 'requestId') ? (((parsed.data as any).requestId ?? null) as any) : null,
            ...(serverId ? { serverId } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.target.primary.set') {
          const raw = (parsed.data as any).sessionId;
          const sessionId = raw === null ? null : normalizeId(raw);
          const res = await deps.sessionTargetPrimarySet({ sessionId: sessionId || null });
          return { ok: true, result: res };
        }

        if (actionId === 'session.target.tracked.set') {
          const res = await deps.sessionTargetTrackedSet({
            sessionIds: Array.isArray((parsed.data as any).sessionIds) ? (((parsed.data as any).sessionIds as unknown[]).map((v) => String(v))) : [],
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.list') {
          const res = await deps.sessionList({
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            ...(typeof (parsed.data as any).includeLastMessagePreview === 'boolean' ? { includeLastMessagePreview: (parsed.data as any).includeLastMessagePreview } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.activity.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionActivityGet({
            sessionId,
            ...(typeof (parsed.data as any).windowSeconds === 'number' ? { windowSeconds: (parsed.data as any).windowSeconds } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'session.messages.recent.get') {
          const sessionId = normalizeId((parsed.data as any).sessionId);
          if (!sessionId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const res = await deps.sessionRecentMessagesGet({
            sessionId,
            defaultSessionId: normalizeId(ctx.defaultSessionId) || null,
            ...(typeof (parsed.data as any).limit === 'number' ? { limit: (parsed.data as any).limit } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'cursor') ? { cursor: (((parsed.data as any).cursor ?? null) as any) } : {}),
            ...(typeof (parsed.data as any).includeUser === 'boolean' ? { includeUser: (parsed.data as any).includeUser } : {}),
            ...(typeof (parsed.data as any).includeAssistant === 'boolean' ? { includeAssistant: (parsed.data as any).includeAssistant } : {}),
            ...(Object.prototype.hasOwnProperty.call(parsed.data, 'maxCharsPerMessage') ? { maxCharsPerMessage: (((parsed.data as any).maxCharsPerMessage ?? null) as any) } : {}),
          });
          return { ok: true, result: res };
        }

        if (actionId === 'ui.voice_global.reset') {
          await deps.resetGlobalVoiceAgent();
          return { ok: true, result: { ok: true } };
        }

        return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
      } catch (error) {
        return { ok: false, errorCode: 'action_failed', error: error instanceof Error ? error.message : 'action_failed' };
      }
    },
  };
}

