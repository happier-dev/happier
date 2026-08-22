import type {
  ActionExecuteAfterHookPayload,
  ActionExecuteBeforeHookPayload,
  AgentToolExecuteAfterHookPayload,
  AgentToolExecuteBeforeHookPayload,
  HookEventEnvelopeV1,
  PluginExecutionInterceptionResult,
} from '@happier-dev/protocol';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

const EXECUTION_INTERCEPTION_HOOK_TIMEOUT_MS = 2_000;

type HookRuntimeRegistry = Parameters<typeof dispatchPluginHookEvent>[0]['runtimeRegistry'];

export type ExecutionInterceptionDispatchResult = Readonly<
  | { status: 'continue'; input: unknown }
  | { status: 'rejected'; code?: string; message?: string }
  | { status: 'failed'; code: string }
>;

function buildHookEnvelope(params: Readonly<{
  eventId: HookEventEnvelopeV1['eventId'];
  category: HookEventEnvelopeV1['category'];
  payload: ActionExecuteBeforeHookPayload | ActionExecuteAfterHookPayload
    | AgentToolExecuteBeforeHookPayload | AgentToolExecuteAfterHookPayload;
}>): HookEventEnvelopeV1 {
  const payload = params.payload;
  const isAgentTool = 'tool' in payload;
  const sessionId = isAgentTool ? payload.sessionId : payload.invocation.sessionId;
  return {
    hookVersion: 1,
    eventId: params.eventId,
    category: params.category,
    scope: 'tool',
    ...(sessionId ? { happySessionId: sessionId } : {}),
    ...(isAgentTool ? {
      agentId: payload.agentId,
      ...(payload.turnId ? { turnId: payload.turnId } : {}),
      toolCallId: payload.tool.callId,
    } : {}),
    timestampMs: payload.timestampMs,
    payload,
  };
}

function readFailedInterceptionCode(
  outcomes: Awaited<ReturnType<typeof dispatchPluginHookEvent>>['outcomes'],
): string | null {
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  return rejected?.error ?? null;
}

async function dispatchBefore(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  eventId: 'action.execute.before' | 'agent.tool.execute.before';
  payload: ActionExecuteBeforeHookPayload | AgentToolExecuteBeforeHookPayload;
  signal?: AbortSignal;
}>): Promise<ExecutionInterceptionDispatchResult> {
  const result = await dispatchPluginHookEvent({
    runtimeRegistry: params.runtimeRegistry,
    event: buildHookEnvelope({
      eventId: params.eventId,
      category: 'augmentation',
      payload: params.payload,
    }),
    handlerTimeoutMs: EXECUTION_INTERCEPTION_HOOK_TIMEOUT_MS,
    ...(params.signal ? { context: { signal: params.signal } } : {}),
  });
  if (result.validationError) {
    return { status: 'failed', code: 'plugin_hook_payload_invalid' };
  }
  if (result.interception?.status === 'rejected') {
    return {
      status: 'rejected',
      ...(result.interception.code ? { code: result.interception.code } : {}),
      ...(result.interception.message ? { message: result.interception.message } : {}),
    };
  }
  const failureCode = readFailedInterceptionCode(result.outcomes);
  if (failureCode) {
    return { status: 'failed', code: failureCode };
  }
  const input = result.interception?.status === 'continued'
    ? result.interception.input
    : params.eventId === 'action.execute.before'
      ? (params.payload as ActionExecuteBeforeHookPayload).input
      : (params.payload as AgentToolExecuteBeforeHookPayload).tool.input;
  return { status: 'continue', input };
}

export async function interceptActionExecutionThroughRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  payload: ActionExecuteBeforeHookPayload;
  signal?: AbortSignal;
}>): Promise<ExecutionInterceptionDispatchResult> {
  return await dispatchBefore({
    runtimeRegistry: params.runtimeRegistry,
    eventId: 'action.execute.before',
    payload: params.payload,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export async function interceptAgentToolExecutionThroughRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  payload: AgentToolExecuteBeforeHookPayload;
  signal?: AbortSignal;
}>): Promise<ExecutionInterceptionDispatchResult> {
  return await dispatchBefore({
    runtimeRegistry: params.runtimeRegistry,
    eventId: 'agent.tool.execute.before',
    payload: params.payload,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

async function observeAfter(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  eventId: 'action.execute.after' | 'agent.tool.execute.after';
  payload: ActionExecuteAfterHookPayload | AgentToolExecuteAfterHookPayload;
}>): Promise<void> {
  await dispatchPluginHookEvent({
    runtimeRegistry: params.runtimeRegistry,
    event: buildHookEnvelope({
      eventId: params.eventId,
      category: 'lifecycle',
      payload: params.payload,
    }),
    handlerTimeoutMs: EXECUTION_INTERCEPTION_HOOK_TIMEOUT_MS,
  });
}

export async function observeActionExecutionThroughRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  payload: ActionExecuteAfterHookPayload;
}>): Promise<void> {
  await observeAfter({
    runtimeRegistry: params.runtimeRegistry,
    eventId: 'action.execute.after',
    payload: params.payload,
  });
}

export async function observeAgentToolExecutionThroughRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  payload: AgentToolExecuteAfterHookPayload;
}>): Promise<void> {
  await observeAfter({
    runtimeRegistry: params.runtimeRegistry,
    eventId: 'agent.tool.execute.after',
    payload: params.payload,
  });
}

export type { PluginExecutionInterceptionResult };
