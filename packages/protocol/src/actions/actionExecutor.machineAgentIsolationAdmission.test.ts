import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { MachineAgentIsolationReadyPreviewV1Schema } from '../machines/agentIsolationV1.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

const actionId = 'machines.agentIsolation.set';
const input = { serverId: 'home', machineId: 'machine', enabled: true, expectedMetadataVersion: 1,
  expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-plan' };
const preview = MachineAgentIsolationReadyPreviewV1Schema.parse({ kind: 'ready', policy: input.expectedPolicy,
  metadataVersion: 1, status: { kind: 'disabled' }, plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0,
    requiresAdmin: true, planDigest: input.expectedPlanDigest } });
const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
  serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'change-isolation',
  externalActionTarget: { kind: 'machine', machineId: 'machine' } };

function createHarness(ask: boolean) {
  const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(async () => ({ artifactId: 'isolation-review' }));
  // Only the target-daemon transport and approval Artifact persistence are substituted.
  const machineAgentIsolationAction = vi.fn<NonNullable<ActionExecutorDeps['machineAgentIsolationAction']>>(async ({ actionId }) =>
    actionId === 'machines.agentIsolation.preview' ? preview
      : { kind: 'unchanged', metadataVersion: 1, status: { kind: 'disabled' } });
  return { executor: createActionExecutor({ approvalsCreate, machineAgentIsolationAction }), approvalsCreate,
    machineAgentIsolationAction, context: { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ask ? ['ui'] : [] } },
      approvalWaivedSurfaces: { [actionId]: ask ? [] : ['ui'] } }) } };
}

describe('Agent isolation Action admission', () => {
  it.each([true, false])('settles exact metadata conflicts before approval or a write (Ask=%s)', async ask => {
    const harness = createHarness(ask);
    for (const expectedMetadataVersion of [0, 2]) {
      expect(await harness.executor.execute(actionId, { ...input, expectedMetadataVersion }, harness.context))
        .toEqual({ ok: true, result: { kind: 'conflict', policy: preview.policy, metadataVersion: 1 } });
    }
    expect(harness.approvalsCreate).not.toHaveBeenCalled();
    expect(harness.machineAgentIsolationAction.mock.calls.map(([request]) => request.actionId))
      .toEqual(['machines.agentIsolation.preview', 'machines.agentIsolation.preview']);
  });

  it('still creates ordinary approval for a fresh changing request', async () => {
    const harness = createHarness(true);
    expect(await harness.executor.execute(actionId, input, harness.context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', actionId, artifactId: 'isolation-review' } });
    expect(harness.approvalsCreate).toHaveBeenCalledOnce();
    expect(harness.machineAgentIsolationAction.mock.calls.map(([request]) => request.actionId))
      .toEqual(['machines.agentIsolation.preview']);
  });

  it('spends a fresh waived admission without repeating its target preview', async () => {
    const harness = createHarness(false);
    const prepared = await harness.executor.prepare(actionId, input, harness.context);
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('Expected admitted isolation update');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: { kind: 'unchanged' } });
    expect(harness.approvalsCreate).not.toHaveBeenCalled();
    expect(harness.machineAgentIsolationAction.mock.calls.map(([request]) => request.actionId))
      .toEqual(['machines.agentIsolation.preview', 'machines.agentIsolation.set']);
  });

});
