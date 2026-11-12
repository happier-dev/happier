import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ACTION_IDS } from './actionIds.js';
import { projectDeploymentPreparationAdmissionV1 } from './externalActionApi.js';
import { invokeHostReviewedChildV1 } from './executor/deploymentRoleChild.js';
import { isReviewedMachineSetupCodecV1 } from '../sessions/creation/sessionRequesterBootstrapV1.js';
import { prepareWorkflowApprovedOperation } from './executor/workflowRunActions.js';

const target = (machineId: string) => ({ homeId: 'home', machineId, scope: 'security', plan: {
  v: 1, basis: { kind: 'updates', machineId, scope: 'security' }, steps: [], nativeFacts: [], planDigest: 'a'.repeat(64),
} });
const input = { homeId: 'home', machineId: 'controller', batches: [[target('first')], [target('second')]],
  failurePolicy: 'fail_stop' };

describe('reviewed fleet updates', () => {
  it('reviews one exact fleet operand and dispatches it once', async () => {
    const id = ACTION_IDS.find(id => String(id) === 'machines.setup.updates.rollout');
    expect(id).toBeDefined();
    if (!id) return;
    let reviews = 0;
    const effects: unknown[] = [];
    const deps: ActionExecutorDeps & { machineSetupUpdatesRollout: (request: { input: unknown }) => Promise<unknown> } = {
      presentUserActionConfirmation: async () => { reviews++; return true; },
      machineSetupUpdatesRollout: async request => { effects.push(request.input); return { operationId: 'fleet', runId: 'run' }; },
    };
    const result = await createActionExecutor(deps).execute(id, input, { surface: 'ui', authority: 'present_user' });
    expect(result).toMatchObject({ ok: true, result: { operationId: 'fleet', runId: 'run' } });
    expect(reviews).toBe(1);
    expect(effects).toEqual([input]);
    expect(await createActionExecutor(deps).execute(id, { ...input, batches: [[target('first')], [target('first')]] },
      { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(effects).toHaveLength(1);
  });

  it('spends the exact admitted native child with zero further reviews', async () => {
    let reviews = 0;
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      presentUserActionConfirmation: async () => { reviews++; return true; },
      machineSetupUpdatesApply: async request => { effects.push(request.input); return { operationId: 'native' }; },
    });
    const child = target('first');
    const result = await invokeHostReviewedChildV1({
      parent: { actionId: 'machines.setup.updates.rollout', input },
      child: { action: 'machines.setup.updates.apply', role: 'update-0-0', input: child },
      context: { surface: 'agent', authority: 'present_user', runtimeAccountId: 'person' },
      admittedReview: { action: 'machines.setup.updates.apply', role: 'update-0-0', surface: 'agent' },
      execute: async (input, context) => executor.execute('machines.setup.updates.apply', input, context),
    });
    expect(result).toMatchObject({ ok: true, result: { operationId: 'native' } });
    expect(effects).toEqual([child]);
    expect(reviews).toBe(0);
  });

  it('lends native updates only the invocation codec while a scheduled rollout keeps Account custody', () => {
    const workflowActionOrigin = { runId: 'run', requestId: 'request' };
    expect(isReviewedMachineSetupCodecV1({ actionId: 'machines.setup.updates.apply', workflowActionOrigin })).toBe(true);
    expect(isReviewedMachineSetupCodecV1({ actionId: 'machines.reboot', workflowActionOrigin })).toBe(true);
    expect(isReviewedMachineSetupCodecV1({ actionId: 'machines.setup.updates.rollout', workflowActionOrigin })).toBe(false);
  });

  it('projects all exact targets through the incumbent batch Manage admission', () => {
    expect(projectDeploymentPreparationAdmissionV1('machines.setup.updates.rollout', input))
      .toEqual({ operation: 'setup', machineTargets: ['first', 'second'], deployments: [] });
  });

  it.each([
    { actionId: 'machines.setup.apply' as const, child: { homeId: 'home', machineId: 'host', targets: [{ homeId: 'home', machineId: 'target',
      desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], recipePlans: [] }] } },
    { actionId: 'machines.setup.updates.rollout' as const, child: input },
  ].flatMap(test => [true, false].map(policyAdmitted => ({ ...test, policyAdmitted }))))(
    'requires exact admitted $actionId custody before producing saved consent (policy=$policyAdmitted)', async ({ actionId, child, policyAdmitted }) => {
    const parent = { actionId: 'workflow.trigger.add', input: {} };
    const retained = await invokeHostReviewedChildV1({ parent,
      child: { action: actionId, role: 'scheduled-rollout', input: child },
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'person', actionRequestId: 'scheduled-invocation' },
      ...(policyAdmitted ? { admittedReview: { action: actionId, role: 'scheduled-rollout', surface: 'agent' as const } } : {}),
      ...{ approvedBy: { accountId: 'person' } },
      execute: async (_input, context) => {
        const approve = (input: typeof child) => prepareWorkflowApprovedOperation({
          parent: { actionId, input },
          steps: [{ actionId, input: child }], context,
        });
        await expect(approve({ ...child, machineId: 'changed' })).rejects.toMatchObject({ code: 'approval_required' });
        await expect(prepareWorkflowApprovedOperation({ parent: { actionId, input: child },
          steps: [{ actionId, input: child }], context: { ...context, runtimeAccountId: 'another-person' },
        })).rejects.toMatchObject({ code: 'approval_required' });
        await expect(prepareWorkflowApprovedOperation({ parent: { actionId, input: child },
          steps: [{ actionId, input: child }], context: { ...context, actionRequestId: 'another-request' },
        })).rejects.toMatchObject({ code: 'approval_required' });
        await expect(prepareWorkflowApprovedOperation({ parent: { actionId, input: child },
          steps: [{ actionId, input: child }], context: structuredClone(context),
        })).rejects.toMatchObject({ code: 'approval_required' });
        if (!policyAdmitted) {
          await expect(approve(child)).rejects.toMatchObject({ code: 'approval_required' });
          return null;
        }
        return approve(child);
      },
    });
    if (policyAdmitted) expect(retained).toMatchObject({ approvedBy: { accountId: 'person' }, parent: { actionId, input: child } });
    else expect(retained).toBeNull();
  });
});
