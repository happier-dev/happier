import { expect, it } from 'vitest';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeContributedAction } from './executeContributedAction';

it.each(['agent', 'mcp'] as const)('observes a contributed %s operation through terminal settlement after admission', async surface => {
  let finish!: () => void;
  const effect = new Promise<void>(resolve => { finish = resolve; });
  const runtime = createExternalActionRuntime('global', 'acme.operation', async () => { await effect; },
    undefined, undefined, undefined, undefined, 'safe', undefined,
    { surfaces: [surface], operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } });
  const host = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home',
    resolveAccountId: async () => 'account', generateOperationId: () => 'contributed-operation' });
  const context = { surface, runtimeAccountId: 'account', serverId: 'home',
    observePluginExecution: host.observePluginExecution };
  try {
    expect(await executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.operation/inspect',
      input: {}, context, actionsSettings: { v: 1, actions: {} } }))
      .toMatchObject({ matched: true, result: { ok: true, result: {
        status: 'accepted', operationId: 'contributed-operation', machineId: 'machine',
      } } });
    finish();
    expect(await host.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'contributed-operation'))
      .toMatchObject({ state: 'succeeded', result: { surface } });
  } finally { finish(); }
});
