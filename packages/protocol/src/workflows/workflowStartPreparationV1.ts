import type { JsonValue } from '../json/strictJsonValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { WorkflowRunAcceptedContextV1, WorkflowRunStartRequestV1 } from './actionsV1.js';
import type { WorkflowDefinitionV1 } from './workflowV1.js';
import type { WorkflowAcceptedSnapshotV1 } from './workflowDefinitionV1.js';
import { setWorkflowStepExecutionTarget } from './workflowDefinitionEditV1.js';
import type { ActionSessionAddressV1 } from '../actions/sessionTargetV1.js';
import { validateInputFieldSchema } from '../inputs/inputTypeRuntime.js';
import { workflowInputToFieldHint, type WorkflowValidationIssue } from './workflowV1.js';

export type WorkflowResolvedSessionTargetV1 = Readonly<{ address: ActionSessionAddressV1; machineId: string }>;
export type ResolveWorkflowSessionTargetV1 = (value: JsonValue) => Promise<WorkflowResolvedSessionTargetV1 | null>;

export const WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1 = 'previousRoundContext';

/** Authored support only; access, terminal state and control eligibility remain caller facts. */
export function supportsWorkflowAnotherRoundV1(definition: Pick<WorkflowDefinitionV1, 'inputs'>): boolean {
  return definition.inputs.some(input => input.name === WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1 && input.valueType === 'json');
}

/** Shared preview/default projection; missing required values stay editable in forms. */
export function resolveWorkflowContextInputDefaultsV1(definition: Pick<WorkflowDefinitionV1, 'inputs'>,
  supplied: Readonly<Record<string, JsonValue>> | undefined, originSession?: ActionSessionAddressV1): Record<string, JsonValue> {
  const inputs = { ...supplied };
  for (const field of definition.inputs) {
    if (!Object.hasOwn(inputs, field.name) && field.defaultFrom === 'origin_session' && originSession) {
      inputs[field.name] = { ...originSession };
    }
  }
  return inputs;
}

/** Exact source binding shared by direct, trigger and nested-frame admission. */
export async function resolveWorkflowContextInputsV1(params: Readonly<{
  definition: Pick<WorkflowDefinitionV1, 'inputs'>; inputs: Readonly<Record<string, JsonValue>> | undefined;
  originSessionId?: string; resolveSessionTarget?: ResolveWorkflowSessionTargetV1;
}>): Promise<Record<string, JsonValue>> {
  let origin: WorkflowResolvedSessionTargetV1 | null | undefined;
  const supplied = { ...params.inputs };
  for (const field of params.definition.inputs) {
    if (!Object.hasOwn(supplied, field.name) && field.defaultFrom === 'origin_session' && params.originSessionId) {
      origin ??= await params.resolveSessionTarget?.(params.originSessionId) ?? null;
      if (!origin || origin.address.sessionId !== params.originSessionId) throw workflowInputErrorV1(field.name, 'invalid_input');
      supplied[field.name] = { ...origin.address };
    }
  }
  const inputs = resolveWorkflowRunStartInputsV1(params.definition, supplied);
  for (const field of params.definition.inputs) {
    if (inputs[field.name] !== undefined && field.conflictsWith?.some(name => inputs[name] !== undefined)) {
      throw workflowInputErrorV1(field.name, 'invalid_input');
    }
  }
  for (const field of params.definition.inputs) {
    const value = inputs[field.name];
    if (value === undefined || !field.inputType || !('hostType' in field.inputType)
      || !field.defaultFrom && field.inputType.hostType !== 'agentParticipant') continue;
    if (field.inputType.hostType === 'agentParticipant' && field.multiple && !Array.isArray(value)) {
      throw workflowInputErrorV1(field.name, 'invalid_input');
    }
    const validation = validateInputFieldSchema({ field: workflowInputToFieldHint(field), value });
    if (validation.status !== 'valid') throw workflowInputErrorV1(field.name, 'invalid_input');
    inputs[field.name] = validation.value;
    if (field.multiple && Array.isArray(validation.value)) {
      if (field.minItems !== undefined && validation.value.length < field.minItems
        || field.uniqueItems && validation.value.some((value, index, values) => values.slice(0, index).some(other => sameStrictJsonValue(value, other)))) {
        throw workflowInputErrorV1(field.name, 'invalid_input');
      }
    }
  }
  return inputs;
}

export class WorkflowInputErrorV1 extends Error {
  readonly code = 'invalid_input';
  readonly issues: readonly WorkflowValidationIssue[];
  readonly details: Readonly<{ issues: readonly WorkflowValidationIssue[] }>;
  constructor(name: string, issueCode: 'invalid_input' | 'missing_reference') {
    super('invalid_input');
    this.issues = [{ code: issueCode,
      path: `/inputs/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, severity: 'error',
      message: issueCode === 'missing_reference' ? 'Choose a value for this required input.' : 'The selected input is unavailable or invalid.' }];
    this.details = { issues: this.issues };
  }
}

export function workflowInputErrorV1(name: string, issueCode: 'invalid_input' | 'missing_reference'): WorkflowInputErrorV1 {
  return new WorkflowInputErrorV1(name, issueCode);
}

export type WorkflowRunStartPreparationV1 = Readonly<{
  definition: WorkflowDefinitionV1;
  inputs?: Readonly<Record<string, JsonValue>>;
  source: Extract<WorkflowRunStartRequestV1['source'], { kind: 'inline' }>;
  project?: WorkflowRunAcceptedContextV1['workspaceTarget']['project'];
  executionTarget?: WorkflowRunAcceptedContextV1['executionTarget'];
  roleOverrides?: WorkflowRunAcceptedContextV1['roleOverrides'];
  metadata?: WorkflowRunStartRequestV1['metadata'];
  originSessionId?: string;
  origin?: WorkflowRunStartRequestV1['origin'];
  onComplete?: WorkflowRunStartRequestV1['onComplete'];
}>;

/** Existing, accessible Machines in the invocation's Home; callers own fresh access/reachability reads. */
export type WorkflowCombinedActionHostMachineV1 = Readonly<{ machineId: string; online: boolean }>;
export type WorkflowCombinedActionHostReviewV1 = Readonly<{
  machineId: string | null;
  machines: readonly WorkflowCombinedActionHostMachineV1[];
}>;
export const WorkflowCombinedActionHostReviewV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  machines: z.array(z.strictObject({ machineId: z.string().check(z.trim(), z.minLength(1)), online: z.boolean() })),
}));
export type WorkflowCombinedActionHostAdmissionV1 =
  | Readonly<{ kind: 'ready'; machineId: string }>
  | Readonly<{ kind: 'unavailable'; code: 'machine_unavailable'; machineId: string; role: 'controller' }>;
export type WorkflowCombinedActionHostResolutionV1 =
  | (WorkflowCombinedActionHostAdmissionV1 & Readonly<{ review: WorkflowCombinedActionHostReviewV1 }>)
  | Readonly<{ kind: 'selection_required' | 'platform_only'; review: WorkflowCombinedActionHostReviewV1 }>;

/** Re-admit the reviewed/accepted host at dispatch; never resolve defaults again after review. */
export function admitCombinedActionWorkflowHostV1(params: Readonly<{
  machineId: string;
  machines: readonly WorkflowCombinedActionHostMachineV1[];
  createdMachineIds?: readonly string[];
}>): WorkflowCombinedActionHostAdmissionV1 {
  if (params.createdMachineIds?.includes(params.machineId)
    || !params.machines.some(machine => machine.machineId === params.machineId && machine.online)) {
    return { kind: 'unavailable', code: 'machine_unavailable', machineId: params.machineId, role: 'controller' };
  }
  return { kind: 'ready', machineId: params.machineId };
}

/**
 * Combined Action preparation shared by setup and Publish. Feed ready.machineId
 * into the existing Workflow materializer's context and host-resolved project;
 * review is display data only, never authority or an Account preference.
 */
export function resolveCombinedActionWorkflowHostV1(params: Readonly<{
  machines: readonly WorkflowCombinedActionHostMachineV1[];
  createdMachineIds?: readonly string[];
  agentMachineId?: string;
  selectedMachineId?: string;
}> & (
  | Readonly<{ actionId: 'machines.setup.apply'; targetMachineIds: readonly string[] }>
  | Readonly<{ actionId: 'deployments.publish'; projectEnvironmentControllerMachineIds?: readonly string[] }>
)): WorkflowCombinedActionHostResolutionV1 {
  const created = new Set(params.createdMachineIds ?? []);
  const machines = params.machines.filter(machine => !created.has(machine.machineId));
  let machineId = params.selectedMachineId ?? params.agentMachineId;
  if (machineId === undefined) {
    const byId = new Map(machines.map(machine => [machine.machineId, machine]));
    machineId = params.actionId === 'machines.setup.apply'
      ? params.targetMachineIds.find(id => byId.get(id)?.online)
      : params.projectEnvironmentControllerMachineIds?.find(id => byId.has(id));
  }
  if (machineId === undefined) {
    return { kind: params.actionId === 'deployments.publish' && machines.length === 0 ? 'platform_only' : 'selection_required',
      review: { machineId: null, machines } };
  }
  return { ...admitCombinedActionWorkflowHostV1({ machineId, machines }), review: { machineId, machines } };
}

/** One preparation owner for new starts and reviewed accepted-run repeats. Admission reopens replay authority. */
export function prepareWorkflowRunStartV1(params: Readonly<{
  definition: WorkflowDefinitionV1;
  acceptedContext?: WorkflowRunAcceptedContextV1 | WorkflowAcceptedSnapshotV1;
  inputs?: Readonly<Record<string, JsonValue>>;
  replay?: NonNullable<Extract<WorkflowRunStartRequestV1['source'], { kind: 'inline' }>['replay']>;
}>): WorkflowRunStartPreparationV1 {
  const accepted = params.acceptedContext;
  let draft = { ...params.definition, name: '' };
  for (const leaf of accepted?.materializedLeaves ?? []) {
    if (leaf.sourceKey === '$root' && leaf.kind === 'step') {
      draft = setWorkflowStepExecutionTarget(draft, leaf.blockId, leaf.executionTarget.kind);
    }
  }
  const definition = { ...params.definition, blocks: draft.blocks };
  const originSessionId = accepted && 'origin' in accepted && accepted.origin && 'originSessionId' in accepted.origin
    ? accepted.origin.originSessionId : undefined;
  const discussion = accepted && 'origin' in accepted ? accepted.origin?.discussion : undefined;
  return {
    definition,
    inputs: params.inputs ?? accepted?.inputs,
    source: { kind: 'inline', definition: { ...definition, inputs: [...definition.inputs], blocks: [...definition.blocks] },
      ...(params.replay === undefined ? {} : { replay: params.replay }) },
    ...(accepted === undefined ? {} : {
      project: accepted.workspaceTarget.project,
      executionTarget: accepted.executionTarget,
      ...(accepted.roleOverrides === undefined ? {} : { roleOverrides: accepted.roleOverrides }),
      ...(accepted.metadata == null ? {} : { metadata: accepted.metadata }),
      ...(originSessionId ? { originSessionId } : {}),
      ...(discussion ? { origin: { kind: 'discussion' as const, discussion: discussion.discussion,
        addressingMessageId: discussion.messageId } } : {}),
    }),
  };
}

/** Declared input/default admission shared by every start surface. */
export function resolveWorkflowRunStartInputsV1(definition: Pick<WorkflowDefinitionV1, 'inputs'>, supplied: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> {
  const inputs: Record<string, JsonValue> = {};
  const known = new Set(definition.inputs.map(input => input.name));
  for (const key of Object.keys(supplied ?? {})) if (!known.has(key)) throw workflowInputErrorV1(key, 'invalid_input');
  for (const input of definition.inputs) {
    const value = supplied && Object.prototype.hasOwnProperty.call(supplied, input.name) ? supplied[input.name] : input.default;
    if (value === undefined) {
      if (input.required) throw workflowInputErrorV1(input.name, 'missing_reference');
      continue;
    }
    if ((input.valueType === 'string' && typeof value !== 'string')
      || (input.valueType === 'number' && typeof value !== 'number')
      || (input.valueType === 'boolean' && typeof value !== 'boolean')
      || (input.enum !== undefined && (typeof value !== 'string' || !input.enum.includes(value)))) throw workflowInputErrorV1(input.name, 'invalid_input');
    inputs[input.name] = value;
  }
  return inputs;
}
