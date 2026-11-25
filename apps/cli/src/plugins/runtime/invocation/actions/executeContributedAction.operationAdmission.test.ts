import type { PluginActionsServiceSeed } from '../services/actions';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { expect, it } from 'vitest';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeContributedAction } from './executeContributedAction';

it('keeps CLI observation attached to the handler after a native child accepts approval', async () => {
  let seed: PluginActionsServiceSeed | undefined;
  let finish!: () => void;
  const effect = new Promise<void>(resolve => { finish = resolve; });
  const approval = { kind: 'approval_request_created' as const, artifactId: 'child-approval', actionId: 'scm.reviewWorkspace.materializePrepared' };
  const progress: unknown[] = [];
  const runtime = createExternalActionRuntime('global', 'acme.cli-operation', async () => {
    // The fixture's native effect publishes through the real invocation ports.
    seed!.finiteOperation!.operationOwnerUpdate.update({ progress: { phase: 'waiting_for_approval', label: 'Waiting for approval', approval } });
    seed!.finiteOperation!.operationAcceptance.accept(approval);
    await effect;
    throw new PluginError({ code: 'review_start_refused', message: 'Reviewer start was refused' });
  }, undefined, undefined, value => { seed = value; }, undefined, 'safe', undefined,
  { surfaces: ['cli'], operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } });
  const host = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home', resolveAccountId: async () => 'account' });
  const approvalContext = { surface: 'cli', runtimeAccountId: 'account', serverId: 'home',
    operationOwnerUpdate: { update: update => { progress.push(update); } } } satisfies ActionExecutorContext;
  let settled = false;
  const pending = executeContributedAction({ runtimeRegistry: runtime, actionId: 'acme.cli-operation/inspect', input: {},
    approvalContext, context: { ...approvalContext, observePluginExecution: host.observePluginExecution },
    actionsSettings: { v: 1, actions: {} } }).then(result => { settled = true; return result; });
  try {
    await expect.poll(() => progress.length > 0 || settled).toBe(true);
    expect(settled).toBe(false);
    expect(progress).toContainEqual({ progress: { phase: 'waiting_for_approval', label: 'Waiting for approval', approval } });
    finish();
    await expect(pending).resolves.toMatchObject({ matched: true, result: { ok: false, errorCode: 'review_start_refused' } });
  } finally { finish(); await pending; }
});

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
