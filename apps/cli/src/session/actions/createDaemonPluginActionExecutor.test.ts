import { describe, expect, it } from 'vitest';

import { createDaemonPluginActionExecutor, createPluginActionExecutor, type PluginActionExecutionRequestOwner } from './createDaemonPluginActionExecutor';
import { createActionExecutor, type ActionCaller, type ActionExecutorDeps } from '@happier-dev/protocol';

describe('createDaemonPluginActionExecutor', () => {
  it('retains the host read-only constraint across the private daemon transport', async () => {
    const transport = createDaemonPluginActionExecutor({
      base: { execute: async () => { throw new Error('Unexpected fallback'); } },
      requestPluginActionExecution: async request => ({ matched: true,
        result: request.requiredDangerLevel === 'safe'
          ? { ok: false, errorCode: 'plugin_action_read_only_required', error: 'write rejected' }
          : { ok: true, result: 'write ran' } }),
    });
    const executor = createActionExecutor({ invokeContributedAction: transport.invokeContributedAction } as unknown as ActionExecutorDeps);
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.source', localId: 'read' }, input: {} }, {
      surface: 'api', requiredContributedActionDangerLevel: 'safe',
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_read_only_required' });
  });
  it('reads the host caller per invocation and refuses unavailable provenance', async () => {
    let caller: ActionCaller | null = { kind: 'session', sessionId: 'host-session', starterDepth: 2, turnDepth: 3 };
    const executor = createDaemonPluginActionExecutor({
      base: { execute: async () => { throw new Error('Unexpected fallback'); } },
      getInitiatingActionCaller: () => caller,
      requestPluginActionExecution: async (request) => ({ matched: true,
        result: { ok: true, result: { startedBy: request.startedBy ?? null } } }),
    });
    expect(await executor.execute('action.spec.get', {}, { surface: 'mcp' })).toMatchObject({
      ok: true, result: { startedBy: 'agent' },
    });
    caller = null;
    expect(await executor.execute('action.spec.get', {}, { surface: 'mcp' })).toMatchObject({
      ok: false, errorCode: 'target_unavailable',
    });
  });
  it('exposes nested wait invocation without falling back recursively for an unavailable plugin', async () => {
    const transport = createDaemonPluginActionExecutor({
      base: { execute: async () => { throw new Error('Nested invocation must not re-enter the base'); } },
      requestPluginActionExecution: async () => ({ matched: false }),
    });
    const executor = createActionExecutor({
      invokeContributedAction: async (request: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0]) => transport.invokeContributedAction(request),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('wait', {
      target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'checkpoint' },
      condition: { kind: 'plugin', actionLocalId: 'observe/checks', condition: 'checks_passed' },
    }, { surface: 'mcp', serverId: 'home' })).toMatchObject({ ok: true, result: { disposition: 'target_unavailable' } });
  });
  it.each([
    ['daemon', createDaemonPluginActionExecutor],
    ['scoped', createPluginActionExecutor],
  ] as const)('routes contributed Action discovery with descriptive starter provenance through the %s owner', async (_owner, createExecutor) => {
    let expectedStarter: 'agent' | 'user' = 'agent';
    const requestPluginActionExecution: PluginActionExecutionRequestOwner = async (request) => {
      // Daemon IPC/HTTP is the system boundary. Assert its existing closed
      // request contract; no internal dispatcher or authority service is mocked.
      expect(request).toEqual({ actionId: request.actionId, input: {}, surface: 'agent', startedBy: expectedStarter });
      return { matched: true, result: { ok: true, result: {
        actionId: request.actionId, startedBy: request.startedBy, source: 'daemon',
      } } };
    };
    const params = {
      base: { execute: async () => { throw new Error('Contributed discovery must not reach the base executor'); } },
      requestPluginActionExecution,
      startedBy: 'agent' as const,
    };
    const executor = createExecutor(params);

    for (const actionId of ['action.spec.search', 'action.spec.get', 'action.options.resolve'] as const) {
      await expect(executor.execute(actionId, {}, { surface: 'agent' })).resolves.toEqual({
        ok: true,
        result: { actionId, startedBy: 'agent', source: 'daemon' },
      });
    }

    expectedStarter = 'user';
    await expect(executor.execute('action.spec.get', {}, { surface: 'agent', actionCaller: { kind: 'host' } })).resolves.toEqual({
      ok: true, result: { actionId: 'action.spec.get', startedBy: 'user', source: 'daemon' },
    });
  });
});
