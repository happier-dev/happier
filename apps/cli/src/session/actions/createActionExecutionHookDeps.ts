import type {
  ActionExecuteAfterHookPayload,
  ActionExecuteBeforeHookPayload,
  ActionExecutorDeps,
  PluginJsonValueV2,
} from '@happier-dev/protocol';

import { clonePluginPlainData } from '@/plugins/runtime/plainData';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  interceptActionExecutionThroughRuntimeRegistry,
  observeActionExecutionThroughRuntimeRegistry,
} from '@/plugins/runtime/hooks/execution/dispatchExecutionInterceptionHooks';

function cloneHookJsonValue(value: unknown, path: string): PluginJsonValueV2 {
  return clonePluginPlainData(value, {
    path,
    invalid: (message) => new Error(message),
  }) as PluginJsonValueV2;
}

function readSessionId(input: unknown, defaultSessionId: string | null | undefined): string | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const candidate = Reflect.get(input, 'sessionId');
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  const fallback = typeof defaultSessionId === 'string' ? defaultSessionId.trim() : '';
  return fallback.length > 0 ? fallback : undefined;
}

function resolveSurface(surface: unknown): ActionExecuteBeforeHookPayload['invocation']['surface'] {
  return surface === 'ui'
    || surface === 'voice'
    || surface === 'agent'
    || surface === 'mcp'
    || surface === 'cli'
    || surface === 'rpc'
    || surface === 'plugin'
    ? surface
    : 'cli';
}

/**
 * Hooks observe the stable public caller identity only. Materialization and
 * contribution facts are host-private authority, not hook ABI fields.
 */
function projectHookCaller(
  caller: Parameters<NonNullable<ActionExecutorDeps['interceptActionExecution']>>[0]['caller'],
): ActionExecuteBeforeHookPayload['invocation']['caller'] {
  return caller.kind === 'plugin'
    ? { kind: 'plugin', pluginId: caller.pluginId }
    : { kind: 'host' };
}

function buildBeforePayload(
  request: Parameters<NonNullable<ActionExecutorDeps['interceptActionExecution']>>[0],
): ActionExecuteBeforeHookPayload {
  const sessionId = readSessionId(request.input, request.context.defaultSessionId);
  return {
    actionId: request.actionId,
    input: cloneHookJsonValue(request.input, 'action interception input'),
    invocation: {
      surface: resolveSurface(request.context.surface),
      ...(sessionId ? { sessionId } : {}),
      caller: projectHookCaller(request.caller),
    },
    timestampMs: Date.now(),
  };
}

function buildAfterPayload(
  observation: Parameters<NonNullable<ActionExecutorDeps['observeActionExecution']>>[0],
): ActionExecuteAfterHookPayload {
  const before = buildBeforePayload({
    actionId: observation.actionId,
    input: observation.input,
    context: observation.context,
    caller: observation.caller,
    ...(observation.context.signal ? { signal: observation.context.signal } : {}),
  });
  if (observation.result.ok) {
    let result: PluginJsonValueV2 | undefined;
    try {
      result = cloneHookJsonValue(observation.result.result, 'action observation result');
    } catch {
      // The observational ABI never publishes a non-JSON host result or private authority object.
    }
    return {
      ...before,
      outcome: { status: 'succeeded', ...(result !== undefined ? { result } : {}) },
      timestampMs: Date.now(),
    };
  }
  return {
    ...before,
    outcome: { status: 'failed', code: observation.result.errorCode },
    timestampMs: Date.now(),
  };
}

export function createActionExecutionHookDeps(): Pick<
  ActionExecutorDeps,
  'interceptActionExecution' | 'observeActionExecution'
> {
  return Object.freeze({
    interceptActionExecution: async (request) => {
      const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
      if (!lease) return { status: 'continue' as const, input: request.input };
      try {
        let payload: ActionExecuteBeforeHookPayload;
        try {
          payload = buildBeforePayload(request);
        } catch {
          return { status: 'failed' as const, code: 'plugin_hook_payload_invalid' };
        }
        return await interceptActionExecutionThroughRuntimeRegistry({
          runtimeRegistry: lease.registry,
          payload,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } finally {
        await lease.release();
      }
    },
    observeActionExecution: async (observation) => {
      const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
      if (!lease) return;
      try {
        await observeActionExecutionThroughRuntimeRegistry({
          runtimeRegistry: lease.registry,
          payload: buildAfterPayload(observation),
        });
      } finally {
        await lease.release();
      }
    },
  });
}
