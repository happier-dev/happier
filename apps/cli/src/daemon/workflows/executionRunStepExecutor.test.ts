import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, buildBackendTargetKeyV2, createActionExecutor, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { readExecutionRunWorkflowObservationSink, type ExecutionRunWorkflowObservationSink } from '@/agent/runtime/bridges/executionRun/executionRunWorkflowObservation';
import { deriveExecutionRunIdFromActionRequestId } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { ProjectSessionDefaultsContextSelectionV1Schema } from '@happier-dev/protocol/projects/projectSessionDefaultsSelectionV1';
import { ExecutionRunStartActionRequestSchema } from '@happier-dev/protocol/actions/specs/executionRuns';

import {
  projectWorkflowRetainedRuntimeSelectionV1,
  type WorkflowStepExecutionSelection,
  type WorkflowDefinitionV1,
} from '@happier-dev/protocol/workflows';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

import {  workflowInvocationKey, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON, WorkflowRuntimeInterruption, type WorkflowStepExecutor } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { buildWorkflowActionContext } from './workflowActionContext';
import { resolveApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createWorkflowProducerBinding } from './workflowScopeBinding';
import { createCoordinatorWorkspaceResolver } from './resolveWorkflowWorkspace';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';
import {
  createWorkflowDetachedExecutionRunStepExecutor,
  createWorkflowStepExecutorDispatcher,
  prepareWorkflowDetachedExecutionRunStep,
} from './executionRunStepExecutor';

const CLAUDE_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

const buildActionContext = () => ({
  surface: 'agent' as const,
  authority: 'account_automation' as const,
  callerPermissionMode: 'workspace_write',
  causalPermissionAuthority: {
    kind: 'admittedSessionInputV1' as const,
    admittedPermissionCeiling: 'workspace_write' as const,
  },
});

function isActionInput(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireActionInput(value: unknown): Record<string, unknown> {
  if (isActionInput(value)) return value;
  throw new Error('expected Action input object');
}

function completedRun(runId: string, localInputId: string, value: unknown) {
  return {
    run: {
      runId,
      callId: `call-${runId}`,
      sidechainId: `sidechain-${runId}`,
      intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'workspace_write',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      status: 'running',
      startedAtMs: 1,
      inputTurns: {
        occurrenceId: `occurrence-${runId}`,
        last: {
          turnId: `turn-${localInputId}`,
          inputIds: [localInputId],
          state: 'completed',
          result: { kind: typeof value === 'string' ? 'text' : 'json', value },
        },
      },
    },
  };
}

function activeRun(runId: string, localInputId: string) {
  const { run } = completedRun(runId, localInputId, 'unused');
  return {
    run: {
      ...run,
      inputTurns: {
        occurrenceId: `occurrence-${runId}`,
        current: { turnId: `turn-${localInputId}`, inputIds: [localInputId], state: 'active' },
      },
    },
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'workflow-1',
    step: {
      kind: 'step',
      id: 'implement',
      document: { text: 'Implement it', references: [], attachments: [] },
      input: [],
      result: { kind: 'json', schema: { type: 'object' } },
    },
    invocation: {
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'implement', scope: [] },
      blockKind: 'step',
      attempt: '0',
      logicalInvocationRecordId: 'invocation-1',
    },
    input: { text: 'Implement it', references: [], attachments: [], values: [] },
    executionTarget: { kind: 'detached_run' },
    execution: {
      agentTarget: CLAUDE_TARGET,
      permissionMode: 'safe-yolo',
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: buildBackendTargetKeyV2(CLAUDE_TARGET),
          providerConnectionId: null,
          modelId: 'sonnet',
        },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { effort: { value: 'high', updatedAt: 1 } },
      },
      capabilitySelection: { mcp: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['repo'],
        forceExcludeServerIds: [],
      } },
      connectedServices: { v: 2, bindingsByServiceId: {} },
      acpSessionModeId: 'plan',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'happier.agent.claude/claude',
        agent: { backendMode: 'acp' },
      },
      conversation: { kind: 'shared_run' },
    } satisfies WorkflowStepExecutionSelection,
    workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
    authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
    beforeInputAdmission: async () => {},
    producerBinding: createWorkflowProducerBinding({ runId: 'workflow-1', store: createInMemoryWorkflowCoordinatorStore(), frame: { blocks: [], scope: [] } }),
    onInputAccepted: vi.fn(async () => {}),
    ...overrides,
  } satisfies Parameters<WorkflowStepExecutor>[0];
}

describe('workflow detached Execution Run step executor', () => {
  it.each([
    { approvalProfileId: 'builtin:full-trust', decision: 'approve', fallback: false },
    { approvalProfileId: null, decision: 'approve', fallback: false },
    { approvalProfileId: null, decision: 'reject', fallback: false },
    { approvalProfileId: 'builtin:full-trust', decision: 'approve', fallback: true },
    { approvalProfileId: null, decision: 'unknown', fallback: false },
  ] as const)('retains native start approval and its returned Run identity ($approvalProfileId, $decision, fallback=$fallback)', async ({ approvalProfileId, decision, fallback }) => {
    let approvals = 0;
    let starts = 0;
    let approval: ApprovalRequestV2 | undefined;
    let localInputId = '';
    let createdRunId = '';
    const origin = { kind: 'direct' as const, originSessionId: 'origin',
      actionRequestAttributionV1: { requestRef: 'request', requester: { serverId: 'home', accountId: 'account-1' },
        persona: { serverId: 'home', sessionId: 'origin' }, origin: null },
      actionPolicy: { authority: 'account_automation' as const, approvalProfileId: fallback ? 'builtin:full-trust' : 'builtin:apply-safe' } };
    const params = baseParams({ origin, originSessionId: 'origin', execution: { agentTarget: CLAUDE_TARGET,
      permissionMode: 'default', approvalProfileId, conversation: { kind: fallback ? 'shared_run' : 'fresh' } } });
    const providerResumeIdentity = { kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const }, providerSessionId: 'vanished-provider' };
    const actionExecutor = createActionExecutor({
      approvalsCreate: async ({ request }) => { approvals++; approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'detached-profile-review' }; },
      approvalsGet: async () => approval ?? null,
      approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async (_sessionId, input, options) => {
        starts++; localInputId = String(input.localInputId);
        if (fallback) expect(input.resumeHandle).toEqual(providerResumeIdentity);
        createdRunId = deriveExecutionRunIdFromActionRequestId(String(options?.actionRequestId));
        return { runId: createdRunId, callId: 'call', sidechainId: 'side' };
      },
      detachedExecutionRunSend: async () => ({ ok: false, errorCode: 'execution_run_not_found', error: 'gone' }),
      executionRunGet: async (_sessionId, input) => {
        expect(input.runId).toBe(createdRunId);
        return completedRun(createdRunId, localInputId, { done: true });
      },
    });
    const execute = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext: execution => ({ ...buildWorkflowActionContext(execution),
        serverId: 'home', runtimeAccountId: 'account-1', defaultSessionId: 'origin',
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        ...(fallback ? { actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
          actions: { 'execution.run.start': { approvalRequiredSurfaces: ['agent'] } }, approvalWaivedSurfaces: { 'execution.run.send': ['agent'] } }) } : {}) }),
      resolveSharedRunConversation: async () => fallback ? { runId: 'vanished', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution), providerResumeIdentity } : null,
      resolveProducerConversation: async () => null });
    const store = createInMemoryWorkflowCoordinatorStore();
    const makeCoordinator = () => createWorkflowCoordinator({ store, executeStep: execute,
      resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });
    const input = { runId: params.runId, definition: { version: 1 as const, inputs: [], defaults: params.execution, blocks: [params.step] },
      inputs: {}, executionTarget: params.executionTarget, origin, originSessionId: 'origin', authorization: params.authorization };
    expect(await makeCoordinator().run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject({ lifecycle: 'waiting_for_approval',
      execution: { kind: 'action', actionId: 'execution.run.start', output: { kind: 'approval_request_created' } } });
    expect(approvals).toBe(1);
    expect(starts).toBe(0);
    expect(await makeCoordinator().run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    expect(approvals).toBe(1);
    if (decision === 'unknown') {
      if (!approval) throw new Error('Expected retained native start Approval');
      approval = ApprovalRequestV2Schema.parse({ ...approval, status: 'outcome_unknown',
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: Date.now() },
        execution: { executedAtMs: Date.now(), ok: false, effectAttempted: true,
          errorCode: 'approval_execution_outcome_unknown', error: 'Acknowledgement lost' } });
      expect(await makeCoordinator().run(input)).toMatchObject({ state: 'interrupted', reason: 'approval_execution_outcome_unknown' });
      expect(await makeCoordinator().run(input)).toMatchObject({ state: 'interrupted', reason: 'approval_execution_outcome_unknown' });
      expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject({ lifecycle: 'outcome_uncertain' });
      expect(approvals).toBe(1);
      expect(starts).toBe(0);
      return;
    }
    expect(await actionExecutor.execute('approval.request.decide', { artifactId: 'detached-profile-review', decision },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account-1',
        actionCaller: { kind: 'host' }, actionRequestId: 'decision' })).toMatchObject({ ok: true });
    expect(approval).toMatchObject(decision === 'approve' ? { status: 'executed', execution: { ok: true } } : { status: 'rejected' });
    expect(await makeCoordinator().run(input)).toMatchObject(decision === 'approve'
      ? { state: 'succeeded' } : { state: 'interrupted', reason: 'approval_rejected' });
    expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject(decision === 'approve'
      ? { lifecycle: 'completed', result: { done: true } } : { lifecycle: 'failed', reason: 'approval_rejected' });
    expect(starts).toBe(decision === 'approve' ? 1 : 0);
    if (fallback) expect(store.list().find(row => row.blockId === params.step.id)?.execution)
      .toMatchObject({ kind: 'detached_run', providerResumeIdentity });
    expect(approvals).toBe(1);
  });
  it.each([
    { approvalProfileId: 'builtin:full-trust', decision: 'approve' },
    { approvalProfileId: null, decision: 'approve' },
    { approvalProfileId: null, decision: 'reject' },
  ] as const)('retains a shared Run send approval across coordinator reclaim ($approvalProfileId, $decision)', async ({ approvalProfileId, decision }) => {
    let approvals = 0;
    let sends = 0;
    let starts = 0;
    let approval: ApprovalRequestV2 | undefined;
    let localInputId = '';
    const origin = { kind: 'direct' as const, originSessionId: 'origin',
      actionRequestAttributionV1: { requestRef: 'retained-request', requester: { serverId: 'home', accountId: 'account-1' },
        persona: { serverId: 'home', sessionId: 'origin' }, origin: null },
      actionPolicy: { authority: 'account_automation' as const, approvalProfileId: 'builtin:apply-safe' } };
    const params = baseParams({ origin, originSessionId: 'origin', execution: { agentTarget: CLAUDE_TARGET,
      permissionMode: 'default', approvalProfileId, conversation: { kind: 'shared_run' } } });
    const providerResumeIdentity = { kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const }, providerSessionId: 'retained-provider' };
    const actionExecutor = createActionExecutor({
      // Artifact persistence and native Run transport are the process boundaries.
      approvalsCreate: async ({ request }) => {
        approvals++; approval = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'retained-send-review' };
      },
      approvalsGet: async () => approval ?? null,
      approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async () => {
        starts++;
        return { runId: 'unexpected-new-run', callId: 'call', sidechainId: 'side' };
      },
      detachedExecutionRunSend: async (_sessionId, request) => {
        expect(request.runId).toBe('retained');
        sends++; localInputId = String(request.localInputId);
        return { ok: true };
      },
      executionRunGet: async (_sessionId, request) => {
        expect(request.runId).toBe('retained');
        return completedRun('retained', localInputId, { done: true });
      },
    });
    const execute = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext: execution => ({ ...buildWorkflowActionContext(execution),
        serverId: 'home', runtimeAccountId: 'account-1', defaultSessionId: 'origin',
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'execution.run.send': ['agent'] } }) }),
      resolveSharedRunConversation: async () => ({ runId: 'retained', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution), providerResumeIdentity }),
      resolveProducerConversation: async () => null });
    const store = createInMemoryWorkflowCoordinatorStore();
    const makeCoordinator = () => createWorkflowCoordinator({ store, executeStep: execute,
      resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });
    const input = { runId: params.runId, definition: { version: 1 as const, inputs: [], defaults: params.execution, blocks: [params.step] },
      inputs: {}, executionTarget: params.executionTarget, origin, originSessionId: 'origin', authorization: params.authorization };
    expect(await makeCoordinator().run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject({ lifecycle: 'waiting_for_approval',
      execution: { kind: 'action', actionId: 'execution.run.send', output: { kind: 'approval_request_created' } } });
    expect(sends).toBe(0);
    expect(starts).toBe(0);
    expect(await makeCoordinator().run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    expect(approvals).toBe(1);
    expect(await actionExecutor.execute('approval.request.decide', { artifactId: 'retained-send-review', decision },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account-1',
        actionCaller: { kind: 'host' }, actionRequestId: 'retained-decision' })).toMatchObject({ ok: true });
    expect(await makeCoordinator().run(input)).toMatchObject(decision === 'approve'
      ? { state: 'succeeded' } : { state: 'interrupted', reason: 'approval_rejected' });
    expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject(decision === 'approve'
      ? { lifecycle: 'completed', result: { done: true } } : { lifecycle: 'failed', reason: 'approval_rejected' });
    if (decision === 'approve') expect(store.list().find(row => row.blockId === params.step.id)?.execution)
      .toMatchObject({ kind: 'detached_run', runId: 'retained', providerResumeIdentity });
    expect(sends).toBe(decision === 'approve' ? 1 : 0);
    expect(starts).toBe(0);
    expect(approvals).toBe(1);
  });

  it.each(['builtin:full-trust', null] as const)('retains the accepted starter and step approval reference through detached Action admission (%s)', async approvalProfileId => {
    const origin = { kind: 'direct' as const, authenticatedStarterV1: {
      requestRef: 'starter', requester: { serverId: 'home', accountId: 'account-1' },
    }, actionPolicy: { authority: 'account_automation' as const, approvalProfileId: 'builtin:read-propose' } };
    const params = baseParams({ origin, execution: { agentTarget: CLAUDE_TARGET,
      permissionMode: 'default', approvalProfileId, conversation: { kind: 'fresh' } } });
    let localInputId = '';
    const requests: Array<ReturnType<typeof resolveApprovalRequesterConfirmationV1>> = [];
    // Native transport is the boundary. Its admission consumer uses the real
    // requester owner, rather than treating the daemon Account as the starter.
    const actionExecutor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async (_sessionId, request, options) => {
        expect(request).toHaveProperty('approvalProfileId', approvalProfileId);
        localInputId = String(request.localInputId);
        const requester = resolveApprovalRequesterConfirmationV1({ actionId: 'execution.run.start', input: request,
          required: false, context: { ...options, surface: 'agent', serverId: 'home', runtimeAccountId: 'account-1' } });
        requests.push(requester);
        if (!requester.ok) return { ...requester, code: requester.errorCode,
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } };
        return { runId: 'native', callId: 'call', sidechainId: 'side' };
      },
      executionRunGet: async () => completedRun('native', localInputId, { done: true }),
    });
    const execute = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext: execution => buildWorkflowActionContext(execution),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null });
    const result = await execute(params);
    expect(requests).toMatchObject([{ ok: true }]);
    expect(result).toMatchObject({ kind: 'completed', result: { done: true } });
  });

  it('settles a detached requester refusal as a visible typed failed step without re-polling', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const params = baseParams({ execution: { agentTarget: CLAUDE_TARGET, permissionMode: 'default',
      conversation: { kind: 'fresh' } } });
    let localInputId = '';
    let reads = 0;
    // Only native Run start/read transport is substituted. Action admission,
    // exact-turn observation and the Workflow failure writer stay real.
    const actionExecutor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async (_sessionId, request) => {
        localInputId = String(request.localInputId);
        return { runId: 'detached-requester-refusal', callId: 'call', sidechainId: 'sidechain' };
      },
      executionRunGet: async () => {
        reads++;
        const { run } = completedRun('detached-requester-refusal', localInputId, 'unused');
        return { run: { ...run, status: 'failed', error: { code: 'approval_requester_unavailable',
          message: 'The detached request has no bindable Session requester.' },
          inputTurns: { occurrenceId: run.inputTurns.occurrenceId, last: {
            turnId: `turn-${localInputId}`, inputIds: [localInputId], state: 'failed',
          } },
        } };
      },
    });
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext, resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });
    await expect(coordinator.run({ runId: params.runId,
      definition: { version: 1, inputs: [], defaults: params.execution, blocks: [params.step] },
      inputs: {}, executionTarget: { kind: 'detached_run' }, authorization: params.authorization,
    })).resolves.toEqual({ state: 'interrupted', reason: 'approval_requester_unavailable' });
    expect(store.list().find(row => row.blockId === params.step.id))
      .toMatchObject({ lifecycle: 'failed', reason: 'approval_requester_unavailable' });
    expect(reads).toBe(1);
  });

  it('retains the classified detached startup failure cause on the Workflow invocation', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const params = baseParams({ execution: { agentTarget: CLAUDE_TARGET, permissionMode: 'default',
      conversation: { kind: 'fresh' } } });
    const failureCause = { phase: 'execution.run.start', errorClass: 'Error',
      errorCode: 'ECONNRESET', httpStatus: null } as const;
    const executionRunGet = vi.fn(async () => completedRun('unexpected-run', 'unexpected-input', {}));
    const actionExecutor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async () => ({
        ok: false, errorCode: 'target_unavailable', error: 'Target unavailable', failureCause,
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      }),
      executionRunGet,
    });
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext, resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });
    await expect(coordinator.run({ runId: params.runId,
      definition: { version: 1, inputs: [], defaults: params.execution, blocks: [params.step] },
      inputs: {}, executionTarget: { kind: 'detached_run' }, authorization: params.authorization,
    })).resolves.toEqual({ state: 'interrupted', reason: 'target_unavailable' });
    expect(store.list().find(row => row.blockId === params.step.id))
      .toMatchObject({ lifecycle: 'failed', reason: 'target_unavailable', failureCause });
    expect(executionRunGet).not.toHaveBeenCalled();
  });

  it.each([1_794_340_800_000, null])('settles a detached refusal with quota attention and its reported reset (%s)', async resetAtMs => {
    const runtimeIssueV1 = {
      v: 1, scope: 'primary_session', status: 'failed', code: 'claude.usage_limit', source: 'usage_limit', occurredAt: 100,
      usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
    } as const;
    const store = createInMemoryWorkflowCoordinatorStore();
    const params = baseParams({ execution: { agentTarget: CLAUDE_TARGET, permissionMode: 'default',
      conversation: { kind: 'fresh' } } });
    let localInputId = '';
    let reads = 0;
    // Only the native Run transport is substituted; observation and step projection are real.
    const actionExecutor = createActionExecutor({
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      executionRunStart: async (_sessionId, request) => {
        localInputId = String(request.localInputId);
        return { runId: 'quota-child', callId: 'call', sidechainId: 'sidechain' };
      },
      executionRunGet: async () => {
        reads++;
        const { run } = completedRun('quota-child', localInputId, 'unused');
        return { run: { ...run, status: 'failed', error: { code: runtimeIssueV1.code,
          message: 'Weekly usage limit reached', runtimeIssueV1 },
          inputTurns: { occurrenceId: run.inputTurns.occurrenceId, last: {
            turnId: `turn-${localInputId}`, inputIds: [localInputId], state: 'failed',
          } },
        } };
      },
    });
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
      buildActionContext, resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });
    await expect(coordinator.run({ runId: params.runId,
      definition: { version: 1, inputs: [], defaults: params.execution, blocks: [params.step] },
      inputs: {}, executionTarget: { kind: 'detached_run' }, authorization: params.authorization,
    })).resolves.toEqual({ state: 'interrupted', reason: runtimeIssueV1.code });
    expect(store.list().find(row => row.blockId === params.step.id))
      .toMatchObject({ lifecycle: 'needs_attention', reason: runtimeIssueV1.code, runtimeIssueV1 });
    expect(reads).toBe(1);
  });

  it.each(['execution_run_target_unavailable', 'execution_run_protocol_unsupported'] as const)(
    'retains the typed prelaunch refusal %s through Action admission and Workflow persistence', async errorCode => {
      const store = createInMemoryWorkflowCoordinatorStore();
      const params = baseParams({ execution: { agentTarget: CLAUDE_TARGET, permissionMode: 'default',
        conversation: { kind: 'fresh' } } });
      const executionRunStart = vi.fn(async () => { throw new Error('refused target must not launch'); });
      // Exact-Machine capability discovery is a transport boundary. Keep the
      // Action executor, noRunCreated evidence and Workflow coordinator real.
      const actionExecutor = createActionExecutor({ executionRunStart,
        executionRunGet: async () => { throw new Error('refused target must not be read'); },
        executionRunCheckProtocolV2: async () => ({ ok: false, errorCode, error: errorCode }),
      } as unknown as ActionExecutorDeps);
      const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0,
        buildActionContext, resolveSharedRunConversation: async () => null,
        resolveProducerConversation: async () => null });
      const coordinator = createWorkflowCoordinator({ store, executeStep,
        resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }) });

      await expect(coordinator.run({ runId: params.runId,
        definition: { version: 1, inputs: [], defaults: params.execution, blocks: [params.step] },
        inputs: {}, executionTarget: { kind: 'detached_run' }, authorization: params.authorization,
      })).resolves.toEqual({ state: 'interrupted', reason: errorCode });
      const leaf = store.list().find(row => row.blockId === params.step.id);
      expect(leaf).toMatchObject({ lifecycle: 'failed', reason: errorCode });
      expect(leaf?.execution).toBeUndefined();
      await expect(executeStep(baseParams({ observationOnly: true }))).resolves.toEqual({
        kind: 'needs_attention', code: 'continuation_unavailable',
      });
      expect(executionRunStart).not.toHaveBeenCalled();
    },
  );

  it('holds the same Workflow invocation on native setup observation until its original Run accepts input', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const scm = createGitWorkflowWorkspaceTestDependencies();
    const location = await scm.inspectLocation({ candidatePath: process.cwd() });
    const params = baseParams({ execution: { agentTarget: CLAUDE_TARGET, permissionMode: 'default', conversation: { kind: 'fresh' } },
      workspace: { machineId: 'machine-1', directory: process.cwd(),
        checkoutRootPath: location?.inspection.rootPath ?? process.cwd() } });
    let release!: () => void;
    const consent = new Promise<void>(resolve => { release = resolve; });
    let localInputId = '';
    let starts = 0;
    const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      actionExecutor: { execute: async (actionId, value, context) => {
        if (actionId === 'execution.run.start') {
          starts++;
          localInputId = String(requireActionInput(value).localInputId);
          const sink = readExecutionRunWorkflowObservationSink(context?.executionRunWorkflowObservationSink);
          if (!sink) throw new Error('Missing production Workflow observation binding');
          await sink.commit({ kind: 'project_setup', runId: 'native', localInputId,
            operation: { version: 1, operationId: 'original-startup', revision: 2, actionId: 'execution.run.start',
              scope: { accountId: 'requester', machineId: 'machine-1' }, state: 'running', title: 'Run',
              cancellation: 'supported', createdAt: 1, startedAt: 1,
              setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
                reviewedEffect: { commands: [] } },
              domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home', machineId: 'machine-1',
                workspaceRefId: 'workspace', cwd: params.workspace.directory } } });
          await consent;
          await sink.commit({ kind: 'input_accepted', runId: 'native', localInputId, acceptedAtMs: Date.now() });
          return { ok: true, result: { runId: 'native', callId: 'call', sidechainId: 'side' } };
        }
        if (actionId === 'execution.run.get') return { ok: true, result: completedRun('native', localInputId, { done: true }) };
        throw new Error(`Unexpected Action ${actionId}`);
      } },
    });
    const coordinator = createWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: createCoordinatorWorkspaceResolver({ store, projectWorkspace: params.workspace,
        scm }) });
    const running = coordinator.run({ runId: params.runId, definition: { version: 1, inputs: [], defaults: params.execution,
      blocks: [params.step] }, inputs: {}, executionTarget: { kind: 'detached_run' }, authorization: params.authorization });
    void running.catch(() => undefined);
    try {
      await expect.poll(() => store.list().find(row => row.blockId === params.step.id)?.lifecycle).toBe('needs_attention');
      const held = store.list().find(row => row.blockId === params.step.id);
      expect(held).toMatchObject({ reason: 'project_setup_consent_required', attempt: 0,
        workspace: { descriptor: { machineId: 'machine-1' } }, execution: { kind: 'action',
          input: { runId: 'native' }, awaitedOperations: [{ operationId: 'original-startup', machineId: 'machine-1' }] } });
      expect(held?.review).toBeUndefined();
      release();
      await expect(running).resolves.toMatchObject({ state: 'succeeded' });
      expect(store.list().find(row => row.blockId === params.step.id)).toMatchObject({ recordId: held?.recordId,
        lifecycle: 'completed', execution: { kind: 'detached_run', runId: 'native', localInputId } });
      expect(starts).toBe(1);
    } finally { release(); await running; }
  });

  it('gives slow preparation the full observation budget after late native acceptance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      let sink: ExecutionRunWorkflowObservationSink | null;
      let localInputId = '';
      let enteredObservation!: () => void;
      const observing = new Promise<void>((resolve) => { enteredObservation = resolve; });
      const params = baseParams();
      const authored: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: params.execution,
        blocks: [{ ...params.step, timeoutMs: 500, result: { kind: 'text' } }] };
      const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0, buildActionContext,
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        actionExecutor: { execute: async (actionId, value, context) => {
          if (actionId === 'execution.run.start') {
            localInputId = String(requireActionInput(value).localInputId);
            sink = readExecutionRunWorkflowObservationSink(context?.executionRunWorkflowObservationSink);
            return { ok: true, result: { runId: 'native', callId: 'call', sidechainId: 'side' } };
          }
          if (actionId === 'execution.run.get') {
            enteredObservation();
            return await new Promise<{ ok: false; errorCode: 'cancelled'; error: string }>((resolve) => {
              const settle = () => resolve({ ok: false, errorCode: 'cancelled', error: 'observation ended' });
              if (context?.signal?.aborted) settle();
              else context?.signal?.addEventListener('abort', settle, { once: true });
            });
          }
          throw new Error(`unexpected ${actionId}`);
        } },
      });
      const coordinator = createWorkflowCoordinator({ store, executeStep,
        resolveWorkspace: async () => ({ ok: true, workspace: params.workspace }),
        prepareStep: async () => { await vi.advanceTimersByTimeAsync(8_000); return {}; },
      });
      let settled = false;
      const running = coordinator.run({ runId: params.runId, definition: authored, inputs: {},
        executionTarget: params.executionTarget, authorization: params.authorization });
      void running.then(() => { settled = true; });
      await observing;
      expect(store.list().find((row) => row.blockId === params.step.id)?.observationDeadline).toBeUndefined();
      await sink!.commit({ kind: 'input_accepted', runId: 'native', localInputId, acceptedAtMs: 9_000 });
      expect(store.list().find((row) => row.blockId === params.step.id)?.observationDeadline)
        .toEqual({ kind: 'at', expiresAt: new Date(9_500).toISOString() });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await running).state).toBe('interrupted');
      expect(store.list().find((row) => row.blockId === params.step.id)?.reason).toBe('workflow_step_timeout');
    } finally { vi.useRealTimers(); }
  });

  it('persists detached Generate acceptance and expires the same deadline across rejoin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    try {
      const store = createInMemoryWorkflowCoordinatorStore();
      const params = baseParams();
      const key = workflowInvocationKey({ runId: params.runId, blockId: params.step.id, scope: [], attempt: 0 });
      await store.ensureIntent({ key, recordId: 'held-row', runId: params.runId, blockKind: 'step', blockId: params.step.id,
        memberOrdinal: '0', path: { blockId: params.step.id, scope: [] }, attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
      await store.commitFact({ key, lifecycle: 'waiting_for_review', result: 'prior',
        observationDeadline: { kind: 'at', expiresAt: new Date(500).toISOString() },
        execution: { kind: 'detached_run', runId: 'native', localInputId: 'prior-input',
          runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution) },
        workspace: { descriptor: params.workspace },
        review: { decision: { kind: 'generate', requestedFromContentRevision: '0' } } });
      const actions: string[] = [];
      const executeStep = createWorkflowDetachedExecutionRunStepExecutor({ workDepth: 0, buildActionContext,
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        actionExecutor: { execute: async (actionId, value, context) => {
          actions.push(actionId);
          if (actionId === 'execution.run.send') {
            const sink = readExecutionRunWorkflowObservationSink(context?.executionRunWorkflowObservationSink);
            if (!sink) throw new Error('Expected workflow observation sink');
            await sink.commit({ kind: 'input_accepted', runId: 'native',
              localInputId: String(requireActionInput(value).localInputId), acceptedAtMs: 9_000 });
            return { ok: true, result: {} };
          }
          if (actionId === 'execution.run.get') throw new WorkflowRuntimeInterruption();
          throw new Error(`unexpected ${actionId}`);
        } },
      });
      const deps = { store, executeStep, resolveWorkspace: async () => ({ ok: true as const, workspace: params.workspace }) };
      const run = { runId: params.runId, definition: { version: 1 as const, inputs: [], defaults: params.execution,
        blocks: [{ ...params.step, timeoutMs: 500, pauseForReview: true, result: { kind: 'text' as const } }] },
        inputs: {}, executionTarget: params.executionTarget, authorization: params.authorization };
      await expect(createWorkflowCoordinator(deps).run(run)).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
      const generation = store.list().find((row) => row.blockId === params.step.id && row.attempt === 1)!;
      expect(generation.observationDeadline).toEqual({ kind: 'at', expiresAt: new Date(9_500).toISOString() });
      vi.setSystemTime(9_501);
      await createWorkflowCoordinator(deps).run(run);
      expect(actions).toEqual(['execution.run.send', 'execution.run.get']);
      expect(store.read(generation.key)).toMatchObject({ reason: 'workflow_step_timeout',
        observationDeadline: { kind: 'at', expiresAt: new Date(9_500).toISOString() } });
      expect(store.read(key)?.result).toBe('prior');
    } finally { vi.useRealTimers(); }
  });

  it('stops a late accepted native identity without the aborted signal even when reporting fails', async () => {
    const controller = new AbortController();
    const reportFailed = new Error('report_failed');
    const stops: string[] = [];
    let localInputId = '';
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      workDepth: 0, buildActionContext, resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      actionExecutor: { execute: async (actionId, value, context) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.start') {
          localInputId = String(input.localInputId);
          controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          return { ok: true, result: { runId: 'late-native', callId: 'call', sidechainId: 'side' } };
        }
        expect(context?.signal).toBeUndefined();
        if (actionId === 'execution.run.get') return { ok: true, result: stops.length === 0
          ? activeRun('late-native', localInputId) : completedRun('late-native', localInputId, 'done') };
        if (actionId === 'execution.run.stop') { stops.push(String(input.runId)); return { ok: true, result: {} }; }
        throw new Error(`unexpected ${actionId}`);
      } },
    });
    await expect(execute(baseParams({ signal: controller.signal, onInputAccepted: async () => { throw reportFailed; } })))
      .rejects.toBe(reportFailed);
    expect(stops).toEqual(['late-native']);
  });

  it('rechecks native resume-start admission after the send reports a missing retained run', async () => {
    let closed = false;
    const effects: string[] = [];
    const pauseWon = new Error('pause_won');
    const params = baseParams({
      execution: { ...baseParams().execution, profileId: 'profile' },
      beforeInputAdmission: async () => { if (closed) throw pauseWon; },
    });
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor: { execute: async (actionId) => {
        effects.push(actionId);
        if (actionId === 'execution.run.send') {
          closed = true;
          return { ok: false, errorCode: 'execution_run_not_found', error: 'gone' };
        }
        throw new Error('fallback must not start');
      } },
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => ({ runId: 'gone', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution),
        providerResumeIdentity: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude' }, providerSessionId: 'resume' },
      }),
      resolveProducerConversation: async () => null,
    });
    await expect(execute(params)).rejects.toBe(pauseWon);
    expect(effects).toEqual(['execution.run.send']);
  });

  it('fences native start after asynchronous conversation preparation', async () => {
    let closed = false;
    const effects: string[] = [];
    const pauseWon = new Error('pause_won');
    const params = baseParams({
      execution: { ...baseParams().execution, profileId: 'profile' },
      beforeInputAdmission: async () => { if (closed) throw pauseWon; },
    });
    const prepared = await prepareWorkflowDetachedExecutionRunStep({
      actionExecutor: { execute: vi.fn() }, workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
    }, params);
    closed = true;
    const gate = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor: { execute: async (actionId) => { effects.push(actionId); throw new Error('input must not start'); } },
      workDepth: 0, buildActionContext, resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
    });
    await expect(gate({ ...params, preparedStep: prepared })).rejects.toBe(pauseWon);
    expect(effects).toEqual([]);
  });
  it('same-conversation recovery preserves the previous native run and provider witness ahead of a shared decoy', async () => {
    const base = baseParams();
    const runtimeSelection = projectWorkflowRetainedRuntimeSelectionV1(base.execution);
    const providerResumeIdentity = {
      kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
      providerSessionId: 'provider-original',
    };
    const prepared = await prepareWorkflowDetachedExecutionRunStep({
      actionExecutor: { execute: vi.fn() }, workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => ({ runId: 'decoy', machineId: 'machine-1', directory: '/repo', runtimeSelection }),
      resolveProducerConversation: async () => null,
    }, {
      ...base,
      invocation: { ...base.invocation, recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
      recoveryPreviousExecution: { kind: 'detached_run', runId: 'original', localInputId: 'old-input', runtimeSelection, providerResumeIdentity },
      recoveryPreviousWorkspace: base.workspace,
    } as never);
    expect(prepared.retainedConversation).toMatchObject({ runId: 'original', providerResumeIdentity, directory: '/repo' });
  });

  it('observes a current admitted input before consulting fresh selection or unsupported launch configuration', async () => {
    const actions: string[] = [];
    const deps = {
      actionExecutor: { execute: async (actionId) => {
        actions.push(actionId);
        return { ok: true, result: completedRun('exact-native', 'exact-input', 'original-result') };
      } },
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    } satisfies Parameters<typeof createWorkflowDetachedExecutionRunStepExecutor>[0];
    const execute = createWorkflowDetachedExecutionRunStepExecutor(deps);
    const params = baseParams({
      invocation: { ...baseParams().invocation, execution: { kind: 'detached_run', runId: 'exact-native', localInputId: 'exact-input' } },
      execution: { ...baseParams().execution, conversation: { kind: 'fresh' }, terminal: { mode: 'integrated' } },
    });
    // Coordinator preparation is also on the rejoin path, before execution.
    await expect(prepareWorkflowDetachedExecutionRunStep(deps, params)).resolves.toMatchObject({ kind: 'workflow_detached_execution_run' });
    await expect(execute(params)).resolves.toMatchObject({ kind: 'completed', result: 'original-result' });
    expect(actions).toEqual(['execution.run.get']);
  });

  it('fresh-agent recovery ignores a prior native target and a shared pointer while preserving its workspace', async () => {
    const base = baseParams();
    const runtimeSelection = projectWorkflowRetainedRuntimeSelectionV1(base.execution);
    const resolveSharedRunConversation = vi.fn(async () => ({ runId: 'decoy', machineId: 'machine-1', directory: '/repo', runtimeSelection }));
    const prepared = await prepareWorkflowDetachedExecutionRunStep({
      actionExecutor: { execute: vi.fn() }, workDepth: 0, buildActionContext,
      resolveSharedRunConversation, resolveProducerConversation: async () => null,
    }, {
      ...base,
      invocation: { ...base.invocation, recovery: { conversation: 'fresh_agent', input: { kind: 'original' } } },
      recoveryPreviousExecution: { kind: 'detached_run', runId: 'original', localInputId: 'old-input', runtimeSelection },
      recoveryPreviousWorkspace: base.workspace,
    } as never);
    expect(prepared.retainedConversation).toBeNull();
    expect(resolveSharedRunConversation).not.toHaveBeenCalled();
  });

  it('rejects a broader step permission than the immutable Run ceiling before any native mutation', async () => {
    const actionExecutor = { execute: vi.fn() };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      execution: { ...baseParams().execution, permissionMode: 'safe-yolo' },
    }) as never)).resolves.toEqual({
      kind: 'failed', code: 'workflow_permission_escalation_denied',
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('uses the contextual default rather than widening an omitted step to the Run ceiling', async () => {
    let localInputId = '';
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.start') {
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { runId: 'run-native-1', callId: 'call-1', sidechainId: 'sidechain-1' } };
        }
        if (actionId === 'execution.run.get') {
          return { ok: true as const, result: completedRun('run-native-1', localInputId, 'done') };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });

    await expect(execute(baseParams({
      execution: { ...baseParams().execution, permissionMode: undefined },
      authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
    }) as never)).resolves.toMatchObject({ kind: 'completed' });
    expect(actionExecutor.execute.mock.calls[0]?.[1]).toMatchObject({ permissionMode: 'default' });
  });

  it.each(['shared_run', 'fresh'] as const)('starts a resumable %s native Agent Run with exact selections and commits correspondence before observation', async (conversation) => {
    const events: string[] = [];
    let localInputId = '';
    let accepted: Parameters<WorkflowStepExecutor>[0]['invocation']['execution'];
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.start') {
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { runId: 'run-native-1', callId: 'call-1', sidechainId: 'sidechain-1' } };
        }
        if (actionId === 'execution.run.get') {
          events.push('observe');
          return { ok: true as const, result: completedRun('run-native-1', localInputId, { changed: true }) };
        }
        if (actionId === 'execution.run.send') {
          expect(input.runId).toBe('run-native-1');
          expect(input.localInputId).not.toBe(localInputId);
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { ok: true } };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext: () => ({
        ...buildActionContext(),
        surface: 'ui',
        authority: 'present_user',
        actionCaller: { kind: 'host' },
      }),
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });
    const params = baseParams({
      execution: { ...baseParams().execution, conversation: { kind: conversation },
        allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' },
      onInputAccepted: async (correspondence: NonNullable<Parameters<WorkflowStepExecutor>[0]['invocation']['execution']>) => {
        accepted = correspondence;
        events.push('commit');
        localInputId = String((correspondence as { localInputId?: unknown }).localInputId);
        expect(correspondence).toEqual({
          kind: 'detached_run', runId: 'run-native-1', localInputId,
          runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(params.execution),
        });
      },
    });

    await expect(execute(params as never)).resolves.toEqual({
      kind: 'completed', result: { changed: true }, resultEncoding: 'typed',
    });
    expect(events).toEqual(['commit', 'observe']);
    expect(actionExecutor.execute).toHaveBeenNthCalledWith(1, 'execution.run.start', expect.objectContaining({
      sessionId: null,
      intent: 'agent',
      backendTarget: CLAUDE_TARGET,
      instructions: 'Implement it',
      cwd: '/repo',
      permissionMode: 'safe-yolo',
      allowedTools: ['mcp__wilson-brief__*'],
      unlistedTools: 'deny',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      localInputId,
      resultContract: { kind: 'json', schema: { type: 'object' } },
      modelId: 'sonnet',
      modelSelection: expect.objectContaining({ modelId: 'sonnet' }),
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1,
        overrides: { effort: { value: 'high', updatedAt: 1 } },
      },
      capabilitySelection: { mcp: expect.objectContaining({ forceIncludeServerIds: ['repo'] }) },
      connectedServices: { v: 2, bindingsByServiceId: {} },
      acpSessionModeId: 'plan',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'happier.agent.claude/claude',
        agent: { backendMode: 'acp' },
      },
    }), expect.objectContaining({
      surface: 'ui',
      agentStartWorkDepth: 1,
      authority: 'present_user',
      actionCaller: {
        kind: 'workflowRun',
        runId: 'workflow-1',
        authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      },
      executionRunTargetMachineId: 'machine-1',
    }));
    if (conversation === 'fresh') {
      await expect(execute(baseParams({
        execution: params.execution,
        invocation: { ...params.invocation, logicalInvocationRecordId: 'generation-1',
          recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
        recoveryPreviousExecution: accepted,
        recoveryPreviousWorkspace: params.workspace,
        onInputAccepted: params.onInputAccepted,
      }) as never)).resolves.toMatchObject({ kind: 'completed' });
      expect(actionExecutor.execute.mock.calls.filter(([id]) => id === 'execution.run.start')).toHaveLength(1);
      expect(actionExecutor.execute.mock.calls.filter(([id]) => id === 'execution.run.send')).toHaveLength(1);
    }
  });

  it.each([
    { retained: false, source: 'v1' },
    { retained: true, source: 'native' },
    { retained: false, source: 'account_provider_connection' },
    { retained: true, source: 'team_resource' },
  ] as const)('uses the portable Launch Profile and preserves $source selection with frozen input=$retained and qualified Project context', async ({ retained, source }) => {
    let localInputId = '';
    // Native daemon transport is the boundary; the Action executor remains real.
    const executionRunStart = vi.fn<NonNullable<ActionExecutorDeps['executionRunStart']>>(async (_sessionId, value: unknown) => {
      localInputId = String(requireActionInput(value).localInputId);
      return { runId: 'run-profile', callId: 'call-profile', sidechainId: 'sidechain-profile' };
    });
    const actionExecutor = createActionExecutor({ executionRunStart,
      executionRunGet: async () => completedRun('run-profile', localInputId, 'done'),
      executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine-1' }),
      // A second per-step admission would refuse: the accepted leaf does not ask
      // mutable caller policy to approve the same model again.
      resolveAgentStartContext: async () => null,
    } as unknown as ActionExecutorDeps);
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      buildActionContext: () => ({ ...buildActionContext(), sessionAgentSpawnPolicyV1: { v: 1, allowModelOverride: false },
        agentStartWorkspaceWrites: 'deny' }),
      workDepth: 2,
      resolveRoleInstructions: () => 'Frozen reviewer instructions',
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });

    const frozenText = 'Original role\n\n<happier_forge_evidence v="1">Original PR comment</happier_forge_evidence>';
    const projectContext = ProjectSessionDefaultsContextSelectionV1Schema.parse({
      projectRef: { serverId: 'project-home', projectKey: 'project-1' },
      sourceRef: { serverId: 'source-home', sourceId: 'source-1' },
    });
    const beforeInputAdmission = vi.fn(async (_renderedText?: string) => {});
    const legacyRef = baseParams().execution.modelSelection.ref;
    const { providerConnectionId: _providerConnectionId, ...nativeRef } = legacyRef;
    const teamRef = { ...nativeRef, resourceId: 'team-resource', teamId: 'team-1',
      expectedResourceRevision: 1, deliveryMode: 'brokered' as const };
    const modelSelection = source === 'v1' ? baseParams().execution.modelSelection
      : { v: 2, updatedAt: 1, ref: source === 'native' ? { ...nativeRef, source }
        : source === 'account_provider_connection' ? { ...nativeRef, source, providerConnectionId: 'provider-1' }
          : { ...teamRef, source } };
    const result = await execute(baseParams({
      execution: { ...baseParams().execution, modelSelection, profileId: 'launch-profile-1', projectContext },
      beforeInputAdmission,
      ...(retained ? { input: { ...baseParams().input, renderedText: frozenText } } : {}),
    }));
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'completed' });
    expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({
      projectContext,
      instructions: retained ? frozenText : expect.stringContaining('Frozen reviewer instructions'),
      ...(source === 'team_resource'
        ? { teamCredentialModel: { kind: 'team_credential_provider_model', ...teamRef } }
        : { modelSelection: { ...legacyRef, providerConnectionId: source === 'account_provider_connection' ? 'provider-1' : null } }),
      sessionConfigOptionOverrides: baseParams().execution.sessionConfigOptionOverrides,
    }), expect.objectContaining({ workDepth: 3, workspaceWrites: 'deny', exactMachineId: 'machine-1',
      actionCaller: { kind: 'workflowRun', runId: 'workflow-1', authorization: baseParams().authorization },
    }));
    const start = requireActionInput(executionRunStart.mock.calls[0]![1]);
    expect(beforeInputAdmission).toHaveBeenCalledWith(start.instructions);
    expect(start).not.toHaveProperty('profileId');
    expect(start).not.toHaveProperty('profileSourceCustody');
    if (source === 'v1') {
      // Malformed qualified context is refused at the same real Action boundary before native transport.
      const startInput = { ...start, sessionId: null };
      expect(ExecutionRunStartActionRequestSchema.safeParse(startInput).success).toBe(true);
      await expect(actionExecutor.execute('execution.run.start', {
        ...startInput,
        projectContext: { sourceRef: { sourceId: 'source-1' } },
      }, buildActionContext())).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    await expect(execute(baseParams({ authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } } })))
      .resolves.toMatchObject({ kind: 'failed', code: 'workflow_permission_escalation_denied' });
    expect(executionRunStart).toHaveBeenCalledOnce();
  });

  it('keeps omitted, explicit-null, and equal-default Run selections distinct at Action admission', async () => {
    const starts: Record<string, unknown>[] = [];
    const actionExecutor = { execute: vi.fn(async (actionId: string, value: unknown) => {
      const input = requireActionInput(value);
      if (actionId !== 'execution.run.start') throw new Error(`unexpected action ${actionId}`);
      starts.push(input);
      return {
        ok: false as const,
        errorCode: 'execution_run_failed',
        error: 'execution_run_failed',
        details: { runCreation: 'noRunCreated' },
      };
    }) };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });
    const authored = baseParams().execution;
    const { runtimeDescriptorV1: _runtimeDescriptorV1, ...withoutRuntimeDescriptor } = authored;

    await execute(baseParams({ execution: { ...authored, runtimeDescriptorV1: null } }) as never);
    await execute(baseParams({ execution: withoutRuntimeDescriptor }) as never);
    await execute(baseParams({ execution: { ...withoutRuntimeDescriptor, permissionMode: 'default' } }) as never);

    expect(starts[0]).toHaveProperty('runtimeDescriptorV1', null);
    expect(starts[1]).not.toHaveProperty('runtimeDescriptorV1');
    expect(starts[2]).toHaveProperty('permissionMode', 'default');
  });

  it('starts a background Run with the step\'s saved-secret bindings and launch Profile', async () => {
    const starts: Record<string, unknown>[] = [];
    const actionExecutor = { execute: vi.fn(async (actionId: string, value: unknown) => {
      if (actionId !== 'execution.run.start') throw new Error(`unexpected action ${actionId}`);
      starts.push(requireActionInput(value));
      return { ok: false as const, errorCode: 'execution_run_failed', error: 'execution_run_failed',
        details: { runCreation: 'noRunCreated' } };
    }) };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({ actionExecutor, workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null });
    const secretReferenceOverlay = { v: 1 as const, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } } };
    await execute(baseParams({ execution: { ...baseParams().execution, profileId: 'chosen-profile', secretReferenceOverlay } }) as never);
    expect(starts).toEqual([expect.objectContaining({ launchProfileId: 'chosen-profile', secretReferenceOverlay })]);
  });

  it('rejects Session-only launch fields that a detached Run cannot consume', async () => {
    const actionExecutor = { execute: vi.fn() };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });

    const cases = [
      { execution: { ...baseParams().execution, transcriptStorage: 'direct' } },
      { execution: { ...baseParams().execution, terminal: null } },
      { execution: { ...baseParams().execution, windowsRemoteSessionLaunchMode: null } },
      { execution: { ...baseParams().execution, windowsRemoteSessionConsole: null } },
      { execution: { ...baseParams().execution, windowsTerminalWindowName: null } },
      { execution: { ...baseParams().execution, title: 'Nightly review' } },
      { execution: { ...baseParams().execution, memoryEnabled: false } },
    ];
    for (const entry of cases) {
      await expect(execute(baseParams(entry) as never)).resolves.toEqual({
        kind: 'needs_attention', code: 'target_unavailable',
      });
    }
    await expect(execute(baseParams({ execution: { ...baseParams().execution,
      conversation: { kind: 'origin_session' },
    } }))).resolves.toEqual({ kind: 'needs_attention', code: 'workflow_conversation_unavailable' });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('carries saved Composer references and portable attachments into a fresh native Run input', async () => {
    const reference = {
      kind: 'happier.file', ref: 'file:src/index.ts', token: '@src/index.ts', label: 'index.ts',
    };
    const attachment = {
      v: 1 as const,
      instanceId: 'review-1',
      attachment: { pluginId: 'acme.review', localId: 'comment' },
      key: 'comment-1',
      value: { reviewId: 'r1' },
      presentation: { label: 'Review', typeLabel: 'Comment' },
    };
    let localInputId = '';
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.start') {
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { runId: 'run-native-1', callId: 'call-1', sidechainId: 'sidechain-1' } };
        }
        if (actionId === 'execution.run.get') {
          return { ok: true as const, result: completedRun('run-native-1', localInputId, 'done') };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });

    await expect(execute(baseParams({
      step: {
        ...baseParams().step,
        document: { text: 'Review @src/index.ts', references: [reference], attachments: [attachment] },
      },
      input: {
        text: 'Review @src/index.ts', references: [reference], attachments: [attachment], values: [],
      },
    }) as never)).resolves.toMatchObject({ kind: 'completed' });

    expect(actionExecutor.execute.mock.calls[0]?.[1]).toMatchObject({
      structuredInput: { v: 1, mentions: [reference], composerAttachments: [attachment] },
    });
  });

  it('reobserves durable detached correspondence without starting, resuming, or replaying input', async () => {
    const actionExecutor = {
      execute: vi.fn(async (actionId: string) => actionId === 'execution.run.get'
        ? { ok: true as const, result: completedRun('run-existing', 'input-existing', 'retained') }
        : (() => { throw new Error(`unexpected action ${actionId}`); })()),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0,
      buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });
    const params = baseParams({
      invocation: {
        ...baseParams().invocation,
        execution: {
          kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing',
        },
      },
    });

    await expect(execute(params as never)).resolves.toEqual({ kind: 'completed', result: 'retained', resultEncoding: 'typed' });
    expect(actionExecutor.execute).toHaveBeenCalledTimes(1);
    expect(actionExecutor.execute).toHaveBeenCalledWith(
      'execution.run.get',
      { sessionId: null, runId: 'run-existing', includeStructured: false, waitForInputId: 'input-existing' },
      expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }),
    );
  });

  it.each(['native backend', 'resume backend'] as const)('rejects a reclaimed resume witness with a foreign %s', async mismatch => {
    const providerResumeIdentity = { kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      providerSessionId: 'late-provider-session' };
    const response = completedRun('run-existing', 'input-existing', 'retained');
    const onExecutionObservation = vi.fn(async () => undefined);
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor: { execute: async () => ({ ok: true, result: { run: { ...response.run,
        backendTarget: { kind: 'builtInAgent', agentId: mismatch === 'native backend' ? 'codex' : 'claude' },
        resumeHandle: providerResumeIdentity,
      } } }) },
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
    });
    await expect(execute(baseParams({ onExecutionObservation, invocation: {
      ...baseParams().invocation,
      execution: { kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing' },
    } }) as never)).rejects.toThrow('workflow_invocation_fact_conflict');
    expect(onExecutionObservation).not.toHaveBeenCalled();
  });

  it('ends only Workflow observation at the authored deadline without stopping the active Run', async () => {
    vi.useFakeTimers();
    try {
      const actionExecutor = {
        execute: vi.fn(async (actionId: string, _input: unknown, context?: RpcActionExecutorContext) => {
          if (actionId !== 'execution.run.get') throw new Error(`unexpected action ${actionId}`);
          return await new Promise<{ ok: false; errorCode: 'cancelled'; error: string }>((resolve) => {
            const settle = () => resolve({ ok: false, errorCode: 'cancelled', error: 'observation ended' });
            if (context?.signal?.aborted) settle();
            else context?.signal?.addEventListener('abort', settle, { once: true });
          });
        }),
      };
      const execute = createWorkflowDetachedExecutionRunStepExecutor({
        actionExecutor,
        workDepth: 0, buildActionContext,
        resolveSharedRunConversation: vi.fn(),
        resolveProducerConversation: vi.fn(),
      });
      const params = baseParams({
        invocation: {
          ...baseParams().invocation,
          observationDeadline: { kind: 'at', expiresAt: new Date(Date.now() + 100).toISOString() },
          execution: {
            kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing',
          },
        },
      });

      const result = execute(params as never);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toEqual({ kind: 'needs_attention', code: 'workflow_step_timeout' });
      expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId)).toEqual(['execution.run.get']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues the shared retained Run with the next exact native input identity', async () => {
    let localInputId = '';
    const providerResumeIdentity = {
      kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
      providerSessionId: 'provider-session-1',
    };
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.send') {
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { ok: true } };
        }
        if (actionId === 'execution.run.get') {
          return { ok: true as const, result: completedRun('run-shared', localInputId, 'second turn') };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => ({
        runId: 'run-shared',
        machineId: 'machine-1',
        directory: 'C:\\Users\\Alice\\repo',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(baseParams().execution),
        providerResumeIdentity,
      }),
      resolveProducerConversation: async () => null,
    });
    const reference = {
      kind: 'happier.file', ref: 'file:src/index.ts', token: '@src/index.ts', label: 'index.ts',
    };
    const attachment = {
      v: 1 as const,
      instanceId: 'review-1',
      attachment: { pluginId: 'acme.review', localId: 'comment' },
      key: 'comment-1', value: { reviewId: 'r1' },
      presentation: { label: 'Review', typeLabel: 'Comment' },
    };
    const onInputAccepted = vi.fn(async () => undefined);
    const params = baseParams({
      onInputAccepted,
      workspace: {
        machineId: 'machine-1',
        directory: 'c:/users/alice/repo',
        checkoutRootPath: 'c:/users/alice/repo',
      },
      input: {
        text: 'Implement it', references: [reference], attachments: [attachment], values: [],
      },
    });

    await expect(execute(params as never)).resolves.toEqual({ kind: 'completed', result: 'second turn', resultEncoding: 'typed' });
    expect(actionExecutor.execute).toHaveBeenNthCalledWith(1, 'execution.run.send', {
      sessionId: null,
      runId: 'run-shared',
      message: 'Implement it',
      delivery: 'prompt',
      resume: true,
      localInputId,
      resultContract: { kind: 'json', schema: { type: 'object' } },
      structuredInput: { v: 1, mentions: [reference], composerAttachments: [attachment] },
    }, expect.anything());
    expect(onInputAccepted).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-shared',
      providerResumeIdentity,
    }));
  });

  it('resumes the provider conversation for only the next authored input when the retained host Run is gone', async () => {
    let localInputId = '';
    const providerResumeIdentity = {
      kind: 'provider_session.v1' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
      providerSessionId: 'provider-session-1',
    };
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.send') {
          return { ok: false as const, errorCode: 'execution_run_not_found', error: 'gone' };
        }
        if (actionId === 'execution.run.start') {
          localInputId = String(input.localInputId);
          return { ok: true as const, result: { runId: 'run-resumed', callId: 'call-2', sidechainId: 'side-2' } };
        }
        if (actionId === 'execution.run.get') {
          return { ok: true as const, result: completedRun('run-resumed', localInputId, 'resumed turn') };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => ({
        runId: 'run-old',
        machineId: 'machine-1',
        directory: '/repo',
        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(baseParams().execution),
        providerResumeIdentity,
      }),
      resolveProducerConversation: async () => null,
    });
    const onInputAccepted = vi.fn(async () => undefined);

    await expect(execute(baseParams({
      onInputAccepted,
      onExecutionObservation: vi.fn(async () => undefined),
    }) as never)).resolves.toEqual({
      kind: 'completed', result: 'resumed turn', resultEncoding: 'typed',
    });
    expect(actionExecutor.execute).toHaveBeenNthCalledWith(2, 'execution.run.start', expect.objectContaining({
      instructions: 'Implement it',
      localInputId,
      resumeHandle: providerResumeIdentity,
    }), expect.objectContaining({
      actionRequestId: `${localInputId}:execution-run-start`,
      executionRunWorkflowObservationSink: expect.any(Object),
    }));
    expect(onInputAccepted).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'detached_run',
      runId: 'run-resumed',
      providerResumeIdentity,
    }));
  });

  it('fails closed when a vanished retained Run has no matching provider resume identity', async () => {
    const actionExecutor = {
      execute: vi.fn(async (actionId: string) => {
        if (actionId === 'execution.run.send') {
          return { ok: false as const, errorCode: 'execution_run_not_found', error: 'gone' };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    for (const providerResumeIdentity of [
      undefined,
      {
        kind: 'provider_session.v1' as const,
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
        providerSessionId: 'other-provider-session',
      },
    ]) {
      const execute = createWorkflowDetachedExecutionRunStepExecutor({
        actionExecutor,
        workDepth: 0, buildActionContext,
        resolveSharedRunConversation: async () => ({
          runId: 'run-old', machineId: 'machine-1', directory: '/repo',
          runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(baseParams().execution),
          ...(providerResumeIdentity ? { providerResumeIdentity } : {}),
        }),
        resolveProducerConversation: async () => null,
      });

      await expect(execute(baseParams() as never)).resolves.toEqual({
        kind: 'needs_attention', code: 'continuation_unavailable',
      });
    }
    expect(actionExecutor.execute).toHaveBeenCalledTimes(2);
  });

  it('retains the coordinator-prepared exact Run without redirecting after workspace selection', async () => {
    let localInputId = '';
    let currentSharedRunId = 'run-before-gate';
    let dispatchedRunId = '';
    const resolveSharedRunConversation = async () => ({
      runId: currentSharedRunId, machineId: 'machine-1', directory: '/repo',
      runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(baseParams().execution),
    });
    const deps = {
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation,
      resolveProducerConversation: vi.fn(async () => null),
      actionExecutor: {
        execute: vi.fn(async (actionId: string, value: unknown) => {
          const input = requireActionInput(value);
          if (actionId === 'execution.run.send') {
            localInputId = String(input.localInputId);
            dispatchedRunId = String(input.runId);
            return { ok: true as const, result: { ok: true } };
          }
          if (actionId === 'execution.run.get') {
            return { ok: true as const, result: completedRun(dispatchedRunId, localInputId, 'done') };
          }
          throw new Error(`unexpected action ${actionId}`);
        }),
      },
    };
    const params = baseParams();
    const preparedStep = await prepareWorkflowDetachedExecutionRunStep(deps, params as never);
    // The coordinator already holds the owner gate while preparing. A later
    // callback answer cannot redirect this prepared input to another target.
    currentSharedRunId = 'run-after-gate';
    const execute = createWorkflowDetachedExecutionRunStepExecutor(deps);

    await expect(execute({ ...params, preparedStep } as never)).resolves.toMatchObject({
      kind: 'completed', result: 'done',
    });
    expect(dispatchedRunId).toBe('run-before-gate');
  });

  it('fails closed before retained Run reuse when its effective runtime witness is absent or changed', async () => {
    const actionExecutor = { execute: vi.fn() };
    const requested = baseParams().execution;
    for (const runtimeSelection of [
      undefined,
      projectWorkflowRetainedRuntimeSelectionV1({ ...requested, profileId: 'different-profile' }),
    ]) {
      const execute = createWorkflowDetachedExecutionRunStepExecutor({
        actionExecutor,
        workDepth: 0, buildActionContext,
        resolveSharedRunConversation: async () => ({
          runId: 'run-shared', machineId: 'machine-1', directory: '/repo',
          ...(runtimeSelection ? { runtimeSelection } : {}),
        }),
        resolveProducerConversation: async () => null,
      });

      await expect(execute(baseParams() as never)).resolves.toEqual({
        kind: 'needs_attention', code: 'workflow_conversation_unavailable',
      });
    }
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('does not equate a Windows home sibling prefix when retaining a detached conversation', async () => {
    const actionExecutor = { execute: vi.fn() };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor, workDepth: 0, buildActionContext,
      resolveSharedRunConversation: async () => ({
        runId: 'run-shared', machineId: 'machine-1', directory: 'C:\\Users\\Alice2\\repo',
      }),
      resolveProducerConversation: async () => null,
    });

    await expect(execute(baseParams({
      workspace: {
        machineId: 'machine-1', directory: 'c:/users/alice/repo',
        checkoutRootPath: 'c:/users/alice/repo',
      },
    }) as never)).resolves.toEqual({
      kind: 'needs_attention', code: 'workflow_conversation_unavailable',
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('settles cancellation through the canonical stop owner and reports uncertainty when stop custody is unknown', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown, context?: RpcActionExecutorContext) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.get') {
          controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          return { ok: true as const, result: activeRun('run-existing', 'input-existing') };
        }
        if (actionId === 'execution.run.stop') {
          expect(input).toEqual({ sessionId: null, runId: 'run-existing' });
          expect(context?.signal).toBeUndefined();
          return { ok: false as const, errorCode: 'execution_run_failed', error: 'custody unknown' };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });
    const params = baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: {
          kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing',
        },
      },
    });

    await expect(execute(params as never)).resolves.toEqual({
      kind: 'outcome_uncertain', code: 'execution_run_failed',
    });
    expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId))
      .toEqual(['execution.run.get', 'execution.run.stop', 'execution.run.get']);
  });

  it('does not treat successful host stop acceptance as provider-terminal cancellation', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, _input: unknown, context?: RpcActionExecutorContext) => {
        if (actionId === 'execution.run.get') {
          controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          // The host projection still reports the exact input active after
          // stop acceptance: no definitive fact, so custody stays unresolved.
          return { ok: true as const, result: activeRun('run-existing', 'input-existing') };
        }
        if (actionId === 'execution.run.stop') {
          expect(context?.signal).toBeUndefined();
          return { ok: true as const, result: { status: 'stopped' } };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: {
          kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing',
        },
      },
    }) as never)).resolves.toEqual({
      kind: 'outcome_uncertain', code: 'workflow_outcome_unresolved',
    });
    expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId))
      .toEqual(['execution.run.get', 'execution.run.stop', 'execution.run.get']);
  });

  it('records the host-cancelled exact input observed after stop instead of relabeling stop custody', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string, value: unknown, context?: RpcActionExecutorContext) => {
        const input = requireActionInput(value);
        if (actionId === 'execution.run.get' && controller.signal.aborted) {
          expect(input).toEqual({ sessionId: null, runId: 'run-existing', includeStructured: false });
          expect(context?.signal).toBeUndefined();
          return { ok: true as const, result: {
            run: {
              ...activeRun('run-existing', 'input-existing').run,
              status: 'cancelled',
              inputTurns: {
                occurrenceId: 'occurrence-run-existing',
                last: { turnId: 'turn-input-existing', inputIds: ['input-existing'], state: 'cancelled' },
              },
            },
          } };
        }
        if (actionId === 'execution.run.get') {
          controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          return { ok: false as const, errorCode: 'cancelled', error: 'observation aborted' };
        }
        if (actionId === 'execution.run.stop') return { ok: true as const, result: { status: 'stopped' } };
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: { kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing' },
      },
    }) as never)).resolves.toEqual({ kind: 'cancelled', code: 'execution_run_input_cancelled' });
    expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId))
      .toEqual(['execution.run.get', 'execution.run.stop', 'execution.run.get']);
  });

  it('reuses the exact completed result when cancellation loses the observation response of an already terminal turn', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string) => {
        if (actionId === 'execution.run.get' && controller.signal.aborted) {
          return { ok: true as const, result: completedRun('run-existing', 'input-existing', 'completed-before-stop') };
        }
        if (actionId === 'execution.run.get') {
          controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          return { ok: false as const, errorCode: 'cancelled', error: 'observation aborted' };
        }
        if (actionId === 'execution.run.stop') {
          return { ok: false as const, errorCode: 'execution_run_not_allowed', error: 'Not running' };
        }
        throw new Error(`unexpected action ${actionId}`);
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: { kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing' },
      },
    }) as never)).resolves.toEqual({
      kind: 'completed', result: 'completed-before-stop', resultEncoding: 'typed',
    });
    expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId))
      .toEqual(['execution.run.get', 'execution.run.stop', 'execution.run.get']);
  });

  it('leaves a surviving Run untouched when the claim is interrupted without a cancellation reason', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string) => {
        if (actionId !== 'execution.run.get') throw new Error(`unexpected action ${actionId}`);
        controller.abort();
        return { ok: false as const, errorCode: 'cancelled', error: 'observation aborted' };
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: { kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing' },
      },
    }) as never)).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(actionExecutor.execute.mock.calls.map(([actionId]) => actionId)).toEqual(['execution.run.get']);
  });

  it('keeps exact terminal input evidence when cancellation races the observation response', async () => {
    const controller = new AbortController();
    const actionExecutor = {
      execute: vi.fn(async (actionId: string) => {
        if (actionId !== 'execution.run.get') throw new Error(`unexpected action ${actionId}`);
        controller.abort();
        return {
          ok: true as const,
          result: completedRun('run-existing', 'input-existing', 'completed-before-stop'),
        };
      }),
    };
    const execute = createWorkflowDetachedExecutionRunStepExecutor({
      actionExecutor,
      workDepth: 0, buildActionContext,
      resolveSharedRunConversation: vi.fn(),
      resolveProducerConversation: vi.fn(),
    });

    await expect(execute(baseParams({
      signal: controller.signal,
      invocation: {
        ...baseParams().invocation,
        execution: {
          kind: 'detached_run', runId: 'run-existing', localInputId: 'input-existing',
        },
      },
    }) as never)).resolves.toEqual({
      kind: 'completed', result: 'completed-before-stop', resultEncoding: 'typed',
    });
    expect(actionExecutor.execute).toHaveBeenCalledOnce();
  });
});

describe('workflow step executor target dispatch', () => {
  it('selects one leaf only from the immutable Run execution target', async () => {
    const session = vi.fn(async () => ({ kind: 'completed' as const, result: 'session' }));
    const detachedRun = vi.fn(async () => ({ kind: 'completed' as const, result: 'detached' }));
    const execute = createWorkflowStepExecutorDispatcher({ session, detachedRun });
    const base = baseParams();

    await expect(execute({ ...base, executionTarget: { kind: 'session' }, execution: { agentTarget: CLAUDE_TARGET } } as never))
      .resolves.toMatchObject({ result: 'session' });
    await expect(execute({ ...base, executionTarget: { kind: 'detached_run' }, execution: { agentTarget: CLAUDE_TARGET } } as never))
      .resolves.toMatchObject({ result: 'detached' });
    expect(session).toHaveBeenCalledTimes(1);
    expect(detachedRun).toHaveBeenCalledTimes(1);
  });
});
