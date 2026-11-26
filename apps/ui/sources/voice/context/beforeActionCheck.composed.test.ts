import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { UiActionDispatchResultV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { readActionAutomationExecutionMachineV1 } from '@happier-dev/protocol/actions/executor/actionSettlement';
import { projectVoiceApprovalGuidance } from '@/sync/ops/actions/voiceActionApprovalAuthority';
import { redactVoiceActionExecutionResultForProvider } from './redactVoiceToolResult';

const ACTION = 'connectedServices.authentication.beginConnect';
type ApprovalRequest = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'];

describe('Before-check Voice receipt composition', () => {
  it.each([true, false])('holds sign-in for a human override after a failed check (explicit Machine: %s)', async explicitMachine => {
    const runMachines: Array<string | undefined> = [];
    const approvals: ApprovalRequest[] = [];
    const effect = vi.fn(async () => ({ ok: true }));
    // Home's index, Run transport and approval persistence are the external
    // boundaries. Selection, failed-Run admission and Voice projection stay real.
    const port = createActionAutomationPortV1({
      accountId: 'actor',
      seed: async () => ({ v: 1, rows: [{
        automationId: 'guard', triggerId: 'before', triggerRevision: 1,
        workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'actor',
        actionIds: [ACTION], phase: 'before', mode: 'wait', onFailure: 'ask',
      }] }),
      start: async ({ context }) => {
        runMachines.push(readActionAutomationExecutionMachineV1(context));
        return { runs: [{ automationId: 'guard', triggerId: 'before', runId: 'failed-check' }], notices: [] };
      },
      settle: async () => {},
    });
    let stored: ApprovalRequest | null = null;
    const executor = createActionExecutor({
      actionAutomations: { ...port, wait: async () => ({ state: 'failed', errorCode: 'command_failed' }) },
      approvalsCreate: async ({ request }) => {
        stored = request;
        approvals.push(request);
        return { artifactId: 'human-override' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      connectedServiceAction: effect,
    });
    // defaultActionExecutor.resolveContext admits this ceiling when Voice's
    // canApproveRequests is off; the person must spend the override by tapping.
    const context: ActionExecutorContext = {
      surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'actor',
      actionRequestId: `voice-sign-in-${explicitMachine}`,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [ACTION]: ['voice'] } }),
    };
    try {
      const execution = await executor.execute(ACTION, {
        ...(explicitMachine ? { machineId: 'operand-machine' } : {}),
        service: { pluginId: 'example.accounts', localId: 'service' }, modeId: 'password',
      }, context);
      expect(runMachines).toEqual([explicitMachine ? 'operand-machine' : undefined]);
      expect(approvals).toHaveLength(1);
      expect(stored).toMatchObject({ status: 'open', automaticChecks: { phase: 'override' } });
      expect(effect).not.toHaveBeenCalled();
      const projected = projectVoiceApprovalGuidance(context, ACTION, execution);
      const toolName = getActionSpec(ACTION).bindings!.voiceClientToolName!;
      const voice = redactVoiceActionExecutionResultForProvider(toolName, projected, {
        shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: true,
      });
      expect(UiActionDispatchResultV1Schema.parse({ v: 1, execution: voice }).execution).toMatchObject({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'human-override', voiceApprovalGuidance: 'tap_required' },
      });
    } finally {
      port.dispose();
    }
  });
});
