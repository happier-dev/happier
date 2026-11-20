import { describe, expect, it } from 'vitest';
import '../actionSpecs.js';
import { createActionAutomationHttpPortV1, createActionAutomationPortV1 } from './actionAutomationAdmission.js';
import { createWorkflowActorConsentPortV1 } from './workflowTriggerActions.js';
import { createActionAutomationInvocationV1 } from './actionSettlement.js';
import { createAccountWorkflowTriggerActions } from './workflowTriggerAccountHost.js';
import type { AutomationDefinitionDetail } from '../../automations/automationApiV3.js';
import { AutomationTriggerDetailSchema } from '../../automations/automationTriggerProjectionV1.js';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '../../automations/automationTriggerDefinitionStoredContent.js';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationStoredWorkflowDefinitionV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import type { AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { createAutomaticApprovalContinuation, restoreApprovalAutomaticContextV1, createApprovalAutomaticChecksV1 } from './automaticApprovalContinuation.js';
import { ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import { automationSubjectKeyV1 } from '../../automations/automationSubjectV1.js';

it('uses the invoking Machine for Account Action checks and visibly skips when it is absent', async () => {
  const rows = (['before', 'after'] as const).map(phase => ({ automationId: 'own', triggerId: phase,
    triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'actor',
    actionIds: ['notifications.notify_me'], phase, ...(phase === 'before' ? { mode: 'wait' as const } : {}) }));
  const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows }),
    settle: async () => {} });
  const args = { actionId: 'notifications.notify_me', input: { message: 'Account effect' },
    context: { defaultSessionMachineId: 'configured-machine' } };
  expect(await port.select(args)).toMatchObject({ status: 'ready', before: [rows[0]], after: [rows[1]], notices: [] });
  expect(await port.select({ ...args, context: {} })).toMatchObject({ status: 'ready', before: [], after: [], notices: rows.map(row => ({
    code: 'action_automation_skipped', reason: 'machineRequired', automationId: row.automationId,
    triggerId: row.triggerId, workflowId: row.workflowId,
  })) });
});

it('marks an automatic before wait check unavailable when its Machine is missing', async () => {
  const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [{
    automationId: 'own', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
    ownerAccountId: 'actor', actionIds: ['machines.command.run'], phase: 'before', mode: 'wait', onFailure: 'refuse',
  }] }), settle: async () => {} });
  const selection = await port.select({ actionId: 'machines.command.run', input: { command: 'printf bypass' },
    context: { authority: 'account_automation', serverIdentityId: 'home' } });
  expect(selection).toMatchObject({ status: 'unavailable', before: [], after: [], notices: [{
    code: 'action_automations_not_checked', reason: 'machineRequired',
  }] });
});

it('matches a Machine subject from the admitted external target', async () => {
  const subject = { kind: 'machine' as const, serverId: 'home', machineId: 'machine' };
  const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [{
    automationId: 'own', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
    ownerAccountId: 'actor', actionIds: ['machines.command.run'], phase: 'before', mode: 'wait', onFailure: 'refuse',
    subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject),
  }] }), settle: async () => {} });
  const selection = await port.select({ actionId: 'machines.command.run', input: { command: 'printf matched' },
    context: { authority: 'account_automation', serverIdentityId: subject.serverId,
      externalActionTarget: subject } });
  expect(selection.before.map(row => row.automationId)).toEqual(['own']);
});

it('reopens an unavailable Action index on the next admission without retrying the failed request', async () => {
  const subject = { kind: 'machine' as const, serverId: 'home', machineId: 'machine' };
  const row = { automationId: 'new-automation', triggerId: 'new-trigger', triggerRevision: 1,
    workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'actor', actionIds: ['machines.command.run'],
    phase: 'before', mode: 'wait', onFailure: 'ask', subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject) };
  let reads = 0;
  const port = createActionAutomationHttpPortV1({ accountId: 'actor', request: async () => {
    if (++reads === 1) throw Object.assign(new Error('Home cannot acquire a transaction'), { code: 'database_connection_unavailable' });
    return { v: 1, rows: [row] };
  } });
  const args = { actionId: 'machines.command.run', input: { command: 'printf d14' },
    context: { authority: 'account_automation' as const, serverIdentityId: subject.serverId,
      externalActionTarget: { kind: 'machine' as const, machineId: subject.machineId } } };

  expect(await port.select(args)).toMatchObject({ status: 'unavailable', before: [], notices: [{
    code: 'action_automations_not_checked', reason: 'database_connection_unavailable',
  }] });
  expect(reads).toBe(1);
  for (const selection of await Promise.all([port.select(args), port.select(args)])) {
    expect(selection).toMatchObject({ status: 'ready', before: [row], notices: [] });
  }
  expect(await port.select(args)).toMatchObject({ status: 'ready', before: [row] });
  expect(reads).toBe(2);
});

it('keeps the refused admission unavailable while a concurrent admission reopens the index', async () => {
  let finishRecovery: (() => void) | undefined;
  const recovery = new Promise(resolve => { finishRecovery = () => resolve({ v: 1, rows: [] }); });
  let reads = 0;
  const port = createActionAutomationPortV1({
    accountId: 'actor',
    seed: () => ++reads === 1
      ? Promise.reject(Object.assign(new Error('Home cannot acquire a transaction'), { code: 'database_connection_unavailable' }))
      : recovery,
    settle: async () => {},
  });
  const args = { actionId: 'machines.command.run', input: { command: 'printf d14' },
    context: { authority: 'account_automation' as const } };

  const failing = port.select(args);
  // Let the seed reject, then start the next admission before the first caller receives its result.
  await Promise.resolve();
  await Promise.resolve();
  const recovering = port.select(args);
  expect(reads).toBe(2);
  expect(await failing).toMatchObject({ status: 'unavailable', notices: [{
    code: 'action_automations_not_checked', reason: 'database_connection_unavailable',
  }] });
  finishRecovery?.();
  expect(await recovering).toMatchObject({ status: 'ready' });
});

it('checks pinned child revisions without rematerializing or reconciling unchanged consent', async () => {
  const childRef = '22222222-2222-4222-8222-222222222222';
  const root = WorkflowDefinitionV1Schema.parse({ version: 1,
    blocks: [{ kind: 'workflow', id: 'child', workflowRef: childRef }] });
  const child = WorkflowDefinitionV1Schema.parse({ version: 1,
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] } }] });
  const revisions = new Map([["root", 1], [childRef, 1]]);
  const definitions = new Map([["root", root], [childRef, child]]);
  let workflowReads = 0;
  let materializationCalls = 0;
  let reconcileWrites = 0;
  let retained: AutomationDefinitionDetail | null = null;
  const actions = createAccountWorkflowTriggerActions({
    nativeAccount: { accountId: 'actor', serverId: 'home', isCurrent: async () => true },
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    randomBytes: length => new Uint8Array(length).fill(1), newId: kind => `${kind}-1`,
    resolveWorkflow: async ref => { workflowReads += 1; return { definition: definitions.get(ref)!, revision: { headerVersion: 1, bodyVersion: revisions.get(ref)! } }; },
    openContext: async row => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
    sealContext: async ({ templateVersion, context }) => ({ v: 2, templateVersion,
      workflow: { t: 'plain', v: context }, triggerEvidence: null, managedTarget: null, visibleTeamId: null }),
    resolveMaterializer: async () => { materializationCalls += 1; return { effects: {} }; },
    automations: {
      get: async () => retained,
      list: async () => ({ automations: [], nextCursor: null }),
      listDetails: async () => ({ automations: [], nextCursor: null }),
      create: async input => {
        retained = { id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
          targetType: null, existingSessionId: null, templateVersion: 1, workflowDefinitionId: input.workflowDefinitionId ?? null,
          scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], executionRecipe: input.executionRecipe,
          triggers: input.triggers.map(item => AutomationTriggerDetailSchema.parse({ ...item.trigger, id: item.triggerId,
            revision: 1, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null })) };
        return retained;
      },
      reconcile: async () => { reconcileWrites += 1; throw new Error('Unexpected consent reconciliation'); },
      delete: async () => ({ ok: true }),
    },
  });
  const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
    runtimeAccountId: 'actor', serverId: 'home', actionRequestId: 'consent' };
  const project = { machineId: 'machine', directory: '/repo' };
  const matching = { actionIds: ['notifications.notify_me'], phase: 'before' as const };
  const consentTrigger = { kind: 'action' as const, enabled: true,
    consentFor: { automationId: 'source', triggerId: 'source-trigger' }, consentedWorkflowRevision: 1 };
  const saved = await actions.saveActorConsent({ workflow: 'root', workflowRevision: 1, matching, project, consentTrigger,
    decisionInput: { artifactId: 'approval', decision: 'approve', triggerConsent: { automationId: 'source', triggerId: 'source-trigger', decision: 'allow' } } }, caller);
  workflowReads = 0;
  materializationCalls = 0;
  reconcileWrites = 0;
  const selection = { workflow: 'root', workflowRevision: 1, matching, project,
    saved: { automationId: saved.automationId, triggerId: saved.triggerId, workflowRevision: saved.workflowRevision }, consentTrigger };
  expect(await actions.readActorConsent(selection, caller)).toMatchObject({ current: true });
  expect(await actions.readActorConsent(selection, caller)).toMatchObject({ current: true });
  expect({ workflowReads, materializationCalls, reconcileWrites }).toEqual({ workflowReads: 4, materializationCalls: 0, reconcileWrites: 0 });
});

describe('Approval profile subject admission', () => {
  it('matches only the available admission binding, including after access is withdrawn', async () => {
    const subject = { kind: 'approvalProfile' as const, serverId: 'home', profileId: 'profile' };
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [{
      automationId: 'automation', triggerId: 'trigger', triggerRevision: 1, workflowId: 'workflow',
      workflowRevision: 1, ownerAccountId: 'actor', actionIds: ['actions.policy.set'], phase: 'before', mode: 'wait',
      subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject),
    }] }), settle: async () => {} });
    const args = { actionId: 'actions.policy.set', input: {}, context: {
      serverIdentityId: 'home', approvalProfileId: 'profile', defaultSessionMachineId: 'machine',
    } };
    // A stored id survives revocation and cannot establish current profile availability.
    expect((await port.select(args)).before).toEqual([]);
    const admitted = await port.select({ ...args, context: { ...args.context, approvalProfileId: 'stored-other-profile', approvalProfile: {
      profile: { id: 'profile', name: 'Shared profile' },
      resolution: { status: 'available', requestedId: 'profile' },
    } } });
    expect(admitted.before.map(row => row.automationId)).toEqual(['automation']);
    expect((await port.select({ ...args, context: { ...args.context, approvalProfile: {
      profile: null, resolution: { status: 'missing', requestedId: 'profile' },
    } } })).before).toEqual([]);
    expect(admitted.before.map(row => row.automationId)).toEqual(['automation']);
  });
});

it.each(['plain', 'e2ee'] as const)('retains selected private Only-when matching for both phases without another definition read (%s)', async mode => {
  const actionId = 'notifications.notify_me';
  const workflowId = '11111111-1111-4111-8111-111111111111';
  const rows = ['before', 'after'].map(phase => ({ automationId: 'own', triggerId: phase,
    triggerRevision: 1, workflowId, workflowRevision: 1, ownerAccountId: 'actor',
    actionIds: [actionId], phase, ...(phase === 'before' ? { mode: 'wait', onFailure: 'refuse' } : {}) }));
  let definitionReads = 0;
  let workflowReads = 0;
  const sent: unknown[] = [];
  const current: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
    ? { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: null } }
    : { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: 'current' },
      material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: mode,
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
  const workflowContext = AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } });
  const stored: AutomationDefinitionDetail = { id: 'own', name: 'Own', description: null, enabled: true,
    targetType: null, existingSessionId: null, templateVersion: 1, workflowDefinitionId: workflowId,
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
      workflow: current.witness.mode === 'e2ee' && 'material' in current
        ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
          material: current.material.material, payload: workflowContext, randomBytes: length => new Uint8Array(length).fill(2) }) }
        : { t: 'plain', v: workflowContext }, triggerEvidence: null, visibleTeamId: null, managedTarget: null }),
    scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
    triggers: rows.map(row => ({ id: row.triggerId, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
      kind: 'action' as const, phase: row.phase as 'before' | 'after', actionIds: [actionId],
      ...(row.phase === 'before' ? { mode: 'wait' as const, onFailure: 'refuse' as const } : {}),
      triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        ...(current.witness.mode === 'e2ee' && 'material' in current
          ? { mode: 'e2ee' as const, material: current.material.material, randomBytes: length => new Uint8Array(length).fill(2) }
          : { mode: 'plain' as const }),
        binding: { v: 1, automationId: 'own', triggerId: row.triggerId, triggerRevision: 1, triggerKind: 'action' },
        definition: { kind: 'action', phase: row.phase, actionIds: [actionId],
          ...(row.phase === 'before' ? { mode: 'wait', onFailure: 'refuse' } : {}),
          filter: { v: 1, all: [{ op: 'eq', field: row.phase === 'before' ? '/phase' : '/outcome',
            value: row.phase === 'before' ? 'after' : 'failed' }] } },
      })) })) };
  const unexpectedWrite = async (): Promise<never> => { throw new Error('Matching performs no write'); };
  let retainedRow = stored;
  const actions = createAccountWorkflowTriggerActions({ resolveEncryption: async () => current,
    randomBytes: length => new Uint8Array(length).fill(1), newId: () => 'unused',
    resolveWorkflow: async () => { workflowReads++; return { definition: WorkflowDefinitionV1Schema.parse({ version: 1,
      blocks: [{ kind: 'action', id: 'notice', actionId, input: { message: { kind: 'literal', value: 'Notice' } } }] }) }; },
    automations: { get: async () => { definitionReads++; return retainedRow; },
      list: async () => ({ automations: [], nextCursor: null }), listDetails: async () => ({ automations: [], nextCursor: null }),
      create: unexpectedWrite, reconcile: unexpectedWrite, delete: unexpectedWrite } });
  const checks = createWorkflowActorConsentPortV1({ accountId: 'actor',
    resolveProject: async () => ({ machineId: 'machine', directory: '/repo' }),
    actions,
  });
  const http = createActionAutomationHttpPortV1({ accountId: 'actor', request: async (_path, request) => {
    if (request.method === 'GET') return { v: 1, rows };
    sent.push(request.body);
    return { results: [] };
  } });
  const context = { actionRequestId: 'original-request', defaultSessionMachineId: 'machine' };
  const empty = await http.select({ actionId: 'account.name.set', input: {}, context, prepareMatching: checks.prepareMatching });
  await createActionAutomationInvocationV1({ actionId: 'account.name.set', context, selection: empty, port: http }).settle({ ok: true });
  expect(definitionReads).toBe(0);
  expect(sent).toEqual([]);
  const selection = await http.select({ actionId, input: {}, context, prepareMatching: checks.prepareMatching });
  expect(workflowReads).toBe(0);
  const invocation = createActionAutomationInvocationV1({ actionId, context, selection, port: http });
  const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs: { message: 'Approved notice' },
    approval: { flow: 'deferred', result: 'required' }, summary: 'Send a notice',
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      accountId: 'actor', serverId: 'home', machineId: 'machine', actionId, requestId: 'original-request' },
    automaticChecks: { ...createApprovalAutomaticChecksV1(selection, true),
      humanDecision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user', decidingAccountId: 'actor' } },
  });
  const continuationContext = { ...context, actionAutomationAdmission: invocation };
  const continuation = createAutomaticApprovalContinuation({ actionAutomations: http }, async () => null);
  const admitted = await continuation.admit('approval', approval, continuationContext);
  const notices = [{ code: 'action_automation_skipped', reason: 'conditionNotMatched', automationId: 'own', triggerId: 'before', workflowId }];
  expect(admitted).toMatchObject({ status: 'open', automaticChecks: { phase: 'checking', runs: [], notices } });
  if (!('v' in admitted)) throw new Error('Expected the nonmatching wait check to settle without a Run');
  expect(await continuation.resume('approval', admitted, continuationContext)).toMatchObject({ kind: 'approved',
    request: { status: 'approved', automaticChecks: { phase: 'passed', runs: [], notices } } });
  expect(sent).toEqual([]);
  const restored = restoreApprovalAutomaticContextV1({ automaticChecks: createApprovalAutomaticChecksV1(selection, false) },
    actionId, { ...context, actionAutomationAdmission: invocation }, { ...http, prepareMatching: checks.prepareMatching });
  expect(await restored.actionAutomationAdmission!.settle({ ok: true })).toEqual({ ok: true });
  expect(sent).toEqual([]);
  expect(definitionReads).toBe(1);
  const failedContext = { actionRequestId: 'failed-request', defaultSessionMachineId: 'machine' };
  const failedSelection = await http.select({ actionId, input: {}, context: failedContext, prepareMatching: checks.prepareMatching });
  const failed = createActionAutomationInvocationV1({ actionId, context: failedContext, selection: failedSelection, port: http });
  await failed.settle({ ok: false, errorCode: 'target_unavailable', error: 'unavailable' });
  expect(sent).toEqual([expect.objectContaining({ evidence: expect.objectContaining({ outcome: 'failed' }),
    triggers: [{ automationId: 'own', triggerId: 'after', triggerRevision: 1 }] })]);
  expect(definitionReads).toBe(2);
  retainedRow = { ...stored, triggers: [] };
  const cold = restoreApprovalAutomaticContextV1({ automaticChecks: createApprovalAutomaticChecksV1(selection, false) },
    actionId, { actionRequestId: 'cold-request', actionAutomationAdmission: invocation }, { ...http, prepareMatching: checks.prepareMatching });
  expect(await cold.actionAutomationAdmission!.settle({ ok: false, errorCode: 'target_unavailable', error: 'unavailable' }))
    .toMatchObject({ automationNotices: [expect.objectContaining({ reason: 'content_unavailable' })] });
  expect(sent).toHaveLength(1);
  expect(definitionReads).toBe(3);
  retainedRow = { ...stored, triggers: [...stored.triggers, { ...stored.triggers[0]!, id: 'unrelated',
    triggerDefinitionEnvelope: 'unavailable unrelated private content' }] };
  http.apply({ automationId: 'own', rows: [selection.after[0]!] });
  const afterContext = { actionRequestId: 'after-only-request', defaultSessionMachineId: 'machine' };
  const afterOnly = await http.select({ actionId, input: {}, context: afterContext, prepareMatching: checks.prepareMatching });
  expect(afterOnly.before).toEqual([]);
  // A later removal cannot rewrite the already admitted private matching snapshot.
  retainedRow = { ...stored, triggers: [] };
  const afterInvocation = createActionAutomationInvocationV1({ actionId, context: afterContext, selection: afterOnly, port: http });
  await afterInvocation.settle({ ok: false, errorCode: 'target_unavailable', error: 'unavailable' });
  expect(sent).toHaveLength(2);
  expect(definitionReads).toBe(4);
  expect(workflowReads).toBe(0);
});

it.each([true, false])('admits shared Action checks for the actor through Workflow content (filtered=%s)', async filtered => {
  const subject = { kind: 'machine' as const, serverId: 'home', machineId: 'subject-machine' };
  const definition = { kind: 'action' as const, phase: 'after' as const, actionIds: ['notifications.notify_me'],
    ...(filtered ? { filter: { v: 1 as const, all: [{ field: '/outcome', op: 'eq' as const, value: 'failed' }] } } : {}) };
  const source = { automationId: 'source', triggerId: 'shared', triggerRevision: 1, workflowId: 'workflow',
    workflowRevision: 1, ownerAccountId: 'author', actionIds: ['notifications.notify_me'], phase: 'after' as const,
    reachesOthers: true, subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject, 'workflow'),
    sharedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, automationId: 'source', triggerId: 'shared', triggerRevision: 1, triggerKind: 'action' }, definition }) };
  const actor = { ...source, automationId: 'actor-consent', triggerId: 'consent', ownerAccountId: 'actor',
    consentFor: { automationId: source.automationId, triggerId: source.triggerId }, consentedWorkflowRevision: 1 };
  let reads = 0;
  let workflowContentReads = 0;
  const sent: unknown[] = [];
  const unexpectedWrite = async (): Promise<never> => { throw new Error('No write'); };
  const actions = createAccountWorkflowTriggerActions({
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    randomBytes: length => new Uint8Array(length).fill(1), newId: () => 'unused',
    resolveWorkflow: async () => { throw new Error('No Workflow projection'); },
    resolveWorkflowContent: async () => {
      workflowContentReads++;
      return { revision: { headerVersion: 1, bodyVersion: 1 }, openAssociatedContent: async content => {
        if (content.t !== 'plain') throw new Error('Expected plain Workflow content');
        return content.v;
      }, sealAssociatedContent: async value => ({ t: 'plain', v: value }) };
    },
    automations: { get: async () => { reads++; throw new Error('No source Account read'); },
      list: async () => ({ automations: [], nextCursor: null }), listDetails: async () => ({ automations: [], nextCursor: null }),
      create: unexpectedWrite, reconcile: unexpectedWrite, delete: unexpectedWrite },
  });
  const checks = createWorkflowActorConsentPortV1({ accountId: 'actor', resolveProject: async () => ({ machineId: 'machine', directory: '/repo' }),
    actions });
  const http = createActionAutomationHttpPortV1({ accountId: 'actor', request: async (_path, request) => {
    if (request.method === 'GET') return { v: 1, rows: [source] };
    sent.push(request.body);
    return { results: [] };
  } });
  const context = { actionRequestId: 'shared-request', defaultSessionMachineId: 'machine' };
  const selection = await http.select({ actionId: source.actionIds[0]!, input: {}, context,
    subjects: [{ role: 'operand', subject }], prepareMatching: checks.prepareMatching });
  const current = { ...selection, after: selection.after.map(row => ({ ...row, consent: { status: 'current' as const, row: actor } })) };
  expect(current.after).toHaveLength(1);
  const invocation = createActionAutomationInvocationV1({ actionId: source.actionIds[0]!, selection: current, context, port: http });
  expect(await invocation.settle({ ok: true })).toEqual({ ok: true });
  expect(sent).toHaveLength(filtered ? 0 : 1);
  const failed = createActionAutomationInvocationV1({ actionId: source.actionIds[0]!, selection: current,
    context: { ...context, actionRequestId: 'failed-shared-request' }, port: http });
  await failed.settle({ ok: false, errorCode: 'target_unavailable', error: 'unavailable' });
  expect(sent).toHaveLength(filtered ? 1 : 2);
  expect(sent.at(-1)).toMatchObject({ triggers: [{ automationId: 'actor-consent', triggerId: 'consent', triggerRevision: 1 }],
    evidence: { outcome: 'failed' } });
  expect(reads).toBe(0);
  expect(workflowContentReads).toBe(1);
});
