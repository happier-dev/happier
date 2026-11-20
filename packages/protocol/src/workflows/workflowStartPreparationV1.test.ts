import { expect, it } from 'vitest';
import { WorkflowRunAcceptedContextV1Schema, WorkflowRunStartRequestV1Schema } from './actionsV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { prepareWorkflowRunStartV1, resolveWorkflowContextInputsV1 } from './workflowStartPreparationV1.js';
import * as preparation from './workflowStartPreparationV1.js';
import { materializeWorkflowAcceptedSnapshotV1, readWorkflowAcceptedAgentStartLeavesV1 } from './materializeWorkflowAcceptedSnapshotV1.js';
import { actionSpecToActionDefinitionV1 } from '../actions/actionCatalog.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { buildReviewStepsWorkflowV1 } from './builtins/reviewAndConverge.js';
import { ReviewStartInputSchema } from '../reviews/reviewStart.js';
import { ActionIdSchema } from '../actions/actionIds.js';

it.each([undefined, 'paid-profile'])('previews each accepted Review participant with its actual profile (%s)', async profileId => {
  const review = ReviewStartInputSchema.parse({ scope: 'repository', instructions: 'Review this repository.',
    ...(profileId ? { profileId, profileSourceCustody: { kind: 'development', registeredRootId: '/private/plugin-root' } } : {}), reviewers: [
    { kind: 'engine', engineId: 'pi', modelId: 'meta/muse-spark-1.3-contributor',
      sessionConfigOptionOverrides: { v: 1, updatedAt: 3, overrides: { reasoning_effort: { value: 'minimal', updatedAt: 3 } } } },
    { kind: 'session', session: { serverId: 'home', sessionId: 'existing-reviewer' } },
    { kind: 'model', launch: { executionTarget: { serverId: 'home', machineId: 'machine-a' },
      directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.pi', localId: 'pi' } },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: 'meta/muse-spark-1.3-contributor', updatedAtMs: 1 },
        permissionIntent: { value: 'read-only', updatedAtMs: 2 },
        options: { reasoning_effort: { value: 'minimal', updatedAtMs: 3 } },
      } } },
    { kind: 'person', principal: { kind: 'account', accountId: 'requested-reviewer' }, required: false },
  ] });
  const built = buildReviewStepsWorkflowV1(review, { reviewId: 'review', roundOrdinal: 1 });
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: built.definition,
    context: { source: { kind: 'inline' }, inputs: built.inputs, machineId: 'machine-a', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: {
      // Session identity, authority and execution reachability are external host facts.
      resolveTargetAvailability: async () => true,
      resolveSessionTarget: async () => ({ address: { serverId: 'home', sessionId: 'existing-reviewer' }, machineId: 'machine-a' }),
      admitSessionAuthority: async () => true,
      readActionContract: async actionId => {
        const action = actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(actionId)));
        return { inputSchema: StrictJsonValueSchema.parse(action.inputSchema),
          outputSchema: StrictJsonValueSchema.parse(action.outputSchema ?? {}) };
      },
    } });
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
  expect(accepted.snapshot.materializedLeaves.find(leaf => leaf.blockId === 'step-1-reviewer-3'))
    .toMatchObject({ participantBindings: { selections: [{ participant: { kind: 'model', launch: {
      permissionMode: 'read-only', configuration: {
        workspaceWrites: 'deny',
        model: { value: 'meta/muse-spark-1.3-contributor', updatedAtMs: 1 },
        options: { reasoning_effort: { value: 'minimal', updatedAtMs: 3 } },
      },
    } } }] } });
  expect(await readWorkflowAcceptedAgentStartLeavesV1(accepted.snapshot)).toContainEqual(
    expect.objectContaining({ blockId: 'step-1-reviewer-3', kind: 'session', workspaceWrites: 'deny' }),
  );
  const replay = { runId: '11111111-1111-4111-8111-111111111111', intent: 'another_round' as const };
  const prepared = prepareWorkflowRunStartV1({ definition: accepted.snapshot.authoredDefinition,
    acceptedContext: accepted.snapshot, replay });
  expect(prepared).toMatchObject({ reviewReviewers: [
    { id: 'step-1-reviewer-1', reviewer: { ...review.reviewers[0], ...(profileId
      ? { profileId, profileSourceCustody: review.profileSourceCustody } : {}) }, continuity: 'fresh' },
    { id: 'step-1-reviewer-2', reviewer: review.reviewers[1], continuity: 'continues' },
    { id: 'step-1-reviewer-3', reviewer: review.reviewers[2], continuity: 'fresh' },
    { id: 'step-1-reviewer-4', reviewer: review.reviewers[3], continuity: 'asked_again' },
  ], source: { replay } });
  expect(prepareWorkflowRunStartV1({ definition: built.definition,
    acceptedContext: { ...accepted.snapshot, materializedLeaves: [] }, replay })).not.toHaveProperty('reviewReviewers');
});

it('requires distinct admitted participants when the authored comparison declares a minimum', async () => {
  const definition = { inputs: [{ name: 'participants', valueType: 'json' as const, required: true, multiple: true,
    inputType: { hostType: 'agentParticipant' as const }, minItems: 2, uniqueItems: true }] };
  const participant = { kind: 'session', session: { serverId: 'home', sessionId: 'one' } };
  for (const participants of [[participant], [participant, participant]]) {
    await expect(resolveWorkflowContextInputsV1({ definition, inputs: { participants } })).rejects.toMatchObject({ code: 'invalid_input' });
  }
  await expect(resolveWorkflowContextInputsV1({ definition, inputs: { participants: [participant,
    { kind: 'session', session: { serverId: 'home', sessionId: 'two' } }] } })).resolves.toHaveProperty('participants');
});

it('prepares an accepted repeat with its concrete target and inputs through the strict start consumer', () => {
  const checked = validateWorkflowDefinition({ version: 1, defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'answerer' } },
  }, inputs: [
    { name: 'question', valueType: 'string', required: true },
  ], blocks: [{ kind: 'step', id: 'work', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] });
  if (!checked.valid || !checked.normalizedDefinition) throw new Error('invalid_definition_fixture');
  const definition = checked.normalizedDefinition;
  const acceptedContext = WorkflowRunAcceptedContextV1Schema.parse({ startedBy: 'user', source: { kind: 'inline' },
    inputs: { question: 'Retained question' }, machineId: 'machine-a', executionTarget: { kind: 'session' },
    materializedLeaves: [{ sourceKey: '$root', blockId: 'work', kind: 'step', selection: {},
      authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } }], frozenChildren: {},
    workspaceTarget: { project: { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' } },
    origin: { kind: 'direct', originSessionId: 'origin-session' },
  });
  const replay = { runId: '11111111-1111-4111-8111-111111111111', intent: 'another_round' as const };
  const prepared = prepareWorkflowRunStartV1({ definition, acceptedContext, replay });
  const request = WorkflowRunStartRequestV1Schema.parse({ runId: '22222222-2222-4222-8222-222222222222',
    source: prepared.source, inputs: prepared.inputs, executionTarget: prepared.executionTarget });
  expect(request).toMatchObject({ inputs: { question: 'Retained question' }, source: { replay,
    definition: { blocks: [{ execution: { executionTarget: { kind: 'detached_run' } } }] } } });
  expect(prepared).toMatchObject({ project: acceptedContext.workspaceTarget.project, originSessionId: 'origin-session' });
  expect(definition.blocks[0]).not.toHaveProperty('execution');
  expect(WorkflowRunStartRequestV1Schema.safeParse({ ...request, source: { ...request.source,
    replay: { ...replay, agentOverride: { sourceKey: '$root', blockId: 'work', roleId: 'planner' } } } }).success).toBe(false);
});

it('selects the first online install target, projects Change choices, and freezes it through real Workflow admission', async () => {
  const host = preparation.resolveCombinedActionWorkflowHostV1({ actionId: 'machines.setup.apply',
    machines: [{ machineId: 'offline', online: false }, { machineId: 'target-b', online: true },
      { machineId: 'target-a', online: true }, { machineId: 'created', online: true }],
    targetMachineIds: ['created', 'offline', 'target-a', 'target-b'], createdMachineIds: ['created'] });
  expect(host).toMatchObject({ kind: 'ready', machineId: 'target-a', review: { machineId: 'target-a' } });
  if (host.kind !== 'ready') throw new Error('host_unavailable');
  expect(host.review.machines.map(machine => machine.machineId)).toEqual(['offline', 'target-b', 'target-a']);
  const action = actionSpecToActionDefinitionV1(getActionSpec('workflow.starters.list'));
  const accepted = await materializeWorkflowAcceptedSnapshotV1({
    definition: { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'action', id: 'list', actionId: 'workflow.starters.list', input: {} },
    ] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId: host.machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: host.machineId, directory: '/host-project', checkoutRootPath: '/host-project' } },
      origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: {
      // Target reachability is a transport boundary; input/schema/materialization stay real.
      resolveTargetAvailability: async () => true,
      readActionContract: async () => ({ inputSchema: StrictJsonValueSchema.parse(action.inputSchema),
        outputSchema: StrictJsonValueSchema.parse(action.outputSchema ?? {}) }),
    },
  });
  expect(accepted).toMatchObject({ ok: true, snapshot: { machineId: 'target-a',
    workspaceTarget: { project: { machineId: 'target-a' } } } });
});

it('defaults agent calls to their own Machine and honors an explicit Change without selecting created Machines', () => {
  const input = { actionId: 'machines.setup.apply' as const, agentMachineId: 'agent',
    machines: [{ machineId: 'target', online: true }, { machineId: 'agent', online: true }, { machineId: 'created', online: true }],
    targetMachineIds: ['target'], createdMachineIds: ['created'] };
  expect(preparation.resolveCombinedActionWorkflowHostV1(input)).toMatchObject({ kind: 'ready', machineId: 'agent' });
  expect(preparation.resolveCombinedActionWorkflowHostV1({ ...input, selectedMachineId: 'target' }))
    .toMatchObject({ kind: 'ready', machineId: 'target' });
  expect(preparation.resolveCombinedActionWorkflowHostV1({ ...input, selectedMachineId: 'created' }))
    .toMatchObject({ kind: 'unavailable', code: 'machine_unavailable', machineId: 'created', role: 'controller' });
});

it('re-admits the reviewed Machine and reports offline/removed hosts without silently relocating', () => {
  for (const machines of [[{ machineId: 'reviewed', online: false }, { machineId: 'other', online: true }],
    [{ machineId: 'other', online: true }]]) {
    expect(preparation.admitCombinedActionWorkflowHostV1({ machineId: 'reviewed', machines }))
      .toEqual({ kind: 'unavailable', code: 'machine_unavailable', machineId: 'reviewed', role: 'controller' });
  }
  expect(preparation.admitCombinedActionWorkflowHostV1({ machineId: 'reviewed',
    machines: [{ machineId: 'reviewed', online: true }] })).toMatchObject({ kind: 'ready', machineId: 'reviewed' });
});
