import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import { AgentStartBaselineSelectionErrorV1, resolveAgentStartBaselineSelectionV1 } from '../actions/executor/agentStartBaselineSelectionV1.js';
import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { resolveRoleSelectionV1, type ResolveRoleSelectionV1Input, type RoleSelectionRefusalV1 } from '../prompts/roles/resolveRoleSelectionV1.js';
import type { ResolvedRoleV1 } from '../prompts/roles/rolesV1.js';
import { readRoleEngineModelRefV1 } from '../prompts/roles/roleArtifactV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { readWorkflowValuePathV1 } from './workflowReferenceV1.js';
import { WorkflowLiteralEngineSelectionV1Schema, type WorkflowLiteralEngineSelectionV1, type WorkflowSelectionBindingV1 } from './workflowV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { WorkflowMaterializedLeafV1 } from './workflowDefinitionV1.js';
import { normalizeExecutableParticipantSelectionV1 } from '../discussions/executableParticipants.js';
import type { WorkflowStepExecutionSelection, WorkflowStepSelectionV1, WorkflowLeafExecutionTargetV1 } from './workflowV1.js';
import type { ConnectedServiceBindingsV2 } from '../connect/connectedServiceBindings.js';
import { replaceProviderModelCredentialBinding } from '../teams/credentials/sessionBindingIntentV1.js';
export { WorkflowLeafExecutionTargetV1Schema, WorkflowStepSelectionV1Schema,
  type WorkflowLeafExecutionTargetV1, type WorkflowStepSelectionV1 } from './workflowV1.js';

export type WorkflowResolvedStepSelectionV1 = Omit<WorkflowStepSelectionV1, 'roleId' | 'engine' | 'participant' | 'executionTarget' | 'connectedServices'>
  & Readonly<{ connectedServices?: ConnectedServiceBindingsV2 | null }>;

/** Host context for the default engine; bindings stay in the existing leaf selection. */
export type WorkflowRoleSelectionContextV1 = Omit<ResolveRoleSelectionV1Input, 'roleId'> & Readonly<{
  defaultProfileId?: string;
  defaultConnectedServices?: ConnectedServiceBindingsV2 | null;
}>;

export type ResolveWorkflowStepSelectionV1Input = Readonly<{
  defaults: WorkflowStepSelectionV1;
  step?: WorkflowStepSelectionV1;
  roleSelection?: WorkflowRoleSelectionContextV1;
  runExecutionTarget?: WorkflowLeafExecutionTargetV1;
  producerExecutionTarget?: WorkflowLeafExecutionTargetV1;
  /** Value-only editor projection: roles and from-step targets stay unresolved until admission. */
  purpose?: 'authoring';
  inputs?: Readonly<Record<string, JsonValue>>;
  itemValue?: JsonValue;
}>;
export type ResolveWorkflowStepSelectionV1Result = Readonly<{
  selection: WorkflowResolvedStepSelectionV1;
  executionTarget?: WorkflowLeafExecutionTargetV1;
  role?: ResolvedRoleV1;
}>;
export type WorkflowStepSelectionRefusalV1 = RoleSelectionRefusalV1 | Readonly<{ code: 'invalid_input' | 'execution_run_child_choice_required' }>;

export class WorkflowStepSelectionErrorV1 extends Error {
  readonly code: WorkflowStepSelectionRefusalV1['code'];

  constructor(readonly refusal: WorkflowStepSelectionRefusalV1) {
    super(refusal.code);
    this.name = 'WorkflowStepSelectionErrorV1';
    this.code = refusal.code;
  }
}

/** Existing engine-option keys enter the same typed engine owner as authored object selections. */
export function parseWorkflowLiteralEngineSelectionV1(value: unknown): ReturnType<typeof WorkflowLiteralEngineSelectionV1Schema.safeParse> {
  if (typeof value === 'string') {
    const key = BackendTargetKeyV2Schema.safeParse(value);
    const target = key.success ? parseBackendTargetKeyV2(key.data) : null;
    if (target?.kind === 'agent') value = { agentTarget: target };
  }
  return WorkflowLiteralEngineSelectionV1Schema.safeParse(value);
}

/** Who runs a step when it is not the flat Agent fields: a Role, or an input/item engine binding. */
export type WorkflowEngineChoiceV1 = Readonly<{ roleId: string }> | WorkflowSelectionBindingV1;
type WorkflowEngineChoiceFieldsV1 = Readonly<{ roleId?: string; engine?: WorkflowSelectionBindingV1; agentTarget?: unknown }>;

/** Whether this selection itself chooses who runs the step, rather than inheriting that choice. */
export function workflowSelectionChoosesEngineV1(selection: WorkflowEngineChoiceFieldsV1 | undefined): selection is WorkflowEngineChoiceFieldsV1 {
  return selection?.roleId !== undefined || selection?.engine !== undefined || selection?.agentTarget !== undefined;
}

/**
 * The step's choice of who runs it (Role, engine binding or Agent) replaces the defaults' choice as
 * one unit; `undefined` means the flat Agent fields carry it. Every reader of the choice asks here.
 */
export function readWorkflowEngineChoiceV1(defaults: WorkflowEngineChoiceFieldsV1,
  step?: WorkflowEngineChoiceFieldsV1): WorkflowEngineChoiceV1 | undefined {
  const owner = workflowSelectionChoosesEngineV1(step) ? step! : defaults;
  return owner.roleId !== undefined ? { roleId: owner.roleId } : owner.engine;
}

/** A Workflow default Agent fills open Action targets; an authored choice replaces them. */
export function workflowActionSelectionOverridesEngineV1(defaults: WorkflowEngineChoiceFieldsV1,
  step?: WorkflowEngineChoiceFieldsV1, hasResolvedRole = false): boolean {
  return readWorkflowEngineChoiceV1(defaults, step) !== undefined || step?.agentTarget !== undefined || hasResolvedRole;
}

/**
 * An inherited model and effort belong to the inherited Agent: a step Role, binding or different
 * Agent replaces them, while a step naming the same Agent (or only a model) keeps per-field inheritance.
 */
function replacesInheritedEngineV1(defaults: WorkflowResolvedStepSelectionV1, step: ResolveWorkflowStepSelectionV1Input['step']): boolean {
  if (step?.roleId !== undefined || step?.engine !== undefined) return true;
  return step?.agentTarget != null && defaults.agentTarget != null && !sameStrictJsonValue(step.agentTarget, defaults.agentTarget);
}

/** Drop the Agent, model and effort another engine choice decides; other config options stay. */
function withoutWorkflowEngineFieldsV1<T extends WorkflowResolvedStepSelectionV1>(selection: T): T {
  const { agentTarget: _agentTarget, modelSelection: _modelSelection, ...rest } = withoutWorkflowModelBinding(selection);
  const config = rest.sessionConfigOptionOverrides;
  if (config?.overrides.reasoning_effort === undefined) return rest as T;
  const { reasoning_effort: _effort, ...overrides } = config.overrides;
  if (Object.keys(overrides).length === 0) {
    const { sessionConfigOptionOverrides: _config, ...withoutConfig } = rest;
    return withoutConfig as T;
  }
  return { ...rest, sessionConfigOptionOverrides: { ...config, overrides } } as T;
}

function withoutWorkflowModelBinding<T extends WorkflowResolvedStepSelectionV1>(selection: T): T {
  const bindings = selection.teamCredentialBindings;
  if (!bindings?.some(binding => binding.slot.kind === 'provider_model')) return selection;
  const { teamCredentialBindings: _bindings, ...rest } = selection;
  const retained = replaceProviderModelCredentialBinding(bindings, null);
  return (retained.length ? { ...rest, teamCredentialBindings: retained } : rest) as T;
}

/** Resolve a lexical engine before opening the selected Role's Account sources. */
export function resolveWorkflowEngineSelectionV1(input: ResolveWorkflowStepSelectionV1Input):
  WorkflowLiteralEngineSelectionV1 | WorkflowSelectionBindingV1 | undefined {
  const engine = readWorkflowEngineChoiceV1(input.defaults, input.step);
  if (!engine) return undefined;
  if ('roleId' in engine) return { role: engine.roleId };
  if (input.purpose === 'authoring') return engine;
  const value = engine.kind === 'input' ? input.inputs?.[engine.name] : input.itemValue;
  const selected = value === undefined ? undefined : readWorkflowValuePathV1(value, engine.path ?? []);
  const parsed = parseWorkflowLiteralEngineSelectionV1(selected);
  if (!parsed.success) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
  return parsed.data;
}

/** Invocation admission can choose only a concrete engine already approved in this leaf. */
export function listWorkflowAcceptedLeafSelectionsV1(leaf: WorkflowMaterializedLeafV1): readonly WorkflowMaterializedLeafV1[] {
  const participants = leaf.participantBindings ? leaf.participantBindings.selections.map(selected => ({ ...leaf,
    participant: selected.participant, selection: selected.selection, executionTarget: selected.executionTarget,
    role: selected.role })) : [leaf];
  const engines = participants.flatMap(participantLeaf => participantLeaf.engineBindings
    ? participantLeaf.engineBindings.selections.map(selected => ({ ...participantLeaf,
      selection: selected.selection, executionTarget: selected.executionTarget, role: selected.role }))
    : [participantLeaf]);
  return leaf.sessionBindings ? engines.flatMap(engine => leaf.sessionBindings!.targets.map(target => ({ ...engine,
    selection: { ...engine.selection, conversation: { kind: 'existing_session' as const,
      sessionId: target.address.sessionId, machineId: target.machineId } } }))) : engines;
}

/** Resolve the current lexical value without consulting a mutable catalog or role default. */
export function resolveWorkflowAcceptedStepSelectionV1(leaf: WorkflowMaterializedLeafV1, itemValue?: JsonValue,
  inputs?: Readonly<Record<string, JsonValue>>): WorkflowMaterializedLeafV1 {
  if (leaf.participantBindings) {
    const reference = leaf.participantBindings.reference;
    const raw = reference.kind === 'item' ? itemValue : inputs?.[reference.name];
    const selectedValue = raw === undefined ? undefined : readWorkflowValuePathV1(raw, reference.path ?? []);
    const participant = normalizeExecutableParticipantSelectionV1(selectedValue);
    const selected = participant && leaf.participantBindings.selections.find(candidate => sameStrictJsonValue(candidate.value, participant));
    if (!selected) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    leaf = { ...leaf, participant: selected.participant, selection: selected.selection,
      executionTarget: selected.executionTarget, role: selected.role };
  }
  if (leaf.sessionBindings) {
    const value = inputs?.[leaf.sessionBindings.inputName];
    const target = leaf.sessionBindings.targets.find(target => sameStrictJsonValue(target.address, value));
    if (!target) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    leaf = { ...leaf, selection: { ...leaf.selection, conversation: { kind: 'existing_session',
      sessionId: target.address.sessionId, machineId: target.machineId } } };
  }
  if (!leaf.engineBindings) return leaf;
  const reference = leaf.engineBindings.reference;
  const raw = reference.kind === 'item' ? itemValue : inputs?.[reference.name];
  const value = raw === undefined ? undefined : readWorkflowValuePathV1(raw, reference.path ?? []);
  const parsed = parseWorkflowLiteralEngineSelectionV1(value);
  const selected = parsed.success ? leaf.engineBindings.selections.find(candidate => sameStrictJsonValue(candidate.value, parsed.data)) : undefined;
  if (!selected) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
  return { ...leaf, selection: { ...selected.selection,
    ...(leaf.sessionBindings ? { conversation: leaf.selection.conversation } : {}) }, executionTarget: selected.executionTarget, role: selected.role };
}

// Value-only authoring consumers preserve the flat Session selection type.
export function resolveWorkflowStepSelectionV1(input: Readonly<{
  defaults: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
  step?: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
}>): Omit<ResolveWorkflowStepSelectionV1Result, 'selection'> & Readonly<{ selection: WorkflowStepExecutionSelection }>;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result {
  const engine = resolveWorkflowEngineSelectionV1(input);
  const { engine: _defaultEngine, roleId: _defaultRoleId, participant: defaultParticipant, executionTarget: defaultTarget, ...defaults } = input.defaults;
  const { engine: _stepEngine, roleId: _stepRoleId, participant: stepParticipant, executionTarget: stepTarget, ...step } = input.step ?? {};
  const participant = stepParticipant ?? defaultParticipant;
  // Optional fields are unset when undefined; explicit null remains an override.
  for (const key of Object.keys(step) as (keyof typeof step)[]) {
    if (step[key] === undefined) delete step[key];
  }
  const inherited = replacesInheritedEngineV1(defaults, input.step) ? withoutWorkflowEngineFieldsV1(defaults)
    : step.modelSelection !== undefined ? withoutWorkflowModelBinding(defaults) : defaults;
  let selection: WorkflowResolvedStepSelectionV1 = input.step === undefined && engine === undefined && participant === undefined && defaultTarget === undefined
    ? input.defaults
    : { ...inherited, ...step };
  let role: ResolvedRoleV1 | undefined;

  if (engine !== undefined) {
    // Work on our own object: authoring readers can retain defaults by identity.
    selection = withoutWorkflowEngineFieldsV1(selection);

    let effort: string | undefined;
    if ('role' in engine && input.purpose !== 'authoring') {
      const resolved = resolveRoleSelectionV1({ ...input.roleSelection, roleId: engine.role });
      if (!resolved.ok) throw new WorkflowStepSelectionErrorV1(resolved.refusal);
      role = resolved.selection;
      const targetKey = BackendTargetKeyV2Schema.safeParse(role.engine?.agentTargetKey);
      const target = targetKey.success ? parseBackendTargetKeyV2(targetKey.data) : null;
      const identity = target?.kind === 'agent' ? target.identity : parseQualifiedPluginContributionKey(role.engine?.agentTargetKey);
      if (identity === null || role.engine === undefined) {
        throw new WorkflowStepSelectionErrorV1({ code: 'target_unavailable', reason: 'engine_unavailable', roleId: role.roleId });
      }
      selection.agentTarget = target?.kind === 'agent' ? target : { kind: 'agent', identity };
      const roleModelRef = readRoleEngineModelRefV1(role.engine);
      if (roleModelRef) selection.modelSelection = { v: 1, updatedAt: 0, ref: roleModelRef };
      if (role.profileId !== undefined && selection.profileId === undefined) selection.profileId = role.profileId;
      effort = role.engine.effort;
    } else if ('agentTarget' in engine) {
      selection.agentTarget = engine.agentTarget;
      if (engine.modelSelection !== undefined) selection.modelSelection = engine.modelSelection;
      effort = engine.effort;
    }
    if (effort !== undefined) {
      const inherited = selection.sessionConfigOptionOverrides;
      selection.sessionConfigOptionOverrides = {
        v: 1, updatedAt: inherited?.updatedAt ?? 0,
        overrides: { ...inherited?.overrides, reasoning_effort: { value: effort, updatedAt: 0 } },
      };
    }
  }
  if (participant !== undefined) {
    if (input.purpose !== 'authoring') {
      const raw = participant.kind === 'input' ? input.inputs?.[participant.name] : input.itemValue;
      const selected = raw === undefined ? undefined : readWorkflowValuePathV1(raw, participant.path ?? []);
      if (!normalizeExecutableParticipantSelectionV1(selected)) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
    selection = { ...withoutWorkflowModelBinding(selection) };
    delete selection.agentTarget;
    delete selection.modelSelection;
  }

  // Connected choice follows the resolved Agent, regardless of whether that
  // Agent came from a Role, a literal engine or an input-bound engine. Freeze
  // it here so Session and detached leaves consume the same admitted choice.
  if (input.purpose !== 'authoring') {
    const parentTarget = input.roleSelection?.defaultEngine?.agentTargetKey;
    try {
      const inherited = resolveAgentStartBaselineSelectionV1({
        targetKey: selection.agentTarget ? buildBackendTargetKeyV2(selection.agentTarget) : undefined,
        profileId: selection.profileId, connectedServices: selection.connectedServices, modelSelection: selection.modelSelection,
      }, {
        ...(parentTarget ? { agentTarget: parseBackendTargetKeyV2(parentTarget) } : {}),
        profileId: input.roleSelection?.defaultProfileId,
        connectedServices: input.roleSelection?.defaultConnectedServices,
      });
      if (inherited.connectedServices !== selection.connectedServices || inherited.profileId !== selection.profileId)
        selection = { ...selection, ...inherited };
    } catch (error) {
      if (error instanceof AgentStartBaselineSelectionErrorV1)
        throw new WorkflowStepSelectionErrorV1({ code: error.code });
      throw error;
    }
  }

  const runTarget = input.runExecutionTarget ?? defaultTarget;
  let executionTarget: WorkflowLeafExecutionTargetV1 | undefined;
  // Value displays have no admission context. Admission supplies the target to
  // resolve from-step classes; the value-only call never guesses a producer's class.
  if (input.purpose !== 'authoring' && (participant !== undefined || runTarget !== undefined || stepTarget !== undefined || role !== undefined
    || input.producerExecutionTarget !== undefined
    || selection.conversation?.kind === 'origin_session' || selection.conversation?.kind === 'existing_session')) {
    const conversation = selection.conversation;
    let boundTarget: WorkflowLeafExecutionTargetV1 | undefined;
    if (conversation?.kind === 'origin_session' || conversation?.kind === 'existing_session') {
      boundTarget = { kind: 'session' };
    } else if (conversation?.kind === 'from_step') {
      if (input.producerExecutionTarget === undefined) {
        throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
      }
      boundTarget = input.producerExecutionTarget;
    }
    if (stepTarget !== undefined && boundTarget !== undefined && stepTarget.kind !== boundTarget.kind) {
      throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
    executionTarget = participant !== undefined ? { kind: 'session' } : stepTarget ?? boundTarget
      ?? (role === undefined ? undefined : { kind: role.runsAs.kind === 'session' ? 'session' : 'detached_run' })
      ?? runTarget;
    if (input.step?.conversation?.kind === 'shared_run' && runTarget !== undefined && executionTarget?.kind !== runTarget.kind) {
      throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
  }
  return { selection, ...(role === undefined ? {} : { role }), ...(executionTarget === undefined ? {} : { executionTarget }) };
}
