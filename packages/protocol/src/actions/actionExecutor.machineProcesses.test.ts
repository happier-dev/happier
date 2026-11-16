import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { MachineProcessesAnswerV1 } from '../machines/processes/machineProcessesV1.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

const totals = { memoryBytes: 0, processCount: 0 };
const answer: MachineProcessesAnswerV1 = { v: 1, machineId: 'm', capturedAtMs: 1, state: 'live', platform: 'linux',
  evidenceModel: 'fenced', owners: [], leftBehind: [], totals: { happier: totals, leftBehind: totals } };
// These fixtures implement only the Machine transport and approval persistence
// boundaries exercised here; all Action admission, policy and validation are real.
const executorFor = (deps: Partial<ActionExecutorDeps>) => createActionExecutor(deps as ActionExecutorDeps);
describe('Machine Processes Action executor', () => {
  it('dispatches reads through the scoped Machine transport and refuses foreign Home targets', async () => {
    const requests: unknown[] = [];
    const executor = executorFor({ machineProcessesAction: async request => { requests.push(request); return answer; } });
    expect(await executor.execute('machines.processes.list', { machineId: 'm' }, { surface: 'cli', serverId: 'h' })).toEqual({ ok: true, result: answer });
    expect(await executor.execute('machines.processes.list', { machineId: 'm', serverId: 'other' }, { surface: 'cli', serverId: 'h' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toHaveLength(1);
    const invalid = executorFor({ machineProcessesAction: async () => ({ ...answer,
      notHappier: [{ appGroup: 'Editor', members: [{ name: 'Editor', appGroup: 'Editor', pid: 60, ref: 'r', memoryBytes: 2, command: 'secret' }] }] }) });
    expect(await invalid.execute('machines.processes.list', { machineId: 'm' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('honors a process-kill waiver without delegating approval to session or listener Actions', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.processes.kill': ['agent'] } });
    const input = { machineId: 'm', targets: [{ ref: 'r', expect: { level: 'proven', owner: { kind: 'session', sessionId: 's' } } }], tree: true };
    const result = { status: 'ended', outcomes: [{ ref: 'r', outcome: 'ended', freedBytes: 5 }] };
    const executor = executorFor({ machineProcessesAction: async () => result,
      readActionsSettings: (context) => (context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 })),
    });
    expect(await executor.execute('machines.processes.kill', input, { surface: 'agent', actionsSettings: settings }))
      .toEqual({ ok: true, result });
    expect(isApprovalRequiredByActionsSettings('session.stop', settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings('localServices.actions.terminateDetected', settings, { surface: 'agent' })).toBe(true);
  });

  it('creates the process Action approval and performs no effect when the deciding person rejects', async () => {
    let requested: ApprovalRequest | undefined;
    let reachedMachine = false;
    const executor = executorFor({
      machineProcessesAction: async () => { reachedMachine = true; return { status: 'ended', outcomes: [] }; },
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { requested = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => requested ?? null,
      approvalsUpdate: async ({ request }) => { requested = request; return { ok: true }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request }),
      readActionsSettings: (context) => (context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 })),
    });
    const input = { machineId: 'm', targets: [{ ref: 'r', expect: { level: 'proven', owner: { kind: 'session', sessionId: 's' } } }], tree: true };
    expect(await executor.execute('machines.processes.kill', input, {
      surface: 'agent', serverId: 'h', runtimeAccountId: 'a', actionRequestId: 'kill-request',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'reject' }, { surface: 'ui', authority: 'present_user', serverId: 'h' }))
      .toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(requested).toMatchObject({ actionId: 'machines.processes.kill', actionArgs: input });
    expect(reachedMachine).toBe(false);
  });

  it('preserves the existing launcher review response through canonical StartAgain output validation', async () => {
    const request = { machineId: 'm', targetId: 'managed:web', expectedEffectDigest: 'a'.repeat(64) };
    const response = { protocolVersion: 1, machineId: 'm', targetId: 'managed:web', status: 'denied', reasonCode: 'effect_review_required',
      reviewedEffect: { command: 'npm run web' }, reviewedEffectDigest: 'b'.repeat(64),
      snapshot: { v: 1, machineId: 'm', updatedAt: 1, targets: [] } };
    const result = { status: 'refused', reasonCode: 'effect_review_required', serviceStart: { request, response } };
    const executor = executorFor({ machineProcessesAction: async () => result });
    expect(await executor.execute('machines.processes.startAgain', { machineId: 'm', ref: 'opaque' }, { surface: 'cli' }))
      .toEqual({ ok: true, result });
    const forged = executorFor({ machineProcessesAction: async () => ({ ...result, serviceStart: { request, response: { ...response, command: 'unreviewed' } } }) });
    expect(await forged.execute('machines.processes.startAgain', { machineId: 'm', ref: 'opaque' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
});
