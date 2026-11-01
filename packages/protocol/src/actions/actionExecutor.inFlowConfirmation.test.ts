import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { computeActionInputApprovalDigestV1 } from './decisionAuthority.js';
const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'install', externalActionTarget: { kind: 'machine', machineId: 'machine' } };
describe('one in-flow confirmation for the requested operation', () => {
  it('prepares an unconfirmed review without creating custody, and running it still requires the ordinary Ask', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    let removed = 0;
    let approvals = 0;
    const observed: unknown[] = [];
    const executor = createActionExecutor({
      notificationConfigurationAction: async () => { removed++; return { channelId: input.channelId }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'ordinary-review' }; },
      // The external plugin observation port must not publish an unexecuted review as settlement.
      observeActionExecution: async event => { observed.push(event); },
    });
    const prepared = await executor.prepare(actionId, input,
      { ...context, externalActionTarget: undefined }, { reviewOnly: true });
    expect(prepared).toMatchObject({ kind: 'ready', operation: { actionId,
      inputDigest: computeActionInputApprovalDigestV1(actionId, input), summary: expect.any(String) } });
    expect(approvals).toBe(0);
    expect(removed).toBe(0);
    expect(observed).toEqual([]);
    if (prepared.kind !== 'ready') throw new Error('Expected non-authorizing prepared review');
    expect(await prepared.invocation.run()).toMatchObject({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'ordinary-review', actionId,
    } });
    expect(approvals).toBe(1);
    expect(removed).toBe(0);
    expect(observed).toEqual([]);
  });

  it('exposes the safe prepared operation summary and digest without dispatching it', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    let removed = 0;
    let approvals = 0;
    const executor = createActionExecutor({
      notificationConfigurationAction: async () => { removed++; return { channelId: input.channelId }; },
      approvalsCreate: async () => { approvals++; return { artifactId: 'unexpected-preparation-ask' }; },
    });
    const prepared = await executor.prepare(actionId, input, {
      ...context, externalActionTarget: undefined,
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId: context.actionRequestId, accountId: context.runtimeAccountId, serverId: context.serverId, target: null },
    }, { reviewOnly: true });
    expect(prepared).toMatchObject({ kind: 'ready', operation: { actionId,
      inputDigest: computeActionInputApprovalDigestV1(actionId, input), summary: expect.any(String) } });
    expect(removed).toBe(0);
    expect(approvals).toBe(0);
  });

  it('answers default Ask for an irreversible Voice operation after the host read-back without an approval Artifact', async () => {
    const actionId = 'notifications.webhooks.remove';
    const input = { channelId: 'spoken-webhook-removal' };
    expect(getActionSpec(actionId).irreversible).toBe(true);
    const removed: unknown[] = [];
    const createdApprovals: unknown[] = [];
    const executor = createActionExecutor({
      // The answering notification client and Artifact persistence are external
      // ports of this process-neutral admission owner; policy/review stay real.
      notificationConfigurationAction: async ({ input }) => {
        removed.push(input);
        return { channelId: 'spoken-webhook-removal' };
      },
      approvalsCreate: async ({ request }) => {
        createdApprovals.push(request);
        return { artifactId: 'unexpected-second-confirmation' };
      },
    });
    const requestId = 'spoken-transcript-turn:remove-webhook';
    // This owner consumes the exact completed host confirmation. Voice's
    // composed producer test must separately prove read-back precedes this call.
    expect(await executor.execute(actionId, input, {
      surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'owner', actionRequestId: requestId,
      presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        requestId, accountId: 'owner', serverId: 'home', target: null },
    })).toMatchObject({ ok: true, result: { channelId: 'spoken-webhook-removal' } });
    expect(removed).toEqual([input]);
    expect(createdApprovals).toEqual([]);
  });

});
