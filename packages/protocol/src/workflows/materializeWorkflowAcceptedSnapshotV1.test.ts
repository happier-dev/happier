import { describe, expect, it } from 'vitest';
import { admitAgentStartV1, type AgentStartContextV1 } from '../account/settings/admitAgentStartV1.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
import type { ActionCaller } from '../actions/executor/types.js';
import { actionSpecToActionDefinitionV1 } from '../actions/actionCatalog.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { LaunchProfileV2Schema } from '../profiles/v2/schema.js';
import { REVIEW_AND_CONVERGE_WORKFLOW_V1 } from './builtins/reviewAndConverge.js';
import { PLAN_WITH_A_PANEL_WORKFLOW_V1 } from './builtins/planWithAPanel.js';
import { materializeWorkflowAcceptedSnapshotV1, materializeWorkflowDefinitionAuthorityV1, readWorkflowAcceptedAgentStartLeavesV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from './materializeWorkflowAcceptedSnapshotV1.js';
import { WorkflowAcceptedSnapshotV1Schema } from './workflowDefinitionV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';

const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const context = {
  source: { kind: 'inline' as const }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' as const },
  workspaceTarget: { project: { machineId: 'machine', directory: '/project', checkoutRootPath: '/project' } },
  origin: { kind: 'direct' as const }, authorization: { principal: { kind: 'host' as const } },
};
const definition = { version: 1, defaults: { agentTarget }, blocks: [{ kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] } }] };
const available = async () => true;
const finiteWorkspace = { workspaceId: 'workspace-a', serverId: 'home', machineId: 'machine-a', rootPath: '/project' };
function finiteInput(actionId: 'projects.script.run' | 'projects.compute.exec') {
  const workspace = { kind: 'literal' as const, value: finiteWorkspace };
  return actionId === 'projects.script.run'
    ? { workspace, selection: { kind: 'literal' as const, value: { kind: 'named', name: 'test' } } }
    : { workspace, executable: { kind: 'literal' as const, value: '/tools/echo' },
      argv: { kind: 'literal' as const, value: [] }, cwd: { kind: 'literal' as const, value: '/project' } };
}
async function finiteContract(actionId: 'projects.script.run' | 'projects.compute.exec') {
  const spec = getActionSpec(actionId);
  if (!spec.outputSchema) throw new Error('finite work requires its canonical result contract');
  const published = actionSpecToActionDefinitionV1(spec);
  return {
    inputSchema: published.inputSchema,
    outputSchema: published.outputSchema ?? {},
  };
}
function materialize(overrides: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = {}) {
  return materializeWorkflowAcceptedSnapshotV1({ definition, context, admission: { kind: 'user' }, effects: { resolveTargetAvailability: available }, ...overrides });
}
const policyContext: AgentStartContextV1 = {
  caller: { kind: 'session', sessionId: 'origin', starterDepth: 1, turnDepth: 1 },
  baseline: { machineId: 'machine', directory: '/project', configuration: { agentTarget, permissionMode: 'default' } },
  ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'yolo',
};

describe('materializeWorkflowAcceptedSnapshotV1', () => {
  it.each(['projects.script.run', 'projects.compute.exec'] as const)('freezes the accepted Machine into %s without implicit pool reselection', async (actionId) => {
    const acceptedMachine = 'machine-a';
    const result = await materialize({
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'finite', actionId, input: finiteInput(actionId) }] },
      context: { ...context, machineId: acceptedMachine,
        workspaceTarget: { project: { ...context.workspaceTarget.project, machineId: acceptedMachine } } },
      effects: { resolveTargetAvailability: available,
        readActionContract: async () => finiteContract(actionId) },
    });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{
      actionInput: { choice: { kind: 'primary' } },
    }] } });
    if (!result.ok) throw new Error(result.error.code);
    const replay = await materialize({ definition: result.snapshot.definition, replay: { snapshot: result.snapshot },
      context: { ...context, machineId: 'machine-b',
        workspaceTarget: { project: { ...context.workspaceTarget.project, machineId: 'machine-b' } } },
      effects: { resolveTargetAvailability: available, readActionContract: async () => finiteContract(actionId) },
    });
    expect(replay).toMatchObject({ ok: true, snapshot: { machineId: acceptedMachine, materializedLeaves: [{
      actionInput: { choice: { kind: 'primary' } },
    }] } });
  });

  it.each(['projects.script.run', 'projects.compute.exec'] as const)('keeps a distinct accepted worker exact for %s', async (actionId) => {
    const result = await materialize({
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'finite', actionId, input: finiteInput(actionId) }] },
      context: { ...context, machineId: 'worker-a',
        workspaceTarget: { project: { ...context.workspaceTarget.project, machineId: 'worker-a' } } },
      effects: { resolveTargetAvailability: available, readActionContract: async () => finiteContract(actionId) },
    });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{
      actionInput: { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-a' } } },
    }] } });
  });

  it('defers the finite default until a referenced workspace has actually resolved', async () => {
    const actionId = 'projects.script.run';
    const result = await materialize({
      definition: { version: 1, defaults: { agentTarget }, blocks: [definition.blocks[0], {
        kind: 'action', id: 'finite', actionId, input: { ...finiteInput(actionId),
          workspace: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] },
        },
      }] },
      context: { ...context, machineId: finiteWorkspace.machineId,
        workspaceTarget: { project: { ...context.workspaceTarget.project, machineId: finiteWorkspace.machineId } } },
      effects: { resolveTargetAvailability: available, readActionContract: async () => finiteContract(actionId) },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.snapshot.materializedLeaves[1]?.actionInput?.workspace).toEqual({ kind: 'unresolved' });
    expect(result.snapshot.materializedLeaves[1]?.actionInput).not.toHaveProperty('choice');
  });

  it.each([
    { kind: 'primary' },
    { kind: 'workers', destination: { kind: 'machine', machineId: 'machine-b' } },
  ])('retains an explicit finite target choice in the accepted snapshot: %j', async (choice) => {
    const result = await materialize({
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'finite', actionId: 'projects.script.run',
        input: { ...finiteInput('projects.script.run'), choice: { kind: 'literal', value: choice } } }] },
      context: { ...context, machineId: finiteWorkspace.machineId,
        workspaceTarget: { project: { ...context.workspaceTarget.project, machineId: finiteWorkspace.machineId } } },
      effects: { resolveTargetAvailability: available,
        readActionContract: async () => finiteContract('projects.script.run') },
    });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ actionInput: { choice } }] } });
  });

  it('freezes native continuation and launch environment into the accepted leaf', async () => {
    const spawn = { conversation: { kind: 'fresh' }, launchEnvironment: { values: { OPENAI_API_KEY: 'retained-value' }, unset: [] },
      providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } };
    const result = await materialize({ definition: { ...definition, defaults: { ...definition.defaults, ...spawn } } });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: spawn }] } });
    if (!result.ok) return;
    expect(WorkflowAcceptedSnapshotV1Schema.parse(result.snapshot).materializedLeaves[0]?.selection).toMatchObject(spawn);
  });
  it('checks the existing Agent-start environment policy for a Workflow launch environment', async () => {
    const result = await materialize({ definition: { ...definition, defaults: { ...definition.defaults,
      conversation: { kind: 'fresh' }, launchEnvironment: { values: { TOKEN: 'retained-value' }, unset: [] } } },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(
        { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false },
        { kind: 'workflow_run_leaf', leaf }, policyContext,
      ) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'environmentVariables' } });
  });
  it.each([
    { launchEnvironment: { values: { TOKEN: 'retained-value' }, unset: [] } },
    { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } },
  ])('refuses Session-only launch configuration on a detached leaf: %j', async (spawn) => {
    expect(await materialize({ definition: { ...definition, defaults: { ...definition.defaults, conversation: { kind: 'fresh' }, ...spawn } },
      context: { ...context, executionTarget: { kind: 'detached_run' } },
    })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
  });
  it('refuses launch environment removal that the Workflow Session spawn owner cannot apply', async () => {
    expect(await materialize({ definition: { ...definition, defaults: { ...definition.defaults,
      launchEnvironment: { values: {}, unset: ['TOKEN'] } } },
    })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
  it.each(['existing_session', 'origin_session', 'shared_run'] as const)('admits existing Session restart intent while refusing other reused launch configuration (%s)', async (kind) => {
    const conversation = kind === 'existing_session' ? { kind, sessionId: 'origin', machineId: 'machine' } : { kind };
    for (const spawn of [
      { launchEnvironment: { values: { TOKEN: 'retained-value' }, unset: [] } },
      { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } },
    ]) {
      const result = await materialize({ definition: { ...definition, blocks: [{ ...definition.blocks[0], execution: { conversation, ...spawn } }] },
        context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } },
      });
      expect(result).toMatchObject(kind === 'existing_session'
        ? { ok: true, snapshot: { materializedLeaves: [{ selection: spawn }] } }
        : { ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
    }
  });
  it('refuses native continuation when reusing an earlier step conversation', async () => {
    expect(await materialize({ definition: { ...definition, blocks: [definition.blocks[0], { ...definition.blocks[0], id: 'follow',
      execution: { conversation: { kind: 'from_step', producer: { blockId: 'work', scope: { kind: 'current' } } },
        providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } },
    }] } })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'follow' } });
  });
  it('refuses fresh-launch configuration on an implicit shared conversation', async () => {
    expect(await materialize({ definition: { ...definition, defaults: { ...definition.defaults,
      providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-session' } },
    } })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
  });
  it('keeps launch defaults on Agent leaves without projecting them onto a human Wait', async () => {
    const result = await materialize({ definition: { ...definition,
      defaults: { ...definition.defaults, conversation: { kind: 'fresh' },
        launchEnvironment: { values: { TOKEN: 'retained-value' }, unset: [] } },
      blocks: [definition.blocks[0], { kind: 'wait', id: 'approve', document: { text: 'Approve', references: [], attachments: [] } }],
    } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.materializedLeaves[0]?.selection.launchEnvironment)
      .toEqual({ values: { TOKEN: 'retained-value' }, unset: [] });
    expect(result.snapshot.materializedLeaves[1]?.selection.launchEnvironment).toBeUndefined();
    expect(validateWorkflowDefinition(result.snapshot.definition).valid).toBe(true);
  });
  it.each(['origin_session', 'existing_session', 'fresh'] as const)('charges start capacity only for a new Agent (%s)', async kind => {
    const conversation = kind === 'existing_session'
      ? { kind, sessionId: 'origin', machineId: 'machine' } : { kind };
    expect(await materialize({ definition: { ...definition, defaults: { ...definition.defaults, conversation } },
      context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } },
    })).toMatchObject({ ok: true, snapshot: { requiresMachineStartCapacity: kind === 'fresh',
      targetSessionIds: kind === 'fresh' ? [] : ['origin'] } });
  });

  it('freezes the deduplicated destination sessions across structural and nested leaves', async () => {
    const target = { kind: 'existing_session', sessionId: 'destination', machineId: 'machine' };
    const accepted = await materialize({
      definition: { ...definition, blocks: [
        { ...definition.blocks[0], execution: { conversation: { kind: 'origin_session' } } },
        { kind: 'parallel', id: 'parallel', failurePolicy: 'fail_stop', branches: [
          { id: 'branch', blocks: [{ ...definition.blocks[0], id: 'writes', execution: { conversation: target } }] },
        ] },
        { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
      ] },
      context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } },
      effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({
        sourceKey: 'builtin:child', definition: { ...definition, defaults: { ...definition.defaults, conversation: target } },
      }) },
    });
    expect(accepted).toMatchObject({ ok: true, snapshot: { targetSessionIds: ['origin', 'destination'] } });
  });

  it('replays frozen roles, children, placement and targets rather than today\'s graph', async () => {
    const role = { roleId: 'frozen_builder', name: 'Builder', instructions: 'Do not write',
      runsAs: { kind: 'background_run' as const, intent: 'delegate' as const },
      engine: { agentTargetKey: 'happier.agent.codex/codex' }, workspaceWrites: 'deny' as const,
      enabled: true, secondOpinion: 'off' as const };
    const authored = { ...definition, defaults: { engine: { role: 'frozen_builder' } }, blocks: [
      definition.blocks[0], { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
    ] };
    const original = await materialize({ definition: authored, roleSelection: { settingsRoles: { frozen_builder: role } },
      effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({
        definition: { ...definition, blocks: [{ ...definition.blocks[0], id: 'child', document: { text: 'Frozen child', references: [], attachments: [] } }] },
        sourceKey: 'builtin:child',
      }) } });
    expect(original, JSON.stringify(original)).toMatchObject({ ok: true });
    if (!original.ok) throw new Error(original.error.code);
    const replay = await materialize({ definition: original.snapshot.definition,
      ...{ replay: { snapshot: original.snapshot } },
      context: { ...context, machineId: 'other', workspaceTarget: { project: { machineId: 'other', directory: '/other', checkoutRootPath: '/other' } } },
      roleSelection: { settingsRoles: { frozen_builder: { ...role, workspaceWrites: 'allow' } } },
      effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({
        definition: { ...definition, blocks: [{ ...definition.blocks[0], id: 'changed' }] }, sourceKey: 'builtin:child',
      }) } });
    expect(replay).toMatchObject({ ok: true, snapshot: {
      workspaceTarget: original.snapshot.workspaceTarget, machineId: original.snapshot.machineId,
      frozenChildren: original.snapshot.frozenChildren, materializedLeaves: original.snapshot.materializedLeaves,
    } });
    if (!replay.ok) throw new Error(replay.error.code);
    expect(replay.agentStartLeaves[0]?.workspaceWrites).toBe('deny');
  });

  it('rebinds edited inputs and only one explicit Agent override while rechecking current policy', async () => {
    const authored = { ...definition, inputs: [{ name: 'request', valueType: 'string', required: true }], blocks: [
      definition.blocks[0], { kind: 'action', id: 'record', actionId: 'session.goal.set', input: { objective: { kind: 'input', name: 'request' } } },
    ] };
    const effects = { resolveTargetAvailability: available, readActionContract: async () => ({
      inputSchema: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] }, outputSchema: {},
    }) };
    const original = await materialize({ definition: authored, context: { ...context, inputs: { request: 'Before' } }, effects });
    if (!original.ok) throw new Error(original.error.code);
    const override = { sourceKey: '$root', blockId: 'work', engine: { agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
    const replayInput = { definition: original.snapshot.definition, context: { ...context, inputs: { request: 'After' } },
      replay: { snapshot: original.snapshot, agentOverride: override }, effects };
    expect(await materialize(replayInput)).toMatchObject({ ok: true, snapshot: {
      inputs: { request: 'After' }, materializedLeaves: [
        { blockId: 'work', selection: { agentTarget: override.engine.agentTarget } },
        { blockId: 'record', actionInput: { objective: 'After' } },
      ],
    } });
    expect(await materialize({ ...replayInput, admission: { kind: 'agent', admitLeaf: async leaf => admitAgentStartV1(
      { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowBackendTargetOverride: false },
      { kind: 'workflow_run_leaf', leaf }, policyContext,
    ) } })).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'agentTarget', blockId: 'work' } });
    expect(await materialize({ ...replayInput, replay: { snapshot: original.snapshot,
      agentOverride: { ...override, blockId: 'missing' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
  it('keeps a from-step conversation target when its one Agent engine is overridden', async () => {
    const original = await materialize({ definition: { ...definition, blocks: [definition.blocks[0],
      { ...definition.blocks[0], id: 'follow', execution: { conversation: {
        kind: 'from_step', producer: { blockId: 'work', scope: { kind: 'current' } },
      } } },
    ] } });
    if (!original.ok) throw new Error(original.error.code);
    const explicit = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const replay = await materialize({ replay: { snapshot: original.snapshot,
      agentOverride: { sourceKey: '$root', blockId: 'follow', engine: { role: 'other_agent' } } },
      roleSelection: { settingsRoles: { other_agent: { name: 'Other', instructions: 'Other role',
        runsAs: { kind: 'background_run', intent: 'delegate' }, engine: { agentTargetKey: 'happier.agent.claude/claude' },
        profileId: 'new-profile', workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } } } });
    expect(replay).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
        { blockId: 'work', selection: { agentTarget }, executionTarget: { kind: 'session' } },
        { blockId: 'follow', selection: { agentTarget: explicit, conversation: original.snapshot.materializedLeaves[1]?.selection.conversation },
          executionTarget: { kind: 'session' } },
      ] } });
    if (!replay.ok) throw new Error(replay.error.code);
    expect(replay.snapshot.materializedLeaves[1]?.selection.profileId).toBeUndefined();
  });
  it('replays the frozen nested Action engine instead of its unprojected authored payload', async () => {
    const explicit = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const original = await materialize({ definition: { ...definition, blocks: [
      { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
    ] }, effects: { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ sourceKey: 'builtin:child', definition: { ...definition, blocks: [
        { kind: 'action', id: 'review', actionId: 'review.start', execution: { engine: { agentTarget: explicit } },
          input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: ['agent:happier.agent.codex/codex'] } } },
      ] } }), readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }),
    } });
    if (!original.ok) throw new Error(original.error.code);
    const replay = await materialize({ replay: { snapshot: original.snapshot } });
    expect(replay).toMatchObject({ ok: true, snapshot: { materializedLeaves: original.snapshot.materializedLeaves },
      agentStartLeaves: [{ engine: { agentTargetKey: 'agent:happier.agent.claude/claude' } }] });
  });
  it.each([
    { name: 'manual', frozenStartedBy: 'trigger', expectedStartedBy: 'user', cause: { kind: 'manual', invokedAt: 1 } },
    { name: 'schedule', frozenStartedBy: 'user', expectedStartedBy: 'trigger', cause: AutomationRunCauseSchema.parse({
      kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1, triggerKind: 'schedule', occurrenceKey: 'A'.repeat(43),
      occurredAt: 1, evidence: { scheduledFor: 1 },
    }) },
  ] as const)('prioritizes an explicit $name Automation cause over a conflicting bounded plugin starter', async scenario => {
    const actionCaller = { kind: 'plugin', pluginId: 'acme.starter', startedBy: scenario.frozenStartedBy,
      initiatingCaller: { kind: 'automationRun', runId: 'automation-run', automationId: 'automation-1', cause: scenario.cause },
    } satisfies ActionCaller;
    const result = await materialize({ context: { ...context, actionCaller } });
    expect(result).toMatchObject({ ok: true, snapshot: { startedBy: scenario.expectedStartedBy } });
  });
  it('freezes the admitting starter independently of origin Session and depth', async () => {
    const user = await materialize({ context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } } });
    const agent = await materialize({ admission: { kind: 'agent', admitLeaf: async (leaf) =>
      admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } });
    const trigger = await materialize({ admission: { kind: 'trigger', workDepth: 0, admitLeaf: async (leaf) =>
      admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } });
    expect(user).toMatchObject({ ok: true, snapshot: { startedBy: 'user' } });
    expect(agent).toMatchObject({ ok: true, snapshot: { startedBy: 'agent' } });
    expect(trigger).toMatchObject({ ok: true, snapshot: { startedBy: 'trigger' } });
    if (!user.ok) throw new Error(user.error.code);
    const missing = { ...user.snapshot };
    Reflect.deleteProperty(missing, 'startedBy');
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(missing).success).toBe(false);
  });
  it('requires frozen workspace intent even for authored inheritance', async () => {
    const accepted = await materialize();
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.snapshot.materializedLeaves[0]?.authoredWorkspace).toEqual({ kind: 'inherit' });
    const incomplete = structuredClone(accepted.snapshot);
    Reflect.deleteProperty(incomplete.materializedLeaves[0]!, 'authoredWorkspace');
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(incomplete).success).toBe(false);
  });
  it.each(['workDepth', 'authoredDefinition', 'materializedLeaves', 'frozenChildren', 'metadata'] as const)(
    'requires every producer-frozen field when opening an accepted snapshot: %s', async (field) => {
    const accepted = await materialize();
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(accepted.snapshot).success).toBe(true);
    const incomplete = { ...accepted.snapshot };
    Reflect.deleteProperty(incomplete, field);
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(incomplete).success, field).toBe(false);
    const noOverrides = { ...accepted.snapshot };
    Reflect.deleteProperty(noOverrides, 'roleOverrides');
    expect(WorkflowAcceptedSnapshotV1Schema.safeParse(noOverrides).success).toBe(true);
  });
  it('rechecks current policy and leaf depth at claim while preserving the frozen firing depth', async () => {
    const claim = (workDepth: number, allowBackendTargetOverride: boolean) => materialize({
      admission: { kind: 'trigger', workDepth, admitLeaf: async (leaf, facts) => admitAgentStartV1(
        { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowBackendTargetOverride }, { kind: 'workflow_run_leaf', leaf }, {
          ...policyContext, caller: { kind: 'originless', runId: 'run', runDepth: workDepth },
          callerPermissionCeiling: facts.permissionCeiling,
        }) },
    });
    expect(await claim(3, true)).toMatchObject({ ok: true, snapshot: { workDepth: 3 } });
    expect(await claim(3, false)).toMatchObject({ ok: false,
      error: { code: 'policy_denied_field', field: 'agentTarget', blockId: 'work' } });
    expect(await claim(4, true)).toMatchObject({ ok: false,
      error: { code: 'work_depth_exceeded', blockId: 'work' } });
  });

  it.each([
    ['Review & converge', REVIEW_AND_CONVERGE_WORKFLOW_V1, { engines: ['agent:happier.agent.codex/codex'] }, 'review'],
    ['Plan with a panel', PLAN_WITH_A_PANEL_WORKFLOW_V1, { request: 'Plan the change', engines: ['agent:happier.agent.codex/codex'] }, 'plan'],
  ] as const)('admits an agent start of %s with runtime-bound Action engines', async (_name, authored, inputs, actionBlockId) => {
    const result = await materialize({ definition: authored,
      context: { ...context, inputs, origin: { kind: 'direct', originSessionId: 'origin' } },
      roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
        availableAgentTargetKeys: ['agent:happier.agent.codex/codex'] },
      effects: { resolveTargetAvailability: available,
        // The catalog boundary supplies contracts; the real role, binding and admission owners run below it.
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      admission: { kind: 'agent', admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, { ...policyContext,
          roles: facts.role ? { [facts.role.roleId]: facts.role } : {} }) },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, snapshot: { workDepth: 2,
      materializedLeaves: expect.arrayContaining([expect.objectContaining({ sourceKey: '$root', blockId: actionBlockId,
        kind: 'action', actionInput: expect.objectContaining({ [actionBlockId === 'review' ? 'engineIds' : 'backendTargetKeys']: [{ kind: 'unresolved' }] }) })]) } });
    if (!result.ok) throw new Error(result.error.code);
    const reread = await readWorkflowAcceptedAgentStartLeavesV1(result.snapshot);
    expect(reread.filter((leaf) => leaf.blockId === actionBlockId)).toMatchObject([
      { facts: { agentTarget }, engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } },
    ]);
  });
  it('checks every known item-loop Action engine against current Agent authority', async () => {
    const result = await materialize({ definition: REVIEW_AND_CONVERGE_WORKFLOW_V1,
      context: { ...context, inputs: { engines: ['agent:happier.agent.codex/codex', 'agent:happier.agent.claude/claude'] },
        origin: { kind: 'direct', originSessionId: 'origin' } },
      roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
        availableAgentTargetKeys: ['agent:happier.agent.codex/codex', 'agent:happier.agent.claude/claude'] },
      effects: { resolveTargetAvailability: available,
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      admission: { kind: 'agent', admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        { kind: 'workflow_run_leaf', leaf }, { ...policyContext, roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
          allowLists: { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: ['agent:happier.agent.codex/codex'] } }) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'agentTarget', blockId: 'review' } });
  });
  it.each(['explicit', 'default', 'child'] as const)('refuses an originless %s origin-session leaf at admission', async (placement) => {
    const originLeaf = { ...definition.blocks[0], execution: { conversation: { kind: 'origin_session' } } };
    const child = { ...definition, blocks: [originLeaf] };
    const authored = placement === 'child' ? { ...definition, blocks: [{ kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} }] }
      : placement === 'default' ? { ...definition, defaults: { ...definition.defaults, conversation: { kind: 'origin_session' } } }
        : child;
    const effects = { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }) };
    expect(await materialize({ definition: authored, effects })).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'work' } });
    expect(await materialize({ definition: authored, effects, context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } } }))
      .toMatchObject({ ok: true });
    // Definition authority has no future Run origin to bind yet.
    expect(await materializeWorkflowDefinitionAuthorityV1({ definition: authored, effects, context }))
      .toMatchObject({ ok: true });
  });

  it('retains lexical workspace intent separately from flattened leaf defaults', async () => {
    const workspace = { kind: 'new_worktree', source: { kind: 'workflow' } };
    const result = await materialize({ definition: { ...definition, defaults: { agentTarget, workspace }, blocks: [
      definition.blocks[0], { ...definition.blocks[0], id: 'explicit', execution: { workspace } },
    ] } });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
      { authoredWorkspace: { kind: 'inherit' } }, { authoredWorkspace: workspace },
    ] } });
  });
  it.each(['until', 'evaluate'] as const)('freezes input-bound %s rounds before effects and rejects invalid bounds', async (kind) => {
    const loop = { kind: 'loop', id: 'rounds', body: definition.blocks, repetition: {
      kind, maxIterations: { kind: 'input', name: 'rounds' },
      ...(kind === 'until' ? { stopWhen: { kind: 'exists', value: { kind: 'literal', value: true } } }
        : { history: 'none', evaluator: { ...definition.blocks[0], id: 'judge', result: { kind: 'decision', decisions: ['continue', 'done', 'stuck'] } } }),
    } };
    const authored = { ...definition, inputs: [{ name: 'rounds', valueType: 'number', required: true }], blocks: [loop] };
    const result = await materialize({ definition: authored, context: { ...context, inputs: { rounds: 3 } } });
    expect(result).toMatchObject({ ok: true, snapshot: { definition: { blocks: [{ repetition: { maxIterations: 3 } }] },
      authoredDefinition: { blocks: [{ repetition: { maxIterations: { kind: 'input', name: 'rounds' } } }] } } });
    expect(await materialize({ definition: { ...authored, inputs: [{ name: 'rounds', valueType: 'number', required: false, default: 2 }] } }))
      .toMatchObject({ ok: true, snapshot: { definition: { blocks: [{ repetition: { maxIterations: 2 } }] } } });
    for (const rounds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let effect = false;
      expect(await materialize({ definition: authored, context: { ...context, inputs: { rounds } }, effects: {
        resolveTargetAvailability: async () => { effect = true; return true; },
      } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(effect).toBe(false);
    }
    expect(await materialize({ definition: { ...authored, inputs: [{ name: 'rounds', valueType: 'string', required: true }] },
      context: { ...context, inputs: { rounds: '3' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
  it('preserves a cleared ACP mode for frozen execution and authority comparisons', async () => {
    const authored = { ...definition, defaults: { agentTarget, acpSessionModeId: null } };
    const result = await materialize({ definition: authored });
    expect(result).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: { acpSessionModeId: null } }] } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.agentStartLeaves[0]?.facts.agentModeId).toBeNull();
    expect(result.snapshot.definition.blocks[0]).toMatchObject({ execution: { acpSessionModeId: null } });
    expect(await materialize({ definition: authored, admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(
      { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowAgentModeOverride: false }, { kind: 'workflow_run_leaf', leaf }, {
        ...policyContext, baseline: { ...policyContext.baseline, configuration: { ...policyContext.baseline.configuration, agentModeId: 'code' } },
      }) } })).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'agentModeId', blockId: 'work' } });
  });

  it('accepts and replays the published native Action contract rather than substituting today\'s schema', async () => {
    const published = actionSpecToActionDefinitionV1(getActionSpec('session.goal.set'));
    const contract = { inputSchema: published.inputSchema, outputSchema: published.outputSchema ?? {} };
    // The first-party Action projection is not an extension of the plugin draft-07 ABI.
    expect(() => compilePluginJsonSchema(contract.inputSchema)).toThrow();
    const authored = { version: 1, blocks: [{ kind: 'action', id: 'goal', actionId: published.id,
      input: { sessionId: { kind: 'literal', value: 'origin' }, objective: { kind: 'literal', value: 'Finish' } } }] };
    const original = await materialize({ definition: authored,
      effects: { resolveTargetAvailability: available, readActionContract: async () => contract } });
    expect(original, JSON.stringify(original)).toMatchObject({ ok: true,
      snapshot: { materializedLeaves: [{ actionInput: { sessionId: 'origin', objective: 'Finish' }, actionContract: contract }] } });
    if (!original.ok) throw new Error(original.error.code);
    const replay = await materialize({ definition: original.snapshot.definition, replay: { snapshot: original.snapshot },
      effects: { resolveTargetAvailability: available, readActionContract: async () => {
        throw new Error('Replay must retain the accepted published contract');
      } } });
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true,
      snapshot: { materializedLeaves: original.snapshot.materializedLeaves } });
  });

  it('refuses a native-invalid goal against its published Action contract', async () => {
    const spec = getActionSpec('session.goal.set');
    const published = actionSpecToActionDefinitionV1(spec);
    const input = { sessionId: 'origin', objective: '' };
    expect(spec.inputSchema.safeParse(input).success).toBe(false);
    const result = await materialize({ definition: { version: 1, blocks: [{ kind: 'action', id: 'goal', actionId: published.id,
      input: { sessionId: { kind: 'literal', value: input.sessionId }, objective: { kind: 'literal', value: input.objective } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({
        inputSchema: published.inputSchema, outputSchema: published.outputSchema ?? {},
      }) } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'goal' } });
  });

  it('validates literal Action payloads even when their JSON contains unresolved-shaped data', async () => {
    const result = await materialize({ definition: { version: 1, blocks: [{ kind: 'action', id: 'goal', actionId: 'session.goal.set',
      input: { objective: { kind: 'literal', value: { kind: 'unresolved' } } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({
        inputSchema: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] }, outputSchema: {},
      }) } });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'goal' } });
  });

  it('preserves a bound root input null as an actual Action selection clear', async () => {
    const result = await materialize({ context: { ...context, inputs: { services: null } },
      definition: { ...definition, inputs: [{ name: 'services', valueType: 'json', required: true }], blocks: [{ kind: 'action', id: 'review', actionId: 'review.start',
        input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: ['agent:happier.agent.codex/codex'] }, connectedServices: { kind: 'input', name: 'services' } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, agentStartLeaves: [{ facts: { connectedServices: null } }],
      snapshot: { materializedLeaves: [{ actionInput: { connectedServices: null } }] } });
  });

  it('admits known Action start authority while leaving dynamic nonauthority payloads for invocation', async () => {
    const result = await materialize({ definition: { ...definition, blocks: [definition.blocks[0], { kind: 'action', id: 'review', actionId: 'review.start',
      input: { engineIds: { kind: 'literal', value: ['agent:happier.agent.codex/codex'] },
        instructions: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, snapshot: { workDepth: 2 }, agentStartLeaves: [{}, { kind: 'action', engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } }] });
  });

  it('freezes an explicit Engine arm into the actual native Action invocation input', async () => {
    const explicit = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const result = await materialize({ definition: { ...definition, blocks: [{ kind: 'action', id: 'review', actionId: 'review.start',
      execution: { engine: { agentTarget: explicit } },
      input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: ['agent:happier.agent.codex/codex'] }, modelId: { kind: 'literal', value: 'native-model' } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, agentStartLeaves: [{ engine: { agentTargetKey: 'agent:happier.agent.claude/claude' } }],
      snapshot: { materializedLeaves: [{ actionInput: { engineIds: ['agent:happier.agent.claude/claude'] } }] } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.snapshot.materializedLeaves[0]?.actionInput?.modelId).toBeUndefined();
  });

  it('refuses inline input tokens with absent or nondecimal bindings at the token path', async () => {
    for (const opaque of ['1', '-1', '0.5', 'bogus']) {
      const result = await materialize({ definition: { ...definition, blocks: [{ ...definition.blocks[0],
        document: { text: 'Review @analysis', references: [{ kind: 'happier.workflowInput', ref: `workflowInput:${opaque}`, token: '@analysis' }], attachments: [] },
        input: [{ kind: 'literal', value: 'analysis' }],
      }] } });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [
        { path: '/blocks/0/document/references/0/ref', code: 'invalid_input', blockId: 'work' },
      ] } });
    }
  });

  it('round-trips inline bindings and refuses a moved producer at the token path', async () => {
    const producer = { ...definition.blocks[0], id: 'analyze' };
    const consumer = { ...definition.blocks[0], document: { text: 'Review @analysis',
      references: [{ kind: 'happier.workflowInput', ref: 'workflowInput:0', token: '@analysis' }], attachments: [] },
      input: [{ kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] }] };
    const result = await materialize({ definition: JSON.parse(JSON.stringify({ ...definition, blocks: [producer, consumer] })) });
    expect(result).toMatchObject({ ok: true, snapshot: { definition: { blocks: [
      { id: 'analyze' }, { document: consumer.document, input: consumer.input },
    ] } } });
    const moved = await materialize({ definition: { ...definition, blocks: [consumer, producer] } });
    expect(moved).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: expect.arrayContaining([
      { path: '/blocks/0/document/references/0/ref', code: 'invalid_reference_scope', blockId: 'work', severity: 'error', message: expect.any(String) },
    ]) } });
  });

  it('applies the canonical 64 mention bound to inline tokens without a second Workflow limit', async () => {
    const references = Array.from({ length: 64 }, (_, index) => ({ kind: 'happier.workflowInput', ref: `workflowInput:${index}`, token: `@input${index}` }));
    const block = { ...definition.blocks[0], document: { text: references.map((entry) => entry.token).join(' '), references, attachments: [] },
      input: references.map((_entry, index) => ({ kind: 'literal', value: index })) };
    expect(await materialize({ definition: { ...definition, blocks: [block] } })).toMatchObject({ ok: true });
    expect(await materialize({ definition: { ...definition, blocks: [{ ...block, document: {
      ...block.document, references: [...references, { kind: 'happier.workflowInput', ref: 'workflowInput:0', token: '@input0' }],
    } }] } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('admits reused Sessions without an Engine but refuses detached Agent creation without one', async () => {
    for (const conversation of [{ kind: 'origin_session' as const }, { kind: 'existing_session' as const, sessionId: 'existing', machineId: 'machine' }]) {
      expect(await materialize({ definition: { ...definition, defaults: { conversation } },
        context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } } }))
        .toMatchObject({ ok: true, agentStartLeaves: [], snapshot: { materializedLeaves: [{ executionTarget: { kind: 'session' } }] } });
    }
    expect(await materialize({ definition: { ...definition, defaults: {} }, context: { ...context, executionTarget: { kind: 'detached_run' } } }))
      .toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
  });

  it('refuses malformed inline role overrides with their canonical input path', async () => {
    const result = await materialize({ roleOverrides: [{ roleId: 'custom' }, { roleId: 'custom' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: [{ path: '/roleOverrides/1/roleId', code: 'invalid_input' }] } });
  });

  it('requires the frozen origin for context in root or nested definitions before any effect', async () => {
    const contextual = { ...definition, blocks: [{ ...definition.blocks[0], input: [{ kind: 'session_context', recentTurns: 0 }] }] };
    expect(await materialize({ definition: contextual })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await materialize({ definition: contextual, context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } } })).toMatchObject({ ok: true });
    const nested = { ...definition, blocks: [{ kind: 'workflow', id: 'nested', workflowRef: 'builtin:nested', input: {} }] };
    expect(await materialize({ definition: nested, effects: { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: contextual, sourceKey: 'builtin:nested' }) } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
  it('keeps opaque literal data independent of origin binding', async () => {
    expect(await materialize({ definition: { ...definition, blocks: [{ ...definition.blocks[0],
      input: [{ kind: 'literal', value: { kind: 'session_context', recentTurns: 1 } }] }] } })).toMatchObject({ ok: true });
  });
  it('honors an authored profile clear even when the resolved role profile is unavailable', async () => {
    const role = { name: 'Custom', instructions: 'Work', engine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
      runsAs: { kind: 'session' as const }, profileId: 'missing', workspaceWrites: 'allow' as const, secondOpinion: 'off' as const, enabled: true };
    const result = await materialize({ definition: { ...definition, defaults: { engine: { role: 'custom' }, profileId: null } },
      roleSelection: { settingsRoles: { custom: role }, availableProfileIds: [] },
      admission: { kind: 'agent', admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf },
        { ...policyContext, roles: facts.role ? { custom: facts.role } : {} }) } });
    expect(result).toMatchObject({ ok: true, agentStartLeaves: [{ facts: { profileId: null } }] });
  });

  it('freezes an explicit origin Session binding and refuses the same binding without an origin', async () => {
    const authored = { version: 1, blocks: [{ kind: 'action', id: 'goal', actionId: 'session.goal.set',
      input: { objective: { kind: 'literal', value: 'Finish' }, sessionId: { kind: 'origin_session_id' } } }] };
    const effects = { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) };
    expect(await materialize({ definition: authored, context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } }, effects }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ actionInput: { objective: 'Finish', sessionId: 'origin' } }] } });
    expect(await materialize({ definition: authored, effects })).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'goal' } });
    const implicit = { version: 1, blocks: [{ ...authored.blocks[0], input: { objective: { kind: 'literal', value: 'Finish' } } }] };
    expect(await materialize({ definition: implicit, context: { ...context, origin: { kind: 'direct', originSessionId: 'origin' } }, effects }))
      .toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ actionInput: { objective: 'Finish' } }] } });
  });

  it('preserves explicit null clears for authority comparisons instead of inheriting caller selections', async () => {
    const result = await materialize({ definition: { ...definition, defaults: { agentTarget, connectedServices: null } },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1({ ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowConnectedServicesOverride: false },
        { kind: 'workflow_run_leaf', leaf }, { ...policyContext, baseline: { ...policyContext.baseline,
          configuration: { ...policyContext.baseline.configuration, connectedServices: { v: 2, bindingsByServiceId: {} } } } }) } });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'connectedServices', blockId: 'work' } });
    const user = await materialize({ definition: { ...definition, defaults: { agentTarget, connectedServices: null } } });
    expect(user).toMatchObject({ ok: true, agentStartLeaves: [{ facts: { connectedServices: null } }] });
  });

  it('keeps resolved roles paired with their definition when root and child ids collide', async () => {
    const pin = (instructions: string) => ({ roleId: 'custom', name: 'Custom', instructions, runsAs: { kind: 'session' as const },
      engine: { agentTargetKey: 'agent:happier.agent.codex/codex' } });
    const child = { ...definition, defaults: { engine: { role: 'custom' } }, roles: [pin('child')] };
    const admittedInstructions: string[] = [];
    const result = await materialize({ definition: { ...definition, defaults: { engine: { role: 'custom' } }, roles: [pin('root')],
      blocks: [definition.blocks[0], { kind: 'workflow', id: 'child', workflowRef: 'builtin:child', input: {} }] },
      effects: { resolveTargetAvailability: available, readWorkflowDefinition: async () => ({ definition: child, sourceKey: 'builtin:child' }) },
      admission: { kind: 'agent', admitLeaf: async (leaf, facts) => {
        admittedInstructions.push(facts.role?.instructions ?? 'missing');
        return admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, { ...policyContext,
          roles: facts.role ? { custom: facts.role } : {} });
      } },
    });
    expect(result.ok).toBe(true);
    expect(admittedInstructions).toEqual(['root', 'child']);
  });

  it('checks run-machine availability of the actual Action Agent targets', async () => {
    const result = await materialize({ definition: { ...definition, blocks: [{ kind: 'action', id: 'review', actionId: 'review.start',
      input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: ['agent:happier.agent.claude/claude'] } } }] },
      effects: { readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }),
        resolveTargetAvailability: async (leaf) => leaf.selection.agentTarget?.identity.localId !== 'claude' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'review' } });
  });

  it('refuses an Agent-started Wait-only run without inventing an admission leaf', async () => {
    const result = await materialize({ definition: { version: 1, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Choose', references: [], attachments: [] } }] },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
  });

  it('checks every explicit Action fan-out target instead of replacing it with Workflow defaults', async () => {
    const result = await materialize({ definition: { ...definition, blocks: [{ kind: 'action', id: 'review', actionId: 'review.start',
      input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: ['agent:happier.agent.codex/codex', 'agent:happier.agent.claude/claude'] } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
        ...policyContext, allowLists: { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: ['agent:happier.agent.codex/codex'] },
      }) } });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied_field', field: 'agentTarget', blockId: 'review' } });
  });

  it('defers human dynamic Action selections but refuses agent authority that cannot be proved', async () => {
    const options: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = { definition: { ...definition, blocks: [definition.blocks[0],
      { kind: 'action', id: 'review', actionId: 'review.start', input: { instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'result', producer: { blockId: 'work', scope: { kind: 'current' } }, path: [] } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) } };
    expect(await materialize(options)).toMatchObject({ ok: true, snapshot: { workDepth: 0 } });
    expect(await materialize({ ...options, admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      { kind: 'workflow_run_leaf', leaf }, policyContext) } })).toMatchObject({ ok: false, error: { code: 'definition_exceeds_authority', blockId: 'review' } });
  });

  it.each(['action', 'defaults'] as const)('preserves the known %s permission ceiling while a human Action target remains deferred', async (source) => {
    const options: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = {
      definition: { version: 1, ...(source === 'defaults' ? { defaults: { permissionMode: 'yolo' } } : {}), blocks: [
        { kind: 'wait', id: 'target', document: { text: 'Choose the Agent', references: [], attachments: [] } },
        { kind: 'action', id: 'start', actionId: 'execution.run.start', input: {
          backendTarget: { kind: 'result', producer: { blockId: 'target', scope: { kind: 'current' } }, path: [] },
          intent: { kind: 'literal', value: 'delegate' },
          retentionPolicy: { kind: 'literal', value: 'ephemeral' }, runClass: { kind: 'literal', value: 'bounded' },
          ioMode: { kind: 'literal', value: 'request_response' },
          ...(source === 'action' ? { permissionMode: { kind: 'literal', value: 'yolo' } } : {}),
        } },
      ] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
    };
    expect(await materialize(options)).toMatchObject({ ok: true, snapshot: { authorization: { admittedPermissionCeiling: 'yolo' } },
      agentStartLeaves: [{ kind: 'action', facts: { agentTarget: { kind: 'unresolved' }, permissionMode: 'yolo' } }] });
    expect(await materialize({ ...options, admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(
      DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } }))
      .toMatchObject({ ok: false, error: { code: 'definition_exceeds_authority', blockId: 'start' } });
  });

  it.each(['action', 'defaults'] as const)('preserves the known %s Session spawn ceiling while its Agent target remains deferred', async (source) => {
    const input = {
      executionTarget: { kind: 'literal', value: { serverId: 'server', machineId: 'machine' } },
      directory: { kind: 'literal', value: { kind: 'path', path: '/project' } },
      agentTarget: { kind: 'result', producer: { blockId: 'target', scope: { kind: 'current' } }, path: [] },
      ...(source === 'action' ? { permissionMode: { kind: 'literal', value: 'yolo' } } : {}),
    };
    const options: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = {
      definition: { version: 1, ...(source === 'defaults' ? { defaults: { permissionMode: 'yolo' } } : {}), blocks: [
        { kind: 'wait', id: 'target', document: { text: 'Choose the Agent', references: [], attachments: [] } },
        { kind: 'action', id: 'spawn', actionId: 'session.spawn_new', input },
      ] }, effects: { resolveTargetAvailability: available,
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
    };
    expect(await materialize(options)).toMatchObject({ ok: true, snapshot: { authorization: { admittedPermissionCeiling: 'yolo' } },
      agentStartLeaves: [{ kind: 'action', facts: { agentTarget: { kind: 'unresolved' },
        machineId: 'machine', directory: '/project', permissionMode: 'yolo' } }] });
    expect(await materialize({ ...options, admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(
      DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } }))
      .toMatchObject({ ok: false, error: { code: 'definition_exceeds_authority', blockId: 'spawn' } });
    expect(await materialize({ ...options, definition: { version: 1, blocks: [
      { kind: 'wait', id: 'target', document: { text: 'Choose the Agent', references: [], attachments: [] } },
      { kind: 'action', id: 'spawn', actionId: 'session.spawn_new', input: {
        ...input, permissionMode: { kind: 'literal', value: 'not-a-permission-mode' },
      } },
    ] } })).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'spawn' } });
  });

  it('preserves known Session spawn authority while its directory remains deferred', async () => {
    const options: Partial<MaterializeWorkflowAcceptedSnapshotV1Input> = {
      definition: { version: 1, blocks: [
        { kind: 'wait', id: 'directory', document: { text: 'Choose a directory', references: [], attachments: [] } },
        { kind: 'action', id: 'spawn', actionId: 'session.spawn_new', input: {
          executionTarget: { kind: 'literal', value: { serverId: 'server', machineId: 'machine' } },
          directory: { kind: 'result', producer: { blockId: 'directory', scope: { kind: 'current' } }, path: [] },
          agentTarget: { kind: 'literal', value: agentTarget }, permissionMode: { kind: 'literal', value: 'yolo' },
        } },
      ] }, effects: { resolveTargetAvailability: async (leaf) => leaf.actionId !== undefined || leaf.executionTarget.kind === 'session',
        readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
    };
    expect(await materialize(options)).toMatchObject({ ok: true, snapshot: { authorization: { admittedPermissionCeiling: 'yolo' } },
      agentStartLeaves: [{ kind: 'action', runsAs: { kind: 'session' }, facts: { agentTarget,
        machineId: 'machine', directory: { kind: 'unresolved' }, permissionMode: 'yolo' } }] });
    expect(await materialize({ ...options, admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(
      DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, policyContext) } }))
      .toMatchObject({ ok: false, error: { code: 'definition_exceeds_authority', blockId: 'spawn' } });
  });

  it('freezes inline override engine, profile permission, instructions and stamped depth before sealing', async () => {
    const role = { roleId: 'custom', name: 'Reviewer', instructions: 'Review carefully', runsAs: { kind: 'session' as const },
      engine: { agentTargetKey: 'happier.agent.codex/codex' }, profileId: 'profile', workspaceWrites: 'allow' as const, secondOpinion: 'off' as const, enabled: true };
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'profile', name: 'Profile', createdAt: 0, updatedAt: 0,
      defaultPermissionModeByTargetKey: { 'agent:happier.agent.codex/codex': 'yolo' } });
    const result = await materialize({ definition: { ...definition, defaults: { engine: { role: 'custom' } }, roles: [{ roleId: 'custom', engine: { agentTargetKey: 'happier.agent.claude/claude' } }] },
      roleSelection: { settingsRoles: { custom: role } },
      roleOverrides: [{ roleId: 'custom', engine: { agentTargetKey: 'happier.agent.codex/codex', modelId: 'override' } }],
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => profile },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, { ...policyContext, roles: { custom: role } }) },
    });
    expect(result).toMatchObject({ ok: true, snapshot: { workDepth: 2, authorization: { admittedPermissionCeiling: 'yolo' },
      materializedLeaves: [{ role: { name: 'Reviewer', instructions: 'Review carefully', changedAt: 'run' } }] } });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.snapshot.definition.blocks[0]).toMatchObject({ execution: { agentTarget, permissionMode: 'yolo', modelSelection: { ref: { modelId: 'override' } } } });
    role.instructions = 'Changed after admission';
    expect(result.snapshot.materializedLeaves[0]?.role?.instructions).toBe('Review carefully');
  });

  it('validates each distinct child once and derives the ceiling and policy from its materialized leaves', async () => {
    const child = { ...definition, defaults: { agentTarget, permissionMode: 'yolo' }, blocks: [{ ...definition.blocks[0], id: 'child' }] };
    const reads: string[] = [];
    const result = await materialize({ definition: { version: 1, defaults: {}, blocks: [
      { kind: 'workflow', id: 'a', workflowRef: 'builtin:child', input: {} },
      { kind: 'workflow', id: 'b', workflowRef: 'builtin:child', input: {} },
    ] }, effects: { resolveTargetAvailability: available, readWorkflowDefinition: async (ref) => { reads.push(ref.kind); return { definition: child, sourceKey: 'builtin:child' }; } },
      admission: { kind: 'agent', admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, { ...policyContext, callerPermissionCeiling: 'default' }) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'permission_exceeds_ceiling', blockId: 'child' } });
    expect(reads).toEqual(['builtin']);
  });

  it('refuses unavailable engines and Actions with the exact block and never calls admission for a user', async () => {
    expect(await materialize({ effects: { resolveTargetAvailability: async () => false } })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
    expect(await materialize({ definition: { version: 1, blocks: [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Done' } } }] },
      effects: { resolveTargetAvailability: available, readActionContract: async () => null } })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'notify' } });
    expect(await materialize()).toMatchObject({ ok: true, snapshot: { workDepth: 0 } });
  });

  it('preserves a frozen trigger cause depth and refuses a leaf at the owner depth limit', async () => {
    const triggered = { ...context, source: { kind: 'automation' as const, automationId: 'automation' } };
    const run = (workDepth: number) => materialize({ context: triggered, admission: { kind: 'trigger', workDepth,
      admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, { ...policyContext,
        caller: { kind: 'originless', runId: 'run', runDepth: workDepth }, callerPermissionCeiling: facts.permissionCeiling }) } });
    expect(await run(3)).toMatchObject({ ok: true, snapshot: { workDepth: 3 } });
    expect(await run(4)).toMatchObject({ ok: false, error: { code: 'work_depth_exceeded', blockId: 'work' } });
  });

  it('refuses cyclic children and semantically invalid child programs before admission', async () => {
    const nested = { version: 1, blocks: [{ kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} }] };
    expect(await materialize({ definition: nested, effects: { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: nested, sourceKey: 'builtin:child' }) } })).toMatchObject({ ok: false, error: { code: 'invalid_input', blockId: 'nested' } });
    expect(await materialize({ definition: nested, effects: { resolveTargetAvailability: available,
      readWorkflowDefinition: async () => ({ definition: { ...definition, finalOutput: { kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [] } }, sourceKey: 'builtin:child' }) } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('refuses detached nonportable Launch Profiles rather than silently dropping authored behavior', async () => {
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'profile', name: 'Profile', createdAt: 0, updatedAt: 0,
      extraEnvironmentVariables: [{ name: 'CUSTOM', value: 'value' }] });
    expect(await materialize({ definition: { ...definition, defaults: { agentTarget, profileId: 'profile' } },
      context: { ...context, executionTarget: { kind: 'detached_run' } },
      effects: { resolveTargetAvailability: available, readLaunchProfile: async () => profile } })).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'work' } });
  });
});
