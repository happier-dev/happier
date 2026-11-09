import { describe, expect, it } from 'vitest';
import { materializeWorkflowAcceptedSnapshotV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from './materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowAcceptedSnapshotV1Schema } from './workflowDefinitionV1.js';
import { resolveWorkflowAcceptedStepSelectionV1 } from './workflowStepSelectionV1.js';
import { REVIEW_AND_CONVERGE_WORKFLOW_V1 } from './builtins/reviewAndConverge.js';
import { admitAgentStartV1 } from '../account/settings/admitAgentStartV1.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { LaunchProfileV2Schema } from '../profiles/v2/schema.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { RoleArtifactV1Schema } from '../prompts/roles/roleArtifactV1.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '../actions/actionCatalog.js';

const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const context = {
  source: { kind: 'inline' as const }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' as const },
  workspaceTarget: { project: { machineId: 'machine', directory: '/project', checkoutRootPath: '/project' } },
  origin: { kind: 'direct' as const }, authorization: { principal: { kind: 'host' as const } },
};
const definition = { version: 1, defaults: { agentTarget }, blocks: [{ kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] } }] };
const available = async () => true;
const emptyProfile = (id: string) => LaunchProfileV2Schema.parse({ v: 2, id, name: id,
  extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
  compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 });
function materialize(overrides: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = {}) {
  return materializeWorkflowAcceptedSnapshotV1({ definition, context, admission: { kind: 'user' }, effects: { resolveTargetAvailability: available }, ...overrides });
}

describe('accepted Workflow selection bindings', () => {
  it.each([
    { defaults: {}, execution: undefined, expected: 'profile:origin' },
    { defaults: { approvalProfileId: 'profile:default' }, execution: undefined, expected: 'profile:default' },
    { defaults: { approvalProfileId: 'profile:default' }, execution: { approvalProfileId: 'profile:step' }, expected: 'profile:step' },
    { defaults: { approvalProfileId: 'profile:default' }, execution: { approvalProfileId: null }, expected: null },
    { defaults: { approvalProfileId: null }, execution: undefined, expected: null },
  ])('freezes one reference for Agent and Action leaves with step/default/origin precedence ($expected)', async ({ defaults, execution, expected }) => {
    const accepted = await materialize({ definition: { ...definition, defaults: { agentTarget, ...defaults }, blocks: [
      { ...definition.blocks[0], execution },
      { kind: 'action', id: 'list', actionId: 'workflow.trigger.list', execution,
        input: { scope: { kind: 'literal', value: 'account_all' } } },
    ] }, context: { ...context, origin: { kind: 'direct', actionPolicy: {
      authority: 'account_automation', approvalProfileId: 'profile:origin',
    } } }, effects: { resolveTargetAvailability: available, readActionContract: async () =>
      freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec('workflow.trigger.list'))) },
    });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.snapshot.materializedLeaves.map(leaf => leaf.selection.approvalProfileId)).toEqual([expected, expected]);
  });
  it.each(['literal', 'input', 'item', 'model', 'child'] as const)('demands the selected Role at the canonical %s resolution and freezes its layered facts', async (kind) => {
    const roleId = 'selected-role';
    const reads: string[] = [];
    const source = RoleArtifactV1Schema.parse({ name: 'Selected', instructions: 'Source instructions',
      engine: { agentTargetKey: buildBackendTargetKeyV2(agentTarget) }, runsAs: { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off', enabled: true });
    const withRole = { ...definition, roles: [{ roleId, workspaceWrites: 'deny' }],
      defaults: { engine: { role: roleId } } };
    const launch = { executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/project' }, agentTarget, roleId };
    const authored = kind === 'literal' ? withRole : kind === 'child' ? { ...definition,
      blocks: [{ kind: 'workflow', id: 'nested', workflowRef: 'builtin:selected-child', input: {} }] }
      : kind === 'input' ? { ...withRole, defaults: {}, inputs: [{ name: 'chosen', valueType: 'json', required: true }],
        blocks: [{ ...definition.blocks[0], execution: { engine: { kind: 'input', name: 'chosen' } } }] }
      : kind === 'item' ? { ...withRole, defaults: {}, inputs: [{ name: 'choices', valueType: 'json', required: true }],
        blocks: [{ kind: 'loop', id: 'each', repetition: { kind: 'items', items: { kind: 'input', name: 'choices' },
          execution: 'parallel', failurePolicy: 'collect_outcomes' },
        body: [{ ...definition.blocks[0], execution: { engine: { kind: 'item', field: 'value' } } }] }] }
      : { ...withRole, defaults: {}, inputs: [{ name: 'chosen', valueType: 'json', required: true,
        inputType: { hostType: 'agentParticipant' } }],
        blocks: [{ ...definition.blocks[0], execution: { participant: { kind: 'input', name: 'chosen' } } }] };
    const inputs = kind === 'input' ? { chosen: { role: roleId } } : kind === 'item' ? { choices: [{ role: roleId }, { role: roleId }] }
      : kind === 'model' ? { chosen: { kind: 'model', launch } } : {};
    const effects = { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: withRole, sourceKey: 'builtin:selected-child' }),
      readRoleSelection: async (selectedId?: string) => {
        if (selectedId === undefined) return {};
        reads.push(selectedId);
        return { settingsRoles: { [selectedId]: source },
          settingsOverrides: { [selectedId]: { roleId: selectedId, instructionsOverride: 'Fresh settings instructions' } } };
      },
    };
    const accepted = await materialize({ definition: authored, context: { ...context, inputs },
      roleOverrides: [{ roleId, secondOpinion: 'encouraged' }], effects });
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, snapshot: { materializedLeaves: expect.arrayContaining([
      expect.objectContaining({ role: expect.objectContaining({ roleId, instructions: 'Fresh settings instructions',
        workspaceWrites: 'deny', secondOpinion: 'encouraged' }) }),
    ]) } });
    expect(reads).toEqual([roleId]);
    if (!accepted.ok) throw new Error(accepted.error.code);
    reads.length = 0;
    const replay = await materialize({ definition: authored, context: { ...context, inputs },
      replay: { snapshot: accepted.snapshot }, effects: { ...effects,
        readRoleSelection: async (selectedId?: string) => {
          if (selectedId === undefined) return {};
          reads.push(selectedId); throw new Error('Live Role source is unavailable');
        } } });
    expect(replay).toMatchObject({ ok: true });
    expect(reads).toEqual([]);
  });

  it('preserves a configured Agent identity from an engine option key through admission', async () => {
    const configured = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'configured' };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'engines', valueType: 'json', required: true }], blocks: [{
      kind: 'loop', id: 'planners', repetition: { kind: 'items', items: { kind: 'input', name: 'engines' }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ ...definition.blocks[0], execution: { engine: { kind: 'item', field: 'value' } } }],
    }] };
    expect(await materialize({ definition: authored, context: { ...context, inputs: { engines: [buildBackendTargetKeyV2(configured)] } } }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: { agentTarget: configured } }] } });
  });
  it('freezes an input roster for result-selected participants without admitting a new identity', async () => {
    const participants = [{ kind: 'session', session: { serverId: 'home', sessionId: 'one' } },
      { kind: 'session', session: { serverId: 'home', sessionId: 'two' } }];
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'participants', valueType: 'json', required: true,
      multiple: true, inputType: { hostType: 'agentParticipant' } }], blocks: [
      { kind: 'step', id: 'select', document: { text: 'Select', references: [], attachments: [] }, execution: { agentTarget } },
      { kind: 'loop', id: 'speakers', repetition: { kind: 'items', items: { kind: 'result', producer: { blockId: 'select', scope: { kind: 'current' } }, path: [] },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{ ...definition.blocks[0],
        execution: { participant: { kind: 'item', field: 'value', roster: 'participants' } } }] },
    ] };
    const result = await materialize({ definition: authored, context: { ...context, inputs: { participants } }, effects: {
      resolveTargetAvailability: available, resolveSessionTarget: async value => ({ address: value as { serverId: string; sessionId: string }, machineId: 'machine' }),
    } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const leaf = result.snapshot.materializedLeaves.find(leaf => leaf.blockId === 'work')!;
    expect(resolveWorkflowAcceptedStepSelectionV1(leaf, participants[1]).participant).toMatchObject({ kind: 'session', session: participants[1]!.session });
    expect(() => resolveWorkflowAcceptedStepSelectionV1(leaf, { kind: 'session', session: { serverId: 'home', sessionId: 'unadmitted' } }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
  it.each(['direct', 'engine_binding', 'child'] as const)('admits Discussion delivery to an attributed detached %s Agent through the existing result obligation', async topology => {
    const detached = { ...definition, blocks: [{ ...definition.blocks[0], execution: {
      executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' } } }] };
    const authored = topology === 'child' ? { ...definition, blocks: [{ kind: 'workflow', id: 'nested',
      workflowRef: 'plugin:external.workflow/detached', input: {} }] }
      : topology === 'engine_binding' ? { ...definition, inputs: [{ name: 'engine', valueType: 'json', required: true }],
        roles: [{ roleId: 'detached', name: 'Detached', instructions: 'Work', runsAs: { kind: 'background_run', intent: 'task' },
          engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }], blocks: [{ ...definition.blocks[0],
          execution: { engine: { kind: 'input', name: 'engine' }, conversation: { kind: 'fresh' } } }] } : detached;
    let observedTargets = 0;
    const effects = { resolveTargetAvailability: async () => { observedTargets += 1; return true; },
      readWorkflowDefinition: async () => ({ definition: detached, sourceKey: 'plugin:external.workflow/detached' }) };
    const inputs = topology === 'engine_binding' ? { engine: { role: 'detached' } } : {};
    expect(await materialize({ definition: authored, context: { ...context, inputs }, effects })).toMatchObject({ ok: true });
    observedTargets = 0;
    const discussion = { discussion: { serverId: 'home', discussionId: 'discussion-1' }, messageId: 'question-1', throughSeq: 1 };
    expect(await materialize({ definition: authored, context: { ...context, inputs,
      origin: { kind: 'direct', discussion }, resultDelivery: { kind: 'originating_discussion', ...discussion } }, effects }))
      .toMatchObject({ ok: true, snapshot: { resultDelivery: { kind: 'originating_discussion', ...discussion } } });
    expect(observedTargets).toBeGreaterThan(0);
  });
  it('freezes an input-selected existing participant on its own Home and Machine', async () => {
    const session = { serverId: 'home-b', sessionId: 'reviewer' };
    const participant = { kind: 'session', session };
    const authored = { version: 1, defaults: { agentTarget, permissionMode: 'read-only' }, inputs: [{ name: 'reviewer', valueType: 'json', required: true,
      inputType: { hostType: 'agentParticipant' } }], blocks: [{ ...definition.blocks[0],
      execution: { participant: { kind: 'input', name: 'reviewer' } } }] };
    const result = await materialize({ definition: authored, context: { ...context, inputs: { reviewer: participant } },
      effects: { resolveTargetAvailability: available, resolveSessionTarget: async value =>
        JSON.stringify(value) === JSON.stringify(session) ? { address: session, machineId: 'machine-b' } : null } });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{
      participant: { kind: 'session', session, machineId: 'machine-b' }, executionTarget: { kind: 'session' },
      selection: { conversation: { kind: 'existing_session', sessionId: 'reviewer', machineId: 'machine-b' } },
    }] } });
    if (!result.ok) return;
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot);
    expect(accepted.materializedLeaves[0]!.selection).toEqual({ conversation: {
      kind: 'existing_session', sessionId: 'reviewer', machineId: 'machine-b',
    } });
    expect(resolveWorkflowAcceptedStepSelectionV1(accepted.materializedLeaves[0]!, undefined, { reviewer: participant }).participant)
      .toEqual({ kind: 'session', session, machineId: 'machine-b' });
    expect(await materialize({ definition: authored, context: { ...context, inputs: { reviewer: participant } },
      effects: { resolveTargetAvailability: available, resolveSessionTarget: async () => ({
        address: session, machineId: 'replaced-machine',
      }) }, replay: { snapshot: accepted } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await materialize({ definition: authored, context: { ...context, inputs: { reviewer: participant },
      actionCaller: { kind: 'session', sessionId: 'starter', starterDepth: 0, turnDepth: 0 } },
      effects: { resolveTargetAvailability: available, resolveSessionTarget: async () => ({ address: session, machineId: 'machine-b' }) } }))
      .toMatchObject({ ok: false, error: { code: 'target_unavailable', reason: 'run_admission_unavailable' } });
  });

  it.each(['profile:step', null] as const)('freezes the complete model launch and approval reference for each admitted item choice (%s)', async approvalProfileId => {
    const launch = { executionTarget: { serverId: 'home-b', machineId: 'machine' },
      directory: { kind: 'path', path: '/review' }, agentTarget, permissionMode: 'read-only',
      profileId: 'review-profile', title: 'Reviewer', primaryTeamId: 'team-a' };
    const participant = { kind: 'model', launch };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'reviewers', valueType: 'json', multiple: true, required: true,
      inputType: { hostType: 'agentParticipant' } }], blocks: [{ kind: 'loop', id: 'opinions',
      repetition: { kind: 'items', items: { kind: 'input', name: 'reviewers' }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ ...definition.blocks[0], execution: { participant: { kind: 'item', field: 'value' }, approvalProfileId } }] }] };
    const result = await materialize({ definition: authored, context: { ...context, inputs: { reviewers: [participant] } },
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => emptyProfile('review-profile') } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot);
    expect(resolveWorkflowAcceptedStepSelectionV1(accepted.materializedLeaves[0]!, participant, accepted.inputs).selection.approvalProfileId)
      .toEqual(approvalProfileId);
    expect(resolveWorkflowAcceptedStepSelectionV1(accepted.materializedLeaves[0]!, participant, accepted.inputs).participant)
      .toEqual(participant);
    expect(() => resolveWorkflowAcceptedStepSelectionV1(accepted.materializedLeaves[0]!, {
      kind: 'model', launch: { ...launch, directory: { kind: 'path', path: '/different' } },
    }, accepted.inputs)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(await materialize({ definition: authored, context: { ...context, inputs: { reviewers: [{
      kind: 'model', launch: { ...launch, executionTarget: { ...launch.executionTarget, machineId: 'other-machine' } },
    }] } } })).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
    const empty = await materialize({ definition: authored, context: { ...context, inputs: { reviewers: [] } } });
    expect(empty).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ participantBindings: { selections: [] } }] },
      agentStartLeaves: [] });
  });

  it('uses the model launch permission for caller authority despite ambient defaults', async () => {
    const participant = { kind: 'model', launch: { executionTarget: { serverId: 'home-b', machineId: 'machine' },
      directory: { kind: 'path', path: '/review' }, agentTarget, permissionMode: 'yolo' } };
    const authored = { version: 1, defaults: { permissionMode: 'read-only' },
      inputs: [{ name: 'chosen', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } }],
      blocks: [{ ...definition.blocks[0], execution: { participant: { kind: 'input', name: 'chosen' } } }] };
    const contextWithChoice = { ...context, inputs: { chosen: participant } };
    expect(await materialize({ definition: authored, context: contextWithChoice }))
      .toMatchObject({ ok: true, agentStartLeaves: [{ facts: { permissionMode: 'yolo' } }] });
    expect(await materialize({ definition: authored, context: contextWithChoice,
      admission: { kind: 'agent', admitLeaf: async leaf => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, { caller: { kind: 'session', sessionId: 'origin', starterDepth: 1, turnDepth: 1 },
          baseline: { machineId: 'machine', directory: '/project', configuration: { agentTarget, permissionMode: 'default' } },
          ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only' }) } }))
      .toMatchObject({ ok: false });
    expect(await materialize({ definition: { ...authored, blocks: [{ ...definition.blocks[0],
      execution: { participant: { kind: 'input', name: 'chosen' }, permissionMode: 'read-only' } }] },
      context: contextWithChoice })).toMatchObject({ ok: true,
        snapshot: { materializedLeaves: [{ selection: { permissionMode: 'read-only' } }] },
        agentStartLeaves: [{ facts: { permissionMode: 'yolo' } }] });
  });

  it('freezes ordinary role model, profile and effort without dropping Team binding intent', async () => {
    const teamCredentialBindings = [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'credential',
      expectedResourceRevision: 3, deliveryMode: 'brokered' }];
    const launch = { executionTarget: { serverId: 'home-b', machineId: 'machine' },
      directory: { kind: 'path', path: '/review' }, agentTarget, roleId: 'custom', teamCredentialBindings };
    const definitionWithRole = { version: 1, defaults: {}, roles: [{ roleId: 'custom', name: 'Custom', instructions: 'Review',
      runsAs: { kind: 'session' }, engine: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'role-model', effort: 'high' },
      profileId: 'role-profile' }],
      inputs: [{ name: 'chosen', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } }],
      blocks: [{ ...definition.blocks[0], execution: { participant: { kind: 'input', name: 'chosen' } } }] };
    const result = await materialize({ definition: definitionWithRole,
      context: { ...context, inputs: { chosen: { kind: 'model', launch } } },
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => emptyProfile('role-profile') } });
    expect(result).toMatchObject({ ok: true, agentStartLeaves: [{ facts: {
      modelSelection: { ref: { modelId: 'role-model' } }, profileId: 'role-profile',
      configOptions: { reasoning_effort: { value: 'high' } },
    } }], snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: {
      modelSelection: { ref: { modelId: 'role-model' } }, profileId: 'role-profile',
      configuration: { options: { reasoning_effort: { value: 'high' } } }, teamCredentialBindings,
    } } }] } });
    if (!result.ok) return;
    expect(resolveWorkflowAcceptedStepSelectionV1(result.snapshot.materializedLeaves[0]!, undefined, result.snapshot.inputs)
      .participant).toEqual(result.snapshot.materializedLeaves[0]!.participant);
    expect(await materialize({ definition: definitionWithRole, context: { ...context, inputs: { chosen: { kind: 'model', launch } } },
      roleSelection: { settingsOverrides: { custom: { roleId: 'custom', engine: {
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'changed', effort: 'low',
      }, profileId: 'changed-profile' } } }, replay: { snapshot: result.snapshot } }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ participant: result.snapshot.materializedLeaves[0]!.participant }] } });
  });

  it('admits sparse Profile permission before caller policy and freezes its fallback across replay', async () => {
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'profile', name: 'Profile', extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: { 'agent:happier.agent.codex/codex': 'yolo' },
      defaultPersistenceModeByTargetKey: { 'agent:happier.agent.codex/codex': 'direct' },
      preferredModelSelection: { v: 1, updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'profile-model' } },
      compatibilityByTargetKey: { 'agent:happier.agent.codex/codex': true },
      createdAt: 1, updatedAt: 1 });
    const participant = { kind: 'model', launch: { executionTarget: { serverId: 'home-b', machineId: 'machine' },
      directory: { kind: 'path', path: '/review' }, agentTarget, profileId: profile.id } };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'chosen', valueType: 'json', required: true,
      inputType: { hostType: 'agentParticipant' } }], blocks: [{ ...definition.blocks[0],
      execution: { participant: { kind: 'input', name: 'chosen' } } }] };
    const chosenContext = { ...context, inputs: { chosen: participant } };
    const effects = { resolveTargetAvailability: available, readLaunchProfile: async () => profile };
    const accepted = await materialize({ definition: authored, context: chosenContext, effects });
    expect(accepted).toMatchObject({ ok: true, agentStartLeaves: [{ facts: { permissionMode: 'yolo' } }],
      snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: { permissionMode: 'yolo',
        modelSelection: { ref: { modelId: 'profile-model' } }, transcriptStorage: 'direct',
      } } }] } });
    expect(await materialize({ definition: authored, context: chosenContext, effects,
      admission: { kind: 'agent', admitLeaf: async leaf => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, { caller: { kind: 'session', sessionId: 'origin', starterDepth: 1, turnDepth: 1 },
          baseline: { machineId: 'machine', directory: '/project', configuration: { agentTarget, permissionMode: 'default' } },
          ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only' }) } }))
      .toMatchObject({ ok: false, error: { code: 'definition_exceeds_authority',
        cause: { code: 'permission_exceeds_ceiling' } } });
    if (!accepted.ok) return;
    const changedProfile = { ...profile, defaultPermissionModeByTargetKey: { 'agent:happier.agent.codex/codex': 'read-only' as const } };
    expect(await materialize({ definition: authored, context: chosenContext, replay: { snapshot: accepted.snapshot },
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => changedProfile } }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: {
        permissionMode: 'yolo',
      } } }] } });
    const configuration = { mode: { value: null, updatedAtMs: 1 }, model: { value: 'local-model', updatedAtMs: 1 },
      permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} };
    const configured = await materialize({ definition: authored, context: { ...context, inputs: { chosen: {
      kind: 'model', launch: { ...participant.launch, configuration },
    } } }, effects });
    expect(configured).toMatchObject({ ok: true, agentStartLeaves: [{ facts: {
      permissionMode: 'read-only', modelSelection: { modelId: 'local-model' },
    } }],
      snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: { permissionMode: 'read-only' } } }] } });
    if (configured.ok) expect(configured.snapshot.materializedLeaves[0]!.participant?.kind === 'model'
      ? configured.snapshot.materializedLeaves[0].participant.launch.modelSelection : undefined).toBeUndefined();
    const noDefault = await materialize({ definition: authored, context: chosenContext,
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => emptyProfile(profile.id) } });
    expect(noDefault).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: {
      permissionMode: 'default',
    } } }] } });
    if (noDefault.ok) expect(await materialize({ definition: authored, context: chosenContext,
      replay: { snapshot: noDefault.snapshot }, effects }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ participant: { kind: 'model', launch: {
        permissionMode: 'default',
      } } }] } });
  });

  it.each(['constrained', 'automation', 'revoked'] as const)('checks current typed Session targets for %s authority without inventing a host grant', async scenario => {
    const address = { serverId: 'home', sessionId: 'review-target' };
    const result = await materialize({ definition: { version: 1, defaults: {}, inputs: [{ name: 'target', valueType: 'json',
      required: true, inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments', actionId: 'reviews.comments.list',
      input: { sessionId: { kind: 'input', name: 'target', path: ['sessionId'] } } }] },
      context: { ...context, inputs: { target: address }, actionCaller: scenario === 'constrained'
        ? { kind: 'session', sessionId: 'origin', starterDepth: 0, turnDepth: 0 }
        : { kind: 'automationRun', runId: 'run', automationId: 'automation', cause: { kind: 'manual', invokedAt: 1 } } },
      admission: scenario === 'constrained' ? { kind: 'user' } : { kind: 'trigger', workDepth: 0,
        admitLeaf: async () => ({ ok: true, stamped: { workDepth: 0 } }) },
      effects: { resolveTargetAvailability: available, resolveSessionTarget: async () => scenario === 'revoked' ? null : { address, machineId: 'machine' },
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
    });
    if (scenario === 'automation') expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ sessionAuthorityBindings: [
      { inputName: 'target', targets: [{ address, machineId: 'machine' }] },
    ] }] } });
    else expect(result).toMatchObject({ ok: false, error: { code: scenario === 'revoked' ? 'invalid_input' : 'target_unavailable' } });
  });

  it('freezes typed Session authority for Action-only nested frames without changing their conversation', async () => {
    const first = { serverId: 'home', sessionId: 'first' };
    const second = { serverId: 'home', sessionId: 'second' };
    const child = { version: 1, defaults: {}, inputs: [{ name: 'renamedTarget', valueType: 'json', required: true,
      inputType: { hostType: 'session' } }], blocks: [{ kind: 'action', id: 'comments', actionId: 'reviews.comments.list',
      input: { sessionId: { kind: 'input', name: 'renamedTarget', path: ['sessionId'] } } }] };
    const result = await materialize({ definition: { version: 1, defaults: {}, blocks: [first, second].map((value, index) => ({
      kind: 'workflow', id: `child-${index}`, workflowRef: 'builtin:child', input: { renamedTarget: { kind: 'literal', value } },
    })) }, effects: { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }),
      resolveSessionTarget: async value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.sessionId === 'string'
        ? { address: { serverId: 'home', sessionId: value.sessionId }, machineId: `${value.sessionId}-machine` } : null,
      readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }),
    } });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: expect.arrayContaining([expect.objectContaining({
      sourceKey: 'builtin:child', blockId: 'comments', sessionAuthorityBindings: [{ inputName: 'renamedTarget', targets: [
        { address: first, machineId: 'first-machine' }, { address: second, machineId: 'second-machine' },
      ] }],
    })]) } });
    if (!result.ok) throw new Error(result.error.code);
    const replay = await materialize({ definition: result.snapshot.authoredDefinition, context: { ...context, inputs: result.snapshot.inputs },
      replay: { snapshot: result.snapshot }, effects: { resolveTargetAvailability: available,
        resolveSessionTarget: async value => value && typeof value === 'object' && !Array.isArray(value) && value.sessionId === 'first'
          ? { address: first, machineId: 'first-machine' } : null,
      } });
    expect(replay).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [{ path: '/inputs/renamedTarget' }] } });
  });
  it('refuses Review & converge without an explicit or context-bound reviewSession at its input path', async () => {
    const result = await materialize({ definition: REVIEW_AND_CONVERGE_WORKFLOW_V1,
      context: { ...context, inputs: { engines: ['external.review/engine'] } } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [
      { code: 'missing_reference', path: '/inputs/reviewSession' },
    ] } });
  });

  it('binds a typed Session input to its own Machine and keeps an explicit target distinct from origin', async () => {
    const origin = { serverId: 'home', sessionId: 'origin' };
    const target = { serverId: 'home', sessionId: 'reviewed' };
    const authored = { version: 1, defaults: {}, inputs: [{ name: 'reviewSession', valueType: 'json', required: true,
      inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }], blocks: [{ ...definition.blocks[0],
      execution: { conversation: { kind: 'input', name: 'reviewSession' } } }] };
    const effects = { resolveTargetAvailability: available,
      resolveSessionTarget: async (value: unknown) => value === 'origin' || JSON.stringify(value) === JSON.stringify(origin) ? { address: origin, machineId: 'origin-machine' }
        : JSON.stringify(value) === JSON.stringify(target) ? { address: target, machineId: 'review-machine' } : null };
    const fromSession = await materialize({ definition: authored, context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } }, effects });
    expect(fromSession).toMatchObject({ ok: true, snapshot: { inputs: { reviewSession: origin }, materializedLeaves: [{
      executionTarget: { kind: 'session' }, selection: { conversation: { kind: 'existing_session', sessionId: 'origin', machineId: 'origin-machine' } },
    }] } });
    const explicit = await materialize({ definition: authored,
      context: { ...context, inputs: { reviewSession: target }, origin: { kind: 'direct', originSessionId: 'origin' } }, effects });
    expect(explicit).toMatchObject({ ok: true, snapshot: { inputs: { reviewSession: target }, materializedLeaves: [{
      selection: { conversation: { kind: 'existing_session', sessionId: 'reviewed', machineId: 'review-machine' } },
    }] } });
    const unavailableTarget = await materialize({ definition: authored,
      context: { ...context, inputs: { reviewSession: { serverId: 'other-home', sessionId: 'reviewed' } } }, effects });
    expect(unavailableTarget).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [{ path: '/inputs/reviewSession' }] } });
    const miswiredTarget = await materialize({ definition: authored, context: { ...context, inputs: { reviewSession: target } },
      effects: { ...effects, resolveSessionTarget: async () => ({ address: origin, machineId: 'origin-machine' }) } });
    expect(miswiredTarget).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [{ path: '/inputs/reviewSession' }] } });
  });

  it('freezes separate Session input witnesses for each use of a nested workflow', async () => {
    const first = { serverId: 'home', sessionId: 'first' };
    const second = { serverId: 'home', sessionId: 'second' };
    const child = { version: 1, defaults: {}, inputs: [{ name: 'target', valueType: 'json', required: true, inputType: { hostType: 'session' } }],
      blocks: [{ ...definition.blocks[0], execution: { conversation: { kind: 'input', name: 'target' } } }] };
    const result = await materialize({ definition: { version: 1, defaults: {}, blocks: [
      { kind: 'workflow', id: 'first', workflowRef: 'builtin:child', input: { target: { kind: 'literal', value: first } } },
      { kind: 'workflow', id: 'second', workflowRef: 'builtin:child', input: { target: { kind: 'literal', value: second } } },
    ] }, effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }),
      resolveSessionTarget: async value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.sessionId === 'string'
        ? { address: { serverId: 'home', sessionId: value.sessionId }, machineId: `${value.sessionId}-machine` } : null } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const leaf = WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot).materializedLeaves.find(leaf => leaf.sourceKey === 'builtin:child')!;
    expect(resolveWorkflowAcceptedStepSelectionV1(leaf, undefined, { target: first }).selection.conversation)
      .toEqual({ kind: 'existing_session', sessionId: 'first', machineId: 'first-machine' });
    expect(resolveWorkflowAcceptedStepSelectionV1(leaf, undefined, { target: second }).selection.conversation)
      .toEqual({ kind: 'existing_session', sessionId: 'second', machineId: 'second-machine' });
    expect(() => resolveWorkflowAcceptedStepSelectionV1(leaf, undefined, { target: { serverId: 'home', sessionId: 'third' } }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('keeps non-executable nested data inputs deferred while admitting Session context defaults', async () => {
    const child = { version: 1, defaults: { agentTarget }, inputs: [{ name: 'message', valueType: 'string', required: true }],
      blocks: [{ ...definition.blocks[0], input: [{ kind: 'input', name: 'message' }] }] };
    const result = await materialize({ definition: { version: 1, defaults: { agentTarget }, blocks: [
      { ...definition.blocks[0], id: 'prepare' },
      { kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: {
        message: { kind: 'result', producer: { blockId: 'prepare', scope: { kind: 'current' } }, path: [] },
      } },
    ] }, effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }) } });
    expect(result).toMatchObject({ ok: true });
  });

  it('freezes input-bound engines through the canonical selection and accepted snapshot reader', async () => {
    const reviewer = { kind: 'agent' as const, identity: { pluginId: 'external.agent', localId: 'reviewer' } };
    const inputs = { answerer: { agentTarget }, settings: { reviewer: { agentTarget: reviewer } } };
    const authored = { version: 1, inputs: [{ name: 'answerer', valueType: 'json', required: true }, { name: 'settings', valueType: 'json', required: true }],
      defaults: {}, blocks: [
        { ...definition.blocks[0], execution: { engine: { kind: 'input', name: 'answerer' } } },
        { ...definition.blocks[0], id: 'review', execution: { engine: { kind: 'input', name: 'settings', path: ['reviewer'] } } },
      ] };
    const result = await materialize({ definition: authored, context: { ...context, inputs } });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
      { blockId: 'work', selection: { agentTarget } }, { blockId: 'review', selection: { agentTarget: reviewer } },
    ] } });
    if (!result.ok) throw new Error(result.error.code);
    const accepted = WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot);
    inputs.answerer.agentTarget = reviewer;
    const replay = await materialize({ definition: authored, context: { ...context, inputs }, replay: { snapshot: accepted } });
    expect(replay).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
      { selection: { agentTarget } }, { selection: { agentTarget: reviewer } },
    ] } });
    expect(await materialize({ definition: authored, context: { ...context, inputs: { ...inputs, answerer: { agentTarget: reviewer, unexpected: true } } } }))
      .toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'work' } });
  });

  it('admits every finite item-bound engine and rejects items outside the accepted choices', async () => {
    const second = { kind: 'agent' as const, identity: { pluginId: 'external.agent', localId: 'second' } };
    const engines = [{ agentTarget }, { agentTarget: second }];
    const authored = { version: 1, inputs: [{ name: 'engines', valueType: 'json', required: true }], defaults: {}, blocks: [{
      kind: 'loop', id: 'panel', repetition: { kind: 'items', items: { kind: 'input', name: 'engines' },
        execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ ...definition.blocks[0], execution: { engine: { kind: 'item', field: 'value' }, conversation: { kind: 'fresh' } } }],
    }] };
    const checked: unknown[] = [];
    const result = await materialize({ definition: authored, context: { ...context, inputs: { engines } },
      effects: { resolveTargetAvailability: async leaf => { checked.push(leaf.selection.agentTarget); return true; } } });
    expect(result).toMatchObject({ ok: true });
    expect(checked).toEqual([agentTarget, second]);
    if (!result.ok) throw new Error(result.error.code);
    const acceptedLeaf = WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot).materializedLeaves[0]!;
    expect(acceptedLeaf).toMatchObject({
      engineBindings: { reference: { kind: 'item', field: 'value' }, selections: [
        { value: engines[0], selection: { agentTarget } }, { value: engines[1], selection: { agentTarget: second } },
      ] },
    });
    expect(resolveWorkflowAcceptedStepSelectionV1(acceptedLeaf, engines[1]).selection.agentTarget).toEqual(second);
    expect(() => resolveWorkflowAcceptedStepSelectionV1(acceptedLeaf, { role: 'unadmitted' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }));
    const empty = await materialize({ definition: authored, context: { ...context, inputs: { engines: [] } } });
    expect(empty).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ engineBindings: { selections: [] } }] } });
    expect(await materialize({ definition: authored, context: { ...context, inputs: { engines } },
      effects: { resolveTargetAvailability: async leaf => leaf.selection.agentTarget?.identity.localId !== 'second' } }))
      .toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
  });

  it('freezes distinct input-bound engines for repeated uses of one child definition', async () => {
    const second = { kind: 'agent' as const, identity: { pluginId: 'external.agent', localId: 'second' } };
    const child = { version: 1, inputs: [{ name: 'engine', valueType: 'json', required: true }], defaults: {},
      blocks: [{ ...definition.blocks[0], execution: { engine: { kind: 'input', name: 'engine' }, conversation: { kind: 'fresh' } } }] };
    const result = await materialize({ definition: { version: 1, defaults: {}, blocks: [
      { kind: 'workflow', id: 'one', workflowRef: 'builtin:child', input: { engine: { kind: 'literal', value: { agentTarget } } } },
      { kind: 'workflow', id: 'two', workflowRef: 'builtin:child', input: { engine: { kind: 'literal', value: { agentTarget: second } } } },
    ] }, effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }) } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const selected = result.snapshot.materializedLeaves.find(leaf => leaf.sourceKey === 'builtin:child')!;
    expect(resolveWorkflowAcceptedStepSelectionV1(selected, undefined, { engine: { agentTarget } }).selection.agentTarget).toEqual(agentTarget);
    expect(resolveWorkflowAcceptedStepSelectionV1(selected, undefined, { engine: { agentTarget: second } }).selection.agentTarget).toEqual(second);
  });

  it('refuses an Action engine binding rather than freezing one item as every Action target', async () => {
    const result = await materialize({ definition: { version: 1, defaults: {}, blocks: [{
      kind: 'loop', id: 'items', repetition: { kind: 'items', items: { kind: 'literal', value: [{ agentTarget }] },
        execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ kind: 'action', id: 'list', actionId: 'workflow.starters.list', input: {},
        execution: { engine: { kind: 'item', field: 'value' } } }],
    }] }, effects: { resolveTargetAvailability: available,
      readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }) } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'list' } });
  });

});
