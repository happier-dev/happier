import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { WorkflowBlockSchema, WorkflowIngressBlockSchema, WorkflowInsertBlockV1Schema } from '../workflows/workflowV1.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';

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

  it('fails closed when an externally admitted effect has no automation admission port', async () => {
    let effects = 0;
    const actionId = 'machines.command.run' as const;
    const input = { command: 'printf bypass' };
    const envelope = { v: 1 as const, requestId: 'external-command', target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admission', binding: {
      serverIdentityId: 'home', accountId: 'owner', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      machineId: 'machine', installationId: 'installation', actionId,
      requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const executor = createActionExecutor({ machineCommandRun: async () => { effects++; return { exitCode: 0, stdout: 'bypassed', stderr: '' }; } });
    const result = await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      bypassApprovals: true, actionRequestId: envelope.requestId, runtimeAccountId: 'owner', serverId: 'home',
      serverIdentityId: 'home', externalActionTarget: envelope.target, externalActionExecutionAuthorization: authorization });
    expect(result).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable', requestId: envelope.requestId });
    expect(effects).toBe(0);
  });
});
