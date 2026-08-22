import { describe, expect, it, vi } from 'vitest';
import { type PluginHookIdV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

function resolvedHook(params: Readonly<{
  pluginId: string;
  hookId: PluginHookIdV1;
  priority: number;
  registrationIndex: number;
  handler: ResolvedPluginHookHandler['handler'];
}>): ResolvedPluginHookHandler {
  const before = params.hookId.endsWith('.before');
  const registration: ResolvedActivatedHookRegistration = {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: params.pluginId,
    manifestPath: `/plugins/${params.pluginId}/plugin.json`,
    daemonEntryPath: `/plugins/${params.pluginId}/daemon.mjs`,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${params.pluginId}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: params.hookId,
      category: before ? 'augmentation' : 'lifecycle',
      scope: 'tool',
      executionKind: before ? 'augment' : 'observe',
      priority: params.priority,
    },
  };
  return {
    pluginId: params.pluginId,
    localId: `${params.hookId}-${params.registrationIndex}`,
    hookId: params.hookId,
    priority: params.priority,
    registrationIndex: params.registrationIndex,
    manifestPath: registration.manifestPath,
    daemonEntryPath: registration.daemonEntryPath!,
    registration,
    handler: params.handler,
  };
}

function runtimeRegistry(
  hookId: PluginHookIdV1,
  handlers: readonly ResolvedPluginHookHandler[],
) {
  return {
    hookHandlersByHookId: new Map([[hookId, Object.freeze([...handlers])]]),
  };
}

function actionBeforeEvent(input: unknown) {
  return {
    hookVersion: 1 as const,
    eventId: 'action.execute.before' as const,
    category: 'augmentation' as const,
    scope: 'tool' as const,
    happySessionId: 'session-1',
    timestampMs: 1,
    payload: {
      actionId: 'session.title.set',
      input,
      invocation: {
        surface: 'plugin',
        sessionId: 'session-1',
        caller: { kind: 'plugin', pluginId: 'caller.plugin' },
      },
      timestampMs: 1,
    },
  };
}

describe('execution interception through the canonical plugin hook dispatcher', () => {
  it('applies valid replacements sequentially in canonical handler order', async () => {
    const calls: string[] = [];
    const lowerPriority = resolvedHook({
      pluginId: 'zeta.plugin',
      hookId: 'action.execute.before',
      priority: 10,
      registrationIndex: 0,
      handler: async (event) => {
        calls.push('zeta');
        const payload = (event as { payload: { input: { title: string } } }).payload;
        return { status: 'continue', input: { ...payload.input, title: `${payload.input.title}-zeta` } };
      },
    });
    const higherPriority = resolvedHook({
      pluginId: 'alpha.plugin',
      hookId: 'action.execute.before',
      priority: 0,
      registrationIndex: 1,
      handler: async (event) => {
        calls.push('alpha');
        const payload = (event as { payload: { input: { title: string } } }).payload;
        return { status: 'continue', input: { ...payload.input, title: `${payload.input.title}-alpha` } };
      },
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: runtimeRegistry('action.execute.before', [higherPriority, lowerPriority]),
      event: actionBeforeEvent({ sessionId: 'session-1', title: 'start' }),
    });

    expect(calls).toEqual(['alpha', 'zeta']);
    expect(result.interception).toEqual({
      status: 'continued',
      input: { sessionId: 'session-1', title: 'start-alpha-zeta' },
    });
    expect(result.aggregate?.result).toMatchObject({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'start-alpha-zeta' },
      invocation: { caller: { kind: 'plugin', pluginId: 'caller.plugin' } },
    });
  });

  it('stops on a typed rejection and keeps it distinct from handler failure', async () => {
    const later = vi.fn(async () => ({ status: 'continue', input: {} }));
    const rejecting = resolvedHook({
      pluginId: 'reject.plugin',
      hookId: 'action.execute.before',
      priority: 0,
      registrationIndex: 0,
      handler: async () => ({ status: 'rejected', code: 'policy_denied', message: 'Denied' }),
    });
    const unreachable = resolvedHook({
      pluginId: 'later.plugin',
      hookId: 'action.execute.before',
      priority: 1,
      registrationIndex: 1,
      handler: later,
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: runtimeRegistry('action.execute.before', [rejecting, unreachable]),
      event: actionBeforeEvent({ sessionId: 'session-1', title: 'start' }),
    });

    expect(later).not.toHaveBeenCalled();
    expect(result.interception).toEqual({ status: 'rejected', code: 'policy_denied', message: 'Denied' });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        pluginId: 'reject.plugin',
        status: 'fulfilled',
        result: { status: 'rejected', code: 'policy_denied', message: 'Denied' },
      }),
    ]);
  });

  it('normalizes caller cancellation and stops fail-closed interception', async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = resolvedHook({
      pluginId: 'cancel.plugin',
      hookId: 'action.execute.before',
      priority: 0,
      registrationIndex: 0,
      handler: async () => ({ status: 'continue', input: {} }),
    });

    const result = await dispatchPluginHookEvent({
      runtimeRegistry: runtimeRegistry('action.execute.before', [handler]),
      event: actionBeforeEvent({ sessionId: 'session-1', title: 'start' }),
      context: { signal: controller.signal },
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: 'rejected', error: 'plugin_hook_handler_cancelled' }),
    ]);
    expect(result.interception).toBeUndefined();
  });

  it('keeps after hooks observational and failure-isolated', async () => {
    const handler = resolvedHook({
      pluginId: 'observer.plugin',
      hookId: 'agent.tool.execute.after',
      priority: 0,
      registrationIndex: 0,
      handler: async () => {
        throw new Error('observer failed');
      },
    });
    const result = await dispatchPluginHookEvent({
      runtimeRegistry: runtimeRegistry('agent.tool.execute.after', [handler]),
      event: {
        hookVersion: 1,
        eventId: 'agent.tool.execute.after',
        category: 'lifecycle',
        scope: 'tool',
        happySessionId: 'session-1',
        agentId: 'claude',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        timestampMs: 1,
        payload: {
          agentId: 'claude',
          runtimeFamily: 'acpSession',
          capability: 'observable',
          caller: { kind: 'plugin', pluginId: 'happier.agent.claude' },
          sessionId: 'session-1',
          turnId: 'turn-1',
          tool: { callId: 'call-1', name: 'Bash', input: { command: 'pwd' } },
          outcome: { status: 'succeeded', result: { output: '/workspace' } },
          timestampMs: 1,
        },
      },
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: 'rejected', error: 'plugin_hook_handler_failed' }),
    ]);
    expect(result.aggregate?.executionKind).toBe('observe');
  });
});
