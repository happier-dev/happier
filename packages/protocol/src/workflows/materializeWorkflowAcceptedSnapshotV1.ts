import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import type { AgentStartAdmissionV1, AgentStartRefusalV1, MaterializedWorkflowLeafV1, Unresolved } from '../account/settings/admitAgentStartV1.js';
import { isAgentStartActionV1, resolveActionAgentStartRequestsV1 } from '../actions/executor/agentStartAdmission.js';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '../automations/automationStoredContentEnvelopeV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import type { ActionCaller } from '../actions/executor/types.js';
import { describePluginJsonSchemaValueIssues } from '../plugins/actions/jsonSchemaValidation.js';
import { compileActionInputJsonSchema } from '../actions/actionInputJsonSchemaValidation.js';
import { isLaunchProfileV2, type AiLaunchProfile } from '../profiles/read.js';
import type { ResolveRoleSelectionV1Input } from '../prompts/roles/resolveRoleSelectionV1.js';
import type { ResolvedRoleV1 } from '../prompts/roles/rolesV1.js';
import { parseAgentPermissionIntentV1Alias, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { formatWorkflowDefinitionRefV1, parseWorkflowDefinitionRefV1, type WorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import { WorkflowAcceptedSnapshotV1Schema, WorkflowMaterializedLeafV1Schema, WorkflowRoleOverridesV1Schema, WorkflowReplayAgentOverrideV1Schema, deriveWorkflowAcceptedPermissionCeilingV1,
  type WorkflowAcceptedAuthorizationV1, type WorkflowAcceptedSnapshotV1, type WorkflowDefinitionMetadataV1,
  type WorkflowMaterializedLeafV1, type WorkflowResolvedInputsV1, type WorkflowRoleOverridesV1,
  type WorkflowReplayAgentOverrideV1,
  type WorkflowRunExecutionTargetV1 } from './workflowDefinitionV1.js';
import { resolveWorkflowStepSelectionV1, WorkflowStepSelectionErrorV1, type WorkflowResolvedStepSelectionV1 } from './workflowStepSelectionV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { WorkflowStepExecutionSelectionSchema, type WorkflowBlock, type WorkflowDefinitionV1,
  type WorkflowIngressContextV1, type WorkflowLeafV1, type WorkflowStepSelectionV1,
  type WorkflowActionValueReferenceV1,
  type WorkflowValidationIssue } from './workflowV1.js';
import type { WorkflowAcceptedWorkspaceTargetV1 } from './workflowWorkspaceV1.js';
import { collectWorkflowConditionValueReferences, readWorkflowValuePathV1, type WorkflowValueReference } from './workflowReferenceV1.js';
import { collectWorkflowLeavesV1 as leavesOf, deriveWorkflowDestinationsV1, readWorkflowLeafTargetSessionIdsV1 } from './workflowDestinationsV1.js';

export type WorkflowMaterializationContextV1 = Readonly<{
  /** Host-stamped admitting caller; private input, never authored Workflow content. */
  actionCaller?: ActionCaller;
  source: WorkflowAcceptedSnapshotV1['source']; inputs: WorkflowResolvedInputsV1;
  machineId: string; executionTarget: WorkflowRunExecutionTargetV1; workspaceTarget: WorkflowAcceptedWorkspaceTargetV1;
  metadata?: WorkflowDefinitionMetadataV1;
  origin?: Readonly<{ kind: 'direct'; originSessionId?: string }>;
  resultDelivery?: WorkflowAcceptedSnapshotV1['resultDelivery'];
  authorization: Omit<WorkflowAcceptedAuthorizationV1, 'admittedPermissionCeiling'>;
}>;

/** Admission and durable approval capture share this descriptive classification, never an authorization decision. */
export function resolveWorkflowRunStartedByForActionCallerV1(caller: ActionCaller): WorkflowAcceptedSnapshotV1['startedBy'] {
  switch (caller.kind) {
    case 'host': return 'user';
    case 'session':
    case 'workflowRun': return 'agent';
    case 'automationRun': return caller.cause.kind === 'manual' ? 'user' : 'trigger';
    case 'plugin': return caller.initiatingCaller
      ? resolveWorkflowRunStartedByForActionCallerV1(caller.initiatingCaller)
      : caller.startedBy ?? 'trigger';
  }
}
export type WorkflowMaterializationEffectsV1 = Readonly<{
  readWorkflowDefinition?: (ref: WorkflowDefinitionRefV1) => Promise<Readonly<{ definition: unknown; sourceKey: string; version?: number | string }> | null>;
  readLaunchProfile?: (profileId: string) => Promise<AiLaunchProfile | null>;
  resolveTargetAvailability: (leaf: Readonly<{
    blockId: string; selection: WorkflowResolvedStepSelectionV1;
    executionTarget: WorkflowRunExecutionTargetV1; actionId?: string; kind?: WorkflowMaterializedLeafV1['kind'];
  }>, context: Readonly<{ sessionIds: readonly string[] }>) => Promise<boolean>;
  readActionContract?: (actionId: string) => Promise<NonNullable<WorkflowMaterializedLeafV1['actionContract']> | null>;
}>;
export type WorkflowMaterializationAdmissionV1 =
  | Readonly<{ kind: 'user' }>
  | Readonly<{ kind: 'agent'; admitRun?: () => Promise<AgentStartAdmissionV1>; admitLeaf: (leaf: MaterializedWorkflowLeafV1,
    facts: Readonly<{ permissionCeiling: AgentPermissionIntentV1; role?: ResolvedRoleV1 }>) => Promise<AgentStartAdmissionV1> }>
  | Readonly<{ kind: 'trigger'; workDepth: number; admitLeaf: (leaf: MaterializedWorkflowLeafV1,
    facts: Readonly<{ permissionCeiling: AgentPermissionIntentV1; role?: ResolvedRoleV1 }>) => Promise<AgentStartAdmissionV1> }>;
export type MaterializeWorkflowAcceptedSnapshotV1Input = Readonly<{
  definition: unknown; context: WorkflowMaterializationContextV1; ingressContext?: WorkflowIngressContextV1;
  roleOverrides?: WorkflowRoleOverridesV1;
  /** Host-opened immutable source, never an authored/client-supplied snapshot. */
  replay?: Readonly<{ snapshot: WorkflowAcceptedSnapshotV1; agentOverride?: WorkflowReplayAgentOverrideV1 }>;
  roleSelection?: Omit<ResolveRoleSelectionV1Input, 'roleId' | 'workflowRoles' | 'runOverrides'>;
  admission: WorkflowMaterializationAdmissionV1; effects: WorkflowMaterializationEffectsV1;
}>;
export type WorkflowMaterializationErrorV1 = AgentStartRefusalV1 | Readonly<{
  code: 'invalid_input' | 'source_unavailable' | 'target_unavailable'; blockId?: string; issues?: readonly WorkflowValidationIssue[];
}>;
export type WorkflowReadyAcceptedSnapshotV1 = WorkflowAcceptedSnapshotV1;
export type MaterializeWorkflowAcceptedSnapshotV1Result =
  | Readonly<{ ok: true; snapshot: WorkflowReadyAcceptedSnapshotV1; agentStartLeaves: readonly MaterializedWorkflowLeafV1[] }>
  | Readonly<{ ok: false; error: WorkflowMaterializationErrorV1 }>;
export type MaterializeWorkflowDefinitionAuthorityV1Result =
  | Readonly<{ ok: true; agentStartLeaves: readonly MaterializedWorkflowLeafV1[];
    materializedLeaves: readonly WorkflowMaterializedLeafV1[] }>
  | Readonly<{ ok: false; error: WorkflowMaterializationErrorV1 }>;

function invalidInput(blockId?: string, issues?: readonly WorkflowValidationIssue[]): MaterializeWorkflowAcceptedSnapshotV1Result {
  return { ok: false, error: { code: 'invalid_input', ...(blockId === undefined ? {} : { blockId }), ...(issues === undefined ? {} : { issues }) } };
}

function usesSessionContext(definition: WorkflowDefinitionV1): boolean {
  const pending = [...definition.blocks];
  const isContext = (reference: WorkflowValueReference) => reference.kind === 'session_context' || reference.kind === 'session_context_field';
  while (pending.length > 0) {
    const block = pending.pop()!;
    if ('onlyWhen' in block && block.onlyWhen && collectWorkflowConditionValueReferences(block.onlyWhen).some(isContext)) return true;
    if (block.kind === 'step' && block.input.some(isContext)) return true;
    if (block.kind === 'action' || block.kind === 'workflow') {
      for (const binding of Object.values(block.input)) {
        if ((binding.kind === 'list' ? binding.items : [binding]).some((reference) => reference.kind !== 'origin_session_id' && isContext(reference))) return true;
      }
    } else if (block.kind === 'parallel') pending.push(...block.branches.flatMap((branch) => branch.blocks));
    else if (block.kind === 'if') {
      if (collectWorkflowConditionValueReferences(block.when).some(isContext)) return true;
      pending.push(...block.then, ...block.otherwise);
    } else if (block.kind === 'loop') {
      pending.push(...block.body);
      if (block.repetition.kind === 'until' && collectWorkflowConditionValueReferences(block.repetition.stopWhen).some(isContext)) return true;
      if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
    }
  }
  return false;
}
function unavailable(blockId: string): MaterializeWorkflowAcceptedSnapshotV1Result {
  return { ok: false, error: { code: 'target_unavailable', blockId } };
}
function invalidDefinition(issues: readonly WorkflowValidationIssue[], blockId?: string): MaterializeWorkflowAcceptedSnapshotV1Result {
  const targetIssue = issues.find((issue) => issue.code === 'target_unavailable' && issue.blockId !== undefined);
  if (targetIssue && !issues.some((issue) => issue.severity === 'error' && issue.code !== 'target_unavailable')) {
    return unavailable(targetIssue.blockId!);
  }
  return invalidInput(blockId, issues);
}

/** Portable defaults belong to admission; detached execution never rereads a live profile. */
function profileSelection(profile: AiLaunchProfile, selection: WorkflowResolvedStepSelectionV1,
  target: WorkflowRunExecutionTargetV1): WorkflowResolvedStepSelectionV1 | null {
  if (target.kind === 'detached_run' && (isLaunchProfileV2(profile)
    ? profile.extraEnvironmentVariables.length > 0 || (profile.envVarRequirements?.length ?? 0) > 0
      || profile.placement !== undefined || profile.checkout !== undefined || profile.codingPromptBehaviorOverrides !== undefined
    : profile.environmentVariables.length > 0 || profile.envVarRequirements.length > 0 || profile.authMode !== undefined
      || profile.requiresMachineLogin !== undefined || profile.requiresMachineLoginTargetKey !== undefined
      || profile.codingPromptBehaviorOverrides !== undefined)) return null;
  let agentTarget = selection.agentTarget;
  if (agentTarget === undefined && isLaunchProfileV2(profile) && profile.preferredAgentTargetKey) {
    const preferred = parseBackendTargetKeyV2(profile.preferredAgentTargetKey);
    if (preferred.kind !== 'agent') return null;
    agentTarget = preferred;
  }
  const key = agentTarget ? buildBackendTargetKeyV2(agentTarget) : undefined;
  if (key !== undefined && profile.compatibilityByTargetKey[key] === false) return null;
  const permissionMode = key === undefined ? undefined : profile.defaultPermissionModeByTargetKey[key];
  const persistenceMode = key === undefined ? undefined : profile.defaultPersistenceModeByTargetKey[key];
  const defaults: WorkflowStepSelectionV1 = {
    ...(agentTarget === undefined ? {} : { agentTarget }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(persistenceMode === undefined ? {} : { transcriptStorage: persistenceMode }),
    ...(isLaunchProfileV2(profile) && profile.preferredModelSelection
      && profile.preferredModelSelection.ref.agentTargetKey === key ? { modelSelection: profile.preferredModelSelection } : {}),
    ...(!isLaunchProfileV2(profile) && permissionMode === undefined && profile.defaultPermissionMode
      ? { permissionMode: profile.defaultPermissionMode } : {}),
  };
  return resolveWorkflowStepSelectionV1({ defaults, step: selection }).selection;
}

function agentLeaf(snapshot: Pick<WorkflowAcceptedSnapshotV1, 'machineId' | 'workspaceTarget'>,
  leaf: WorkflowMaterializedLeafV1): MaterializedWorkflowLeafV1 | null {
  if (leaf.kind !== 'step' || !leaf.selection.agentTarget) return null;
  const selection = leaf.selection;
  const agentTargetKey = buildBackendTargetKeyV2(selection.agentTarget!);
  const effort = selection.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value;
  return {
    sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: leaf.executionTarget.kind,
    ...(leaf.role ? { roleId: leaf.role.roleId } : {}),
    engine: { agentTargetKey, ...(selection.modelSelection ? { modelId: selection.modelSelection.ref.modelId } : {}),
      ...(typeof effort === 'string' ? { effort } : {}) },
    runsAs: leaf.executionTarget.kind === 'session' ? { kind: 'session' }
      : { kind: 'background_run', intent: leaf.role?.runsAs.kind === 'background_run' ? leaf.role.runsAs.intent : 'delegate' },
    workspaceWrites: leaf.role?.workspaceWrites ?? 'allow',
    facts: {
      machineId: snapshot.machineId, directory: snapshot.workspaceTarget.project.directory,
      agentTarget: selection.agentTarget!, ...(selection.modelSelection !== undefined ? { modelSelection: selection.modelSelection } : {}),
      permissionMode: parseAgentPermissionIntentV1Alias(selection.permissionMode ?? 'default') ?? { kind: 'unresolved' },
      ...(selection.acpSessionModeId === undefined ? {} : { agentModeId: selection.acpSessionModeId }),
      ...(selection.profileId === undefined ? {} : { profileId: selection.profileId }),
      ...(selection.connectedServices !== undefined ? { connectedServices: selection.connectedServices } : {}),
      ...(selection.mcpSelection !== undefined ? { mcpSelection: selection.mcpSelection } : {}),
      ...(selection.transcriptStorage ? { transcriptStorage: selection.transcriptStorage } : {}),
      ...(selection.sessionConfigOptionOverrides !== undefined ? { configOptions: selection.sessionConfigOptionOverrides === null ? null
        : Object.fromEntries(Object.entries(selection.sessionConfigOptionOverrides.overrides)
          .map(([name, option]) => [name, { value: option.value, updatedAtMs: option.updatedAt }])) } : {}),
    },
  };
}

/** Machine start admission is about execution, never trigger scope. */
export function workflowRequiresMachineStartCapacityV1(leaves: readonly WorkflowMaterializedLeafV1[]): boolean {
  return leaves.some(leaf => {
    if (leaf.kind === 'action') return leaf.actionId !== undefined && isAgentStartActionV1(leaf.actionId);
    if (leaf.kind !== 'step') return false;
    const conversation = leaf.selection.conversation?.kind;
    return conversation !== 'existing_session' && conversation !== 'origin_session' && conversation !== 'from_step';
  });
}

export class WorkflowMaterializationFailureV1 extends Error {
  readonly code: WorkflowMaterializationErrorV1['code'];
  constructor(readonly error: WorkflowMaterializationErrorV1) { super(error.code); this.code = error.code; }
}

function projectActionStart(snapshot: Pick<WorkflowAcceptedSnapshotV1, 'machineId' | 'workspaceTarget'>, leaf: WorkflowMaterializedLeafV1,
  overrideEngine = leaf.role !== undefined, deferAuthorityErrors = hasUnresolvedValue(leaf.actionInput)): Readonly<{
  leaves: readonly MaterializedWorkflowLeafV1[]; effectiveInput?: WorkflowMaterializedLeafV1['actionInput'];
}> {
  if (!leaf.actionId || !isAgentStartActionV1(leaf.actionId)) return { leaves: [] };
  const selection = leaf.selection;
  const baseline = { machineId: snapshot.machineId, directory: snapshot.workspaceTarget.project.directory };
  const actionInput = { ...leaf.actionInput };
  const requested = resolveActionAgentStartRequestsV1({ actionId: leaf.actionId, input: actionInput,
    context: { executionRunTargetMachineId: snapshot.machineId }, baseline,
    effectiveSelection: { selection, overrideEngine } });
  if (!requested.ok) {
    if (deferAuthorityErrors && requested.errorCode === 'target_unavailable') return { leaves: [{ sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: 'action', actionId: leaf.actionId,
      ...(leaf.role ? { roleId: leaf.role.roleId, engine: leaf.role.engine } : {}),
      runsAs: { kind: 'background_run', intent: 'delegate' }, workspaceWrites: leaf.role?.workspaceWrites ?? 'allow',
      facts: { ...requested.knownFacts, permissionMode: requested.knownFacts?.permissionMode ?? 'default', agentTarget: { kind: 'unresolved' } },
    }] };
    throw new WorkflowMaterializationFailureV1({
      code: requested.errorCode === 'invalid_parameters' ? 'invalid_input' : requested.errorCode, blockId: leaf.blockId,
    });
  }
  const effectiveInput = WorkflowMaterializedLeafV1Schema.shape.actionInput.safeParse(requested.effectiveInput);
  if (!effectiveInput.success || effectiveInput.data === undefined) throw new WorkflowMaterializationFailureV1({ code: 'invalid_input', blockId: leaf.blockId });
  const leaves = requested.requests.flatMap((request): MaterializedWorkflowLeafV1[] => {
    if (request.kind !== 'spawn_new' && request.kind !== 'execution_run') return [];
    const facts = { ...request.facts,
      machineId: request.facts.machineId ?? baseline.machineId, directory: request.facts.directory ?? baseline.directory,
      permissionMode: request.facts.permissionMode ?? 'default',
    };
    const target = facts.agentTarget;
    if ((!target || target.kind === 'unresolved') && !deferAuthorityErrors) throw new WorkflowMaterializationFailureV1({ code: 'target_unavailable', blockId: leaf.blockId });
    const model = facts.modelSelection;
    const modelRef = model && !('kind' in model) ? ('ref' in model ? model.ref : model) : undefined;
    return [{ sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: 'action', actionId: leaf.actionId,
      ...(leaf.role ? { roleId: leaf.role.roleId } : request.roleId ? { roleId: request.roleId } : {}),
      ...(target && target.kind !== 'unresolved' ? { engine: { agentTargetKey: buildBackendTargetKeyV2(target), ...(modelRef ? { modelId: modelRef.modelId } : {}) } } : {}),
      runsAs: request.kind === 'spawn_new' ? { kind: 'session' } : { kind: 'background_run', intent: request.intent },
      workspaceWrites: leaf.role?.workspaceWrites ?? 'allow', facts,
    }];
  });
  return { leaves, effectiveInput: effectiveInput.data };
}

type WorkflowBoundItem = Readonly<{ value: JsonValue; index: number; position: number; count: number }>;
type WorkflowBindingContext = Pick<WorkflowMaterializationContextV1, 'inputs' | 'origin'>;

/** Enumerate only items already frozen in Run inputs, never future result choices. */
function actionItemContexts(definition: WorkflowDefinitionV1, blockId: string, context: WorkflowBindingContext): readonly (WorkflowBoundItem | undefined)[] | null {
  const pending: { blocks: readonly WorkflowBlock[]; items: readonly (WorkflowBoundItem | undefined)[] | null }[] = [
    { blocks: definition.blocks, items: [undefined] },
  ];
  while (pending.length > 0) {
    const { blocks, items } = pending.pop()!;
    for (const block of blocks) {
      if (block.id === blockId) return items;
      if (block.kind === 'parallel') pending.push(...block.branches.map((branch) => ({ blocks: branch.blocks, items })));
      else if (block.kind === 'if') pending.push({ blocks: block.then, items }, { blocks: block.otherwise, items });
      else if (block.kind === 'loop') {
        let bodyItems = items;
        if (block.repetition.kind === 'items') {
          const expanded: WorkflowBoundItem[] = [];
          bodyItems = expanded;
          if (items === null) bodyItems = null;
          else for (const item of items) {
            const values = boundValue(block.repetition.items, context, block.id, 'run', item);
            if (!Array.isArray(values)) { bodyItems = null; break; }
            values.forEach((value, index) => expanded.push({ value, index, position: index + 1, count: values.length }));
          }
        }
        pending.push({ blocks: block.body, items: bodyItems });
        if (block.repetition.kind === 'evaluate') pending.push({ blocks: [block.repetition.evaluator], items });
      }
    }
  }
  return null;
}

export async function readWorkflowAcceptedAgentStartLeavesV1(snapshot: Pick<WorkflowAcceptedSnapshotV1,
  'machineId' | 'workspaceTarget' | 'materializedLeaves' | 'authoredDefinition' | 'frozenChildren' | 'inputs' | 'origin'>): Promise<readonly MaterializedWorkflowLeafV1[]> {
  const result: MaterializedWorkflowLeafV1[] = [];
  for (const leaf of snapshot.materializedLeaves) {
    const agent = agentLeaf(snapshot, leaf);
    if (agent) result.push(agent);
    const definition = leaf.sourceKey === '$root' ? snapshot.authoredDefinition : snapshot.frozenChildren[leaf.sourceKey];
    const authored = definition && leavesOf(definition).find((block) => block.id === leaf.blockId);
    const context = { inputs: leaf.sourceKey === '$root' ? snapshot.inputs : {}, origin: snapshot.origin };
    const items = definition !== undefined && leaf.kind === 'action' && authored?.kind === 'action' && hasUnresolvedValue(leaf.actionInput)
      ? actionItemContexts(definition, leaf.blockId, context) : null;
    if (items === null || authored?.kind !== 'action') {
      result.push(...projectActionStart(snapshot, leaf).leaves);
      continue;
    }
    for (const item of items) {
      const actionInput = { ...leaf.actionInput };
      for (const [field, binding] of Object.entries(authored.input)) {
        if (!hasUnresolvedValue(actionInput[field]) || !(binding.kind === 'list'
          ? binding.items.some((reference) => reference.kind === 'item') : binding.kind === 'item')) continue;
        actionInput[field] = binding.kind === 'list'
          ? binding.items.map((reference) => boundValue(reference, context, leaf.blockId, 'run', item))
          : boundValue(binding, context, leaf.blockId, 'run', item);
      }
      result.push(...projectActionStart(snapshot, { ...leaf, actionInput }).leaves);
    }
  }
  return result;
}

function boundValue(reference: WorkflowActionValueReferenceV1, context: WorkflowBindingContext, blockId: string, purpose: 'run' | 'definition', item?: WorkflowBoundItem): JsonValue | Unresolved {
  if (reference.kind === 'literal') return reference.value;
  if (reference.kind === 'input') return Object.hasOwn(context.inputs, reference.name)
    ? context.inputs[reference.name]! : { kind: 'unresolved' };
  if (reference.kind === 'origin_session_id') {
    if (purpose === 'definition' && !context.origin?.originSessionId) return { kind: 'unresolved' };
    if (!context.origin?.originSessionId) throw new WorkflowMaterializationFailureV1({ code: 'invalid_input', blockId });
    return context.origin.originSessionId;
  }
  if (reference.kind === 'item' && item) {
    const selected = readWorkflowValuePathV1(item[reference.field], reference.path ?? []);
    return selected === undefined ? { kind: 'unresolved' } : selected;
  }
  return { kind: 'unresolved' };
}

function hasUnresolvedValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === 'object') {
      if ('kind' in current && current.kind === 'unresolved') return true;
      pending.push(...Object.values(current));
    }
  }
  return false;
}

/** Freezes a frame's declared round bounds before its first leaf can admit input. */
export function freezeWorkflowLoopLimitsV1(
  authored: WorkflowDefinitionV1,
  inputs: WorkflowResolvedInputsV1,
): WorkflowDefinitionV1 | null {
  const definition = structuredClone(authored);
  const pending = [...definition.blocks];
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (block.kind === 'parallel') pending.push(...block.branches.flatMap((branch) => branch.blocks));
    else if (block.kind === 'if') pending.push(...block.then, ...block.otherwise);
    else if (block.kind === 'loop') {
      pending.push(...block.body);
      const repetition = block.repetition;
      if ((repetition.kind === 'until' || repetition.kind === 'evaluate') && typeof repetition.maxIterations !== 'number') {
        const name = repetition.maxIterations.name;
        const declared = authored.inputs.find((input) => input.name === name);
        const value = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : declared?.default;
        if (declared?.valueType !== 'number' || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
        Object.assign(block, { repetition: { ...repetition, maxIterations: value } });
      }
    }
  }
  return definition;
}

/** The one pre-effect pass for direct, saved, inline and trigger admission. */
export async function materializeWorkflowAcceptedSnapshotV1(input: MaterializeWorkflowAcceptedSnapshotV1Input): Promise<MaterializeWorkflowAcceptedSnapshotV1Result> {
  return materializeWorkflowV1(input, 'run');
}

/** Definition authority resolves the same leaves, without binding future Run inputs. */
export async function materializeWorkflowDefinitionAuthorityV1(
  input: Omit<MaterializeWorkflowAcceptedSnapshotV1Input, 'admission'>,
): Promise<MaterializeWorkflowDefinitionAuthorityV1Result> {
  return materializeWorkflowV1({ ...input, admission: { kind: 'user' } }, 'definition');
}

function materializeWorkflowV1(input: MaterializeWorkflowAcceptedSnapshotV1Input, purpose: 'run'): Promise<MaterializeWorkflowAcceptedSnapshotV1Result>;
function materializeWorkflowV1(input: MaterializeWorkflowAcceptedSnapshotV1Input, purpose: 'definition'): Promise<MaterializeWorkflowDefinitionAuthorityV1Result>;
async function materializeWorkflowV1(input: MaterializeWorkflowAcceptedSnapshotV1Input, purpose: 'run' | 'definition'): Promise<MaterializeWorkflowAcceptedSnapshotV1Result | MaterializeWorkflowDefinitionAuthorityV1Result> {
  const replay = input.replay;
  if (replay) {
    if (purpose !== 'run') return invalidInput();
    const override = replay.agentOverride && WorkflowReplayAgentOverrideV1Schema.safeParse(replay.agentOverride);
    if (override && !override.success) return invalidInput();
    if (replay.agentOverride && !replay.snapshot.materializedLeaves.some(leaf => leaf.kind === 'step'
      && leaf.sourceKey === replay.agentOverride!.sourceKey && leaf.blockId === replay.agentOverride!.blockId)) return invalidInput();
    input = { ...input, definition: replay.snapshot.authoredDefinition, roleOverrides: replay.snapshot.roleOverrides,
      context: { ...input.context, machineId: replay.snapshot.machineId,
        workspaceTarget: replay.snapshot.workspaceTarget, executionTarget: replay.snapshot.executionTarget } };
  }
  const overrides = WorkflowRoleOverridesV1Schema.safeParse(input.roleOverrides ?? []);
  if (!overrides.success) return invalidInput(undefined, overrides.error.issues.map((issue) => ({
    code: 'invalid_input', path: `/roleOverrides/${issue.path.map(String).join('/')}`, message: issue.message, severity: 'error',
  })));
  const normalized = validateWorkflowDefinition(input.definition, { context: input.ingressContext });
  if (!normalized.valid || !normalized.normalizedDefinition) return invalidDefinition(normalized.issues);
  const root = normalized.normalizedDefinition;
  const frozenRoot = purpose === 'definition' ? structuredClone(root) : freezeWorkflowLoopLimitsV1(root, input.context.inputs);
  if (!frozenRoot) return invalidInput();
  const definitions = new Map<string, WorkflowDefinitionV1>([['$root', root]]);
  const sourceRef = input.context.source.kind === 'saved' ? input.context.source.definitionId
    : input.context.source.kind === 'catalog' ? input.context.source.ref
      : input.context.source.kind === 'automation' ? input.context.source.definitionId : undefined;
  const visiting = new Set<string>(sourceRef === undefined ? [] : [sourceRef]);
  type ResolveTask = { kind: 'enter'; leaf: Extract<WorkflowLeafV1, { kind: 'workflow' }> }
    | { kind: 'exit'; ref: string };
  const pending: ResolveTask[] = leavesOf(root).filter((leaf) => leaf.kind === 'workflow')
    .reverse().map((leaf) => ({ kind: 'enter', leaf }));
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.kind === 'exit') { visiting.delete(task.ref); continue; }
    const ref = parseWorkflowDefinitionRefV1(task.leaf.workflowRef);
    if (!ref) return invalidInput(task.leaf.id);
    const key = formatWorkflowDefinitionRefV1(ref);
    if (visiting.has(key)) return invalidInput(task.leaf.id, [{ code: 'invalid_input', blockId: task.leaf.id,
      path: `/blocks/${task.leaf.id}/workflowRef`, severity: 'error', message: 'Workflow composition cannot contain a cycle.' }]);
    if (definitions.has(key)) continue;
    const source = replay ? (replay.snapshot.frozenChildren[key]
      ? { definition: replay.snapshot.frozenChildren[key] } : null) : await input.effects.readWorkflowDefinition?.(ref);
    if (!source) return { ok: false, error: { code: 'source_unavailable', blockId: task.leaf.id } };
    const child = validateWorkflowDefinition(source.definition, { context: input.ingressContext });
    if (!child.valid || !child.normalizedDefinition) return invalidDefinition(child.issues, task.leaf.id);
    definitions.set(key, child.normalizedDefinition);
    visiting.add(key);
    pending.push({ kind: 'exit', ref: key });
    pending.push(...leavesOf(child.normalizedDefinition).filter((leaf) => leaf.kind === 'workflow')
      .reverse().map((leaf): ResolveTask => ({ kind: 'enter', leaf })));
  }

  // Context belongs to the Run's frozen origin even across nested Workflow frames.
  if (purpose === 'run' && !input.context.origin?.originSessionId) {
    for (const definition of definitions.values()) {
      if (usesSessionContext(definition)) return invalidInput();
    }
  }

  const concrete = new Map<string, WorkflowDefinitionV1>();
  const materializedLeaves: WorkflowMaterializedLeafV1[] = [];
  const profiles = new Map<string, AiLaunchProfile | null>();
  for (const [sourceKey, authored] of definitions) {
    // Child inputs are bound at the inline frame's admission, not the parent's.
    const definition = sourceKey === '$root' ? frozenRoot : structuredClone(authored);
    const leaves = leavesOf(definition);
    const targetById = new Map<string, WorkflowRunExecutionTargetV1>();
    // Semantic validation already proves producer order and lexical visibility.
    for (const leaf of leaves) {
      const frozen = replay?.snapshot.materializedLeaves.find(entry => entry.sourceKey === sourceKey && entry.blockId === leaf.id);
      if (replay && (!frozen || frozen.kind !== leaf.kind)) return invalidInput(leaf.id);
      const agentOverride = replay?.agentOverride?.sourceKey === sourceKey && replay.agentOverride.blockId === leaf.id
        ? replay.agentOverride : undefined;
      let resolved: ReturnType<typeof resolveWorkflowStepSelectionV1>;
      try {
        const conversation = leaf.execution?.conversation ?? definition.defaults.conversation;
        resolved = frozen ? { selection: agentOverride
          ? resolveWorkflowStepSelectionV1({ defaults: frozen.selection, step: { engine: agentOverride.engine },
            roleSelection: input.roleSelection,
            ...(frozen.selection.conversation?.kind === 'from_step'
              ? { producerExecutionTarget: frozen.executionTarget } : {}) }).selection
          : structuredClone(frozen.selection), executionTarget: frozen.executionTarget, role: frozen.role }
          : resolveWorkflowStepSelectionV1({ defaults: definition.defaults, step: leaf.execution,
          runExecutionTarget: input.context.executionTarget,
          ...(conversation?.kind === 'from_step' ? { producerExecutionTarget: targetById.get(conversation.producer.blockId) } : {}),
          roleSelection: { ...input.roleSelection, workflowRoles: definition.roles, runOverrides: overrides.data },
        });
      } catch (error) {
        if (error instanceof WorkflowStepSelectionErrorV1) return { ok: false, error: { ...error.refusal, blockId: leaf.id } };
        throw error;
      }
      const executionTarget = resolved.executionTarget ?? input.context.executionTarget;
      let selection = resolved.selection;
      // Choosing a role's engine does not also choose that role's profile.
      if (frozen && agentOverride && frozen.selection.profileId === undefined) delete selection.profileId;
      if (purpose === 'run' && selection.conversation?.kind === 'origin_session' && !input.context.origin?.originSessionId) return invalidInput(leaf.id);
      if (!frozen && selection.profileId) {
        if (!profiles.has(selection.profileId)) profiles.set(selection.profileId, await input.effects.readLaunchProfile?.(selection.profileId) ?? null);
        const profile = profiles.get(selection.profileId);
        if (!profile) return unavailable(leaf.id);
        const portable = profileSelection(profile, selection, executionTarget);
        if (!portable) return unavailable(leaf.id);
        selection = portable;
      }
      const parsedSelection = WorkflowStepExecutionSelectionSchema.safeParse(selection);
      if (!parsedSelection.success) return invalidInput(leaf.id);
      selection = parsedSelection.data;
      const sidecar: WorkflowMaterializedLeafV1 = { sourceKey, blockId: leaf.id, kind: leaf.kind, selection, executionTarget,
        authoredWorkspace: frozen?.authoredWorkspace ?? leaf.execution?.workspace ?? { kind: 'inherit' },
        ...(resolved.role === undefined ? {} : { role: { ...structuredClone(resolved.role),
          ...(selection.profileId === null ? { profileUnavailable: false } : {}) } }),
        ...(leaf.kind === 'workflow' ? { childRef: frozen?.childRef ?? leaf.workflowRef } : {}),
      };
      if (leaf.kind === 'action') {
        const contract = frozen ? frozen.actionContract : await input.effects.readActionContract?.(leaf.actionId);
        if (!contract) return unavailable(leaf.id);
        sidecar.actionId = leaf.actionId;
        sidecar.actionContract = structuredClone(contract);
        const bindingContext = sourceKey === '$root' ? input.context : { ...input.context, inputs: {} };
        const hasDeferredBinding = Object.values(leaf.input).some((binding) =>
          (binding.kind === 'list' ? binding.items : [binding]).some((reference) =>
            reference.kind !== 'literal' && reference.kind !== 'origin_session_id'
            && (reference.kind !== 'input' || !Object.hasOwn(bindingContext.inputs, reference.name))));
        try {
          // Child frame inputs bind at invocation. Keep its already-projected
          // Action engine rather than rebuilding it from the concrete carrier.
          sidecar.actionInput = frozen && sourceKey !== '$root' ? structuredClone(frozen.actionInput)
            : Object.fromEntries(Object.entries(leaf.input).map(([field, binding]) => [field,
            binding.kind === 'list' ? binding.items.map((reference) => boundValue(reference, bindingContext, leaf.id, purpose))
              : boundValue(binding, bindingContext, leaf.id, purpose)]));
        } catch (error) {
          if (error instanceof WorkflowMaterializationFailureV1) return { ok: false, error: error.error };
          throw error;
        }
        try {
          const projected = projectActionStart(input.context, sidecar,
            (sourceKey === '$root' ? root : authored).defaults.engine !== undefined || leaf.execution?.engine !== undefined || frozen?.role !== undefined,
            hasDeferredBinding);
          if (projected.effectiveInput) sidecar.actionInput = projected.effectiveInput;
        } catch (error) {
          if (error instanceof WorkflowMaterializationFailureV1) return { ok: false, error: error.error };
          throw error;
        }
        if (contract.inputSchema === null || typeof contract.inputSchema !== 'object' || Array.isArray(contract.inputSchema)) return invalidInput(leaf.id);
        const validate = compileActionInputJsonSchema(contract.inputSchema);
        if (!hasDeferredBinding && !validate(sidecar.actionInput)) return invalidInput(leaf.id,
          describePluginJsonSchemaValueIssues(validate).map((issue) => ({ code: 'invalid_input', blockId: leaf.id,
            path: `/blocks/${leaf.id}/input${issue.pointer}`, message: issue.message, severity: 'error' })));
      }
      // Every executable leaf carries concrete authoring fields. Mutable roles
      // and profile catalogs cannot influence dispatch or recovery after this pass.
      leaf.execution = selection;
      targetById.set(leaf.id, executionTarget);
      materializedLeaves.push(sidecar);
    }
    const { engine: _engine, executionTarget: _target, ...defaults } = definition.defaults;
    concrete.set(sourceKey, { ...definition, defaults });
  }
  let agentStartLeaves: readonly MaterializedWorkflowLeafV1[];
  const frozenChildren = Object.fromEntries([...concrete].filter(([key]) => key !== '$root'));
  try { agentStartLeaves = await readWorkflowAcceptedAgentStartLeavesV1({
    machineId: input.context.machineId, workspaceTarget: input.context.workspaceTarget, materializedLeaves,
    authoredDefinition: root, frozenChildren, inputs: input.context.inputs, origin: input.context.origin,
  }); }
  catch (error) { if (error instanceof WorkflowMaterializationFailureV1) return { ok: false, error: error.error }; throw error; }
  const permissionCeiling = deriveWorkflowAcceptedPermissionCeilingV1(concrete.get('$root')!,
    [...concrete].filter(([key]) => key !== '$root').map(([, definition]) => definition),
    agentStartLeaves.flatMap((leaf) => {
      const intent = typeof leaf.facts.permissionMode === 'string' ? parseAgentPermissionIntentV1Alias(leaf.facts.permissionMode) : null;
      return intent === null ? [] : [intent];
    }));
  let workDepth = input.admission.kind === 'trigger' ? input.admission.workDepth : 0;
  if (input.admission.kind === 'agent' && agentStartLeaves.length === 0) {
    const admitted = await input.admission.admitRun?.();
    if (!admitted) return { ok: false, error: { code: 'target_unavailable' } };
    if (!admitted.ok) return { ok: false, error: admitted.refusal };
    workDepth = admitted.stamped.workDepth;
  }
  if (input.admission.kind !== 'user') {
    for (const leaf of agentStartLeaves) {
      const role = materializedLeaves.find((sidecar) => sidecar.sourceKey === leaf.sourceKey && sidecar.blockId === leaf.blockId && sidecar.role?.roleId === leaf.roleId)?.role;
      const admitted = await input.admission.admitLeaf(leaf, { permissionCeiling, ...(role ? { role } : {}) });
      if (!admitted.ok) return { ok: false, error: leaf.kind === 'action' && hasUnresolvedValue(leaf.facts)
        ? { code: 'definition_exceeds_authority', blockId: leaf.blockId, cause: admitted.refusal }
        : { ...admitted.refusal, blockId: admitted.refusal.blockId ?? leaf.blockId } };
      if (input.admission.kind === 'agent') workDepth = admitted.stamped.workDepth;
    }
  }
  // Action leaves also receive the supplied origin as defaultSessionId, even
  // without an explicit origin reference in the authored definition.
  const requiredOriginSessionId = purpose === 'run' ? input.context.origin?.originSessionId : undefined;
  for (const leaf of materializedLeaves) {
    const sessionIds = readWorkflowLeafTargetSessionIdsV1(leaf.selection, requiredOriginSessionId);
    if ((leaf.kind === 'step' || leaf.kind === 'action' || sessionIds.length > 0)
      && !await input.effects.resolveTargetAvailability(leaf, { sessionIds })) return unavailable(leaf.blockId);
  }
  for (const leaf of agentStartLeaves) {
    if (leaf.kind !== 'action' || !leaf.facts.agentTarget || leaf.facts.agentTarget.kind === 'unresolved') continue;
    if (leaf.facts.agentTarget.kind !== 'agent') return unavailable(leaf.blockId);
    const selected = materializedLeaves.find((sidecar) => sidecar.sourceKey === leaf.sourceKey && sidecar.blockId === leaf.blockId && sidecar.kind === 'action');
    if (!selected) return unavailable(leaf.blockId);
    if (!await input.effects.resolveTargetAvailability({ blockId: leaf.blockId,
      selection: { ...selected.selection, agentTarget: leaf.facts.agentTarget },
      executionTarget: leaf.runsAs.kind === 'session' ? { kind: 'session' } : { kind: 'detached_run' },
    }, { sessionIds: [] })) return unavailable(leaf.blockId);
  }
  if (purpose === 'definition') return { ok: true, agentStartLeaves, materializedLeaves };
  const { origin, resultDelivery, actionCaller, ...sharedContext } = input.context;
  const snapshot = WorkflowAcceptedSnapshotV1Schema.safeParse({
    ...sharedContext, ...(origin ? { origin } : input.context.source.kind === 'automation' ? {} : { origin: { kind: 'direct' } }),
    ...(resultDelivery ? { resultDelivery } : {}),
    definition: concrete.get('$root'), authoredDefinition: root, materializedLeaves, frozenChildren, workDepth,
    requiresMachineStartCapacity: workflowRequiresMachineStartCapacityV1(materializedLeaves),
    targetSessionIds: deriveWorkflowDestinationsV1({ definition: concrete.get('$root')!, materializedLeaves,
      originSessionId: input.context.origin?.originSessionId }).targetSessionIds,
    startedBy: actionCaller ? resolveWorkflowRunStartedByForActionCallerV1(actionCaller) : input.admission.kind,
    metadata: sharedContext.metadata ?? null,
    roleOverrides: overrides.data,
    authorization: { ...input.context.authorization, admittedPermissionCeiling: permissionCeiling },
  });
  if (!snapshot.success) return invalidInput();
  if (new TextEncoder().encode(JSON.stringify(snapshot.data)).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES) return invalidInput();
  return { ok: true, snapshot: snapshot.data, agentStartLeaves };
}
