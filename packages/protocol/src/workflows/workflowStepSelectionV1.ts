import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { resolveRoleSelectionV1, type ResolveRoleSelectionV1Input, type RoleSelectionRefusalV1 } from '../prompts/roles/resolveRoleSelectionV1.js';
import type { ResolvedRoleV1 } from '../prompts/roles/rolesV1.js';
import type { WorkflowStepExecutionSelection, WorkflowStepSelectionV1, WorkflowLeafExecutionTargetV1 } from './workflowV1.js';
export { WorkflowLeafExecutionTargetV1Schema, WorkflowEngineSelectionV1Schema, WorkflowStepSelectionV1Schema,
  type WorkflowLeafExecutionTargetV1, type WorkflowEngineSelectionV1, type WorkflowStepSelectionV1 } from './workflowV1.js';

export type WorkflowResolvedStepSelectionV1 = Omit<WorkflowStepSelectionV1, 'engine' | 'executionTarget'>;

export type ResolveWorkflowStepSelectionV1Input = Readonly<{
  defaults: WorkflowStepSelectionV1;
  step?: WorkflowStepSelectionV1;
  roleSelection?: Omit<ResolveRoleSelectionV1Input, 'roleId'>;
  runExecutionTarget?: WorkflowLeafExecutionTargetV1;
  producerExecutionTarget?: WorkflowLeafExecutionTargetV1;
  /** Value-only editor projection: roles and from-step targets stay unresolved until admission. */
  purpose?: 'authoring';
}>;
export type ResolveWorkflowStepSelectionV1Result = Readonly<{
  selection: WorkflowResolvedStepSelectionV1;
  executionTarget?: WorkflowLeafExecutionTargetV1;
  role?: ResolvedRoleV1;
}>;
export type WorkflowStepSelectionRefusalV1 = RoleSelectionRefusalV1 | Readonly<{ code: 'invalid_input' }>;

export class WorkflowStepSelectionErrorV1 extends Error {
  readonly code: WorkflowStepSelectionRefusalV1['code'];

  constructor(readonly refusal: WorkflowStepSelectionRefusalV1) {
    super(refusal.code);
    this.name = 'WorkflowStepSelectionErrorV1';
    this.code = refusal.code;
  }
}

// Value-only authoring consumers preserve the flat Session selection type.
export function resolveWorkflowStepSelectionV1(input: Readonly<{
  defaults: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
  step?: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
}>): Omit<ResolveWorkflowStepSelectionV1Result, 'selection'> & Readonly<{ selection: WorkflowStepExecutionSelection }>;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result {
  const engine = input.step?.engine ?? input.defaults.engine;
  const { engine: defaultEngine, executionTarget: defaultTarget, ...defaults } = input.defaults;
  const { engine: stepEngine, executionTarget: stepTarget, ...step } = input.step ?? {};
  // Optional fields are unset when undefined; explicit null remains an override.
  for (const key of Object.keys(step) as (keyof typeof step)[]) {
    if (step[key] === undefined) delete step[key];
  }
  let selection: WorkflowResolvedStepSelectionV1 = input.step === undefined && engine === undefined && defaultTarget === undefined
    ? input.defaults
    : { ...defaults, ...step };
  let role: ResolvedRoleV1 | undefined;

  if (engine !== undefined) {
    // Work on our own object: authoring readers can retain defaults by identity.
    selection = { ...selection };
    delete selection.agentTarget;
    delete selection.modelSelection;
    const config = selection.sessionConfigOptionOverrides;
    if (config?.overrides.reasoning_effort !== undefined) {
      const { reasoning_effort, ...overrides } = config.overrides;
      selection.sessionConfigOptionOverrides = { ...config, overrides };
    }

    let effort: string | undefined;
    if ('role' in engine && input.purpose !== 'authoring') {
      const resolved = resolveRoleSelectionV1({ ...input.roleSelection, roleId: engine.role });
      if (!resolved.ok) throw new WorkflowStepSelectionErrorV1(resolved.refusal);
      role = resolved.selection;
      const targetKey = BackendTargetKeyV2Schema.safeParse(role.engine?.agentTargetKey);
      const target = targetKey.success ? parseBackendTargetKeyV2(targetKey.data) : null;
      const identity = target?.kind === 'agent' ? target.identity : parseQualifiedPluginContributionKey(role.engine?.agentTargetKey);
      if (identity === null || role.engine === undefined) {
        throw new WorkflowStepSelectionErrorV1({ code: 'target_unavailable', roleId: role.roleId });
      }
      selection.agentTarget = { kind: 'agent', identity };
      if (role.engine.modelId !== undefined) {
        selection.modelSelection = {
          v: 1, updatedAt: 0,
          ref: { agentTargetKey: role.engine.agentTargetKey, providerConnectionId: null, modelId: role.engine.modelId },
        };
      }
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

  const runTarget = input.runExecutionTarget ?? defaultTarget;
  let executionTarget: WorkflowLeafExecutionTargetV1 | undefined;
  // Value displays have no admission context. Admission supplies the target to
  // resolve from-step classes; the value-only call never guesses a producer's class.
  if (input.purpose !== 'authoring' && (runTarget !== undefined || stepTarget !== undefined || role !== undefined
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
    executionTarget = stepTarget ?? boundTarget
      ?? (role === undefined ? undefined : { kind: role.runsAs.kind === 'session' ? 'session' : 'detached_run' })
      ?? runTarget;
    if (input.step?.conversation?.kind === 'shared_run' && runTarget !== undefined && executionTarget?.kind !== runTarget.kind) {
      throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
  }
  return { selection, ...(role === undefined ? {} : { role }), ...(executionTarget === undefined ? {} : { executionTarget }) };
}
