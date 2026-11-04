import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionDetail, AutomationDefinitionReconcileRequest } from '../../automations/automationApiV3.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import type { AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { createAccountWorkflowTriggerActions } from './workflowTriggerAccountHost.js';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionExecutorContext } from './types.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../../approvals/approvalRequestTransition.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { WorkflowTriggerListResultV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { WorkflowTriggerListRequestV1Schema, WorkflowTriggerUpdateRequestV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
  AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../automations/automationTemplateV02.testFixtures.js';

const plain: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
const encrypted: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
  material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };

function fixture(templateCiphertext: string, encryption = plain, targetType: AutomationDefinitionDetail['targetType'] = 'newSession') {
  let row: AutomationDefinitionDetail = { id: 'legacy-one', name: 'Release review', description: null, enabled: true,
    targetType, existingSessionId: null, templateVersion: 3, templateCiphertext,
    workflowDefinitionId: null, scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-one', enabled: true, priority: 2, updatedAt: 1 }],
    triggers: [{ id: AutomationTriggerIdSchema.parse('schedule-one'), kind: 'schedule', enabled: true, revision: 2,
      schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
      createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null }] };
  let writes = 0;
  let written: AutomationDefinitionReconcileRequest | null = null;
  // Automation HTTP persistence is a system boundary; the real trigger/codec owners run beneath it.
  const params = { resolveEncryption: async () => encryption, randomBytes: (length: number) => new Uint8Array(length).fill(1),
    resolveSession: async () => ({ project: { machineId: 'machine-one', directory: '/repo' }, nativeGoalOwner: null,
      executionSelection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }),
    newId: () => 'unused', resolveWorkflow: async () => { throw new Error('No Artifact is read for legacy rows'); },
    automations: { get: async () => row, list: async () => ({ automations: [row], nextCursor: null }),
      listDetails: async () => ({ automations: [row], nextCursor: null }),
      create: async () => { throw new Error('No Automation is created'); }, delete: async () => ({ ok: true as const }),
      reconcile: async (_id: string, input: AutomationDefinitionReconcileRequest) => {
        if (input.expectedTemplateVersion !== row.templateVersion) throw Object.assign(new Error('conflict'), { code: 'currentness_conflict' });
        writes++;
        written = input;
        const { templateCiphertext: _old, ...retained } = row;
        row = { ...(input.executionRecipe === undefined ? row : { ...retained, targetType: null, executionRecipe: input.executionRecipe }),
          templateVersion: row.templateVersion + 1, triggers: row.triggers.map((trigger) => {
            const change = input.triggers.find((item) => item.kind === 'existing' && item.triggerId === trigger.id);
            return { ...trigger, enabled: change?.kind === 'existing' ? change.enabled ?? trigger.enabled : trigger.enabled };
          }).filter((trigger) => !input.removedTriggers.some((removed) => removed.triggerId === trigger.id)),
          enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? row.workflowDefinitionId };
        if (row.executionRecipe) row.executionRecipe = { ...row.executionRecipe, templateVersion: row.templateVersion };
        return row;
      } } };
  return { params, row: () => row, writes: () => writes, written: () => written };
}

it('marks an unrelated retained definition as indexed in the same recipe conversion write', async () => {
  const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
  const host = createAccountWorkflowTriggerActions(f.params);
  await host.list({ scope: 'account_all' });
  expect(f.writes()).toBe(1);
  expect(f.written()?.executionRecipe).toHaveProperty('managedTarget', null);
});

it('withdraws a census if Account encryption changes before final private disclosure', async () => {
  const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
  let reads = 0;
  const host = createAccountWorkflowTriggerActions({ ...f.params,
    resolveEncryption: async () => ++reads === 1 ? plain : encrypted,
  });
  await expect(host.list({ scope: 'account_all' })).rejects.toMatchObject({ code: 'content_unavailable' });
  expect(reads).toBe(2);
  // A later authority change does not deny the already committed legacy conversion.
  expect(f.writes()).toBe(1);
});

async function conversionApprovalFixture(surface: 'agent' | 'mcp' | 'cli' = 'mcp') {
  const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
  f.row().enabled = false;
  const observations: ActionExecutorContext[] = [];
  const agentStartContext = {
    caller: { kind: 'session' as const, sessionId: 'session-old', starterDepth: 0, turnDepth: 0 },
    baseline: { machineId: 'machine-one', directory: '/repo', configuration: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    } },
    ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' as const,
  };
  const host = createAccountWorkflowTriggerActions({ ...f.params,
    resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
      material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    resolveSession: async (_sessionId, caller) => {
      if (caller) observations.push(caller);
      return f.params.resolveSession();
    },
    resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
  });
  const human = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-one',
    presentUserConfirmation: { actionId: 'workflow.trigger.update' } } as const;
  const { sets } = await host.list({ automationId: 'legacy-one', review: true }, human);
  const input = WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
    confirmLegacyConversion: true, patch: { target: sets[0]!.target, project: sets[0]!.project, enabled: true } });
  const definitions = createWorkflowDefinitionActions({ artifactStore: {
    list: async () => ({ items: [] }), read: async () => null,
    create: async () => { throw new Error('Unexpected definition write'); },
    update: async () => { throw new Error('Unexpected definition write'); }, delete: async () => ({ ok: true }),
  }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: async () => undefined });
  let request: ApprovalRequest | null = null;
  let settings = ActionsSettingsV1Schema.parse({ v: 1 });
  // Approval Artifact persistence and authenticated Session metadata are system boundaries.
  // The real executor, approval transitions, materializer, crypto and trigger owner run beneath them.
  const reloadExecutor = () => createActionExecutor({
    workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, triggers: host,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } } }),
    approvalsCreate: async ({ request: created }) => {
      request = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(created)));
      return { artifactId: 'conversion-approval' };
    },
    approvalsGet: async () => request,
    approvalsUpdate: async ({ request: next }) => {
      const parsed = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(next)));
      if (!request) throw new Error('Missing approval');
      const transition = decideApprovalRequestTransition(request, parsed);
      if (transition.ok) request = parsed;
      return transition;
    },
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home-one',
    resolveAgentStartContext: async () => agentStartContext,
    isActionApprovalRequired: (actionId, context, actionInput) =>
      isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, actionInput),
    observeActionExecution: async ({ context }) => { observations.push(context); },
  });
  const context: ActionExecutorContext = { surface, authority: 'account_automation', serverId: 'home-one',
    actionRequestId: 'conversion-request', actionsSettings: settings, defaultSessionMachineId: 'machine-one',
    ...(surface === 'agent' ? { actionCaller: agentStartContext.caller, defaultSessionId: 'session-old',
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, agentStartContext,
      approvalOrigin: { kind: 'transcript_tool_call' as const, sessionId: 'session-old', toolCallId: 'convert-tool' } }
      : { actionCaller: { kind: 'host' as const } }),
  };
  return { ...f, host, executor: reloadExecutor(), reloadExecutor, input, context, human, observations,
    waiveApproval: () => { settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'workflow.trigger.update': [surface],
    } }); },
    request: () => ApprovalRequestV2Schema.parse(request) };
}

describe('0.2 Automation Account trigger host', () => {
  it.each(['agent', 'mcp', 'cli'] as const)('converts a %s request only after the exact default present-user approval', async (surface) => {
    const f = await conversionApprovalFixture(surface);
    expect(await f.executor.execute('workflow.trigger.update', f.input, f.context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'conversion-approval' } });
    expect(f.writes()).toBe(0);
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    expect(f.request()).toMatchObject({ status: 'open', actionArgs: f.input,
      executionOriginV1: { surface, caller: f.context.actionCaller, requestId: 'conversion-request' } });
    const fields = describeApprovalActionFields(f.request());
    expect(fields.unrepresentable).toBeNull();
    expect(fields.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'automationId', value: 'legacy-one' }),
      expect.objectContaining({ path: 'confirmLegacyConversion', value: 'true' }),
      expect.objectContaining({ path: 'expectedRevision', value: '3' }),
      expect.objectContaining({ path: 'patch', value: JSON.stringify(f.input.patch) }),
    ]));
    expect(await f.executor.execute('approval.request.decide', { artifactId: 'conversion-approval', decision: 'approve' }, f.context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(f.request().status).toBe('open');
    expect(f.writes()).toBe(0);
    expect(await f.reloadExecutor().execute('approval.request.decide', { artifactId: 'conversion-approval', decision: 'approve' }, f.human))
      .toMatchObject({ ok: true });
    expect(f.request()).toMatchObject({ status: 'executed', decision: { kind: 'approve', authority: 'present_user' }, execution: { ok: true } });
    expect(f.writes()).toBe(1);
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.row().executionRecipe).toMatchObject({ v: 2, workflow: { t: 'plain', v: {
      workspace: { directory: '/repo' }, inlineDefinition: f.input.patch.target?.kind === 'inline' ? f.input.patch.target.definition : undefined,
    } } });
    expect(f.written()).toMatchObject({ enabled: true, expectedTemplateVersion: 3,
      assignments: [{ machineId: 'machine-one', enabled: true, priority: 2 }] });
    // Account approval replay is a new present-user invocation. The Artifact
    // above retains the original Session/MCP/CLI provenance.
    expect(f.observations.filter((entry) => entry.bypassApprovals).at(-1))
      .toMatchObject({ surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, actionRequestId: 'conversion-request',
        presentUserApproval: { actionId: 'workflow.trigger.update' } });
  });
  it('leaves denied conversion requests unchanged', async () => {
    const f = await conversionApprovalFixture();
    expect(await f.executor.execute('workflow.trigger.update', f.input, f.context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(await f.executor.execute('approval.request.decide', { artifactId: 'conversion-approval', decision: 'reject' }, f.human))
      .toMatchObject({ ok: true });
    expect(f.request().status).toBe('rejected');
    expect(f.writes()).toBe(0);
    expect(f.row()).toMatchObject({ enabled: false, templateVersion: 3, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED });
  });
  it('refuses a stale conversion revision on approved replay', async () => {
    const f = await conversionApprovalFixture();
    expect(await f.executor.execute('workflow.trigger.update', f.input, f.context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    f.row().templateVersion = 4;
    await f.executor.execute('approval.request.decide', { artifactId: 'conversion-approval', decision: 'approve' }, f.human);
    expect(f.request()).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'currentness_conflict' } });
    expect(f.writes()).toBe(0);
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
  });
  it('preserves direct present-user UI conversion through the executor', async () => {
    const f = await conversionApprovalFixture();
    expect(await f.executor.execute('workflow.trigger.update', f.input, f.human)).toMatchObject({ ok: true, result: { set: { revision: 4 } } });
    expect(f.writes()).toBe(1);
    expect(f.row().templateCiphertext).toBeUndefined();
  });
  it('refuses a bare approval bypass or an agent with only present-user authority', async () => {
    const f = await conversionApprovalFixture('agent');
    expect(await f.executor.execute('workflow.trigger.update', f.input, { ...f.context, bypassApprovals: true }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await f.executor.execute('workflow.trigger.update', f.input, { ...f.context, authority: 'present_user', bypassApprovals: true }))
      .toMatchObject({ ok: false });
    await expect(f.host.update(f.input, { ...f.context, authority: 'present_user', bypassApprovals: true }))
      .rejects.toMatchObject({ code: 'present_user_required' });
    expect(f.writes()).toBe(0);
  });
  it.each(['agent', 'mcp', 'cli'] as const)('refuses waived %s conversion without present-user execution authority', async (surface) => {
    const f = await conversionApprovalFixture(surface);
    f.waiveApproval();
    expect(await f.executor.execute('workflow.trigger.update', f.input, f.context))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(f.writes()).toBe(0);
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
  });
  it('binds approval proof to the Action, original request and every reviewed operand', async () => {
    const f = await conversionApprovalFixture('agent');
    await f.executor.execute('workflow.trigger.update', f.input, f.context);
    await f.executor.execute('approval.request.decide', { artifactId: 'conversion-approval', decision: 'approve' }, f.human);
    expect(f.request()).toMatchObject({ status: 'executed', execution: { ok: true } });
    const replay = f.observations.find((entry) => entry.presentUserApproval);
    expect(replay?.presentUserApproval).toBeDefined();
    if (!replay?.presentUserApproval) throw new Error('Missing approved context');
    const fresh = await conversionApprovalFixture('agent');
    for (const { input, code } of [
      { input: { ...f.input, expectedRevision: 2 }, code: 'currentness_conflict' },
      { input: { ...f.input, patch: { ...f.input.patch, project: { machineId: 'machine-one', directory: '/different' } } }, code: 'present_user_required' },
      { input: { ...f.input, patch: { ...f.input.patch, enabled: false } }, code: 'present_user_required' },
      { input: { ...f.input, patch: { ...f.input.patch, executionTarget: { kind: 'detached_run' as const } } }, code: 'present_user_required' },
    ]) {
      await expect(fresh.host.update(input, replay)).rejects.toMatchObject({ code });
    }
    for (const context of [
      { ...replay, actionRequestId: 'another-request' },
      { ...replay, presentUserApproval: { ...replay.presentUserApproval, actionId: 'workflow.trigger.add' as const } },
      { ...replay, presentUserApproval: undefined },
      { ...replay, authority: 'account_automation' as const },
      { ...replay, bypassApprovals: false },
    ]) {
      await expect(fresh.host.update(f.input, context)).rejects.toMatchObject({ code: 'present_user_required' });
    }
    expect(fresh.writes()).toBe(0);
  });
  it.each([{ placement: 'zero', explicitProject: false }, { placement: 'plural', explicitProject: false },
    { placement: 'plural', explicitProject: true }])
    ('keeps converted $placement placements through an ordinary trigger edit (explicit project: $explicitProject)', async ({ placement, explicitProject }) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().assignments = placement === 'zero' ? [] : [
      { machineId: 'machine-two', enabled: true, priority: 2, updatedAt: 1 },
      { machineId: 'machine-three', enabled: false, priority: 7, updatedAt: 1 },
    ];
    const originalAssignments = f.row().assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority }));
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    const set = sets[0]!;
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: set.target, project: set.project, enabled: false } }), caller);
    const savedRecipe = f.row().executionRecipe;
    const recipeBody = savedRecipe?.v === 2 ? savedRecipe.workflow : undefined;
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', triggerId: 'schedule-one', expectedRevision: 4,
      patch: { enabled: false, ...(explicitProject ? { project: set.project } : {}) } }), caller);
    expect(f.written()?.assignments).toEqual(originalAssignments);
    expect(f.row()).toMatchObject({ enabled: false, templateVersion: 5, triggers: [{ id: 'schedule-one', enabled: false }] });
    if (!explicitProject) {
      expect(f.written()?.executionRecipe).toBeUndefined();
      expect(f.row().executionRecipe).toMatchObject({ templateVersion: 5, workflow: recipeBody });
    }
  });
  it('does not grant a background host project-free editing authority after user confirmation', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().assignments.push({ machineId: 'machine-two', enabled: false, priority: 7, updatedAt: 1 });
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: sets[0]!.target, project: sets[0]!.project, enabled: false } }), caller);
    await expect(host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', triggerId: 'schedule-one', expectedRevision: 4,
      patch: { enabled: false } }), { authority: 'account_automation', actionCaller: { kind: 'host' } }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(f.row()).toMatchObject({ templateVersion: 4, triggers: [{ id: 'schedule-one', enabled: true }] });
  });
  it.each(['zero', 'plural'] as const)('keeps original %s placements when the authenticated review project is unchanged', async (placement) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().assignments = placement === 'zero' ? [] : [
      { machineId: 'machine-two', enabled: true, priority: 2, updatedAt: 1 },
      { machineId: 'machine-three', enabled: false, priority: 7, updatedAt: 1 },
    ];
    const originalAssignments = f.row().assignments.map(({ machineId, enabled, priority }) => ({ machineId, enabled, priority }));
    let keyReads = 0;
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => { keyReads++; return { sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }; },
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    const set = sets[0]!;
    expect(set.project).toEqual({ machineId: 'machine-one', directory: '/repo' });
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: set.target, project: set.project, enabled: false } }), caller);
    expect(f.written()?.assignments).toEqual(originalAssignments);
    expect(f.row().enabled).toBe(false);
    expect(keyReads).toBe(1);
  });
  it.each([{ edit: 'Machine', project: { machineId: 'machine-two', directory: '/repo' } },
    { edit: 'workspace', project: { machineId: 'machine-one', directory: '/edited' } }])
    ('replaces placement only for an explicit reviewed $edit change', async ({ project }) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().assignments.push({ machineId: 'machine-two', enabled: false, priority: 7, updatedAt: 1 });
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: sets[0]!.target, project, enabled: false } }), caller);
    expect(f.written()?.assignments).toEqual([{ machineId: project.machineId, enabled: true, priority: 2 }]);
  });
  it.each([{ scope: 'selected trigger', triggerId: 'schedule-one', setEnabled: true },
    { scope: 'global disabled set', triggerId: undefined, setEnabled: false }])
    ('confirms a $scope without enabling the reviewed disabled trigger', async ({ triggerId, setEnabled }) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().triggers[0]!.enabled = false;
    f.row().triggers.push({ ...f.row().triggers[0]!, id: AutomationTriggerIdSchema.parse('schedule-two'), enabled: true });
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    const set = sets[0]!;
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', triggerId, expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: set.target, project: set.project, enabled: false } }), caller);
    expect(f.row()).toMatchObject({ enabled: setEnabled, triggers: [{ id: 'schedule-one', enabled: false }, { id: 'schedule-two', enabled: true }] });
  });
  it('keeps plural placement and priority when consent saves the reviewed workspace', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    f.row().enabled = false;
    f.row().assignments.push({ machineId: 'machine-two', enabled: false, priority: 7, updatedAt: 1 });
    f.row().triggers.push({ ...f.row().triggers[0]!, id: AutomationTriggerIdSchema.parse('schedule-two') });
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    const set = sets[0]!;
    expect(set.project).toEqual({ machineId: 'machine-one', directory: '/repo' });
    await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', triggerId: 'schedule-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { target: set.target, project: set.project, enabled: true } }), caller);
    expect(f.written()?.assignments).toEqual([{ machineId: 'machine-one', enabled: true, priority: 2 },
      { machineId: 'machine-two', enabled: false, priority: 7 }]);
    expect(f.row()).toMatchObject({ enabled: true, triggers: [{ id: 'schedule-one', enabled: true }, { id: 'schedule-two', enabled: true }] });
  });
  it('pauses a retained row even when its first read is an explicit review', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    const { sets } = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }),
      { authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(sets[0]).toMatchObject({ enabled: false, revision: 4 });
    expect(f.written()?.executionRecipe).toBeUndefined();
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
  });
  it('requires trusted present-user authority to open or confirm retained private content', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions(f.params);
    const input = WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true });
    await expect(host.list(input, { surface: 'ui', authority: 'account_automation' })).rejects.toMatchObject({ code: 'present_user_required' });
    await expect(host.list(input, { authority: 'present_user', surface: 'agent' })).rejects.toMatchObject({ code: 'present_user_required' });
    const conversion = WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 3,
      confirmLegacyConversion: true, patch: { enabled: false } });
    await expect(host.update(conversion, { authority: 'account_automation', surface: 'mcp', actionCaller: { kind: 'host' } }))
      .rejects.toMatchObject({ code: 'present_user_required' });
    await expect(host.update(conversion, { authority: 'present_user', surface: 'agent', actionCaller: { kind: 'host' } }))
      .rejects.toMatchObject({ code: 'present_user_required' });
    expect(f.writes()).toBe(0);
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
  });
  it('converts predecessor rows once on read while keeping trigger identities and Channel association', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    const host = createAccountWorkflowTriggerActions({ ...f.params });
    const first = await host.list({ scope: 'account_inline' });
    expect(first.sets[0]?.legacy).toBeUndefined();
    expect(first.sets[0]).toMatchObject({ revision: 4, target: { kind: 'inline' } });
    expect(f.writes()).toBe(1);
    expect(f.written()?.triggers).toEqual([{ kind: 'existing', triggerId: 'schedule-one', expectedRevision: 2 }]);
    await host.list({ scope: 'account_inline' });
    expect(f.writes()).toBe(1);
  });
  it('pauses retained ciphertext without opening it, then converts only after deliberate review and Save', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    let keyReads = 0;
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => { keyReads++; return { sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }; },
      resolveSession: async () => ({ project: { machineId: 'machine-one', directory: '/repo' }, nativeGoalOwner: null,
        executionSelection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }),
    });
    const listed = await host.list({ scope: 'account_inline' });
    expect(listed.sets[0]).toMatchObject({ enabled: false, health: 'source_unavailable', legacy: { lockedReason: 'review_required' } });
    expect(listed.sets[0]?.target).toBeUndefined();
    expect(keyReads).toBe(0);
    expect(f.written()?.executionRecipe).toBeUndefined();
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    await expect(host.update({ automationId: 'legacy-one', expectedRevision: 4, patch: { enabled: true } }))
      .rejects.toMatchObject({ code: 'legacy_conversion_unsupported', details: { reason: 'review_required' } });
    const caller = { authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const review = await host.list(WorkflowTriggerListRequestV1Schema.parse({ automationId: 'legacy-one', review: true }), caller);
    const set = review.sets[0]!;
    expect(set).toMatchObject({ enabled: false, health: 'available', legacy: { lockedReason: 'review_required' } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    const result = await host.update(WorkflowTriggerUpdateRequestV1Schema.parse({ automationId: 'legacy-one', expectedRevision: 4,
      confirmLegacyConversion: true, patch: { target: set.target, project: set.project, enabled: true } }), caller);
    expect(result.set.legacy).toBeUndefined();
    expect(f.row().executionRecipe).toMatchObject({ v: 2, workflow: { t: 'plain' } });
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(keyReads).toBe(1);
  });
  it('reads retained E2EE Session content on a plain Account with explicit historical custody', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    expect((await host.list({ scope: 'account_inline' })).sets[0]).toMatchObject({ enabled: false, health: 'source_unavailable',
      legacy: { editable: false, lockedReason: 'review_required' } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    expect(f.writes()).toBe(1);
  });
  it.each([AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_ENCRYPTED])('lists locked encrypted legacy rows and permits deletion without their keys', async (templateCiphertext) => {
    const f = fixture(templateCiphertext, plain, templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED ? 'existingSession' : 'newSession');
    const host = createAccountWorkflowTriggerActions(f.params);
    const set = WorkflowTriggerListResultV1Schema.parse(await host.list({ scope: 'account_inline' })).sets[0];
    expect(set).toMatchObject({ health: 'source_unavailable', legacy: { editable: false,
      lockedReason: templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED ? 'review_required' : 'migration_required' } });
    expect(set?.target).toBeUndefined();
    await host.remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(f.row().triggers).toEqual([]);
    expect(f.row().templateCiphertext).toBe(templateCiphertext);
  });
  it('converts existing-Session predecessor bytes using its actual Agent and placement instead of stale template settings', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveSession: async () => ({ project: { machineId: 'machine-one', directory: '/actual-session-directory' }, nativeGoalOwner: null,
        executionSelection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'read-only' as const } }),
    });
    const result = await host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } });
    expect(result.set).toMatchObject({ revision: 4, target: { definition: { defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'default',
      conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-one' },
    } } }, project: { machineId: 'machine-one', directory: '/actual-session-directory' } });
    expect(f.writes()).toBe(1);
  });
  it.each(['missing Agent', 'mismatched Machine'])('refuses existing-Session conversion with %s', async (unproven) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveSession: async () => ({ project: { machineId: unproven === 'mismatched Machine' ? 'another-machine' : 'machine-one', directory: '/repo' }, nativeGoalOwner: null,
        ...(unproven === 'missing Agent' ? {} : { executionSelection: {
          agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        } }) }),
    });
    await expect(host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'legacy_conversion_unsupported', details: { reason: 'conversation_unrepresentable' } });
    expect(f.writes()).toBe(0);
  });
  it.each([{ machines: [] }, { machines: ['machine-one', 'machine-two'] }])('reads every retained placement without assigning a canonical project: $machines', async ({ machines }) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    f.row().assignments = machines.map((machineId) => ({ machineId, enabled: true, priority: 0, updatedAt: 1 }));
    const result = WorkflowTriggerListResultV1Schema.parse(await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' }));
    expect(result.sets[0]).toMatchObject({ health: 'available',
      placements: machines.map((machineId) => ({ machineId, directory: '/repo' })),
    target: { definition: { blocks: [{ document: { text: 'Review the release' } }] } },
    triggers: [{ nextRunAt: 2 }] });
    expect(result.sets[0]?.project).toBeUndefined();
    expect(f.writes()).toBe(1);
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.row().assignments.map(({ machineId }) => machineId)).toEqual(machines);
  });
  it('reads encrypted placement content without advertising disabled assignments or changing its envelope', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted);
    f.row().assignments.push({ machineId: 'machine-two', enabled: false, priority: 0, updatedAt: 1 });
    const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
    expect(sets[0]).toMatchObject({ health: 'available', placements: [
      { machineId: 'machine-one', directory: '/repo' },
    ], target: { definition: { blocks: [{ document: { text: 'Review the release' } }] } } });
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.row().executionRecipe).toMatchObject({ workflow: { t: 'encrypted' } });
    expect(f.row().assignments).toHaveLength(2);
    expect(f.writes()).toBe(1);
  });
  it('resolves the exact Session machine rather than selecting a multi-placement assignment', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    f.row().assignments.push({ machineId: 'machine-two', enabled: true, priority: 0, updatedAt: 1 });
    const { sets } = await createAccountWorkflowTriggerActions({ ...f.params,
      resolveSession: async (sessionId) => {
        expect(sessionId).toBe('session-old');
        return { project: { machineId: 'actual-session-machine', directory: '/repo' }, nativeGoalOwner: null,
          executionSelection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
      },
    }).list({ scope: 'account_inline' });
    expect(sets[0]?.target).toMatchObject({ definition: { defaults: {
      conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'actual-session-machine' },
    } } });
    expect(sets[0]?.project).toBeUndefined();
    expect(f.writes()).toBe(1);
  });
  it('removes the legacy trigger without conversion, preserving assignments and omitting an execution rewrite', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    await createAccountWorkflowTriggerActions(f.params).remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(f.written()).toMatchObject({ assignments: [{ machineId: 'machine-one', enabled: true, priority: 2 }],
      triggers: [], removedTriggers: [{ triggerId: 'schedule-one', expectedRevision: 2 }] });
    expect(f.written()?.executionRecipe).toBeUndefined();
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
    expect(f.row().triggers).toEqual([]);
  });
  it('retains a legacy row and permits removal when its existing Session is unavailable', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    f.row().assignments = [];
    const host = createAccountWorkflowTriggerActions({ ...f.params, resolveSession: async () => {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    } });
    const { sets } = await host.list({ scope: 'account_inline' });
    expect(sets[0]).toMatchObject({ health: 'source_unavailable', legacy: { reason: 'created_in_0_2' } });
    const removed = await host.remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(removed.set).toMatchObject({ health: 'source_unavailable', triggers: [] });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN);
  });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted]] as const)
    ('projects predecessor bytes with prompt, placement, schedule and a distinct legacy state', async (bytes, encryption) => {
      const f = fixture(bytes, encryption);
      const result = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      const set = WorkflowTriggerListResultV1Schema.parse(result).sets[0];
      expect(set).toMatchObject({ health: 'available',
        project: { machineId: 'machine-one', directory: '/repo' }, target: { kind: 'inline', definition: {
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ document: { text: 'Review the release' } }] } }, triggers: [{ nextRunAt: 2, schedule: { everyMs: 60_000 } }] });
      expect(f.row().templateCiphertext).toBeUndefined();
      expect(f.writes()).toBe(1);
    });
  it.each([[AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, encrypted]] as const)
    ('retains the exact existing Session target', async (bytes, encryption) => {
      const f = fixture(bytes, encryption, 'existingSession');
      const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      expect(sets[0]?.target).toMatchObject({ definition: { defaults: {
        conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-one' } } } });
    });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted],
    [AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED, encrypted]] as const)
    ('converts a representable 0.2 row through one Automation CAS after the Channels boundary proves absence', async (bytes, encryption) => {
    const f = fixture(bytes, encryption);
    const host = createAccountWorkflowTriggerActions({ ...f.params });
    const result = await host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } });
    expect(result.set).toMatchObject({ revision: 4, enabled: false, health: 'available',
      target: { kind: 'inline', definition: { blocks: [{ document: { text: 'Review the release' } }] } } });
    expect(result.set.legacy).toBeUndefined();
    expect(result.set.triggers).toEqual(f.row().triggers);
    expect(f.row().assignments).toEqual([{ machineId: 'machine-one', enabled: true, priority: 2, updatedAt: 1 }]);
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.row().workflowDefinitionId).toBeNull();
    expect(f.writes()).toBe(1);
    expect(f.written()).toMatchObject({ expectedTemplateVersion: 3, workflowDefinitionId: null,
      assignments: [{ machineId: 'machine-one', enabled: true, priority: 2 }],
      triggers: [{ kind: 'existing', triggerId: 'schedule-one', expectedRevision: 2 }], removedTriggers: [] });
    await expect(host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: true } }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(f.writes()).toBe(1);
  });
  it('converts bound rows without replacing their Automation or trigger identities', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted);
    const result = await createAccountWorkflowTriggerActions({ ...f.params })
      .update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } });
    expect(result.set.automationId).toBe('legacy-one');
    expect(result.set.triggers[0]?.id).toBe('schedule-one');
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.writes()).toBe(1);
  });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, encrypted]] as const)
    ('fails mode mismatch closed before disclosure or mutation', async (bytes, encryption) => {
      const f = fixture(bytes, encryption);
      const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      expect(sets[0]).toMatchObject({ health: 'source_unavailable', legacy: { lockedReason: 'migration_required' } });
      expect(sets[0]?.target).toBeUndefined();
      expect(sets[0]?.context).toBeUndefined();
      expect(f.writes()).toBe(0);
    });
});
