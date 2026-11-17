import { describe, expect, it } from 'vitest';

import { createDaemonPluginActionExecutor, createPluginActionExecutor, type PluginActionExecutionRequestOwner } from './createDaemonPluginActionExecutor';
import { createActionExecutor, type ActionCaller, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('createDaemonPluginActionExecutor', () => {
  it('retains a deliberately complete catalog when merging local and daemon discovery', async () => {
    const local = createActionExecutor(createUnavailableActionTransportDeps());
    const base = serializeActionSpec(getActionSpec('action.spec.search'), { includeOutputSchema: false });
    const remote = Array.from({ length: 201 }, (_, index) => ({
      ...base, id: `test.complete/actions/choice-${index}`, title: `Choice ${index}`,
    }));
    const executor = createDaemonPluginActionExecutor({
      base: local,
      executeInCurrentProcess: async (actionId, input, context) => ({ matched: true,
        result: await local.execute(actionId as Parameters<typeof local.execute>[0], input, context) }),
      // The daemon IPC boundary supplies its schema-valid external contribution catalog.
      requestPluginActionExecution: async () => ({ matched: true,
        result: { ok: true, result: { actionSpecs: remote } } }),
    });
    const result = await executor.execute('action.spec.search', { query: 'test.complete', limit: null }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.search'].parse(result.result).actionSpecs.map(row => row.id).sort())
      .toEqual(remote.map(row => row.id).sort());
  });

  it('refuses a plugin call without a bound local owner instead of reconstructing CLI authority', async () => {
    let transportRequests = 0;
    const executor = createDaemonPluginActionExecutor({
      base: { execute: async () => { throw new Error('Unexpected fallback'); } },
      requestPluginActionExecution: async () => {
        transportRequests++;
        return { matched: true, result: { ok: true, result: 'executed as a CLI caller' } };
      },
    });
    await expect(executor.execute('action.invoke', { action: { pluginId: 'acme.target', localId: 'read' }, input: {} }, {
      surface: 'plugin', authority: 'account_automation', actionCaller: { kind: 'plugin', pluginId: 'acme.caller' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_execution_placement_unavailable' });
    expect(transportRequests).toBe(0);
  });

  it('retains an opaque committed message reference through canonical CLI Action admission and daemon transport', async () => {
    const messageActionReference = { v: 1 as const, sessionId: 'session', messageId: 'message', observedRevision: 'revision' };
    const action = { pluginId: 'acme.source', localId: 'draft' };
    const transport = createDaemonPluginActionExecutor({
      base: { execute: async () => { throw new Error('Unexpected fallback'); } },
      requestPluginActionExecution: async request => {
        expect(request).toMatchObject({ actionId: 'action.invoke', surface: 'cli', input: { action, input: {}, messageActionReference } });
        return { matched: true, result: { ok: true, result: 'accepted' } };
      },
    });
    const executor = createActionExecutor({ invokeContributedAction: transport.invokeContributedAction } as unknown as ActionExecutorDeps);
    expect(await executor.execute('action.invoke', { action, input: {}, messageActionReference }, { surface: 'cli' }))
      .toEqual({ ok: true, result: 'accepted' });
  });
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
        actionId: request.actionId, startedBy: request.startedBy ?? null, source: 'daemon',
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
