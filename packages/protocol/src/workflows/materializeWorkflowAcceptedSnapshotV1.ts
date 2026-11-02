import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import type { AgentStartAdmissionV1, AgentStartRefusalV1, AgentStartRequestV1, MaterializedWorkflowLeafV1, Unresolved } from '../account/settings/admitAgentStartV1.js';
import { isAgentStartActionV1, projectAgentStartSelectionV1, resolveActionAgentStartRequestsV1 } from '../actions/executor/agentStartAdmission.js';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '../automations/automationStoredContentEnvelopeV1.js';
import { sameStrictJsonValue, type JsonValue } from '../json/strictJsonValue.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import type { ActionCaller } from '../actions/executor/types.js';
import { describePluginJsonSchemaValueIssues } from '../plugins/actions/jsonSchemaValidation.js';
import { compileActionInputJsonSchema } from '../actions/actionInputJsonSchemaValidation.js';
import { isLaunchProfileV2, type AiLaunchProfile } from '../profiles/read.js';
import type { ResolvedRoleV1 } from '../prompts/roles/rolesV1.js';
import { resolveRoleSelectionV1 } from '../prompts/roles/resolveRoleSelectionV1.js';
import { parseAgentPermissionIntentV1Alias, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { formatWorkflowDefinitionRefV1, parseWorkflowDefinitionRefV1, type WorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';
import { WorkflowAcceptedSnapshotV1Schema, WorkflowMaterializedLeafV1Schema, WorkflowRoleOverridesV1Schema, WorkflowReplayAgentOverrideV1Schema, deriveWorkflowAcceptedPermissionCeilingV1,
  type WorkflowAcceptedAuthorizationV1, type WorkflowAcceptedSnapshotV1, type WorkflowDefinitionMetadataV1,
  type WorkflowMaterializedLeafV1, type WorkflowResolvedInputsV1, type WorkflowRoleOverridesV1,
  type WorkflowReplayAgentOverrideV1,
  type WorkflowRunExecutionTargetV1 } from './workflowDefinitionV1.js';
import { listWorkflowAcceptedLeafSelectionsV1, parseWorkflowLiteralEngineSelectionV1, resolveWorkflowAcceptedStepSelectionV1, resolveWorkflowEngineSelectionV1, resolveWorkflowStepSelectionV1, WorkflowStepSelectionErrorV1, type ResolveWorkflowStepSelectionV1Input, type WorkflowResolvedStepSelectionV1, type WorkflowStepSelectionRefusalV1, type WorkflowRoleSelectionContextV1 } from './workflowStepSelectionV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { WorkflowStepExecutionSelectionSchema, type WorkflowBlock, type WorkflowDefinitionV1,
  type WorkflowIngressContextV1, type WorkflowLeafV1, type WorkflowStepSelectionV1,
  type WorkflowActionValueReferenceV1,
  type WorkflowValidationIssue } from './workflowV1.js';
import type { WorkflowAcceptedWorkspaceTargetV1 } from './workflowWorkspaceV1.js';
import { collectWorkflowConditionValueReferences, readWorkflowValuePathV1, type WorkflowValueReference } from './workflowReferenceV1.js';
import { collectWorkflowLeavesV1 as leavesOf, deriveWorkflowDestinationsV1, readWorkflowLeafTargetSessionIdsV1 } from './workflowDestinationsV1.js';
import type { WorkflowTargetUnavailableDetailsV1 } from './workflowProgressV1.js';
import { normalizeExecutableParticipantSelectionV1 } from '../discussions/executableParticipants.js';
import { SessionSpawnNewSelectionV2Schema } from '../sessions/creation/sessionSpawnNewSelectionV2.js';
import { resolveWorkflowContextInputsV1, workflowInputErrorV1, WorkflowInputErrorV1, type ResolveWorkflowSessionTargetV1, type WorkflowResolvedSessionTargetV1 } from './workflowStartPreparationV1.js';

export type WorkflowMaterializationContextV1 = Readonly<{
  /** Host-stamped admitting caller; private input, never authored Workflow content. */
  actionCaller?: ActionCaller;
  source: WorkflowAcceptedSnapshotV1['source']; inputs: WorkflowResolvedInputsV1;
  machineId: string; executionTarget: WorkflowRunExecutionTargetV1; workspaceTarget: WorkflowAcceptedWorkspaceTargetV1;
  metadata?: WorkflowDefinitionMetadataV1;
  origin?: WorkflowAcceptedSnapshotV1['origin'];
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
  resolveSessionTarget?: ResolveWorkflowSessionTargetV1;
  /** Admission against the original caller's canonical Session corpus, not Account access. */
  admitSessionAuthority?: (target: WorkflowResolvedSessionTargetV1) => Promise<boolean>;
  readWorkflowDefinition?: (ref: WorkflowDefinitionRefV1) => Promise<Readonly<{ definition: unknown; sourceKey: string; version?: number | string }> | null>;
  readLaunchProfile?: (profileId: string) => Promise<AiLaunchProfile | null>;
  /** Fresh source facts for an unfrozen Role actually consumed by this admission. */
  readRoleSelection?: (roleId: string) => Promise<NonNullable<MaterializeWorkflowAcceptedSnapshotV1Input['roleSelection']>>;
  resolveTargetAvailability: (leaf: Readonly<{
    blockId: string; selection: WorkflowResolvedStepSelectionV1;
    executionTarget: WorkflowRunExecutionTargetV1; actionId?: string; kind?: WorkflowMaterializedLeafV1['kind'];
    participant?: WorkflowMaterializedLeafV1['participant'];
  }>, context: Readonly<{ sessionIds: readonly string[] }>) => Promise<boolean | WorkflowTargetUnavailableDetailsV1>;
  readActionContract?: (actionId: string) => Promise<NonNullable<WorkflowMaterializedLeafV1['actionContract']> | null>;
}>;
export type WorkflowMaterializationAdmissionV1 =
  | Readonly<{ kind: 'user' }>
  | Readonly<{ kind: 'agent'; admitRun?: (facts: Readonly<{ permissionCeiling: AgentPermissionIntentV1 }>) => Promise<AgentStartAdmissionV1>; admitLeaf: (leaf: MaterializedWorkflowLeafV1,
    facts: Readonly<{ permissionCeiling: AgentPermissionIntentV1; role?: ResolvedRoleV1 }>) => Promise<AgentStartAdmissionV1> }>
  | Readonly<{ kind: 'trigger'; workDepth: number; admitLeaf: (leaf: MaterializedWorkflowLeafV1,
    facts: Readonly<{ permissionCeiling: AgentPermissionIntentV1; role?: ResolvedRoleV1 }>) => Promise<AgentStartAdmissionV1> }>;
export type MaterializeWorkflowAcceptedSnapshotV1Input = Readonly<{
  definition: unknown; context: WorkflowMaterializationContextV1; ingressContext?: WorkflowIngressContextV1;
  roleOverrides?: WorkflowRoleOverridesV1;
  /** Host-opened immutable source, never an authored/client-supplied snapshot. */
  replay?: Readonly<{ snapshot: WorkflowAcceptedSnapshotV1; agentOverride?: WorkflowReplayAgentOverrideV1 }>;
  roleSelection?: Omit<WorkflowRoleSelectionContextV1, 'workflowRoles' | 'runOverrides'>;
  admission: WorkflowMaterializationAdmissionV1; effects: WorkflowMaterializationEffectsV1;
}>;
export type WorkflowMaterializationErrorV1 = AgentStartRefusalV1 | WorkflowTargetUnavailableDetailsV1 | (WorkflowStepSelectionRefusalV1 & Readonly<{ blockId: string }>) | Readonly<{
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

function usesWorkflowContext(definition: WorkflowDefinitionV1, origin: 'session' | 'discussion'): boolean {
  const pending = [...definition.blocks];
  const isContext = (reference: WorkflowValueReference) => origin === 'discussion'
    ? reference.kind === 'discussion_context'
    : reference.kind === 'session_context' || reference.kind === 'session_context_field';
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
function unavailable(blockId: string, details?: WorkflowTargetUnavailableDetailsV1): MaterializeWorkflowAcceptedSnapshotV1Result {
  return { ok: false, error: { code: 'target_unavailable', reason: 'selection_unavailable', ...details, blockId } };
}
function mayAdmitSessionWithoutDedicatedAuthority(input: MaterializeWorkflowAcceptedSnapshotV1Input): boolean {
  return input.context.authorization.principal.kind === 'host'
    && (input.admission.kind === 'user' && (!input.context.actionCaller || input.context.actionCaller.kind === 'host')
      || input.admission.kind === 'trigger' && input.context.actionCaller?.kind === 'automationRun');
}
function invalidDefinition(issues: readonly WorkflowValidationIssue[], blockId?: string): MaterializeWorkflowAcceptedSnapshotV1Result {
  const targetIssue = issues.find((issue) => issue.code === 'target_unavailable' && issue.blockId !== undefined);
  if (targetIssue && !issues.some((issue) => issue.severity === 'error' && issue.code !== 'target_unavailable')) {
    return unavailable(targetIssue.blockId!);
  }
  return invalidInput(blockId ?? issues.find((entry) => entry.blockId !== undefined)?.blockId, issues);
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
  const launch = leaf.participant?.kind === 'model' ? leaf.participant.launch : undefined;
  if (launch) {
    const requested = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: launch,
      context: { executionRunTargetMachineId: snapshot.machineId },
      baseline: { machineId: snapshot.machineId, directory: snapshot.workspaceTarget.project.directory } });
    const start = requested.ok ? requested.requests.find(request => request.kind === 'spawn_new') : undefined;
    if (!start || start.kind !== 'spawn_new') throw new WorkflowMaterializationFailureV1({ code: 'invalid_input', blockId: leaf.blockId });
    return { sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: 'session',
      ...(launch.roleId ? { roleId: launch.roleId } : {}),
      engine: { agentTargetKey: buildBackendTargetKeyV2(launch.agentTarget),
        ...(launch.modelSelection ? { modelId: launch.modelSelection.ref.modelId } : {}) },
      runsAs: { kind: 'session' }, workspaceWrites: leaf.role?.workspaceWrites ?? 'allow',
      facts: start.facts };
  }
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
      ...(selection.launchEnvironment === undefined ? {} : { hasEnvironmentVariables:
        Object.keys(selection.launchEnvironment.values).length > 0 || selection.launchEnvironment.unset.length > 0 }),
      ...(selection.connectedServices !== undefined ? { connectedServices: selection.connectedServices } : {}),
      ...(selection.capabilitySelection !== undefined ? { capabilitySelection: selection.capabilitySelection } : {}),
      ...(selection.transcriptStorage ? { transcriptStorage: selection.transcriptStorage } : {}),
      ...(selection.sessionConfigOptionOverrides !== undefined ? { configOptions: selection.sessionConfigOptionOverrides === null ? null
        : Object.fromEntries(Object.entries(selection.sessionConfigOptionOverrides.overrides)
          .map(([name, option]) => [name, { value: option.value, updatedAtMs: option.updatedAt }])) } : {}),
    },
  };
}

/** Machine start admission is about execution, never trigger scope. */
export function workflowRequiresMachineStartCapacityV1(leaves: readonly WorkflowMaterializedLeafV1[]): boolean {
  return leaves.flatMap(listWorkflowAcceptedLeafSelectionsV1).some(leaf => {
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

/** The accepted Machine supplies only a default; authored choices keep their own admission path. */
export function projectWorkflowFiniteActionInputV1(input: Readonly<{
  machineId: string; actionId: string; input: Record<string, JsonValue>;
}>): Record<string, JsonValue> {
  if ((input.actionId !== 'projects.script.run' && input.actionId !== 'projects.compute.exec')
    || Object.hasOwn(input.input, 'choice')) return input.input;
  const workspace = WorkspaceAddressV1Schema.safeParse(input.input.workspace);
  // Deferred bindings resolve at invocation. Do not invent their primary/worker classification.
  if (!workspace.success) return input.input;
  return {
    ...input.input,
    choice: workspace.data.machineId === input.machineId
      ? { kind: 'primary' }
      : { kind: 'workers', destination: { kind: 'machine', machineId: input.machineId } },
  };
}

function projectActionStart(snapshot: Pick<WorkflowAcceptedSnapshotV1, 'machineId' | 'workspaceTarget'>, leaf: WorkflowMaterializedLeafV1,
  overrideEngine = leaf.role !== undefined, deferAuthorityErrors = hasUnresolvedValue(leaf.actionInput)): Readonly<{
  leaves: readonly MaterializedWorkflowLeafV1[]; effectiveInput?: WorkflowMaterializedLeafV1['actionInput'];
}> {
  if (leaf.actionId === 'projects.script.run' || leaf.actionId === 'projects.compute.exec') {
    return { leaves: [], effectiveInput: projectWorkflowFiniteActionInputV1({
      machineId: snapshot.machineId, actionId: leaf.actionId, input: leaf.actionInput ?? {},
    }) };
  }
  if (!leaf.actionId || !isAgentStartActionV1(leaf.actionId)) return { leaves: [] };
  const selection = leaf.selection;
  const baseline = { machineId: snapshot.machineId, directory: snapshot.workspaceTarget.project.directory };
  const actionInput = { ...leaf.actionInput };
  const requested = resolveActionAgentStartRequestsV1({ actionId: leaf.actionId, input: actionInput,
    context: { executionRunTargetMachineId: snapshot.machineId }, baseline,
    effectiveSelection: { selection, overrideEngine } });
  const projectRequest = (request: AgentStartRequestV1): MaterializedWorkflowLeafV1[] => {
    if (request.kind !== 'spawn_new' && request.kind !== 'execution_run') return [];
    const facts = { ...request.facts,
      machineId: request.facts.machineId ?? baseline.machineId, directory: request.facts.directory ?? baseline.directory,
      permissionMode: request.facts.permissionMode ?? 'default',
    };
    const target = facts.agentTarget;
    if ((!target || target.kind === 'unresolved') && !deferAuthorityErrors) throw new WorkflowMaterializationFailureV1({ code: 'target_unavailable', reason: 'selection_unavailable', blockId: leaf.blockId });
    const model = facts.modelSelection;
    const modelRef = model && !('kind' in model) ? ('ref' in model ? model.ref : model) : undefined;
    return [{ sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: 'action', actionId: leaf.actionId,
      ...(leaf.role ? { roleId: leaf.role.roleId } : request.roleId ? { roleId: request.roleId } : {}),
      ...(target && target.kind !== 'unresolved' ? { engine: { agentTargetKey: buildBackendTargetKeyV2(target), ...(modelRef ? { modelId: modelRef.modelId } : {}) } } : {}),
      runsAs: request.kind === 'spawn_new' ? { kind: 'session' } : { kind: 'background_run', intent: request.intent },
      workspaceWrites: leaf.role?.workspaceWrites ?? 'allow', facts,
    }];
  };
  if (!requested.ok) {
    if (deferAuthorityErrors && requested.errorCode === 'target_unavailable') return { leaves: [
      ...(requested.knownRequests ?? []).flatMap(projectRequest),
      { sourceKey: leaf.sourceKey, blockId: leaf.blockId, kind: 'action', actionId: leaf.actionId,
        ...(leaf.role ? { roleId: leaf.role.roleId, engine: leaf.role.engine } : {}),
        runsAs: { kind: 'background_run', intent: 'delegate' }, workspaceWrites: leaf.role?.workspaceWrites ?? 'allow',
        facts: { ...requested.knownFacts, permissionMode: requested.knownFacts?.permissionMode ?? 'default', agentTarget: { kind: 'unresolved' } },
      },
    ] };
    throw new WorkflowMaterializationFailureV1({
      code: requested.errorCode === 'invalid_parameters' ? 'invalid_input' : requested.errorCode, blockId: leaf.blockId,
    });
  }
  const effectiveInput = WorkflowMaterializedLeafV1Schema.shape.actionInput.safeParse(requested.effectiveInput);
  if (!effectiveInput.success || effectiveInput.data === undefined) throw new WorkflowMaterializationFailureV1({ code: 'invalid_input', blockId: leaf.blockId });
  return { leaves: requested.requests.flatMap(projectRequest), effectiveInput: effectiveInput.data };
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
            const source = block.repetition.items;
            if (source.kind === 'input' && !Object.hasOwn(context.inputs, source.name)
              && definition.inputs.some(field => field.name === source.name && !field.required)) continue;
            const values = boundValue(source, context, block.id, 'run', item);
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
    for (const selected of listWorkflowAcceptedLeafSelectionsV1(leaf)) {
      const agent = agentLeaf(snapshot, selected);
      if (agent) result.push(agent);
    }
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
  if (reference.kind === 'input') {
    const value = Object.hasOwn(context.inputs, reference.name)
      ? readWorkflowValuePathV1(context.inputs[reference.name]!, reference.path ?? []) : undefined;
    return value === undefined ? { kind: 'unresolved' } : value;
  }
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

export { hasUnresolvedValue as hasUnresolvedWorkflowValueV1 };

/** Host-only Run admission; concrete Action children still require ordinary admission at the frozen Run depth. */
export function readWorkflowRunLeafStartRequestV1(leaf: MaterializedWorkflowLeafV1): Extract<AgentStartRequestV1, { kind: 'workflow_run_leaf' }> {
  if (leaf.kind === 'action' && Object.values(leaf.facts).some(value =>
    value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'unresolved')) {
    return { kind: 'workflow_run_leaf', leaf, selection: 'deferred' };
  }
  return { kind: 'workflow_run_leaf', leaf };
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
        workspaceTarget: replay.snapshot.workspaceTarget, executionTarget: replay.snapshot.executionTarget,
        origin: replay.snapshot.origin } };
  }
  const overrides = WorkflowRoleOverridesV1Schema.safeParse(input.roleOverrides ?? []);
  if (!overrides.success) return invalidInput(undefined, overrides.error.issues.map((issue) => ({
    code: 'invalid_input', path: `/roleOverrides/${issue.path.map(String).join('/')}`, message: issue.message, severity: 'error',
  })));
  const normalized = validateWorkflowDefinition(input.definition, { context: input.ingressContext });
  if (!normalized.valid || !normalized.normalizedDefinition) return invalidDefinition(normalized.issues);
  const root = normalized.normalizedDefinition;
  // One finite admission observes each consumed source once; a later operation
  // opens it afresh. Unchanged frozen replay never opens the mutable catalog.
  const roleSelections = new Map<string, Promise<NonNullable<MaterializeWorkflowAcceptedSnapshotV1Input['roleSelection']>>>();
  const readRoleSelection = async (roleId: string) => {
    let selected = roleSelections.get(roleId);
    if (!selected) {
      selected = input.effects.readRoleSelection?.(roleId) ?? Promise.resolve({});
      roleSelections.set(roleId, selected);
    }
    return { ...await selected, ...input.roleSelection };
  };
  if (purpose === 'run') {
    try {
      input = { ...input, context: { ...input.context, inputs: await resolveWorkflowContextInputsV1({ definition: root,
        inputs: input.context.inputs, originSessionId: input.context.origin?.originSessionId,
        resolveSessionTarget: input.effects.resolveSessionTarget }) } };
    } catch (error) {
      if (error instanceof WorkflowInputErrorV1) return invalidInput(undefined, error.issues);
      throw error;
    }
  }
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

  // Session and originless admissions cannot substitute for a Discussion context owner.
  if (purpose === 'run' && !input.context.origin?.discussion) {
    for (const definition of definitions.values()) {
      if (usesWorkflowContext(definition, 'discussion')) return invalidInput();
    }
  }
  // Context belongs to the Run's frozen origin even across nested Workflow frames.
  if (purpose === 'run' && !input.context.origin?.originSessionId) {
    for (const definition of definitions.values()) {
      if (usesWorkflowContext(definition, 'session')) return invalidInput();
    }
  }

  const concrete = new Map<string, WorkflowDefinitionV1>();
  // Reused child definitions may bind different immutable inputs at each parent use.
  // Enumerate those admitted values, while invocation identity stays with its ordinary frame.
  const sourceInputs = new Map<string, WorkflowResolvedInputsV1[]>([['$root', [input.context.inputs]]]);
  const inputFrames = [{ sourceKey: '$root', inputs: input.context.inputs }];
  while (inputFrames.length > 0) {
    const frame = inputFrames.pop()!;
    const authored = definitions.get(frame.sourceKey)!;
    for (const leaf of leavesOf(authored)) {
      if (leaf.kind !== 'workflow') continue;
      const child = definitions.get(leaf.workflowRef);
      if (!child) continue;
      const context = { inputs: frame.inputs, origin: input.context.origin };
      for (const item of actionItemContexts(authored, leaf.id, context) ?? [undefined]) {
        const inputs: WorkflowResolvedInputsV1 = Object.fromEntries(child.inputs.filter(input => input.default !== undefined)
          .map(input => [input.name, input.default!]));
        for (const [name, reference] of Object.entries(leaf.input)) inputs[name] = boundValue(reference, context, leaf.id, purpose, item);
        if (purpose === 'run') {
          try {
            // Ordinary data may still depend on a prior invocation. Only
            // Session context defaults must be concrete at parent admission.
            const contextFields = child.inputs.filter(field => field.defaultFrom
              || field.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'agentParticipant');
            Object.assign(inputs, await resolveWorkflowContextInputsV1({ definition: { inputs: contextFields },
              inputs: Object.fromEntries(contextFields.filter(field => Object.hasOwn(inputs, field.name)).map(field => [field.name, inputs[field.name]!])),
              originSessionId: input.context.origin?.originSessionId, resolveSessionTarget: input.effects.resolveSessionTarget }));
          } catch (error) {
            if (error instanceof WorkflowInputErrorV1) return invalidInput(leaf.id, error.issues);
            throw error;
          }
        }
        const previous = sourceInputs.get(leaf.workflowRef) ?? [];
        if (previous.some(candidate => sameStrictJsonValue(candidate, inputs))) continue;
        sourceInputs.set(leaf.workflowRef, [...previous, inputs]);
        inputFrames.push({ sourceKey: leaf.workflowRef, inputs });
      }
    }
  }
  const materializedLeaves: WorkflowMaterializedLeafV1[] = [];
  const profiles = new Map<string, AiLaunchProfile | null>();
  for (const [sourceKey, authored] of definitions) {
    // Child inputs are bound at the inline frame's admission, not the parent's.
    let definition = sourceKey === '$root' ? frozenRoot : structuredClone(authored);
    // A nested frame's ordinary binder consumes literal defaults, so retain the
    // source Session as an exact admitted default in its executable definition.
    if (purpose === 'run' && sourceKey !== '$root' && input.context.origin?.originSessionId
      && definition.inputs.some(field => field.defaultFrom === 'origin_session')) {
      const defaults = await resolveWorkflowContextInputsV1({ definition: { inputs: definition.inputs.filter(field => field.defaultFrom) }, inputs: {},
        originSessionId: input.context.origin.originSessionId, resolveSessionTarget: input.effects.resolveSessionTarget });
      definition = { ...definition, inputs: definition.inputs.map(field => {
        if (!field.defaultFrom) return field;
        const { defaultFrom: _defaultFrom, ...declared } = field;
        return { ...declared, required: false, default: defaults[field.name]! };
      }) };
    }
    const leaves = leavesOf(definition);
    const authorityBindings: NonNullable<WorkflowMaterializedLeafV1['sessionAuthorityBindings']> = [];
    if (purpose === 'run' || input.effects.admitSessionAuthority) {
      for (const field of authored.inputs.filter(field => field.valueType === 'json' && field.inputType
        && 'hostType' in field.inputType && field.inputType.hostType === 'session')) {
        const targets: NonNullable<WorkflowMaterializedLeafV1['sessionAuthorityBindings']>[number]['targets'] = [];
        for (const inputs of sourceInputs.get(sourceKey) ?? []) {
          const value = Object.hasOwn(inputs, field.name) ? inputs[field.name] : field.default;
          // Birth-trigger authoring admits explicit targets, while a future
          // Session's context defaults and deferred values stay unresolved.
          if (purpose === 'definition' && (value === undefined || hasUnresolvedValue(value))) continue;
          if (value === undefined && !field.required) continue;
          const target = value === undefined ? null : await input.effects.resolveSessionTarget?.(value);
          if (!target || !sameStrictJsonValue(target.address, value) || !target.machineId.trim()) {
            return invalidInput(leaves[0]?.id, workflowInputErrorV1(field.name, 'invalid_input').issues);
          }
          // Check each concrete frame target before recording authority. The
          // declaration and ordinary Account access are not a Session grant.
          if (input.effects.admitSessionAuthority) {
            if (!await input.effects.admitSessionAuthority(target)) return { ok: false, error: { code: 'subtree_denied', blockId: leaves[0]?.id } };
          } else if (!mayAdmitSessionWithoutDedicatedAuthority(input)) {
            return { ok: false, error: { code: 'target_unavailable', reason: 'run_admission_unavailable', blockId: leaves[0]?.id } };
          }
          if (!targets.some(accepted => sameStrictJsonValue(accepted, target))) targets.push(structuredClone(target));
        }
        if (targets.length > 0) authorityBindings.push({ inputName: field.name, targets });
      }
    }
    const targetById = new Map<string, WorkflowRunExecutionTargetV1>();
    // Semantic validation already proves producer order and lexical visibility.
    for (const leaf of leaves) {
      const frozen = replay?.snapshot.materializedLeaves.find(entry => entry.sourceKey === sourceKey && entry.blockId === leaf.id);
      if (replay && (!frozen || frozen.kind !== leaf.kind)) return invalidInput(leaf.id);
      const agentOverride = replay?.agentOverride?.sourceKey === sourceKey && replay.agentOverride.blockId === leaf.id
        ? replay.agentOverride : undefined;
      let resolved: ReturnType<typeof resolveWorkflowStepSelectionV1>;
      let boundEngines: WorkflowMaterializedLeafV1['engineBindings'];
      let boundSessions: WorkflowMaterializedLeafV1['sessionBindings'];
      let boundParticipants: WorkflowMaterializedLeafV1['participantBindings'];
      try {
        const conversation = leaf.execution?.conversation ?? definition.defaults.conversation;
        const engine = leaf.execution?.engine ?? definition.defaults.engine;
        const producer = conversation?.kind === 'from_step' ? materializedLeaves.find(candidate => candidate.sourceKey === sourceKey
          && candidate.blockId === conversation.producer.blockId) : undefined;
        const participantBinding = leaf.execution?.participant ?? definition.defaults.participant ?? frozen?.participantBindings?.reference;
        const binding = participantBinding ? undefined : engine && 'kind' in engine ? engine : producer?.engineBindings?.reference;
        const frameInputs = sourceInputs.get(sourceKey) ?? [];
        if (participantBinding && purpose === 'run') {
          // A chosen participant owns its existing Session setup or complete fresh launch;
          // ambient Workflow defaults are fallback choices, not launch overrides.
          if (leaf.kind !== 'step'
            || frozen && (!frozen.participantBindings
              || !sameStrictJsonValue(frozen.participantBindings.reference, participantBinding))
            || !frozen && (leaf.execution?.permissionMode !== undefined && leaf.execution.permissionMode !== 'read-only'
              || Object.keys(leaf.execution ?? {}).some(key => key !== 'participant' && key !== 'permissionMode'
              && !(key === 'workspace' && leaf.execution?.workspace?.kind === 'inherit')
              && !(key === 'executionTarget' && leaf.execution?.executionTarget?.kind === 'session')))) return invalidInput(leaf.id);
          boundParticipants = { reference: participantBinding, selections: [] };
          for (const inputs of frameInputs) {
            const items = participantBinding.kind === 'item'
              ? participantBinding.roster !== undefined
                ? Array.isArray(inputs[participantBinding.roster])
                  ? (inputs[participantBinding.roster] as JsonValue[]).map((value, index, roster) => ({ value, index, position: index + 1, count: roster.length }))
                  : null
                : actionItemContexts(authored, leaf.id, { inputs, origin: input.context.origin }) : [undefined];
            if (items === null || participantBinding.kind === 'item' && items.some(item => item === undefined)) return invalidInput(leaf.id);
            for (const item of items) {
              const raw = participantBinding.kind === 'item' ? item!.value : inputs[participantBinding.name];
              if (raw === undefined && participantBinding.kind === 'input'
                && authored.inputs.some(field => field.name === participantBinding.name && !field.required)) continue;
              const selectedValue = raw === undefined ? undefined : readWorkflowValuePathV1(raw, participantBinding.path ?? []);
              const value = normalizeExecutableParticipantSelectionV1(selectedValue);
              if (!value) return invalidInput(leaf.id);
              const accepted = frozen?.participantBindings?.selections.find(choice => sameStrictJsonValue(choice.value, value));
              if (frozen && !accepted) return invalidInput(leaf.id);
              if (boundParticipants.selections.some(choice => sameStrictJsonValue(choice.value, value))) continue;
              if (value.kind === 'session') {
                const target = await input.effects.resolveSessionTarget?.(value.session);
                if (!target || !sameStrictJsonValue(target.address, value.session) || !target.machineId.trim()) return invalidInput(leaf.id);
                if (accepted && (accepted.participant.kind !== 'session' || accepted.participant.machineId !== target.machineId)) return invalidInput(leaf.id);
                if (input.effects.admitSessionAuthority && !await input.effects.admitSessionAuthority(target)) {
                  return { ok: false, error: { code: 'subtree_denied', blockId: leaf.id } };
                }
                if (!input.effects.admitSessionAuthority && !mayAdmitSessionWithoutDedicatedAuthority(input)) {
                  return { ok: false, error: { code: 'target_unavailable', reason: 'run_admission_unavailable', blockId: leaf.id } };
                }
                boundParticipants.selections.push({ value, participant: { kind: 'session', session: target.address, machineId: target.machineId },
                  selection: { conversation: { kind: 'existing_session', sessionId: target.address.sessionId, machineId: target.machineId } },
                  executionTarget: { kind: 'session' } });
              } else {
                const chosenLaunch = value.launch;
                if (chosenLaunch.executionTarget.machineId !== input.context.machineId || chosenLaunch.directory.kind !== 'path'
                  || chosenLaunch.checkoutCreationDraft != null) return unavailable(leaf.id);
                let role: ResolvedRoleV1 | undefined;
                if (chosenLaunch.roleId) {
                  if (accepted) {
                    if (accepted.role?.roleId !== chosenLaunch.roleId) return invalidInput(leaf.id);
                    role = accepted.role;
                  } else {
                    const roleResult = resolveRoleSelectionV1({ ...await readRoleSelection(chosenLaunch.roleId), workflowRoles: definition.roles,
                      runOverrides: overrides.data, roleId: chosenLaunch.roleId,
                      defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(chosenLaunch.agentTarget),
                        ...(chosenLaunch.modelSelection ? { modelId: chosenLaunch.modelSelection.ref.modelId } : {}) } });
                    if (!roleResult.ok) return { ok: false, error: { ...roleResult.refusal, blockId: leaf.id } };
                    role = roleResult.selection;
                  }
                  if (role.runsAs.kind !== 'session' || role.engine?.agentTargetKey !== buildBackendTargetKeyV2(chosenLaunch.agentTarget)
                    || chosenLaunch.modelSelection !== undefined && role.engine.modelId !== chosenLaunch.modelSelection.ref.modelId
                    || chosenLaunch.profileId !== undefined && role.profileId !== chosenLaunch.profileId
                    || chosenLaunch.configuration?.model.value && role.engine.modelId !== chosenLaunch.configuration.model.value
                    || chosenLaunch.configuration?.options.reasoning_effort?.value
                      && role.engine.effort !== chosenLaunch.configuration.options.reasoning_effort.value) return unavailable(leaf.id);
                }
                let projected: unknown = role ? projectAgentStartSelectionV1(chosenLaunch,
                  { engine: role.engine!, ...(role.profileId ? { profileId: role.profileId } : {}) }, 'spawn_new',
                  { machineId: input.context.machineId, directory: input.context.workspaceTarget.project.directory },
                  chosenLaunch.modelSelection?.ref) : chosenLaunch;
                if (accepted) {
                  if (accepted.participant.kind !== 'model') return invalidInput(leaf.id);
                  // A replay selects the host-opened effective launch, never a changed Profile catalog.
                  projected = accepted.participant.launch;
                } else {
                  const roleLaunch = SessionSpawnNewSelectionV2Schema.safeParse(projected);
                  if (!roleLaunch.success) return invalidInput(leaf.id);
                  const current = roleLaunch.data;
                  if (current.profileId) {
                    if (!profiles.has(current.profileId)) profiles.set(current.profileId,
                      await input.effects.readLaunchProfile?.(current.profileId) ?? null);
                    const profile = profiles.get(current.profileId);
                    if (!profile) return unavailable(leaf.id);
                    const key = buildBackendTargetKeyV2(current.agentTarget);
                    if (isLaunchProfileV2(profile) && Object.keys(profile.compatibilityByTargetKey).length > 0
                      && profile.compatibilityByTargetKey[key] !== true) return unavailable(leaf.id);
                    const portable = profileSelection(profile, { agentTarget: current.agentTarget,
                      ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
                      ...(current.permissionMode ? { permissionMode: current.permissionMode } : {}),
                      ...(current.transcriptStorage ? { transcriptStorage: current.transcriptStorage } : {}) },
                    { kind: 'session' });
                    if (!portable) return unavailable(leaf.id);
                    const permission = current.permissionMode ?? current.configuration?.permissionIntent.value
                      ?? portable.permissionMode ?? 'default';
                    const permissionMode = parseAgentPermissionIntentV1Alias(permission);
                    if (!permissionMode) return unavailable(leaf.id);
                    projected = { ...current, permissionMode,
                      ...(current.modelSelection === undefined && !current.configuration?.model.value && portable.modelSelection
                        ? { modelSelection: portable.modelSelection } : {}),
                      ...(current.transcriptStorage === undefined && portable.transcriptStorage
                        ? { transcriptStorage: portable.transcriptStorage } : {}) };
                  }
                }
                const effectiveLaunch = SessionSpawnNewSelectionV2Schema.safeParse(projected);
                if (!effectiveLaunch.success) return invalidInput(leaf.id);
                const participant = { kind: 'model' as const, launch: effectiveLaunch.data };
                if (accepted && !sameStrictJsonValue(accepted.participant, participant)) return invalidInput(leaf.id);
                boundParticipants.selections.push({ value, participant,
                  selection: { agentTarget: effectiveLaunch.data.agentTarget,
                    ...(effectiveLaunch.data.modelSelection ? { modelSelection: effectiveLaunch.data.modelSelection } : {}),
                    ...(effectiveLaunch.data.permissionMode ? { permissionMode: effectiveLaunch.data.permissionMode } : {}),
                    ...(effectiveLaunch.data.connectedServices ? { connectedServices: effectiveLaunch.data.connectedServices } : {}),
                    ...(effectiveLaunch.data.capabilitySelection ? { capabilitySelection: effectiveLaunch.data.capabilitySelection } : {}),
                    conversation: { kind: 'fresh' } }, executionTarget: { kind: 'session' },
                  ...(role ? { role } : {}) });
              }
            }
          }
          if (leaf.execution?.permissionMode === 'read-only') {
            boundParticipants.selections = boundParticipants.selections.map(choice => ({ ...choice,
              selection: { ...choice.selection, permissionMode: 'read-only' } }));
          }
        }
        if (frozen?.sessionBindings) {
          boundSessions = structuredClone(frozen.sessionBindings);
          const acceptedSessions = boundSessions;
          if (frameInputs.some(inputs => !acceptedSessions.targets.some(target => sameStrictJsonValue(target.address, inputs[acceptedSessions.inputName])))) {
            throw workflowInputErrorV1(acceptedSessions.inputName, 'invalid_input');
          }
        }
        else if (purpose === 'run' && !participantBinding && conversation?.kind === 'input') {
          const declaration = authored.inputs.find(field => field.name === conversation.name);
          if (!declaration?.inputType || !('hostType' in declaration.inputType) || declaration.inputType.hostType !== 'session') {
            throw workflowInputErrorV1(conversation.name, 'invalid_input');
          }
          boundSessions = { inputName: conversation.name, targets: [],
            ...(declaration.defaultFrom ? { defaultFrom: declaration.defaultFrom } : {}) };
          const sessionTargets = boundSessions.targets;
          for (const inputs of frameInputs) {
            const value = inputs[conversation.name];
            const target = value === undefined ? null : await input.effects.resolveSessionTarget?.(value);
            if (!target || !sameStrictJsonValue(target.address, value) || !target.machineId.trim()) throw workflowInputErrorV1(conversation.name, 'invalid_input');
            if (!sessionTargets.some(candidate => sameStrictJsonValue(candidate.address, target.address))) sessionTargets.push(structuredClone(target));
          }
        }
        const sessionTargets = boundSessions;
        const resolveSelection = async (itemValue?: JsonValue, inputs = frameInputs[0] ?? {}) => {
          const selectionInput: ResolveWorkflowStepSelectionV1Input = {
            defaults: definition.defaults, step: sessionTargets ? { ...leaf.execution, conversation: (() => {
              const target = sessionTargets.targets.find(target => sameStrictJsonValue(target.address, inputs[sessionTargets.inputName]));
              if (!target) throw workflowInputErrorV1(sessionTargets.inputName, 'invalid_input');
              return { kind: 'existing_session' as const, sessionId: target.address.sessionId, machineId: target.machineId };
            })() } : leaf.execution,
            inputs,
            ...(itemValue === undefined ? {} : { itemValue }),
            runExecutionTarget: input.context.executionTarget,
            ...(conversation?.kind === 'from_step' ? { producerExecutionTarget: producer
              ? resolveWorkflowAcceptedStepSelectionV1(producer, itemValue, inputs).executionTarget
              : targetById.get(conversation.producer.blockId) } : {}),
            roleSelection: { ...input.roleSelection, workflowRoles: definition.roles, runOverrides: overrides.data },
          };
          const engine = resolveWorkflowEngineSelectionV1(selectionInput);
          return resolveWorkflowStepSelectionV1({ ...selectionInput,
            ...(engine && 'role' in engine ? { roleSelection: { ...await readRoleSelection(engine.role),
              workflowRoles: definition.roles, runOverrides: overrides.data } } : {}),
          });
        };
        if (frozen?.engineBindings && !agentOverride) boundEngines = structuredClone(frozen.engineBindings);
        else if (!frozen && binding && (binding.kind === 'item' || sourceKey !== '$root')) {
          boundEngines = { reference: binding, selections: [] };
          for (const inputs of frameInputs) {
            const items = binding.kind === 'item' ? actionItemContexts(authored, leaf.id, { inputs, origin: input.context.origin }) : [undefined];
            if (items === null || binding.kind === 'item' && items.some(item => item === undefined)) return invalidInput(leaf.id);
            for (const item of items) {
              const raw = binding.kind === 'item' ? item!.value : inputs[binding.name];
              const value = parseWorkflowLiteralEngineSelectionV1(raw === undefined ? undefined : readWorkflowValuePathV1(raw, binding.path ?? []));
              if (!value.success) return invalidInput(leaf.id);
              const selected = await resolveSelection(item?.value, inputs);
              boundEngines.selections.push({ value: value.data, selection: selected.selection,
                executionTarget: selected.executionTarget ?? input.context.executionTarget,
                ...(selected.role ? { role: selected.role } : {}) });
            }
          }
        }
        resolved = boundParticipants ? { selection: boundParticipants.selections[0]?.selection ?? {},
          executionTarget: { kind: 'session' }, role: boundParticipants.selections[0]?.role } : frozen ? { selection: agentOverride
          ? resolveWorkflowStepSelectionV1({ defaults: frozen.selection, step: { engine: agentOverride.engine },
            roleSelection: 'role' in agentOverride.engine ? await readRoleSelection(agentOverride.engine.role) : input.roleSelection,
            ...(frozen.selection.conversation?.kind === 'from_step'
              ? { producerExecutionTarget: frozen.executionTarget } : {}) }).selection
          : structuredClone(frozen.selection), executionTarget: frozen.executionTarget, role: frozen.role }
          : boundEngines ? boundEngines.selections[0] ?? resolveWorkflowStepSelectionV1({ defaults: definition.defaults,
            step: leaf.execution, purpose: 'authoring' }) : await resolveSelection();
      } catch (error) {
        if (error instanceof WorkflowInputErrorV1) return invalidInput(leaf.id, error.issues);
        if (error instanceof WorkflowStepSelectionErrorV1) {
          const engine = leaf.execution?.engine ?? definition.defaults.engine;
          return error.code === 'invalid_input' && engine && 'kind' in engine
            ? invalidInput(leaf.id, [{ code: 'invalid_input', blockId: leaf.id, path: `/blocks/${leaf.id}/execution/engine`,
              severity: 'error', message: 'The selection binding must resolve to a declared engine choice.' }])
            : { ok: false, error: { ...error.refusal, blockId: leaf.id } };
        }
        throw error;
      }
      const executionTarget = resolved.executionTarget ?? input.context.executionTarget;
      let selection = resolved.selection;
      if (leaf.kind !== 'step') {
        const { launchEnvironment: _launchEnvironment, providerSessionResume: _providerSessionResume, ...nonAgentSelection } = selection;
        selection = nonAgentSelection;
      }
      if (leaf.kind === 'step' && executionTarget.kind === 'detached_run'
        && (selection.launchEnvironment !== undefined || selection.providerSessionResume !== undefined)) return unavailable(leaf.id);
      // Choosing a role's engine does not also choose that role's profile.
      if (frozen && agentOverride && frozen.selection.profileId === undefined) delete selection.profileId;
      if (purpose === 'run' && selection.conversation?.kind === 'origin_session' && !input.context.origin?.originSessionId) return invalidInput(leaf.id);
      if (!boundParticipants && !frozen && selection.profileId) {
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
        ...(boundParticipants?.selections[0] ? { participant: boundParticipants.selections[0].participant } : frozen?.participant
          ? { participant: frozen.participant } : {}),
        authoredWorkspace: frozen?.authoredWorkspace ?? leaf.execution?.workspace ?? { kind: 'inherit' },
        ...(resolved.role === undefined ? {} : { role: { ...structuredClone(resolved.role),
          ...(selection.profileId === null ? { profileUnavailable: false } : {}) } }),
        ...(leaf.kind === 'workflow' ? { childRef: frozen?.childRef ?? leaf.workflowRef } : {}),
      };
      if (authorityBindings.length > 0) {
        for (const binding of authorityBindings) {
          const previous = frozen?.sessionAuthorityBindings?.find(accepted => accepted.inputName === binding.inputName);
          if (replay && binding.targets.some(target => !previous?.targets.some(accepted => sameStrictJsonValue(accepted, target)))) {
            return invalidInput(leaf.id, workflowInputErrorV1(binding.inputName, 'invalid_input').issues);
          }
        }
        sidecar.sessionAuthorityBindings = structuredClone(authorityBindings);
      }
      if (boundSessions) sidecar.sessionBindings = boundSessions;
      if (boundParticipants) sidecar.participantBindings = boundParticipants;
      if (boundEngines) {
        // Profiles are resolved for every admitted choice, before deriving the ceiling or checking availability.
        for (const bound of boundEngines.selections) {
          if (bound.selection.profileId && !frozen) {
            if (!profiles.has(bound.selection.profileId)) profiles.set(bound.selection.profileId,
              await input.effects.readLaunchProfile?.(bound.selection.profileId) ?? null);
            const profile = profiles.get(bound.selection.profileId);
            if (!profile) return unavailable(leaf.id);
            const portable = profileSelection(profile, bound.selection, bound.executionTarget);
            if (!portable) return unavailable(leaf.id);
            bound.selection = portable;
          }
          const parsed = WorkflowStepExecutionSelectionSchema.safeParse(bound.selection);
          if (!parsed.success) return invalidInput(leaf.id);
          bound.selection = parsed.data;
          if (bound.executionTarget.kind === 'detached_run'
            && (bound.selection.launchEnvironment !== undefined || bound.selection.providerSessionResume !== undefined)) return unavailable(leaf.id);
        }
        sidecar.engineBindings = boundEngines;
      }
      if (leaf.kind === 'action') {
        const contract = frozen ? frozen.actionContract : await input.effects.readActionContract?.(leaf.actionId);
        if (!contract) return unavailable(leaf.id);
        sidecar.actionId = leaf.actionId;
        sidecar.actionContract = structuredClone(contract);
        const bindingContext = sourceKey === '$root' ? input.context : { ...input.context, inputs: {} };
        const hasDeferredBinding = Object.values(leaf.input).some((binding) =>
          (binding.kind === 'list' ? binding.items : [binding]).some((reference) =>
            reference.kind === 'origin_session_id'
              ? purpose === 'definition' && !bindingContext.origin?.originSessionId
              : reference.kind !== 'literal'
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
    const { engine: _engine, participant: _participant, executionTarget: _target, ...defaults } = definition.defaults;
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
    const admitted = await input.admission.admitRun?.({ permissionCeiling });
    if (!admitted) return { ok: false, error: { code: 'target_unavailable', reason: 'run_admission_unavailable' } };
    if (!admitted.ok) return { ok: false, error: admitted.refusal };
    workDepth = admitted.stamped.workDepth;
  }
  if (input.admission.kind !== 'user') {
    for (const leaf of agentStartLeaves) {
      const owner = materializedLeaves.find(sidecar => sidecar.sourceKey === leaf.sourceKey && sidecar.blockId === leaf.blockId);
      const role = (owner ? listWorkflowAcceptedLeafSelectionsV1(owner) : []).find(selected => selected.role?.roleId === leaf.roleId)?.role;
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
    for (const selected of listWorkflowAcceptedLeafSelectionsV1(leaf)) {
      const sessionIds = readWorkflowLeafTargetSessionIdsV1(selected.selection, requiredOriginSessionId);
      if (leaf.kind === 'step' || leaf.kind === 'action' || sessionIds.length > 0) {
        const availability = await input.effects.resolveTargetAvailability(selected, { sessionIds });
        if (availability !== true) return unavailable(leaf.blockId, availability === false ? undefined : availability);
      }
    }
  }
  for (const leaf of agentStartLeaves) {
    if (leaf.kind !== 'action' || !leaf.facts.agentTarget || leaf.facts.agentTarget.kind === 'unresolved') continue;
    if (leaf.facts.agentTarget.kind !== 'agent') return unavailable(leaf.blockId);
    const selected = materializedLeaves.find((sidecar) => sidecar.sourceKey === leaf.sourceKey && sidecar.blockId === leaf.blockId && sidecar.kind === 'action');
    if (!selected) return unavailable(leaf.blockId);
    const availability = await input.effects.resolveTargetAvailability({ blockId: leaf.blockId,
      selection: { ...selected.selection, agentTarget: leaf.facts.agentTarget },
      executionTarget: leaf.runsAs.kind === 'session' ? { kind: 'session' } : { kind: 'detached_run' },
    }, { sessionIds: [] });
    if (availability !== true) return unavailable(leaf.blockId, availability === false ? undefined : availability);
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
