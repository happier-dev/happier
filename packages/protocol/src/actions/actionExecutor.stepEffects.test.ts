import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { WorkflowBlockSchema, WorkflowIngressBlockSchema, WorkflowInsertBlockV1Schema } from '../workflows/workflowV1.js';

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
    const calls: unknown[] = [];
    // Only the machine/network effect boundaries are replaced; Action admission stays real.
    const executor = createActionExecutor({
      webhookCall: async (input: unknown, context: unknown) => {
        calls.push({ input, context });
        return { ok: false, errorCode: 'webhook_failed', error: 'webhook_failed', details: { status: 302, body: 'moved' } };
      },
      machineCommandRun: async (input: unknown, context: unknown) => {
        calls.push({ input, context });
        return { exitCode: 0, stdout: '$(touch unwanted)', stderr: '' };
      },
    } as unknown as ActionExecutorDeps);
    // The effect is already host-approved; policy defaults are covered by the adjacent Action suite.
    const context = { surface: 'cli' as const, authority: 'present_user' as const, bypassApprovals: true,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine', project: { machineId: 'machine', directory: '/workspace' } },
      actionRequestId: 'run/step/0' };
    const command = { command: 'printf "%s" "$VALUE"', env: { VALUE: '$(touch unwanted)' } };
    expect(await executor.execute('machines.command.run', command, context)).toEqual({
      ok: true, result: { exitCode: 0, stdout: '$(touch unwanted)', stderr: '' },
    });
    expect(await executor.execute('webhooks.call', { url: 'https://example.test/hook', body: { value: 1 } }, context))
      .toEqual({ ok: false, errorCode: 'webhook_failed', error: 'webhook_failed', details: { status: 302, body: 'moved' } });
    expect(calls[0]).toEqual({ input: command, context });
  });
});
