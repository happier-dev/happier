import type { HookEventEnvelopeV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { tryCreateDaemonAgentRuntimeTurnContributionsBridge } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeClient';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

type HookPayload = Record<string, unknown>;
type HookRuntimeRegistry = Parameters<typeof dispatchPluginHookEvent>[0]['runtimeRegistry'];

export type ToolPromptContribution = Readonly<{
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

function readLocalizedString(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
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
  signal?: AbortSignal;
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
    ...(params.signal ? { context: { signal: params.signal } } : {}),
  });
  const transformed = result.aggregate?.result;
  return isRecord(transformed) ? transformed : params.payload;
}

export async function transformAgentContextThroughPluginRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  return await dispatchTransformHookWithRuntimeRegistry({
    runtimeRegistry,
    eventId: 'agent.context.before',
    scope: 'agent',
    payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
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
  } catch {
    logger.debug('[plugins] Plugin transform hook dispatch failed; using prior payload', {
      hookId: params.eventId,
      error: 'plugin_hook_dispatch_failed',
    });
    return params.payload;
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after hook dispatch', {
          hookId: params.eventId,
          error: 'plugin_hook_registry_release_failed',
        });
      });
    }
  }
}

export async function transformSessionInputThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  const daemonBridge = tryCreateDaemonAgentRuntimeTurnContributionsBridge();
  const sessionId = readOptionalString(payload.sessionId);
  if (daemonBridge && sessionId) {
    try {
      return await daemonBridge.transformSessionInput({
        sessionId,
        payload,
      });
    } catch {
      logger.debug('[plugins] Daemon session input transform failed; using prior payload');
      return payload;
    }
  }
  return await dispatchTransformHook({
    eventId: 'session.input.transform',
    scope: 'session',
    payload,
  });
}

export async function transformSessionInputThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  return await dispatchTransformHookWithRuntimeRegistry({
    runtimeRegistry,
    eventId: 'session.input.transform',
    scope: 'session',
    payload,
    ...(options?.signal ? { signal: options.signal } : {}),
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
  } catch {
    logger.debug('[plugins] Plugin ACP request hook dispatch failed; using prior payload');
    return payload;
  }
}

export async function observeAgentStreamTokenThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
): Promise<void> {
  await dispatchPluginHookEvent({
    runtimeRegistry,
    event: buildHookEnvelope({
      eventId: 'agent.stream.token',
      category: 'lifecycle',
      scope: 'agent',
      payload,
    }),
    handlerTimeoutMs: AGENT_STREAM_TOKEN_HOOK_TIMEOUT_MS,
  });
}

export async function observeAgentStreamTokenThroughPluginHooks(payload: HookPayload): Promise<void> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    await observeAgentStreamTokenThroughRuntimeRegistry(lease.registry, payload);
  } catch {
    logger.debug('[plugins] Plugin stream token hook dispatch failed (non-fatal)');
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after stream token hook dispatch');
      });
    }
  }
}

export async function resolvePluginToolPromptContributions(): Promise<readonly ToolPromptContribution[]> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return resolvePluginToolPromptContributionsThroughRuntimeRegistry(
      lease.registry,
    );
  } catch {
    logger.debug('[plugins] Failed to resolve plugin tool prompt contributions');
    return Object.freeze([]);
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after tool prompt resolution');
      });
    }
  }
}

export function resolvePluginToolPromptContributionsThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry & Readonly<{
    contributes: Readonly<{
      tools?: readonly Readonly<{
        definition: Readonly<{
          id: string;
          name?: string | null;
          title: string | Readonly<{ fallback: string }>;
          promptSnippet?: string | null;
          promptGuidelines?: readonly string[] | null;
        }>;
      }>[];
    }>;
  }>,
): readonly ToolPromptContribution[] {
  return Object.freeze((runtimeRegistry.contributes.tools ?? [])
    .map((tool) => tool.definition)
    .filter((tool) => Boolean(tool.promptSnippet) || (tool.promptGuidelines?.length ?? 0) > 0)
    .map((tool) => Object.freeze({
      id: tool.id,
      name: tool.name,
      title: readLocalizedString(tool.title),
      promptSnippet: tool.promptSnippet ?? null,
      promptGuidelines: tool.promptGuidelines ?? null,
    })));
}

export async function resolvePluginPromptAssetBlocks(params: Readonly<{
  agentId: string;
  selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
  sessionId?: string;
  machineId?: string;
  featureIds?: readonly string[];
  signal?: AbortSignal;
}>): Promise<readonly import('@happier-dev/protocol').PromptBlockV1[]> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return await lease.registry.resolvePromptAssetBlocks(params);
  } finally {
    await lease.release();
  }
}
