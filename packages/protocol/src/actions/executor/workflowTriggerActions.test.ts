import { describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import type { AutomationDefinitionDetail, AutomationTriggerDetail } from '../../automations/automationApiV3.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { resolveWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionResolverV1.js';
import { createWorkflowTriggerActions, type WorkflowTriggerActionsDependencies } from './workflowTriggerActions.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './workflowDefinitions.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { AutomationTriggerDetailSchema } from '../../automations/automationTriggerProjectionV1.js';
import { AutomationPullRequestTriggerSchema } from '../../automations/automationTriggerDefinition.js';
import { openAutomationTriggerDefinitionStoredEnvelopeV1, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '../../automations/automationTriggerDefinitionStoredContent.js';

const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'prompt', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});
const trigger = { kind: 'schedule' as const, enabled: true,
  schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };
const project = { machineId: 'machine-one', directory: '/workspace' };
const workflow = '11111111-1111-4111-8111-111111111111';
const ownCaller = { surface: 'agent' as const, sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
  agentStartContext: { caller: { kind: 'session' as const, sessionId: 'session-one', starterDepth: 0, turnDepth: 0 },
    baseline: { ...project, configuration: { agentTarget: definition.defaults!.agentTarget! } }, ledSubtreeSessionIds: [],
    workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' as const } };

function fixture() {
  // These operations are the persistent/network Automation boundary; all Action semantics and validation run real.
  const rows = new Map<string, AutomationDefinitionDetail>();
  let nextId = 0;
  const artifact = { artifactId: workflow, ownerAccountId: 'owner', access: 'owner' as const,
    header: { kind: 'workflow-definition.v1', definitionId: workflow,
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } },
    body: JSON.stringify({ kind: 'workflow-definition.v1', definition }), revision: { headerVersion: 1, bodyVersion: 1 } };
  const artifacts = new Map([[workflow, artifact]]);
  // Artifact reads/writes are the external persistent boundary; resolution and validation stay real.
  const artifactStore: WorkflowDefinitionArtifactOperations = {
    read: async (id) => artifacts.get(id) ?? null,
    list: async () => ({ items: [] }),
    create: async () => { throw new Error('Unexpected fixture Artifact write'); },
    update: async () => { throw new Error('Unexpected fixture Artifact write'); },
    delete: async (id) => { artifacts.delete(id); return { ok: true }; },
  };
  const definitions = createWorkflowDefinitionActions({ artifactStore,
    encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: () => { throw new Error('Unexpected fixture definition policy write'); } });
  const toTrigger = (id: string, enabled = trigger.enabled): AutomationTriggerDetail => ({ ...trigger, enabled, id: AutomationTriggerIdSchema.parse(id),
    revision: 0, createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null });
  const deps: WorkflowTriggerActionsDependencies = {
    newId: (kind) => `${kind}-${++nextId}`,
    resolveRunSource: async () => ({ terminal: true }),
    resolveWorkflow: async (ref) => {
      const source = await resolveWorkflowDefinitionRefV1(ref, { readArtifact: (definitionId) => definitions.get({ definitionId }) });
      if (!source) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      return source.definition;
    },
    resolveWorkflowTeamIds: async () => [],
    openContext: async (row) => row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain' ? row.executionRecipe.workflow.v : null,
    sealContext: async ({ templateVersion, context }) => ({ v: 2, templateVersion, workflow: { t: 'plain', v: context }, triggerEvidence: null }),
    openPullRequestTrigger: async (row, item) => {
      const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, automationId: row.id, triggerId: item.id, triggerRevision: item.revision, triggerKind: item.kind },
        envelope: JSON.parse(item.triggerDefinitionEnvelope) });
      if (opened.kind !== 'available') throw new Error(opened.kind);
      return AutomationPullRequestTriggerSchema.parse(opened.definition);
    },
    automations: {
      // The real list projection omits the private execution recipe; callers must
      // open the authorized detail before comparing an inline notification intent.
      list: async () => ({ automations: [...rows.values()].map(({ executionRecipe: _private, ...row }) => row), nextCursor: null }),
      get: async (id) => rows.get(id) ?? null,
      create: async (input) => {
        const row: AutomationDefinitionDetail = { id: input.automationId, name: input.name, description: input.description ?? null,
          enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
          assignments: (input.assignments ?? []).map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
          triggers: input.triggers.map((value) => value.trigger.kind === 'prComment' || value.trigger.kind === 'ciFailed'
            ? AutomationTriggerDetailSchema.parse({ kind: value.trigger.kind, id: value.triggerId, revision: 0, enabled: value.trigger.enabled,
              createdAt: 1, updatedAt: 1, sourceSessionId: input.scopeSessionId,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value.trigger ? value.trigger.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: input.automationId, triggerId: AutomationTriggerIdSchema.parse(value.triggerId), triggerRevision: 0, triggerKind: value.trigger.kind },
                  definition: { kind: value.trigger.kind, pullRequest: value.trigger.pullRequest } })) })
            : value.trigger.kind === 'sessionLifecycle' || value.trigger.kind === 'runLifecycle'
            ? AutomationTriggerDetailSchema.parse({ ...value.trigger, id: value.triggerId,
              revision: 0, createdAt: 1, updatedAt: 1, remainingOccurrences: 1,
              status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }) : toTrigger(value.triggerId, value.trigger.enabled)), executionRecipe: input.executionRecipe };
        rows.set(row.id, row); return row;
      },
      reconcile: async (id, input) => {
        const current = rows.get(id)!;
        if (current.templateVersion !== input.expectedTemplateVersion) throw Object.assign(new Error('conflict'), { code: 'currentness_conflict' });
        const triggers = await Promise.all(input.triggers.map(async (item): Promise<AutomationTriggerDetail> => {
          if (item.kind === 'new' && (item.trigger.kind === 'prComment' || item.trigger.kind === 'ciFailed')) {
            const value = item.trigger;
            return AutomationTriggerDetailSchema.parse({ kind: value.kind, id: item.triggerId, revision: 0,
              enabled: value.enabled, createdAt: 1, updatedAt: 1, sourceSessionId: current.scopeSessionId,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in value ? value.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                  binding: { v: 1, automationId: id, triggerId: AutomationTriggerIdSchema.parse(item.triggerId), triggerRevision: 0, triggerKind: value.kind },
                  definition: { kind: value.kind, pullRequest: value.pullRequest } })) });
          }
          if (item.kind === 'new') return toTrigger(item.triggerId, item.trigger.enabled);
          const old = current.triggers.find((value) => value.id === item.triggerId)!;
          if ((old.kind === 'prComment' || old.kind === 'ciFailed') && (item.enabled !== undefined || item.trigger !== undefined)) {
            const revision = old.revision + 1;
            const definition = item.trigger ?? await deps.openPullRequestTrigger!(current, old);
            if (definition.kind !== 'prComment' && definition.kind !== 'ciFailed') throw new Error('Unsupported fixture replacement');
            return AutomationTriggerDetailSchema.parse({ ...old, kind: definition.kind, revision, enabled: item.enabled ?? old.enabled,
              triggerDefinitionEnvelope: JSON.stringify('triggerDefinitionEnvelope' in definition ? definition.triggerDefinitionEnvelope
                : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, automationId: id,
                  triggerId: old.id, triggerRevision: revision, triggerKind: definition.kind }, definition })) });
          }
          return { ...old, ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
            ...(item.enabled === undefined && item.trigger === undefined ? {} : { revision: old.revision + 1 }) };
        }));
        const row: AutomationDefinitionDetail = { ...current,
          templateVersion: input.executionRecipe === undefined ? current.templateVersion : current.templateVersion + 1, enabled: input.enabled,
          assignments: input.assignments.map((value) => ({ machineId: value.machineId, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 1 })),
          workflowDefinitionId: input.workflowDefinitionId === undefined ? current.workflowDefinitionId : input.workflowDefinitionId,
          executionRecipe: input.executionRecipe ?? current.executionRecipe, triggers };
        rows.set(id, row); return row;
      },
      delete: async (id) => { rows.delete(id); },
    },
  };
  return { rows, deps, actions: createWorkflowTriggerActions(deps), loseSource: () => { artifacts.delete(workflow); } };
}

describe('workflow trigger Automation composition', () => {
  it('prepares Session birth triggers without writing or choosing the source Session', async () => {
    const { rows, deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const prepared = await actions.prepareSessionInitialTriggers({ project, initialTriggers: [{
      target: { kind: 'workflow', ref: workflow },
      trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } },
    }] });
    expect(rows.size).toBe(0);
    expect(prepared).toMatchObject([{ workflowDefinitionId: workflow, assignments: [{ machineId: project.machineId }],
      executionRecipe: { v: 2, workflow: { t: 'plain', v: { workspace: { directory: project.directory } } } },
      triggers: [{ trigger: { events: ['sessionStarted'] } }] }]);
    expect(prepared[0]).not.toHaveProperty('scopeSessionId');
    expect(prepared[0]?.triggers[0]?.trigger).not.toHaveProperty('sourceSessionId');
    await expect(actions.prepareSessionInitialTriggers({ project, initialTriggers: [{
      target: { kind: 'workflow', ref: workflow }, trigger,
    }], caller: { ...ownCaller, agentStartContext: { ...ownCaller.agentStartContext, workDepthLimit: 0 } } }))
      .rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(rows.size).toBe(0);
  });
  it('enables only the selected trigger of a disabled plural set in one revision transition', async () => {
    const { rows, actions } = fixture();
    const first = await actions.add({ workflow, project, trigger });
    const second = await actions.add({ workflow, project, trigger });
    const disabled = await actions.update({ automationId: first.set.automationId,
      expectedRevision: second.set.revision, patch: { enabled: false } });
    const enabled = await actions.update({ automationId: first.set.automationId, triggerId: second.triggerId,
      expectedRevision: disabled.set.revision, patch: { enabled: true } });
    expect(enabled.set).toMatchObject({ enabled: true, revision: disabled.set.revision + 1,
      triggers: [{ id: first.triggerId, enabled: false }, { id: second.triggerId, enabled: true }] });
    expect(rows.get(first.set.automationId)?.enabled).toBe(true);
  });
  it('summarizes attached disabled triggers from the public list without opening private context or session-scoped sets', async () => {
    const { deps, rows, actions } = fixture();
    const saved = await actions.add({ workflow, project, trigger: { ...trigger, enabled: false } });
    const row = rows.get(saved.set.automationId)!;
    rows.set('session-only', { ...row, id: 'session-only', scopeSessionId: 'session-one' });
    const read = createWorkflowTriggerActions({ ...deps, automations: { ...deps.automations,
      get: async () => { throw new Error('summary_must_not_open_private_detail'); } },
      openContext: async () => { throw new Error('summary_must_not_open_private_context'); } });
    expect(await read.readWorkflowSummaries()).toEqual(new Map([[workflow, {
      triggers: [{ kind: 'schedule', schedule: trigger.schedule }], nextRunAt: null,
    }]]));
  });
  it('uses the earliest enabled scheduler occurrence across attached sets without recomputing schedules', async () => {
    const { rows, actions } = fixture();
    const saved = await actions.add({ workflow, project, trigger });
    const row = rows.get(saved.set.automationId)!;
    const scheduled = row.triggers[0]!;
    if (scheduled.kind !== 'schedule') throw new Error('Expected schedule');
    rows.set(row.id, { ...row, triggers: [
      { ...scheduled, nextRunAt: 900 }, { ...scheduled, id: AutomationTriggerIdSchema.parse('earlier'), nextRunAt: 400 },
      { ...scheduled, id: AutomationTriggerIdSchema.parse('disabled'), enabled: false, nextRunAt: 100 },
    ] });
    rows.set('disabled-set', { ...row, id: 'disabled-set', enabled: false, triggers: [{ ...scheduled, nextRunAt: 50 }] });
    rows.set('session-set', { ...row, id: 'session-set', scopeSessionId: 'session', triggers: [{ ...scheduled, nextRunAt: 10 }] });
    expect((await actions.readWorkflowSummaries()).get(workflow)).toMatchObject({ nextRunAt: 400 });
    rows.set(row.id, { ...row, triggers: [{ ...scheduled, nextRunAt: null }] });
    expect((await actions.readWorkflowSummaries()).get(workflow)).toMatchObject({ nextRunAt: null });
  });
  it('preserves cancellation instead of turning it into link unavailability', async () => {
    const { deps } = fixture();
    const controller = new AbortController();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: { listLinks: async () => { controller.abort(new Error('cancelled')); controller.signal.throwIfAborted(); return []; },
        attach: async () => undefined, removeTrigger: async () => undefined },
    });
    await expect(actions.sessionList({ sessionId: 'session-one' }, { signal: controller.signal })).rejects.toThrow('cancelled');
  });
  it.each(['rejected', 'unavailable', 'not-configured'] as const)('lists ordinary Session triggers when PR links are %s', async (failure) => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      ...(failure === 'not-configured' ? {} : { pullRequests: {
        listLinks: async () => { throw Object.assign(new Error(failure), { code: failure === 'rejected' ? 'denied' : 'target_unavailable' }); },
        attach: async () => undefined, removeTrigger: async () => undefined,
      } }),
    });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    await expect(actions.sessionList({ sessionId: 'session-one' })).resolves.toMatchObject({
      sessionId: 'session-one', sets: [added.set], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' },
    });
  });

  it.each(['prComment', 'ciFailed'] as const)('attaches %s through the PR binding owner and returns its link', async (triggerKind) => {
    const { deps } = fixture();
    const bindings = new Map<string, { provider: 'github'; repository: string; number: number }>();
    const selected = { repository: 'happier-dev/happier', number: 42 };
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: {
        listLinks: async () => [...bindings.values()],
        attach: async ({ triggerId, pullRequest }) => { bindings.set(triggerId, { provider: 'github', ...pullRequest }); },
        removeTrigger: async () => undefined,
      },
    });
    const result = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow },
      trigger: { kind: triggerKind, enabled: true, pullRequest: selected } });
    expect(result.set.triggers).toMatchObject([{ kind: triggerKind, pullRequest: selected }]);
    expect(await actions.sessionList({ sessionId: 'session-one' })).toMatchObject({
      sessionId: 'session-one', pullRequestLinks: [{ provider: 'github', ...selected }],
    });
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: result.triggerId! });
    const afterRemoval = await actions.sessionList({ sessionId: 'session-one' });
    expect(afterRemoval.sets.flatMap((set) => set.triggers)).toEqual([]);
    expect(afterRemoval.pullRequestLinks).toEqual([{ provider: 'github', ...selected }]);
  });

  it('requires a selected or single linked PR before writing a scoped PR trigger', async () => {
    const { deps, rows } = fixture();
    let links: { provider: 'github'; repository: string; number: number }[] = [];
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }),
      pullRequests: { listLinks: async () => links, attach: async () => undefined, removeTrigger: async () => undefined },
    });
    const request = { sessionId: 'session-one', target: { kind: 'workflow' as const, ref: workflow },
      trigger: { kind: 'prComment' as const, enabled: true } };
    await expect(actions.sessionAdd(request)).rejects.toMatchObject({ code: 'pull_request_link_required' });
    expect(rows.size).toBe(0);
    links = [{ provider: 'github', repository: 'happier-dev/happier', number: 42 }];
    expect((await actions.sessionAdd(request)).set.triggers).toMatchObject([{ kind: 'prComment', pullRequest: { repository: links[0]!.repository, number: 42 } }]);
    links.push({ provider: 'github', repository: 'happier-dev/happier', number: 43 });
    await expect(actions.sessionAdd(request)).rejects.toMatchObject({ code: 'pull_request_link_required' });
  });

  it('registers one exact run notification and removes its observation on cancellation', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run finished' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'workflow_run' as const, runId: 'run-one' }, condition: 'terminal' as const } };
    const first = await actions.add(request);
    const replay = await actions.add(request);
    expect(replay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect(first.set.triggers).toMatchObject([{ kind: 'runLifecycle', remainingOccurrences: 1,
      source: request.trigger.source, condition: 'terminal' }]);
    // Terminal catch-up can commit before the registration acknowledgement.
    // The external persisted projection now describes the consumed intent.
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    const completedReplay = await actions.add(request);
    expect(completedReplay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect(completedReplay.set.triggers).toMatchObject([{ remainingOccurrences: 0, status: { state: 'finished' } }]);
    await actions.remove({ automationId: first.set.automationId, triggerId: first.triggerId! });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(0);
    expect((await actions.add(request)).triggerId).not.toBe(first.triggerId);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
  });

  it('rearms an exhausted Run attention observation instead of acknowledging it as waiting', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run needs you' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'workflow_run' as const, runId: 'run-one' }, condition: 'needs_attention' as const } };
    const first = await actions.add(request);
    expect((await actions.add(request)).triggerId).toBe(first.triggerId);
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    const rearmed = await actions.add(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect(rearmed.set.triggers).toMatchObject([{ remainingOccurrences: 1, status: { state: 'waiting' } }]);
  });

  it('rearms terminal observation when the exact execution Run has resumed', async () => {
    const { deps, rows } = fixture();
    let terminal = true;
    const actions = createWorkflowTriggerActions({ ...deps, resolveRunSource: async () => ({ terminal }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Run finished' } } }] });
    const request = { project, target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'runLifecycle' as const, enabled: true,
        source: { kind: 'execution_run' as const, machineId: 'machine-one', runId: 'run-one' }, condition: 'terminal' as const } };
    const first = await actions.add(request);
    const retained = rows.get(first.set.automationId)!;
    rows.set(retained.id, { ...retained, triggers: retained.triggers.map(item => item.kind === 'runLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    expect((await actions.add(request)).triggerId).toBe(first.triggerId);
    // The genuine source-read boundary now reports the same Run's resumed state.
    terminal = false;
    const rearmed = await actions.add(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect(rearmed.set.triggers).toMatchObject([{ remainingOccurrences: 1, status: { state: 'waiting' } }]);
  });

  it('rejoins a one-shot session notification through the same Action owner, and cancellation removes it', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'This turn finished' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['parentTurnCompleted' as const, 'parentTurnFailed' as const, 'parentTurnCancelled' as const],
        policy: { kind: 'currentTurn' as const, sourceTurnId: 'turn-one' } } };
    const first = await actions.sessionAdd(request);
    const replay = await actions.sessionAdd(request);
    expect(replay.triggerId).toBe(first.triggerId);
    expect(rows.size).toBe(1);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
    await actions.sessionRemove({ sessionId: request.sessionId, triggerId: first.triggerId! });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(0);
    const rearmed = await actions.sessionAdd(request);
    expect(rearmed.triggerId).not.toBe(first.triggerId);
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(1);
  });

  it('keeps a needs-me one-shot distinct from exact-turn completion and from repeating notifications', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    expect((await actions.sessionAdd(request)).triggerId).toBe(first.triggerId);
    await actions.sessionAdd({ ...request, trigger: { ...request.trigger, policy: { kind: 'everyMatch' } } });
    await actions.sessionAdd({ ...request, trigger: { ...request.trigger, policy: { kind: 'everyMatch' } } });
    expect([...rows.values()].flatMap((row) => row.triggers)).toHaveLength(3);
  });

  it('does not acknowledge an exhausted needs-me trigger as a newly armed observation', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    const row = [...rows.values()][0]!;
    rows.set(row.id, { ...row, triggers: row.triggers.map((item) => item.kind === 'sessionLifecycle'
      ? { ...item, remainingOccurrences: 0, status: { state: 'finished', runId: null } } : item) });
    expect((await actions.sessionAdd(request)).triggerId).not.toBe(first.triggerId);
  });

  it('rejoins the same observation at the authorized Machine after Session placement changes', async () => {
    const { deps } = fixture();
    let machineId = 'machine-one';
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveSession: async () => ({ project: { ...project, machineId }, nativeGoalOwner: false }) });
    const notice = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notify',
      actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Needs you' } } }] });
    const request = { sessionId: 'session-one', target: { kind: 'inline' as const, definition: notice },
      trigger: { kind: 'sessionLifecycle' as const, sourceSessionId: 'session-one', enabled: true,
        events: ['userActionRequired' as const], policy: { kind: 'firstMatch' as const } } };
    const first = await actions.sessionAdd(request);
    machineId = 'machine-two';
    const moved = await actions.sessionAdd(request);
    expect(moved.triggerId).toBe(first.triggerId);
    expect(moved.set.project?.machineId).toBe('machine-two');
  });

  it('keeps a Session caller under agent policy through Account trigger approval and replay', async () => {
    const { deps, rows } = fixture();
    const observations: ActionExecutorContext[] = [];
    const triggers = createWorkflowTriggerActions({ ...deps,
      resolveSession: async (_sessionId, caller) => {
        if (caller) observations.push(caller);
        return { project, nativeGoalOwner: false };
      },
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [] }), read: async () => null,
      create: async () => { throw new Error('Unexpected Artifact write'); },
      update: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => ({ ok: true }),
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: async () => undefined });
    let storedRequest: ApprovalRequest | null = null;
    let policyFactsAvailable = true;
    let currentTurnDepth = 0;
    const createExecutor = (
      approvalPorts: Partial<Pick<ActionExecutorDeps, 'approvalsGet' | 'approvalsUpdate'>> = {},
    ): ReturnType<typeof createActionExecutor> => createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, triggers,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } },
    }),
      approvalsCreate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'session-agent-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.caller.kind === 'session'
        && origin.caller.sessionId === 'session-one',
      // Account trigger approval is mandatory even when configurable policy waives it.
      isActionApprovalRequired: () => false,
      resolveAgentStartContext: async () => policyFactsAvailable ? { ...ownCaller.agentStartContext,
        caller: { ...ownCaller.agentStartContext.caller, turnDepth: currentTurnDepth } } : null,
      observeActionExecution: async ({ context }) => { observations.push(context); },
      ...approvalPorts,
    });
    const executor = createExecutor();
    const context: ActionExecutorContext = { ...ownCaller, surface: 'cli', authority: 'account_automation',
      serverId: 'home-one', actionRequestId: 'session-action-request', defaultSessionId: 'untrusted-default', callerPermissionMode: 'default',
      approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'session-one', toolCallId: 'tool-one' },
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } };
    expect(await executor.execute('workflow.trigger.list', { scope: 'account_inline' }, context)).toMatchObject({ ok: true, result: { sets: [] } });
    expect(await executor.execute('session.trigger.add', {
      sessionId: 'foreign-session', target: { kind: 'inline', definition }, trigger,
    }, context)).toMatchObject({ ok: false });
    expect(rows.size).toBe(0);
    expect(await executor.execute('session.trigger.add', {
      sessionId: 'session-one', target: { kind: 'inline', definition }, trigger,
    }, context)).toMatchObject({ ok: true, result: { set: { health: 'available' } } });
    expect(rows.size).toBe(1);
    expect(observations.at(-1)).toMatchObject({ surface: 'agent', defaultSessionId: 'session-one',
      actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } });
    policyFactsAvailable = false;
    const { agentStartContext: _agentStartContext, ...withoutDepth } = context;
    expect(await executor.execute('session.trigger.list', { sessionId: 'session-one' }, withoutDepth))
      .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ health: 'available' })] } });
    expect(await executor.execute('session.trigger.list', { sessionId: 'foreign-session' }, withoutDepth))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    policyFactsAvailable = true;
    const accountTrigger = await executor.execute('workflow.trigger.add', {
      target: { kind: 'inline', definition }, project, trigger,
    }, context);
    expect(accountTrigger.ok, JSON.stringify(accountTrigger)).toBe(true);
    expect(accountTrigger).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(rows.size).toBe(1);
    expect(storedRequest).toMatchObject({ executionOriginV1: { surface: 'agent',
      caller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } } });
    const captured = ApprovalRequestV2Schema.parse(storedRequest);
    expect(ApprovalRequestV2Schema.safeParse({ ...captured, executionOriginV1: { ...captured.executionOriginV1,
      caller: { kind: 'session', sessionId: 'session-one' } } }).success).toBe(false);
    expect(rows.size).toBe(1);
    currentTurnDepth = 50;
    // A fresh daemon executor has no originating invocation/turn closure.
    // It opens the persisted caller depth and resolves current baseline facts.
    expect(await createExecutor().execute('approval.request.decide', {
      artifactId: 'session-agent-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home-one' })).toMatchObject({ ok: true });
    expect(rows.size).toBe(2);
    expect(storedRequest).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(observations.filter((entry) => entry.bypassApprovals).at(-1)).toMatchObject({ surface: 'agent',
      defaultSessionId: 'session-one', actionCaller: { kind: 'session', sessionId: 'session-one', starterDepth: 0, turnDepth: 0 } });
    policyFactsAvailable = false;
    expect(await executor.execute('session.trigger.list', { sessionId: 'session-one' }, withoutDepth))
      .toMatchObject({ ok: true, result: { sets: [expect.objectContaining({ health: 'available' })] } });
    expect(await executor.execute('session.trigger.list', { sessionId: 'foreign-session' }, withoutDepth))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const sessionRow = [...rows.values()].find((row) => row.scopeSessionId === 'session-one')!;
    expect(await executor.execute('session.trigger.remove', { sessionId: 'session-one', triggerId: sessionRow.triggers[0]!.id }, withoutDepth))
      .toMatchObject({ ok: true, result: { set: { triggers: [] } } });
  });
  it('validates and retains the selected Team before add or update', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveWorkflowTeamIds: async () => ['team-one', 'team-two'] });
    for (const visibleTeamId of [undefined, null, 'ungranted']) {
      await expect(actions.add({ workflow, project, trigger, ...(visibleTeamId === undefined ? {} : { visibleTeamId }) }))
        .rejects.toMatchObject({ code: 'visible_team_not_granted' });
    }
    expect(rows.size).toBe(0);
    const added = await actions.add({ workflow, project, trigger, visibleTeamId: 'team-two' });
    expect(added.set.context?.visibleTeamId).toBe('team-two');
    await expect(actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { visibleTeamId: 'ungranted' } })).rejects.toMatchObject({ code: 'visible_team_not_granted' });
    expect(rows.get(added.set.automationId)?.templateVersion).toBe(1);
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision, patch: { enabled: false } });
    expect(updated.set.context?.visibleTeamId).toBe('team-two');
  });
  it('does not project current one-shot recipes as predecessor Workflow triggers', async () => {
    const { rows, actions } = fixture();
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = rows.get(added.set.automationId)!;
    rows.set(row.id, { ...row, targetType: 'newSession', executionRecipe: {
      v: 1, templateVersion: 1, template: { t: 'plain', v: { v: 1, prompt: 'Review retained prompt' } }, triggerEvidence: null,
      target: { kind: 'newSession', spawn: { executionTarget: { serverId: 'source-server', machineId: project.machineId },
        directory: { kind: 'path', path: project.directory }, agentTarget: definition.defaults!.agentTarget! } },
    } });
    const listed = await actions.list({ scope: 'account_inline' });
    expect(listed.sets).toEqual([]);
    expect(rows.get(row.id)?.executionRecipe?.v).toBe(1);
  });
  it('excludes Session-scoped rows from the Account-inline census', async () => {
    const { actions, rows } = fixture();
    const scoped = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    const row = rows.get(scoped.set.automationId)!;
    rows.set(row.id, { ...row, scopeSessionId: 'session-owned' });
    const account = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    expect((await actions.list({ scope: 'account_inline' })).sets.map((set) => set.automationId)).toEqual([account.set.automationId]);
  });
  it('reuses the workflow set without resetting its frozen run context when another trigger is added', async () => {
    const { actions, rows } = fixture();
    const first = await actions.add({ workflow, project, trigger, executionTarget: { kind: 'detached_run' }, inputs: { repository: 'repo' } });
    const second = await actions.add({ workflow, project, trigger });
    expect(rows.size).toBe(1);
    expect(second.set.automationId).toBe(first.set.automationId);
    expect(second.set.triggers).toHaveLength(2);
    expect(second.set.context).toMatchObject({ executionTarget: { kind: 'detached_run' }, inputs: { repository: 'repo' } });
  });
  it('keeps inline definitions only in their payload and changes machine and workspace in one set write', async () => {
    const { actions, rows } = fixture();
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger });
    expect(rows.get(added.set.automationId)?.workflowDefinitionId).toBeNull();
    expect((await actions.list({ scope: 'account_inline' })).sets[0]?.target).toEqual({ kind: 'inline', definition });
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { project: { machineId: 'machine-two', directory: '/other' } } });
    expect(updated.set.project).toEqual({ machineId: 'machine-two', directory: '/other' });
    expect(rows.get(added.set.automationId)?.assignments.map((assignment) => assignment.machineId)).toEqual(['machine-two']);
    await expect(actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'currentness_conflict', details: { revision: updated.set.revision } });
    expect(rows.get(added.set.automationId)?.enabled).toBe(true);
  });
  it('shows missing sources and still removes their final trigger without deleting the Manual set', async () => {
    const { actions, rows, loseSource } = fixture();
    const added = await actions.add({ workflow, project, trigger });
    loseSource();
    expect((await actions.list({ workflow })).sets[0]?.health).toBe('source_unavailable');
    const removed = await actions.remove({ automationId: added.set.automationId, triggerId: added.triggerId! });
    expect(removed.set.triggers).toEqual([]);
    expect(rows.size).toBe(1);
    await actions.removeForWorkflow(workflow);
    expect(rows.size).toBe(0);
  });
  it('deletes every Account and Session trigger set referencing a deleted Artifact', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    await actions.add({ workflow, project, trigger });
    await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    await actions.sessionAdd({ sessionId: 'session-two', target: { kind: 'inline', definition }, trigger });
    await actions.removeForWorkflow(workflow);
    expect([...rows.values()]).toMatchObject([{ scopeSessionId: 'session-two', workflowDefinitionId: null }]);
  });
  it('admits Account agent add/update through the same materialized ORC trigger policy', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps,
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const added = await actions.add({ target: { kind: 'inline', definition }, project, trigger }, ownCaller);
    expect(added.set.health).toBe('available');
    const updated = await actions.update({ automationId: added.set.automationId, expectedRevision: added.set.revision,
      patch: { enabled: false } }, ownCaller);
    expect(updated.set.enabled).toBe(false);
    await expect(actions.add({ workflow, project, trigger }, { ...ownCaller,
      agentStartContext: { ...ownCaller.agentStartContext, caller: { ...ownCaller.agentStartContext.caller, turnDepth: 4 } },
    })).rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(rows.size).toBe(1);
  });
  it('keeps transient source reads retryable in the trigger list', async () => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions(deps);
    await actions.add({ workflow, project, trigger });
    const failure = Object.assign(new Error('Home unavailable'), { code: 'ECONNRESET' });
    const reader = createWorkflowTriggerActions({ ...deps, resolveWorkflow: async () => { throw failure; } });
    await expect(reader.list({ workflow })).rejects.toBe(failure);
  });
  it('uses the Automation owner filters for workflow, inline and scoped reads and deletion', async () => {
    const { deps } = fixture();
    const inputs: unknown[] = [];
    const actions = createWorkflowTriggerActions({ ...deps, automations: { ...deps.automations,
      list: async (input) => { inputs.push(input); return { automations: [], nextCursor: null }; } },
      resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    await actions.list({ workflow });
    await actions.list({ scope: 'account_inline' });
    await actions.sessionList({ sessionId: 'session-one' });
    await actions.removeForWorkflow(workflow);
    expect(inputs).toEqual([{ workflowDefinitionId: workflow }, { scope: 'account_inline' },
      { scopeSessionId: 'session-one' }, { workflowDefinitionId: workflow }]);
  });
  it('refuses agent writes when materialized trigger policy is absent', async () => {
    const { actions, rows } = fixture();
    await expect(actions.add({ target: { kind: 'inline', definition }, project, trigger }, { surface: 'agent' }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(rows.size).toBe(0);
  });
  it('attaches, lists, updates and removes scoped triggers using the authorized Session placement', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const scopedDefinition = WorkflowDefinitionV1Schema.parse({ ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'origin_session' } } });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition: scopedDefinition }, trigger,
      onComplete: { kind: 'originating_session' } });
    expect(rows.get(added.set.automationId)).toMatchObject({ scopeSessionId: 'session-one', assignments: [{ machineId: project.machineId }] });
    expect(added.set.context).toMatchObject({ workspace: { directory: project.directory }, onComplete: { kind: 'originating_session' } });
    expect(added.set.destinations).toMatchObject({ targetSessionIds: ['session-one'] });
    expect((await actions.sessionList({ sessionId: 'session-other' })).sets).toEqual([]);
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([]);
    const updated = await actions.sessionUpdate({ sessionId: 'session-one', triggerId: added.triggerId!, expectedRevision: added.set.revision,
      patch: { enabled: false } });
    expect(updated.set.triggers[0]?.enabled).toBe(false);
    await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! });
    expect((await actions.sessionList({ sessionId: 'session-one' })).sets[0]?.triggers).toEqual([]);
  });
  it('refuses native Keep going for humans and agents and never accepts caller placement', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: true }) });
    for (const caller of [undefined, ownCaller]) {
      await expect(actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }, caller))
        .rejects.toMatchObject({ code: 'native_goal_owner' });
    }
    const unauthorizedPlacement = { sessionId: 'session-one', target: { kind: 'inline' as const, definition }, trigger,
      project: { machineId: 'elsewhere', directory: '/elsewhere' } };
    await expect(actions.sessionAdd(unauthorizedPlacement)).rejects.toBeDefined();
    expect(rows.size).toBe(0);
  });
  it('reads and removes scoped triggers without requiring a reachable native goal control', async () => {
    const { deps } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async (_sessionId, _caller, options) => {
      // The Session transport is reachable, but its opened-runtime RPC is not.
      if (options?.checkNativeGoalOwner !== false) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
      return { project, nativeGoalOwner: null };
    } });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    expect((await actions.sessionList({ sessionId: 'session-one' })).sets).toHaveLength(1);
    expect((await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! })).set.triggers).toEqual([]);
    await expect(actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }))
      .rejects.toMatchObject({ code: 'target_unavailable' });
  });
  it('refuses scoped Event updates without Channel permission evidence but permits removal', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }) });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger });
    const row = rows.get(added.set.automationId)!;
    // Persisted network input may predate this Action's Channel-aware writer.
    rows.set(row.id, { ...row, triggers: [{ id: added.triggerId!, revision: 0, enabled: false, createdAt: 1, updatedAt: 1,
      kind: 'pluginEvent', eventRef: { pluginId: 'happier.channel.github', localId: 'pull-request-comment' }, sourceSelectorId: 'source',
      sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null,
      sourceCatalogStatus: null, triggerDefinitionEnvelope: '{}',
    }] });
    await expect(actions.sessionUpdate({ sessionId: 'session-one', triggerId: added.triggerId!, expectedRevision: added.set.revision,
      patch: { enabled: true } })).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(rows.get(row.id)?.triggers[0]?.enabled).toBe(false);
    expect((await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! })).set.triggers).toEqual([]);
  });
  it('admits direct own-session agent writes through ORC and denies unrelated Session writes', async () => {
    const { deps, rows } = fixture();
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }),
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const caller = ownCaller;
    await expect(actions.sessionAdd({ sessionId: 'unrelated', target: { kind: 'inline', definition }, trigger }, caller))
      .rejects.toMatchObject({ code: 'subtree_denied' });
    await expect(actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, {
      ...caller, agentStartContext: { ...caller.agentStartContext, caller: { ...caller.agentStartContext.caller, turnDepth: 4 } },
    })).rejects.toMatchObject({ code: 'work_depth_exceeded' });
    expect(rows.size).toBe(0);
    const own = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, caller);
    expect(own.set.health).toBe('available');
  });
  it('permits an originless run to remove exactly its own firing trigger without opening a missing source', async () => {
    const { deps, loseSource } = fixture();
    let firing: { sessionId: string; triggerId: string } | null = null;
    const actions = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner: false }),
      resolveRunTrigger: async () => firing });
    const added = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'workflow', ref: workflow }, trigger });
    firing = { sessionId: 'session-one', triggerId: added.triggerId! };
    const caller = { surface: 'agent' as const, actionCaller: { kind: 'workflowRun' as const, runId: 'run-one',
      authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'read-only' as const } } };
    await expect(actions.sessionRemove({ sessionId: 'other', triggerId: added.triggerId! }, caller)).rejects.toMatchObject({ code: 'run_access_denied' });
    await expect(actions.sessionRemove({ sessionId: 'session-one', triggerId: 'other-trigger' }, caller)).rejects.toMatchObject({ code: 'run_access_denied' });
    loseSource();
    expect((await actions.sessionRemove({ sessionId: 'session-one', triggerId: added.triggerId! }, caller)).set.triggers).toEqual([]);
  });
  it('consumes session trigger writes directly through the real Action executor without an approval', async () => {
    const { deps, rows } = fixture();
    let nativeGoalOwner = false;
    const triggers = createWorkflowTriggerActions({ ...deps, resolveSession: async () => ({ project, nativeGoalOwner }),
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }) });
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      list: async () => ({ items: [] }), read: async () => null,
      create: async () => { throw new Error('Unexpected Artifact write'); },
      update: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => ({ ok: true }),
    }, encodeListCursor: (row) => row.artifactId, assertDefinitionWriteAllowed: async () => undefined });
    const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, triggers,
      runs: { execute: async () => { throw new Error('Unexpected Run write'); } },
    }) });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger }, ownCaller))
      .toMatchObject({ ok: true, result: { set: { health: 'available' } } });
    expect(rows.size).toBe(1);
    nativeGoalOwner = true;
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'workflow', ref: 'builtin:keep-going' }, trigger }, ownCaller))
      .toMatchObject({ ok: false, errorCode: 'native_goal_owner' });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger: {
      kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'session-one', events: ['sessionStarted'], policy: { kind: 'everyMatch' },
    } }, ownCaller)).toMatchObject({ ok: false, errorCode: 'session_already_started' });
    expect(await executor.execute('session.trigger.add', { sessionId: 'session-one', target: { kind: 'inline', definition }, trigger: {
      kind: 'sessionLifecycle', enabled: true, sourceSessionId: 'foreign-session', events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
    } }, ownCaller)).toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(rows.size).toBe(1);
    const [row] = rows.values();
    expect(await executor.execute('session.trigger.remove', {
      sessionId: 'session-one', triggerId: row!.triggers[0]!.id,
    }, ownCaller)).toMatchObject({ ok: true, result: { set: { triggers: [] } } });
    expect(rows.get(row!.id)?.triggers).toEqual([]);
  });
});
