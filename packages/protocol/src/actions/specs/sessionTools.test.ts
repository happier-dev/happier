import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';
import { UNKNOWN_ACTION_FAILURE_CAUSE_V1 } from '../actionExecutionResult.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';
import { listHappierToolAutoApprovedNamesV1 } from '../../tools/happierToolAutoApprovalV1.js';

describe('Session tool Actions', () => {
  it.each(['search', 'describe', 'call'] as const)('registers tools.%s as an approval-free Session operation', operation => {
    const spec = getActionSpec(`tools.${operation}`);
    expect(spec).toMatchObject({
      approval: { result: 'none' }, executionPlacement: 'session', safety: 'safe', sideEffectClass: 'read',
      bindings: { mcpToolName: `tools_${operation}` },
    });
    expect(listHappierToolAutoApprovedNamesV1()).toContain(spec.bindings?.mcpToolName);
  });

  it('carries the inner refusal through the executor without opening the outer output envelope', async () => {
    const outcome = { ok: false, errorCode: 'permission_denied', refusalCause: UNKNOWN_ACTION_FAILURE_CAUSE_V1 } as const;
    const spec = getActionSpec('tools.call');
    expect(spec.outputSchema.safeParse({ ...outcome, privateContext: 'sentinel' }).success).toBe(false);
    const executor = createActionExecutor({ sessionToolsCall: async () => outcome });
    await expect(executor.execute('tools.call', { source: 'happier', tool: 'lookup', args: {} }, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, defaultSessionId: 'session',
    })).resolves.toEqual({ ok: true, result: outcome });
  });

  it('asks once for the workflow change through the inner Action', async () => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => {
        requests.push(request);
        return { artifactId: 'approval' };
      },
      sessionToolsCall: async ({ source, tool, args }, context) => {
        if (source !== 'happier' || tool !== 'workflow.trigger.remove') return { ok: false, errorCode: 'unknown_tool' };
        const result = await executor.execute(tool, args, context);
        return result.ok
          ? { ok: true, result: result.result }
          : { ok: false, errorCode: result.errorCode, refusalCause: result.failureCause };
      },
    });

    await expect(executor.execute('tools.call', {
      source: 'happier',
      tool: 'workflow.trigger.remove',
      args: { automationId: 'automation', triggerId: 'trigger' },
    }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      defaultSessionId: 'session', defaultSessionMachineId: 'machine', serverId: 'server', actionRequestId: 'request',
    })).resolves.toEqual({
      ok: true, result: { ok: true, result: {
        kind: 'approval_request_created', artifactId: 'approval', actionId: 'workflow.trigger.remove',
      } },
    });
    expect(requests).toEqual([expect.objectContaining({ status: 'open', actionId: 'workflow.trigger.remove' })]);
  });
});
