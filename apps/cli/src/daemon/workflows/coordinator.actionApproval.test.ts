import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DiscussionInviteInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from './workflowCoordinator.testkit';
import { readWorkflowActionApprovalSettlement } from './actionApproval';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

describe('workflow built-in Action approval holds', () => {
  it.each([
    { placement: 'root', selected: undefined, native: false, waived: false, held: false },
    { placement: 'root', selected: 'builtin:apply-safe', native: false, waived: false, held: false },
    { placement: 'root', selected: 'builtin:full-trust', native: false, waived: false, held: true },
    { placement: 'nested', selected: 'builtin:full-trust', native: false, waived: false, held: true },
    { placement: 'nested', selected: null, native: false, waived: false, held: true },
    { placement: 'root', selected: null, native: true, waived: false, held: false },
    { placement: 'root', selected: null, native: false, waived: true, held: false },
  ] as const)('requires profile-control consent for an agent Workflow selection change ($placement, $selected, native=$native, waived=$waived)', async ({ placement, selected, native, waived, held }) => {
    let effects = 0;
    let approval: ApprovalRequestV2 | undefined;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      machinesList: async () => { effects++; return { items: [] }; },
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'selection-approval' }; },
      approvalsGet: async () => approval ?? null,
    });
    const store = createInMemoryWorkflowCoordinatorStore();
    const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
    const child = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: selected === undefined ? {} : { approvalProfileId: selected },
      blocks: [{ kind: 'action', id: 'list', actionId: 'machines.list', input: {} }] });
    const definition = placement === 'root' ? child : WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {},
      blocks: [{ kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: {} }] });
    const origin = { kind: 'direct' as const, originSessionId: 'origin',
      ...(native ? { authenticatedStarterV1: { requestRef: 'native-start', requester: { serverId: 'home', accountId: 'account' } } } : {}),
      actionRequestAttributionV1: { requestRef: 'request', requester: { serverId: 'home', accountId: 'account' },
        persona: { serverId: 'home', sessionId: 'origin' }, origin: null },
      actionPolicy: { authority: 'account_automation' as const, approvalProfileId: 'builtin:apply-safe' } };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
        readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }),
        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
    if (!accepted.ok) throw new Error(`selection_fixture_unavailable:${accepted.error.code}`);
    const coordinator = createTestWorkflowCoordinator({ store, executeStep: async () => { throw new Error('Action has no Agent step'); },
      resolveWorkspace: async () => ({ ok: true, workspace }), action: { executor,
        buildContext: async input => ({ ...buildWorkflowActionContext(input),
          serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account', defaultSessionId: 'origin',
          ...(waived ? { actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'session.approval_profile.set': ['agent'] } }) } : {}) }),
        observeRun: async () => { throw new Error('Listing has no execution Run'); } } });
    const result = await coordinator.run({ ...accepted.snapshot, runId: 'selection-run', originSessionId: 'origin' });
    expect(result).toMatchObject(held ? { state: 'paused', reason: 'approval_required' } : { state: 'succeeded' });
    expect(effects).toBe(held ? 0 : 1);
    expect(approval?.actionId).toBe(held ? 'machines.list' : undefined);
  });
  it.each([
    { defaultProfile: undefined, stepProfile: undefined, held: true },
    { defaultProfile: 'builtin:full-trust', stepProfile: undefined, held: false },
    { defaultProfile: 'builtin:full-trust', stepProfile: 'builtin:read-propose', held: true },
    { defaultProfile: 'builtin:read-propose', stepProfile: null, held: false },
  ])('routes a child Action through its frozen step/default/origin profile ($defaultProfile, $stepProfile)', async ({ defaultProfile, stepProfile, held }) => {
    let effects = 0;
    let approval: ApprovalRequestV2 | undefined;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      machinesList: async () => { effects++; return { items: [] }; },
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'profile-approval' }; },
      approvalsGet: async () => approval ?? null,
    });
    const store = createInMemoryWorkflowCoordinatorStore();
    const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
    const coordinator = createTestWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('Action has no Agent step'); },
      resolveWorkspace: async () => ({ ok: true, workspace }),
      action: { executor, buildContext: async input => ({ ...buildWorkflowActionContext(input),
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account', defaultSessionId: 'origin' }),
        observeRun: async () => { throw new Error('Listing has no execution Run'); } },
    });
    const result = await coordinator.run({ runId: 'profile-run',
      definition: { version: 1, inputs: [], defaults: defaultProfile === undefined ? {} : { approvalProfileId: defaultProfile },
        blocks: [{ kind: 'action', id: 'list', actionId: 'machines.list', input: {},
          ...(stepProfile === undefined ? {} : { execution: { approvalProfileId: stepProfile } }) }] },
      inputs: {}, executionTarget: { kind: 'session' }, originSessionId: 'origin',
      origin: { kind: 'direct', originSessionId: 'origin', authenticatedStarterV1: {
        requestRef: 'start-request', requester: { serverId: 'home', accountId: 'account' } },
        actionPolicy: { authority: 'account_automation', approvalProfileId: 'builtin:read-propose' } },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
    });
    expect(result).toMatchObject(held ? { state: 'paused', reason: 'approval_required' } : { state: 'succeeded' });
    expect(effects).toBe(held ? 0 : 1);
    expect(approval?.actionId).toBe(held ? 'machines.list' : undefined);
  });

  it.each(['artifact-echo', 'reservation-fields'] as const)(
    'binds the recorded invitation receipt without revalidating same-Account %s', async edited => {
      const launch = { executionTarget: { serverId: 'home', machineId: 'machine' },
        directory: { kind: 'path', path: '/repo' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
      const spec = getActionSpec('discussion.invite');
      const input = DiscussionInviteInputV1Schema.parse({ discussionId: 'discussion',
        participant: { kind: 'model', participantSlotId: 'slot', launch } });
      const result = spec.outputSchema!.parse({ discussionId: 'discussion', ownerAccountId: 'account',
        access: 'owner', grants: [], changed: true, modelParticipant: {
          participant: { kind: 'model', participantSlotId: 'slot' }, launch, sessionId: null,
          answerPolicy: 'when_addressed', createdAt: 1 } });
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'discussion.invite',
        actionArgs: edited === 'reservation-fields' ? { ...input, discussionId: 'edited-discussion' } : input,
        summary: 'Invite', approval: { flow: 'deferred', result: 'none' },
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'home',
          accountId: 'account', machineId: 'machine', actionId: 'discussion.invite', requestId: 'invitation-request',
          caller: { kind: 'workflowRun', runId: 'run', authorization: {
            principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
            discussionModelReservation: { discussionId: edited === 'reservation-fields' ? 'edited-discussion' : 'discussion',
              participantSlotId: edited === 'reservation-fields' ? 'edited-slot' : 'slot' } } },
        execution: { executedAtMs: 2, ok: true, result },
      });
      const reads: string[] = [];
      expect(await readWorkflowActionApprovalSettlement({ runId: 'run', execution: {
        kind: 'action', actionId: 'discussion.invite', actionRequestId: 'invitation-request', localInputId: 'invitation-input',
        input, output: { kind: 'approval_request_created', artifactId: 'invitation-approval', actionId: 'discussion.invite' },
      }, read: async artifactId => {
        reads.push(artifactId);
        return { ...(edited === 'artifact-echo' ? {} : { artifactId }), request };
      } })).toEqual(edited === 'artifact-echo' ? { kind: 'unresolved', code: 'approval_unavailable' }
        : { kind: 'completed', result });
      expect(reads).toEqual(['invitation-approval']);
    });

  it.each(['executed', 'rejected', 'outcome_unknown', 'failed_unknown', 'failed'] as const)('parks a built-in Ask receipt and observes its existing settlement (%s)', async settlement => {
    const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
    const leaf: WorkflowActionLeafV1 = { kind: 'action', id: 'trigger', actionId: 'workflow.trigger.add', input: {
      workflow: { kind: 'literal', value: 'builtin:review-and-converge' },
      project: { kind: 'literal', value: { machineId: workspace.machineId, directory: workspace.directory } },
      trigger: { kind: 'literal', value: { kind: 'schedule', enabled: true,
        schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'UTC' } } },
    } };
    let stored: ApprovalRequestV2 | undefined;
    let approvals = 0;
    let effects = 0;
    // Only the persistent Artifact and Workflow transport boundaries are replaced.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        approvals++;
        return { artifactId: 'trigger-approval' };
      },
      approvalsGet: async () => stored ?? null,
      workflowAction: async () => { effects++; throw new Error('Unconfirmed trigger must not execute'); },
    });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('Action must not spawn an Agent'); },
      resolveWorkspace: async () => ({ ok: true, workspace }),
      action: { executor, buildContext: async input => ({ ...buildWorkflowActionContext(input),
        serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account',
        defaultSessionId: 'origin', defaultSessionMachineId: workspace.machineId,
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        agentStartContext: { caller: { kind: 'originless', runId: input.runId, runDepth: input.workDepth },
          baseline: { machineId: workspace.machineId, directory: workspace.directory },
          ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: input.authorization.admittedPermissionCeiling },
        externalActionTarget: { kind: 'machine', machineId: workspace.machineId,
          project: { machineId: workspace.machineId, directory: workspace.directory } } }),
        observeRun: async () => { throw new Error('Trigger mutation has no execution Run'); } },
    });
    const input = { runId: 'builtin-approval-run',
      definition: { version: 1 as const, inputs: [], defaults: {}, blocks: [leaf] }, inputs: {},
      executionTarget: { kind: 'session' as const }, originSessionId: 'origin',
      origin: { kind: 'direct' as const, originSessionId: 'origin', authenticatedStarterV1: {
        requestRef: 'start-request', requester: { serverId: 'home', accountId: 'account' } } },
      authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } };
    expect(await coordinator.run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    const row = store.list().find(value => value.blockId === leaf.id);
    if (row?.execution?.kind !== 'action') throw new Error('Expected retained Action correspondence');
    expect(row).toMatchObject({ lifecycle: 'waiting_for_approval', execution: { kind: 'action',
      actionId: leaf.actionId, output: { kind: 'approval_request_created', artifactId: 'trigger-approval', actionId: leaf.actionId } } });
    expect(stored).toMatchObject({ status: 'open', actionId: leaf.actionId,
      executionOriginV1: { caller: { kind: 'workflowRun', runId: input.runId }, requestId: row.execution.actionRequestId } });
    expect(await coordinator.run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    expect(approvals).toBe(1);
    expect(effects).toBe(0);
    if (!stored) throw new Error('Expected the approval owner to create its request');
    const original = stored;
    // An unrelated Artifact body is not this retained invocation's settlement.
    stored = ApprovalRequestV2Schema.parse({ ...original, executionOriginV1: {
      ...original.executionOriginV1, requestId: 'different-invocation' } });
    expect(await coordinator.run(input)).toMatchObject({ state: 'paused', reason: 'approval_unavailable' });
    // Approval alone is not the completed effect.
    stored = ApprovalRequestV2Schema.parse({ ...original, status: 'approved', decision: {
      kind: 'approve', authority: 'present_user', decidedAtMs: Date.now() } });
    expect(await coordinator.run(input)).toMatchObject({ state: 'paused', reason: 'approval_required' });
    const output = WorkflowTriggerWriteResultV1Schema.parse({ set: {
      automationId: '11111111-1111-4111-8111-111111111111', revision: 1, enabled: false,
      health: 'available', triggers: [] } });
    // This is the persisted response from the separate approval execution owner,
    // not execution by the coordinator or evidence of a live confirmation replay.
    const uncertain = settlement === 'outcome_unknown' || settlement === 'failed_unknown';
    const failure = WorkflowActionFailureV1Schema.parse({ ok: false, errorCode: 'workflow_http_error',
      error: 'Receipt effect did not settle', details: { status: 503 },
      failureCause: { phase: 'workflow.trigger.write', errorClass: 'HttpStatusError', errorCode: 'database_transaction_timeout', httpStatus: 503 } });
    stored = ApprovalRequestV2Schema.parse(settlement === 'executed' ? { ...stored, status: 'executed',
      execution: { executedAtMs: Date.now(), ok: true, result: output } }
      : settlement === 'rejected' ? { ...original, status: 'rejected', decision: { kind: 'reject', authority: 'present_user', decidedAtMs: Date.now() } }
      : { ...stored, status: settlement === 'failed_unknown' ? 'failed' : settlement, execution: { executedAtMs: Date.now(),
        ...failure, ...(uncertain ? { errorCode: 'approval_execution_outcome_unknown',
          details: { reasonCode: 'approval_execution_outcome_unknown' } } : {}) } });
    const expected = settlement === 'executed' ? { lifecycle: 'completed', result: output }
      : settlement === 'rejected' ? { lifecycle: 'failed', reason: 'approval_rejected' }
      : uncertain ? { lifecycle: 'outcome_uncertain', reason: 'approval_execution_outcome_unknown' }
      : { lifecycle: 'failed', reason: 'workflow_http_error', result: { status: 503 },
        failureCause: { phase: 'workflow.trigger.write', errorClass: 'HttpStatusError', errorCode: 'database_transaction_timeout', httpStatus: 503 },
        reasonMessage: 'Receipt effect did not settle' };
    expect(await coordinator.run(input)).toMatchObject(settlement === 'executed'
      ? { state: 'succeeded' } : { state: uncertain ? 'outcome_uncertain' : 'interrupted', reason: expected.reason });
    expect(store.list().find(value => value.blockId === leaf.id)).toMatchObject(expected);
    if (uncertain) {
      expect(await coordinator.run(input)).toMatchObject({ state: 'outcome_uncertain' });
      expect(store.list().filter(value => value.blockId === leaf.id)).toHaveLength(1);
    }
    expect(approvals).toBe(1);
    expect(effects).toBe(0);
  });
});
