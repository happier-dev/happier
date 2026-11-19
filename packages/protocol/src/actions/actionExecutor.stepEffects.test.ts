import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { WorkflowBlockSchema, WorkflowIngressBlockSchema, WorkflowInsertBlockV1Schema } from '../workflows/workflowV1.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';
import { createActionAutomationPortV1 } from './executor/actionAutomationAdmission.js';

describe('workflow effect Actions', () => {
  it('exposes webhook and command effects through the same Action catalog used by MCP and workflow leaves', () => {
    for (const actionId of ['webhooks.call', 'machines.command.run'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, cli: true });
      expect(spec.bindings?.mcpToolName).toBeTruthy();
    }
  });

  it('keeps workflow command text literal while permitting bound environment values', () => {
    const block = {
        kind: 'action', id: 'command', actionId: 'machines.command.run',
        input: { command: { kind: 'input', name: 'untrusted' }, env: { kind: 'literal', value: { VALUE: 'literal' } } },
    };
    for (const schema of [WorkflowBlockSchema, WorkflowIngressBlockSchema, WorkflowInsertBlockV1Schema]) {
      expect(schema.safeParse(block).success).toBe(false);
      expect(schema.safeParse({ ...block, input: {
        command: { kind: 'literal', value: 'printf "%s" "$VALUE"' }, env: { kind: 'input', name: 'values' },
      } }).success).toBe(true);
    }
  });

  it('passes effect inputs unchanged to the host and retains typed failure output', async () => {
    const calls: { input: unknown; context: ActionExecutorContext }[] = [];
    // Only the machine/network effect boundaries are replaced; Action admission stays real.
    const executor = createActionExecutor({
      webhookCall: async (input, context) => {
        calls.push({ input, context });
        return { ok: false, errorCode: 'webhook_failed', error: 'webhook_failed', details: { status: 302, body: 'moved' } };
      },
      machineCommandRun: async (input, context) => {
        calls.push({ input, context });
        return { exitCode: 0, stdout: '$(touch unwanted)', stderr: '' };
      },
    } satisfies ActionExecutorDeps);
    // The effect is already host-approved; policy defaults are covered by the adjacent Action suite.
    const context = { surface: 'cli' as const, authority: 'present_user' as const, bypassApprovals: true,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine', project: { machineId: 'machine', directory: '/workspace' } },
      actionRequestId: 'run/step/0' };
    const command = { command: 'printf "%s" "$VALUE"', env: { VALUE: '$(touch unwanted)' } };
    expect(await executor.execute('machines.command.run', command, context)).toEqual({
      ok: true, result: { exitCode: 0, stdout: '$(touch unwanted)', stderr: '' },
    });
    expect(await executor.execute('webhooks.call', { url: 'https://example.test/hook', body: { value: 1 } }, context))
      .toEqual({ ok: false, errorCode: 'webhook_failed', error: 'webhook_failed', requestId: context.actionRequestId,
        details: { status: 302, body: 'moved' } });
    expect(calls[0]?.input).toEqual(command);
    expect(calls[0]?.context).toMatchObject(context);
    expect(calls[0]?.context).not.toHaveProperty('externalActionCredential');
    expect(calls[0]?.context).not.toHaveProperty('externalActionExecutionAuthorization');
  });

  it.each([
    { bindingActionId: 'machines.command.run', externalActionContinuation: true, withPort: false, expectedEffects: 1 },
    { bindingActionId: 'machines.command.run', externalActionContinuation: true, withPort: true, expectedEffects: 1 },
    { bindingActionId: 'execution.run.start', externalActionContinuation: true, withPort: false, expectedEffects: 0 },
    { bindingActionId: 'machines.command.run', externalActionContinuation: undefined, withPort: false, expectedEffects: 0 },
  ] as const)('requires automation admission with binding $bindingActionId, continuation $externalActionContinuation and port $withPort', async ({
    bindingActionId, externalActionContinuation, withPort, expectedEffects,
  }) => {
    let effects = 0;
    const actionId = 'machines.command.run' as const;
    const input = { command: 'printf bypass' };
    const envelope = { v: 1 as const, requestId: 'external-command', target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admission', binding: {
      serverIdentityId: 'home', accountId: 'owner', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      machineId: 'machine', installationId: 'installation', actionId: bindingActionId,
      requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    let selections = 0;
    const executor = createActionExecutor({
      machineCommandRun: async () => { effects++; return { exitCode: 0, stdout: 'bypassed', stderr: '' }; },
      ...(withPort ? { actionAutomations: {
        select: async () => { selections++; return { status: 'unavailable' as const, subjects: [], before: [], after: [], notices: [] }; },
        settle: async () => {},
      } } : {}),
    });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      bypassApprovals: true, actionRequestId: envelope.requestId, runtimeAccountId: 'owner', serverId: 'home',
      serverIdentityId: 'home', externalActionTarget: envelope.target, externalActionExecutionAuthorization: authorization,
      externalActionContinuation } as const;
    const result = await executor.execute(actionId, input, context);
    expect(result).toMatchObject(expectedEffects ? { ok: true } : { ok: false, errorCode: 'target_unavailable', requestId: envelope.requestId });
    expect(effects).toBe(expectedEffects);
    expect(selections).toBe(0);
  });

  it('starts Before checks once when a host-prepared execution continues the admitted invocation', async () => {
    const actionId = 'machines.command.run' as const;
    let starts = 0;
    let effects = 0;
    // The Home automation index and the Workflow start are external boundaries.
    const actionAutomations = createActionAutomationPortV1({ accountId: 'owner', seed: async () => ({ v: 1, rows: [
      { automationId: 'notify', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
        ownerAccountId: 'owner', actionIds: [actionId], phase: 'before', mode: 'notify' },
    ] }), start: async () => { starts++; return { runs: [], notices: [] }; }, settle: async () => {} });
    const executor = createActionExecutor({ actionAutomations,
      // A domain owner continues the admitted invocation through its own execution wrapper.
      prepareHostReviewedChildren: async () => ({ children: [], executeAdmittedAction: ({ context, execute }) => execute(context) }),
      machineCommandRun: async () => { effects++; return { exitCode: 0, stdout: 'ran', stderr: '' }; } });
    const result = await executor.execute(actionId, { command: 'printf once' }, { surface: 'cli', authority: 'present_user',
      actionCaller: { kind: 'host' }, bypassApprovals: true, actionRequestId: 'continued-once', runtimeAccountId: 'owner',
      serverId: 'home', defaultSessionMachineId: 'machine' });
    expect(result).toMatchObject({ ok: true });
    expect(effects).toBe(1);
    expect(starts).toBe(1);
  });

  it('fails closed when automatic admission reports an unavailable before check', async () => {
    let effects = 0;
    const actionId = 'machines.command.run' as const;
    const input = { command: 'printf bypass' };
    const envelope = { v: 1 as const, requestId: 'external-unavailable', target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admission', binding: {
      serverIdentityId: 'home', accountId: 'owner', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      machineId: 'machine', installationId: 'installation', actionId,
      requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const executor = createActionExecutor({ actionAutomations: {
      select: async () => ({ status: 'unavailable' as const, subjects: [], before: [], after: [], notices: [] }),
      settle: async () => {},
    }, machineCommandRun: async () => { effects++; return { exitCode: 0, stdout: 'bypassed', stderr: '' }; } });
    const result = await executor.execute(actionId, input, { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      bypassApprovals: true, actionRequestId: envelope.requestId, runtimeAccountId: 'owner', serverId: 'home',
      serverIdentityId: 'home', externalActionTarget: envelope.target, externalActionExecutionAuthorization: authorization });
    expect(result).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', requestId: envelope.requestId });
    expect(effects).toBe(0);
  });
});
