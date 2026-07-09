import type { HookEventEnvelopeV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

type HookPayload = Record<string, unknown>;
type HookRuntimeRegistry = Parameters<typeof dispatchPluginHookEvent>[0]['runtimeRegistry'];

type ToolPromptContribution = Readonly<{
  id: string;
  name?: string | null;
  title?: string | null;
  promptSnippet?: string | null;
  promptGuidelines?: readonly string[] | null;
}>;

const AGENT_TRANSFORM_HOOK_TIMEOUT_MS = 2_000;
const AGENT_STREAM_TOKEN_HOOK_TIMEOUT_MS = 100;

function isRecord(value: unknown): value is HookPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function readTimestampMs(payload: HookPayload): number {
  const timestampMs = payload.timestampMs;
  return typeof timestampMs === 'number' && Number.isFinite(timestampMs) && timestampMs >= 0
    ? Math.trunc(timestampMs)
    : Date.now();
}

function buildHookEnvelope(params: Readonly<{
  eventId: HookEventEnvelopeV1['eventId'];
  category: HookEventEnvelopeV1['category'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
}>): HookEventEnvelopeV1 {
  const sessionId = readOptionalString(params.payload.sessionId);
  const agentId = readOptionalString(params.payload.agentId);
  const turnId = readOptionalString(params.payload.turnId);
  return {
    hookVersion: 1,
    eventId: params.eventId,
    category: params.category,
    scope: params.scope,
    ...(sessionId ? { happySessionId: sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(turnId ? { turnId } : {}),
    timestampMs: readTimestampMs(params.payload),
    payload: params.payload,
  };
}

async function dispatchTransformHookWithRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  eventId: HookEventEnvelopeV1['eventId'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
}>): Promise<HookPayload> {
  const result = await dispatchPluginHookEvent({
    runtimeRegistry: params.runtimeRegistry,
    event: buildHookEnvelope({
      eventId: params.eventId,
      category: 'augmentation',
      scope: params.scope,
      payload: params.payload,
    }),
    handlerTimeoutMs: AGENT_TRANSFORM_HOOK_TIMEOUT_MS,
  });
  const transformed = result.aggregate?.result;
  return isRecord(transformed) ? transformed : params.payload;
}

async function dispatchTransformHook(params: Readonly<{
  eventId: HookEventEnvelopeV1['eventId'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
}>): Promise<HookPayload> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return await dispatchTransformHookWithRuntimeRegistry({
      runtimeRegistry: lease.registry,
      eventId: params.eventId,
      scope: params.scope,
      payload: params.payload,
    });
  } catch (error) {
    logger.debug('[plugins] Plugin transform hook dispatch failed; using prior payload', {
      hookId: params.eventId,
      error,
    });
    return params.payload;
  } finally {
    if (lease) {
      await lease.release().catch((error: unknown) => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after hook dispatch', {
          hookId: params.eventId,
          error,
        });
      });
    }
  }
}

export async function transformSessionInputThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'session.input.transform',
    scope: 'session',
    payload,
  });
}

export async function transformAgentContextThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'agent.context.before',
    scope: 'agent',
    payload,
  });
}

export async function transformAgentRequestThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'agent.request.before',
    scope: 'agent',
    payload,
  });
}

export async function transformAgentRequestThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
): Promise<HookPayload> {
  try {
    return await dispatchTransformHookWithRuntimeRegistry({
      runtimeRegistry,
      eventId: 'agent.request.before',
      scope: 'agent',
      payload,
    });
  } catch (error) {
    logger.debug('[plugins] Plugin ACP request hook dispatch failed; using prior payload', { error });
    return payload;
  }
}

export async function observeAgentStreamTokenThroughPluginHooks(payload: HookPayload): Promise<void> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    await dispatchPluginHookEvent({
      runtimeRegistry: lease.registry,
      event: buildHookEnvelope({
        eventId: 'agent.stream.token',
        category: 'lifecycle',
        scope: 'agent',
        payload,
      }),
      handlerTimeoutMs: AGENT_STREAM_TOKEN_HOOK_TIMEOUT_MS,
    });
  } catch (error) {
    logger.debug('[plugins] Plugin stream token hook dispatch failed (non-fatal)', { error });
  } finally {
    if (lease) {
      await lease.release().catch((error: unknown) => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after stream token hook dispatch', { error });
      });
    }
  }
}

export async function resolvePluginToolPromptContributions(): Promise<readonly ToolPromptContribution[]> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return Object.freeze((lease.registry.contributes.tools ?? [])
      .map((tool) => tool.definition)
      .filter((tool) => Boolean(tool.promptSnippet) || (tool.promptGuidelines?.length ?? 0) > 0)
      .map((tool) => Object.freeze({
        id: tool.id,
        name: tool.name,
        title: tool.title,
        promptSnippet: tool.promptSnippet ?? null,
        promptGuidelines: tool.promptGuidelines ?? null,
      })));
  } catch (error) {
    logger.debug('[plugins] Failed to resolve plugin tool prompt contributions', { error });
    return Object.freeze([]);
  } finally {
    if (lease) {
      await lease.release().catch((error: unknown) => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after tool prompt resolution', { error });
      });
    }
  }
}
