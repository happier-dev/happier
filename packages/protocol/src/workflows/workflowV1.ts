import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ConnectedServiceBindingsV2IngressSchema } from '../connect/connectedServiceBindings.js';
import { ExecutionRunResultContractV1Schema } from '../execution/runs/resultContractV1.js';
import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import {
  SessionAuthoringSelectionFieldsV1,
} from '../sessions/authoring/selectionFieldsV1.js';
import { PortableRuntimeDescriptorV1Schema } from '../sessions/metadata/runtimeDescriptorV1.js';
import { WorkflowStepComposerDocumentSchema } from './workflowComposerDocumentV1.js';
import {
  WorkflowAuthoredProducerRefSchema,
  WorkflowAuthoredResultReferenceSchema,
  WorkflowBlockIdSchema,
  WorkflowConditionSchema,
  WorkflowConversationSelectionSchema,
  WorkflowInputNameSchema,
  WorkflowResultPathSchema,
  WorkflowValueReferenceSchema,
  type WorkflowCondition,
  type WorkflowValueReference,
} from './workflowReferenceV1.js';
import { WorkflowWorkspaceSelectionSchema } from './workflowWorkspaceV1.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { WorkflowRoleV1Schema, type WorkflowRoleV1 } from '../prompts/roles/rolesV1.js';
import { WorkflowDefinitionRefV1StringSchema } from './workflowDefinitionRefV1.js';
import type { InputFieldHint } from '../inputs/inputFields.js';
import { InputTypeReferenceV1Schema } from '../inputs/inputTypes.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { isWorkflowActionLiteralFieldV1 } from './stepActionsV1.js';
import { AgentLaunchEnvironmentV1Schema, AgentSessionProviderResumeV1Schema } from '../runtime/agentSessionV1.js';
import { readCapabilitySelectionCarrierV1 } from '../reach/sessionCapabilitySelectionV1.js';
import { findInvalidWorkflowResultFieldName } from './workflowResultFieldsV1.js';
import { isWorkflowRunSummaryActionIdV1 } from '../actions/actionIds.js';

export {
  WorkflowStepComposerDocumentSchema,
  type WorkflowStepComposerDocument,
} from './workflowComposerDocumentV1.js';

/**
 * The one canonical, origin-neutral executable workflow definition (FLOW §3.1).
 *
 * UI, CLI, both SDKs, agent Actions and Automation admission all parse through
 * these exports. There is deliberately no second workflow dialect: the editor
 * imports this validator for instant local feedback and the Action host reruns
 * the same parser before any save or start effect.
 */

export const WorkflowInputDefinitionSchema = lazyZodSchema(() => z.strictObject({
  name: WorkflowInputNameSchema,
  valueType: z.enum(['string', 'number', 'boolean', 'json']),
  multiple: z.optional(z.boolean()),
  minItems: z.optional(z.number().check(z.int(), z.positive())),
  uniqueItems: z.optional(z.boolean()),
  conflictsWith: z.optional(z.array(WorkflowInputNameSchema)),
  enum: z.optional(z.array(z.string()).check(z.minLength(1))),
  required: z.boolean(),
  default: zMini.optional(StrictJsonValueSchema),
  /** Bind the real source Session at admission; never a fabricated origin. */
  defaultFrom: z.optional(z.literal('origin_session')),
  description: z.optional(z.string()),
  optionsSourceId: z.optional(z.string().check(z.minLength(1))),
  inputType: zMini.optional(InputTypeReferenceV1Schema),
}).check(z.superRefine((value, ctx) => {
  if ((value.minItems !== undefined || value.uniqueItems !== undefined) && !value.multiple) {
    ctx.addIssue({ code: 'custom', path: ['multiple'], message: 'List constraints require a participant list' });
  }
  if (value.multiple && (value.valueType !== 'json' || !value.inputType || !('hostType' in value.inputType)
    || value.inputType.hostType !== 'agentParticipant')) {
    ctx.addIssue({ code: 'custom', path: ['multiple'], message: 'Participant lists require the executable participant input type' });
  }
  if (value.defaultFrom && (value.default !== undefined || value.valueType !== 'json'
    || !value.inputType || !('hostType' in value.inputType) || value.inputType.hostType !== 'session')) {
    ctx.addIssue({ code: 'custom', path: ['defaultFrom'], message: 'A Session context default requires a typed Session input without a literal default' });
  }
  if (value.inputType && (value.optionsSourceId || value.enum)) {
    ctx.addIssue({ code: 'custom', path: ['inputType'], message: 'A typed input uses its declared options owner' });
  }
  if (value.enum !== undefined && (value.valueType !== 'string'
    || (value.default !== undefined && (typeof value.default !== 'string' || !value.enum.includes(value.default))))) {
    ctx.addIssue({ code: 'custom', path: ['enum'], message: 'String choices require a string input and a matching default' });
  }
  if (value.required && value.default !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['default'],
      message: 'required inputs cannot have defaults',
    });
  }
})));
export type WorkflowInputDefinition = z.infer<typeof WorkflowInputDefinitionSchema>;

/**
 * What a Workflow input is called to a person: its declared presentation title, else its key read as
 * words ("qa_note" → "Qa note"). Every field, chip and review row names an input through this one rule.
 */
export function workflowInputTitle(
  definition: Pick<WorkflowInputDefinition, 'name'>,
  presentation?: Readonly<{ title?: string }>,
): string {
  if (presentation?.title) return presentation.title;
  const words = definition.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : definition.name;
}

/** Presentation adapter only: Workflow admission, defaults and references stay Workflow-owned. */
export function workflowInputToFieldHint(
  definition: WorkflowInputDefinition,
  presentation?: Readonly<{ title?: string; optionLabels?: Readonly<Record<string, string>> }>,
): InputFieldHint {
  const hasChoices = definition.enum !== undefined || definition.optionsSourceId !== undefined || definition.inputType !== undefined;
  return {
    path: definition.name,
    title: workflowInputTitle(definition, presentation),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    widget: hasChoices ? definition.multiple || definition.valueType === 'json' && !definition.inputType ? 'multiselect' : 'select'
      : definition.valueType === 'string' ? 'text' : definition.valueType,
    required: definition.required,
    ...(definition.inputType ? { inputType: definition.inputType } : {}),
    ...(hasChoices ? { requireExplicitSelection: true } : {}),
    ...(definition.enum === undefined ? {} : {
      options: definition.enum.map((value) => ({ value, label: presentation?.optionLabels?.[value] ?? value })),
    }),
    ...(definition.optionsSourceId === undefined ? {} : { optionsSourceId: definition.optionsSourceId }),
  };
}

export const WorkflowResultContractSchema = ExecutionRunResultContractV1Schema;
export type WorkflowResultContract = z.infer<typeof WorkflowResultContractSchema>;

/**
 * The audited serializable subset of the incumbent Session authoring contract.
 *
 * Each member keeps its canonical nested schema rather than collapsing to a
 * string id, so a saved definition reproduces the exact Agent target, model
 * connection, permission intent, MCP selection and Connected Service bindings
 * the author chose. Omission inherits; a present value — including an explicit
 * `null` or a value equal to the current default — is a preserved override.
 *
 * Machine placement, directory/checkout, existing-Session identity and prompt
 * content are deliberately absent: those are owned by Run target selection,
 * `workspace`, `conversation` and the Composer document respectively. Raw
 * environment variables and Account/team placement are excluded from this
 * Session-authoring field registry. Execution-only launch values below reuse
 * the Agent launch contract and are not synced Session draft fields.
 */
const WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE = {
  allowedTools: SessionAuthoringSelectionFieldsV1.allowedTools,
  unlistedTools: SessionAuthoringSelectionFieldsV1.unlistedTools,
  agentTarget: zMini.optional(SessionAuthoringSelectionFieldsV1.agentTarget),
  // The catalog entry carries a `.default(null)` for draft hydration. A workflow
  // definition must distinguish omission from an explicit null, so this consumes
  // the underlying selection schema without that default.
  modelSelection: zMini.optional(zMini.nullable(SessionModelSelectionV1Schema)),
  profileId: zMini.optional(SessionAuthoringSelectionFieldsV1.profileId),
  approvalProfileId: zMini.optional(SessionAuthoringSelectionFieldsV1.approvalProfileId),
  permissionMode: zMini.optional(SessionAuthoringSelectionFieldsV1.permissionMode),
  acpSessionModeId: zMini.optional(SessionAuthoringSelectionFieldsV1.acpSessionModeId),
  sessionConfigOptionOverrides: zMini.optional(SessionAuthoringSelectionFieldsV1.sessionConfigOptionOverrides),
  capabilitySelection: zMini.optional(SessionAuthoringSelectionFieldsV1.capabilitySelection),
  // Portable definitions normalize supported V1 persistence into the strict
  // current selection so native/profile/group/team-resource intent survives
  // without carrying unknown fields into exported JSON.
  connectedServices: zMini.optional(zMini.nullable(ConnectedServiceBindingsV2IngressSchema)),
  transcriptStorage: zMini.optional(SessionAuthoringSelectionFieldsV1.transcriptStorage),
  terminal: zMini.optional(SessionAuthoringSelectionFieldsV1.terminal),
  windowsRemoteSessionLaunchMode: zMini.optional(SessionAuthoringSelectionFieldsV1.windowsRemoteSessionLaunchMode),
  windowsRemoteSessionConsole: zMini.optional(SessionAuthoringSelectionFieldsV1.windowsRemoteSessionConsole),
  windowsTerminalWindowName: zMini.optional(SessionAuthoringSelectionFieldsV1.windowsTerminalWindowName),
  runtimeDescriptorV1: zMini.optional(zMini.nullable(PortableRuntimeDescriptorV1Schema)),
} as const;

export const WorkflowSessionAuthoringSelectionSchema = lazyZodSchema(() => z.strictObject(WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE));
export type WorkflowSessionAuthoringSelection = z.infer<typeof WorkflowSessionAuthoringSelectionSchema>;

/** The Session-authoring field ids a workflow definition round-trips, in editor order. */
export type WorkflowSessionAuthoringSelectionFieldId = keyof typeof WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE;
export const WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS = Object.freeze(
  Object.keys(WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE) as WorkflowSessionAuthoringSelectionFieldId[],
);

export const WorkflowStepExecutionSelectionSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowSessionAuthoringSelectionSchema, {
  /** Incoming runtime intent; arbitration remains at the Session runtime snapshot owner. */
  permissionModeUpdatedAt: z.optional(z.number().check(z.int())),
  /** Execution-only launch values, composed by the incumbent Session spawn owner. */
  launchEnvironment: zMini.optional(AgentLaunchEnvironmentV1Schema.check(zMini.refine((environment) => environment.unset.length === 0, {
    message: 'Workflow Session launches cannot unset inherited environment values',
  }))),
  /** Native Agent continuation; the Happier conversation may still be fresh. */
  providerSessionResume: zMini.optional(AgentSessionProviderResumeV1Schema),
  conversation: zMini.optional(WorkflowConversationSelectionSchema),
  workspace: zMini.optional(WorkflowWorkspaceSelectionSchema),
})));
export type WorkflowStepExecutionSelection = z.infer<typeof WorkflowStepExecutionSelectionSchema>;

function projectStoredCapabilitySelection(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { mcpSelection, ...canonical } = raw as Record<string, unknown>;
  const capabilitySelection = readCapabilitySelectionCarrierV1(raw);
  return { ...canonical,
    ...(capabilitySelection ? { capabilitySelection } : canonical.capabilitySelection === undefined && mcpSelection != null
      ? { capabilitySelection: { mcp: mcpSelection } } : {}),
  };
}

defineStoredReadProjection(WorkflowSessionAuthoringSelectionSchema, () => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(projectStoredCapabilitySelection), createStoredReadSchema(lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(WorkflowSessionAuthoringSelectionSchema)))));
defineStoredReadProjection(WorkflowStepExecutionSelectionSchema, () => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(projectStoredCapabilitySelection), createStoredReadSchema(lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(WorkflowStepExecutionSelectionSchema)))));

export const WorkflowLeafExecutionTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session') }),
  z.strictObject({ kind: z.literal('detached_run') }),
]));
export type WorkflowLeafExecutionTargetV1 = z.infer<typeof WorkflowLeafExecutionTargetV1Schema>;
/** Executable identities can bind only immutable inputs or the current admitted item. */
export const WorkflowSelectionBindingV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('input'), name: WorkflowInputNameSchema, path: z.optional(WorkflowResultPathSchema) }),
  z.strictObject({ kind: z.literal('item'), field: z.literal('value'), path: z.optional(WorkflowResultPathSchema) }),
]));
export type WorkflowSelectionBindingV1 = z.infer<typeof WorkflowSelectionBindingV1Schema>;
/** Result-selected items can narrow this admitted input roster, never introduce an executable identity. */
export const WorkflowParticipantBindingV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('input'), name: WorkflowInputNameSchema, path: z.optional(WorkflowResultPathSchema) }),
  z.strictObject({ kind: z.literal('item'), field: z.literal('value'), path: z.optional(WorkflowResultPathSchema),
    roster: z.optional(WorkflowInputNameSchema) }),
]));
export const WorkflowLiteralEngineSelectionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ role: z.string().check(z.minLength(1)) }),
  z.strictObject({ agentTarget: AgentExecutionTargetV1Schema,
    modelSelection: zMini.optional(zMini.nullable(SessionModelSelectionV1Schema)), effort: z.optional(z.string().check(z.minLength(1))) }),
]));
export const WorkflowEngineSelectionV1Schema = lazyZodSchema(() => z.union([
  WorkflowLiteralEngineSelectionV1Schema, WorkflowSelectionBindingV1Schema,
]));
export type WorkflowEngineSelectionV1 = z.infer<typeof WorkflowEngineSelectionV1Schema>;
export const WorkflowStepSelectionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStepExecutionSelectionSchema, {
  engine: z.optional(WorkflowEngineSelectionV1Schema),
  participant: z.optional(WorkflowParticipantBindingV1Schema),
  executionTarget: z.optional(WorkflowLeafExecutionTargetV1Schema),
})).check(z.superRefine((selection, context) => {
  if (selection.participant !== undefined && (selection.engine !== undefined || selection.conversation !== undefined
    || selection.agentTarget !== undefined || selection.modelSelection !== undefined || selection.executionTarget?.kind === 'detached_run')) {
    context.addIssue({ code: 'custom', path: ['participant'], message: 'A participant owns its Session and launch selection' });
  }
  if (selection.engine === undefined) return;
  for (const field of ['agentTarget', 'modelSelection'] as const) {
    if (selection[field] !== undefined) context.addIssue({ code: 'custom', path: [field], message: 'An engine arm cannot also set a flat engine field' });
  }
  if (selection.sessionConfigOptionOverrides?.overrides.reasoning_effort !== undefined) {
    context.addIssue({ code: 'custom', path: ['sessionConfigOptionOverrides', 'overrides', 'reasoning_effort'], message: 'Engine effort belongs to the engine arm' });
  }
})));
export type WorkflowStepSelectionV1 = z.infer<typeof WorkflowStepSelectionV1Schema>;
defineStoredReadProjection(WorkflowStepSelectionV1Schema, () => (<I extends zMini.core.$ZodType, O extends zMini.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as zMini.ZodMiniPipe<I, O>)(z.transform(projectStoredCapabilitySelection), createStoredReadSchema(lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(WorkflowStepSelectionV1Schema)))));

/** An authored block title; blank input restores the derived presentation label. */
export const WorkflowBlockNameV1Schema = lazyZodSchema(() => z.optional(z.pipe(z.string().check(z.trim()), z.transform((name) => name || undefined))));

function omitEmptyWorkflowBlockName<T extends { name?: string }>(block: T): T {
  if (block.name === undefined) delete block.name;
  return block;
}

/** Relative to the immediately preceding block in the same ordered list. Omission means success. */
export const WorkflowRunWhenV1Schema = lazyZodSchema(() => z.enum(['success', 'failure', 'always']));
export type WorkflowRunWhenV1 = z.infer<typeof WorkflowRunWhenV1Schema>;

export const WorkflowStepSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('step'),
  id: WorkflowBlockIdSchema,
  name: WorkflowBlockNameV1Schema,
  document: zMini.extend(WorkflowStepComposerDocumentSchema, { text: z.string() }),
  /** Create or acquire the Session without admitting a turn. */
  inputMode: z.optional(z.literal('none')),
  execution: z.optional(WorkflowStepSelectionV1Schema),
  input: z._default(z.array(WorkflowValueReferenceSchema), []),
  /** Publish this leaf as a reply to the exact producer's committed Discussion result. */
  discussionReplyTo: z.optional(WorkflowAuthoredProducerRefSchema),
  result: zMini._default(WorkflowResultContractSchema, { kind: 'text' }),
  timeoutMs: z.optional(z.number().check(z.int(), z.positive(), z.int())),
  pauseForReview: z.optional(z.boolean()),
  onlyWhen: zMini.optional(WorkflowConditionSchema),
  runWhen: z.optional(WorkflowRunWhenV1Schema),
}).check(z.refine((step) => step.inputMode === 'none' || step.document.text.length > 0, {
  path: ['document', 'text'], message: 'An Agent step needs a prompt or explicit inputless creation',
}), z.overwrite(omitEmptyWorkflowBlockName)));
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowAgentLeafV1Schema = WorkflowStepSchema;
export type WorkflowAgentLeafV1 = WorkflowStep;
export const WorkflowActionValueReferenceV1Schema = lazyZodSchema(() => z.union([
  WorkflowValueReferenceSchema,
  z.strictObject({ kind: z.literal('origin_session_id') }),
]));
export type WorkflowActionValueReferenceV1 = z.infer<typeof WorkflowActionValueReferenceV1Schema>;
export const WorkflowActionFieldBindingV1Schema = lazyZodSchema(() => z.union([
  WorkflowActionValueReferenceV1Schema,
  z.strictObject({ kind: z.literal('list'), items: z.array(WorkflowActionValueReferenceV1Schema) }),
  z.strictObject({ kind: z.literal('object'), fields: z.record(z.string(), WorkflowActionValueReferenceV1Schema) }),
]));
export type WorkflowActionFieldBindingV1 = z.infer<typeof WorkflowActionFieldBindingV1Schema>;
const workflowLeafFields = { id: WorkflowBlockIdSchema, name: WorkflowBlockNameV1Schema, execution: zMini.optional(WorkflowStepSelectionV1Schema), onlyWhen: zMini.optional(WorkflowConditionSchema), runWhen: zMini.optional(WorkflowRunWhenV1Schema) };
function refineWorkflowActionBindings(value: Readonly<{ actionId: string; input: Record<string, WorkflowActionFieldBindingV1> }>, context: z.core.$RefinementCtx) {
  for (const [field, binding] of Object.entries(value.input)) {
    if (!isWorkflowActionLiteralFieldV1(value.actionId, field)) continue;
    const literal = binding.kind === 'literal'
      || field === 'argv' && binding.kind === 'list' && binding.items.every(item => item.kind === 'literal');
    if (!literal) {
      context.addIssue({ code: 'custom', path: ['input', field], message: 'Command text and argv elements must be literal' });
    }
  }
}
export const WorkflowActionLeafV1Schema = lazyZodSchema(() => z.strictObject({
  ...workflowLeafFields, kind: z.literal('action'),
  actionId: z.string().check(z.minLength(1), z.refine((id) => !id.startsWith('workflow.run.')
    || isWorkflowRunSummaryActionIdV1(id), 'Workflow composition uses a Workflow leaf')),
  input: z._default(z.record(z.string().check(z.minLength(1)), WorkflowActionFieldBindingV1Schema), {}),
  timeoutMs: z.optional(z.number().check(z.int(), z.positive(), z.int())),
  pauseForReview: z.optional(z.boolean()),
}).check(z.superRefine(refineWorkflowActionBindings), z.overwrite(omitEmptyWorkflowBlockName)));
export type WorkflowActionLeafV1 = z.infer<typeof WorkflowActionLeafV1Schema>;
export const WorkflowNestedLeafV1Schema = lazyZodSchema(() => z.strictObject({
  ...workflowLeafFields, kind: z.literal('workflow'), workflowRef: WorkflowDefinitionRefV1StringSchema,
  input: z._default(z.record(WorkflowInputNameSchema, WorkflowValueReferenceSchema), {}),
}).check(z.overwrite(omitEmptyWorkflowBlockName)));
export type WorkflowNestedLeafV1 = z.infer<typeof WorkflowNestedLeafV1Schema>;
export const WorkflowWaitLeafV1Schema = lazyZodSchema(() => z.strictObject({
  ...workflowLeafFields, kind: z.literal('wait'), document: WorkflowStepComposerDocumentSchema,
  result: zMini.optional(WorkflowResultContractSchema),
}).check(z.overwrite(omitEmptyWorkflowBlockName)));
export type WorkflowWaitLeafV1 = z.infer<typeof WorkflowWaitLeafV1Schema>;
export const WorkflowLeafV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [WorkflowAgentLeafV1Schema, WorkflowActionLeafV1Schema, WorkflowNestedLeafV1Schema, WorkflowWaitLeafV1Schema]));
export type WorkflowLeafV1 = z.infer<typeof WorkflowLeafV1Schema>;
function refineWorkflowEvaluatorRunWhen(value: Readonly<{ runWhen?: WorkflowRunWhenV1 }>, context: z.core.$RefinementCtx) {
  if (value.runWhen !== undefined && value.runWhen !== 'success') {
    context.addIssue({ code: 'custom', path: ['runWhen'], message: 'An evaluator must produce a decision every round' });
  }
}
export const WorkflowEvaluatorLeafV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [WorkflowAgentLeafV1Schema, WorkflowActionLeafV1Schema]).check(z.superRefine(refineWorkflowEvaluatorRunWhen)));
export type WorkflowEvaluatorLeafV1 = z.infer<typeof WorkflowEvaluatorLeafV1Schema>;

export const WORKFLOW_FAILURE_POLICIES = ['fail_stop', 'collect_outcomes'] as const;
export type WorkflowFailurePolicy = (typeof WORKFLOW_FAILURE_POLICIES)[number];

export const WORKFLOW_ITEM_EXECUTION_MODES = ['sequential', 'parallel'] as const;
export type WorkflowItemExecutionMode = (typeof WORKFLOW_ITEM_EXECUTION_MODES)[number];

export const WORKFLOW_EVALUATOR_HISTORY_MODES = ['none', 'latest', 'all'] as const;
export type WorkflowEvaluatorHistoryMode = (typeof WORKFLOW_EVALUATOR_HISTORY_MODES)[number];

/** One lane of a Side by side group; its optional authored name captions the lane (07: "lanes carry their authored names or 'Lane {n}'"). */
export type WorkflowParallelBranch = Readonly<{ id: string; name?: string; blocks: readonly WorkflowBlock[] }>;

export const WorkflowMaxIterationsV1Schema = lazyZodSchema(() => z.union([
  z.number().check(z.int(), z.positive(), z.int()),
  z.strictObject({ kind: z.literal('input'), name: WorkflowInputNameSchema }),
]));
export type WorkflowMaxIterationsV1 = z.infer<typeof WorkflowMaxIterationsV1Schema>;

export type WorkflowRepetition =
  | Readonly<{ kind: 'count'; count: WorkflowValueReference }>
  | Readonly<{
    kind: 'items';
    items: WorkflowValueReference;
    execution: WorkflowItemExecutionMode;
    failurePolicy: WorkflowFailurePolicy;
    maxConcurrent?: number;
  }>
  | Readonly<{ kind: 'until'; maxIterations: WorkflowMaxIterationsV1; stopWhen: WorkflowCondition }>
  | Readonly<{
    kind: 'evaluate';
    maxIterations: WorkflowMaxIterationsV1;
    evaluator: WorkflowEvaluatorLeafV1;
    history: WorkflowEvaluatorHistoryMode;
  }>;

export type WorkflowBlock =
  | WorkflowLeafV1
  | Readonly<{
    kind: 'parallel';
    id: string;
    name?: string;
    branches: readonly WorkflowParallelBranch[];
    failurePolicy: WorkflowFailurePolicy;
    maxConcurrent?: number;
    onlyWhen?: WorkflowCondition;
    runWhen?: WorkflowRunWhenV1;
  }>
  | Readonly<{
    kind: 'loop';
    id: string;
    name?: string;
    body: readonly WorkflowBlock[];
    repetition: WorkflowRepetition;
    onlyWhen?: WorkflowCondition;
    runWhen?: WorkflowRunWhenV1;
  }>
  | Readonly<{
    kind: 'if';
    id: string;
    name?: string;
    when: WorkflowCondition;
    then: readonly WorkflowBlock[];
    otherwise: readonly WorkflowBlock[];
    runWhen?: WorkflowRunWhenV1;
  }>;

export const WorkflowEvaluateRepetitionFieldsSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('evaluate'),
  maxIterations: WorkflowMaxIterationsV1Schema,
  history: z.enum(WORKFLOW_EVALUATOR_HISTORY_MODES),
}));

function createWorkflowRepetitionSchema(evaluator: z.ZodMiniType) {
  return z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('count'), count: WorkflowValueReferenceSchema }),
  z.strictObject({
    kind: z.literal('items'),
    items: WorkflowValueReferenceSchema,
    execution: z.enum(WORKFLOW_ITEM_EXECUTION_MODES),
    failurePolicy: z.enum(WORKFLOW_FAILURE_POLICIES),
    maxConcurrent: z.optional(z.number().check(z.int(), z.positive(), z.int())),
  }),
  z.strictObject({
    kind: z.literal('until'),
    maxIterations: WorkflowMaxIterationsV1Schema,
    stopWhen: WorkflowConditionSchema,
  }),
  lazyZodSchema(() => z.extend(WorkflowEvaluateRepetitionFieldsSchema, {
    evaluator,
  })),
  ]);
}
export const WorkflowRepetitionSchema = createWorkflowRepetitionSchema(WorkflowEvaluatorLeafV1Schema) as z.ZodMiniType<WorkflowRepetition>;

/** Insertion keeps canonical fields while allowing the edit owner to assign identities. */
export type WorkflowInsertBlockV1 =
  | { [TKind in WorkflowLeafV1['kind']]: Omit<Extract<WorkflowLeafV1, { kind: TKind }>, 'id'> & { id?: string } }[WorkflowLeafV1['kind']]
  | (Omit<Extract<WorkflowBlock, { kind: 'parallel' }>, 'id' | 'branches'> & {
    id?: string; branches: readonly { id?: string; blocks: readonly WorkflowInsertBlockV1[] }[];
  })
  | (Omit<Extract<WorkflowBlock, { kind: 'loop' }>, 'id' | 'body' | 'repetition'> & {
    id?: string; body: readonly WorkflowInsertBlockV1[];
    repetition: Exclude<WorkflowRepetition, { kind: 'evaluate' }>
      | (Omit<Extract<WorkflowRepetition, { kind: 'evaluate' }>, 'evaluator'> & {
        evaluator: (Omit<WorkflowStep, 'id'> | Omit<WorkflowActionLeafV1, 'id'>) & { id?: string };
      });
  })
  | (Omit<Extract<WorkflowBlock, { kind: 'if' }>, 'id' | 'then' | 'otherwise'> & {
    id?: string; then: readonly WorkflowInsertBlockV1[]; otherwise: readonly WorkflowInsertBlockV1[];
  });

// Canonical non-recursive fields, also used by insertion's optional-id dialect.
export const WorkflowParallelBlockFieldsSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('parallel'), id: WorkflowBlockIdSchema,
  name: WorkflowBlockNameV1Schema,
  failurePolicy: z.enum(WORKFLOW_FAILURE_POLICIES),
  maxConcurrent: z.optional(z.number().check(z.int(), z.positive(), z.int())),
  onlyWhen: zMini.optional(WorkflowConditionSchema),
  runWhen: z.optional(WorkflowRunWhenV1Schema),
}).check(z.overwrite(omitEmptyWorkflowBlockName)));
export const WorkflowLoopBlockFieldsSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('loop'), id: WorkflowBlockIdSchema,
  name: WorkflowBlockNameV1Schema,
  repetition: WorkflowRepetitionSchema,
  onlyWhen: zMini.optional(WorkflowConditionSchema),
  runWhen: z.optional(WorkflowRunWhenV1Schema),
}).check(z.overwrite(omitEmptyWorkflowBlockName)));
export const WorkflowIfBlockFieldsSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('if'), id: WorkflowBlockIdSchema,
  name: WorkflowBlockNameV1Schema,
  when: WorkflowConditionSchema,
  runWhen: z.optional(WorkflowRunWhenV1Schema),
}).check(z.overwrite(omitEmptyWorkflowBlockName)));

const WorkflowParallelBranchFieldsSchema = lazyZodSchema(() => z.strictObject({ id: WorkflowBlockIdSchema, name: WorkflowBlockNameV1Schema }));
function isBlockRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Visits only block lists; conditions and JSON retain their own schema owners. */
function workflowChildLists(value: unknown): { blocks: unknown[]; path: (string | number)[] }[] {
  if (!isBlockRecord(value)) return [];
  if (value.kind === 'parallel' && Array.isArray(value.branches)) {
    return value.branches.flatMap((branch, index) => isBlockRecord(branch) && Array.isArray(branch.blocks)
      ? [{ blocks: branch.blocks, path: ['branches', index, 'blocks'] }] : []);
  }
  const keys = value.kind === 'loop' ? ['body'] : value.kind === 'if' ? ['then', 'otherwise'] : [];
  return keys.flatMap((key) => Array.isArray(value[key]) ? [{ blocks: value[key], path: [key] }] : []);
}

/** Authored depth-first order, including evaluators; stored projections need no full block admission. */
export function walkWorkflowBlocks(blocks: readonly WorkflowBlock[]): readonly WorkflowBlock[];
export function walkWorkflowBlocks(blocks: readonly unknown[]): readonly unknown[];
export function walkWorkflowBlocks(blocks: readonly unknown[]): readonly unknown[] {
  const collected: unknown[] = [];
  const pending = [...blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop();
    collected.push(block);
    const lists = workflowChildLists(block);
    for (let listIndex = lists.length - 1; listIndex >= 0; listIndex -= 1) {
      const list = lists[listIndex]!.blocks;
      for (let index = list.length - 1; index >= 0; index -= 1) pending.push(list[index]);
    }
    if (isBlockRecord(block) && block.kind === 'loop' && isBlockRecord(block.repetition)
      && block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
  }
  return collected;
}

function workflowFieldsWithOptionalId<T extends z.core.$ZodShape>(schema: z.ZodMiniObject<T>) {
  // Rebuild the same strict field shape before changing id: Zod's partial()
  // rejects object overwrite checks. The variant retains the canonical fields.
  return z.extend(z.strictObject(schema.shape), { id: zMini.optional(WorkflowBlockIdSchema) });
}

/** One structural engine for canonical parsing, ingress and normalization. */
function createWorkflowBlockSchema<T extends WorkflowIngressBlock | WorkflowInsertBlockV1>(dialect: 'canonical' | 'ingress' | 'insert' | 'stored'): z.ZodMiniType<T> {
  const allowShorthand = dialect === 'ingress';
  const optionalIds = dialect === 'insert';
  const step = optionalIds ? workflowFieldsWithOptionalId(WorkflowStepSchema).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowStepSchema;
  const action = optionalIds ? workflowFieldsWithOptionalId(WorkflowActionLeafV1Schema).check(z.superRefine(refineWorkflowActionBindings), z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowActionLeafV1Schema;
  const workflow = optionalIds ? workflowFieldsWithOptionalId(WorkflowNestedLeafV1Schema).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowNestedLeafV1Schema;
  const wait = optionalIds ? workflowFieldsWithOptionalId(WorkflowWaitLeafV1Schema).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowWaitLeafV1Schema;
  const parallel = optionalIds ? workflowFieldsWithOptionalId(WorkflowParallelBlockFieldsSchema).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowParallelBlockFieldsSchema;
  // A lane's blank name is omitted, exactly as a block's (one canonical spelling).
  const branch = (optionalIds ? lazyZodSchema(() => z.partial(WorkflowParallelBranchFieldsSchema, { id: true })) : WorkflowParallelBranchFieldsSchema).check(z.overwrite(omitEmptyWorkflowBlockName));
  const loop = optionalIds ? z.extend(workflowFieldsWithOptionalId(WorkflowLoopBlockFieldsSchema), {
    repetition: createWorkflowRepetitionSchema(z.discriminatedUnion('kind', [step, action]).check(z.superRefine(refineWorkflowEvaluatorRunWhen))),
  }).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowLoopBlockFieldsSchema;
  const conditional = optionalIds ? workflowFieldsWithOptionalId(WorkflowIfBlockFieldsSchema).check(z.overwrite(omitEmptyWorkflowBlockName)) : WorkflowIfBlockFieldsSchema;
  const canonicalShallow = z.discriminatedUnion('kind', [step, action, workflow, wait,
    z.extend(parallel, { branches: z.array(z.extend(branch, { blocks: z.array(z.unknown()).check(z.minLength(1)) })).check(z.minLength(1)) }),
    z.extend(loop, { body: z.array(z.unknown()).check(z.minLength(1)) }),
    z.extend(conditional, { then: z.array(z.unknown()).check(z.minLength(1)), otherwise: z._default(z.array(z.unknown()), []) }),
  ]);
  const shallow = dialect === 'stored' ? createStoredReadSchema(canonicalShallow) : canonicalShallow;
  const schema = z.pipe(z.unknown(), z.transform((value, context): T => {
    let output: unknown;
    let failed = false;
    const ancestors = new WeakSet<object>();
    type Task = { value: unknown; path: (string | number)[]; assign: (value: unknown) => void } | { finish: object };
    const pending: Task[] = [
      { value, path: [], assign: (parsed) => { output = parsed; } },
    ];
    while (pending.length > 0) {
      const task = pending.pop()!;
      if ('finish' in task) { ancestors.delete(task.finish); continue; }
      if (task.value !== null && typeof task.value === 'object') {
        if (ancestors.has(task.value)) {
          context.issues.push({ code: 'custom', path: task.path, message: 'Workflow blocks cannot contain cycles', input: context.value });
          failed = true;
          continue;
        }
        ancestors.add(task.value);
        pending.push({ finish: task.value });
      }
      // Admission uses the shared name rule before schema normalization; stored reads stay tolerant.
      if (dialect !== 'stored' && isBlockRecord(task.value) && (task.value.kind === 'step' || task.value.kind === 'wait')) {
        const invalidName = findInvalidWorkflowResultFieldName(task.value.result);
        if (invalidName !== null) {
          context.issues.push({ code: 'custom', path: [...task.path, 'result', 'schema', 'properties', invalidName], message: 'Invalid result field name', input: context.value });
          failed = true;
          continue;
        }
      }
      const parsed = allowShorthand && typeof task.value === 'string'
        ? z.string().check(z.minLength(1)).safeParse(task.value)
        : shallow.safeParse(task.value);
      if (!parsed.success) {
        failed = true;
        for (const issue of parsed.error.issues) context.issues.push({ ...issue, path: [...task.path, ...issue.path], input: ('input' in issue ? issue.input ?? context.value : context.value) } as zMini.core.$ZodRawIssue);
      } else {
        task.assign(parsed.data);
      }
      // Even a malformed parent reports its malformed descendants, preserving
      // normalization's exact repair paths. Failed output is never returned.
      const lists = workflowChildLists(parsed.success ? parsed.data : task.value);
      for (let listIndex = lists.length - 1; listIndex >= 0; listIndex -= 1) {
        const list = lists[listIndex]!;
        for (let index = list.blocks.length - 1; index >= 0; index -= 1) {
          pending.push({ value: list.blocks[index], path: [...task.path, ...list.path, index],
            assign: parsed.success ? (child) => { list.blocks[index] = child; } : () => {}, });
        }
      }
    }
    // Every returned leaf/field/list has passed its canonical shallow schema.
    return failed ? z.NEVER : output as T;
  }));

  // Action/SDK exporters still need the recursive declaration graph. It is
  // derived from the same field owners and used only for JSON Schema projection,
  // never as a second runtime parser (the same bridge as internalProtocolZodAdapter).
  const projection = z.lazy(() => {
    const shapes = [step, action, workflow, wait,
      z.extend(parallel, {
        branches: z.array(z.extend(branch, { blocks: z.array(schema).check(z.minLength(1)) })).check(z.minLength(1)),
      }),
      z.extend(loop, { body: z.array(schema).check(z.minLength(1)) }),
      z.extend(conditional, { then: z.array(schema).check(z.minLength(1)), otherwise: z._default(z.array(schema), []) }),
    ] as const;
    return allowShorthand ? z.union([z.string().check(z.minLength(1)), ...shapes]) : z.discriminatedUnion('kind', shapes);
  });
  schema._zod.processJSONSchema = (context, _json, params) => {
    // Recursive blocks reuse the same rich execution/field declarations. Ref
    // extraction keeps AJV's recursive stack frames proportional to blocks,
    // rather than duplicating every leaf's complete selection validator.
    context.reused = 'ref';
    z.core.process(projection, context, params);
    context.seen.get(schema)!.ref = projection;
  };
  return schema;
}

// Union construction inspects leaf shapes; keep all block dialects cold until
// cyclic composer/attachment imports have finished initializing.
export const WorkflowBlockSchema = defineStoredReadProjection(lazyZodSchema(() => createWorkflowBlockSchema<WorkflowBlock>('canonical')),
  () => createWorkflowBlockSchema<WorkflowBlock>('stored'));
export const WorkflowInsertBlockV1Schema = lazyZodSchema(() => createWorkflowBlockSchema<WorkflowInsertBlockV1>('insert'));

export const WorkflowDefinitionBaseSchema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  inputs: z._default(z.array(WorkflowInputDefinitionSchema), []),
  defaults: z._default(WorkflowStepSelectionV1Schema, {}),
  roles: z.optional(z.array(WorkflowRoleV1Schema)),
  blocks: z.array(WorkflowBlockSchema).check(z.minLength(1)),
  finalOutput: zMini.optional(WorkflowAuthoredResultReferenceSchema),
}));

export type WorkflowDefinitionV1 = Readonly<{
  version: 1;
  inputs: readonly WorkflowInputDefinition[];
  defaults: WorkflowStepSelectionV1;
  roles?: readonly WorkflowRoleV1[];
  blocks: readonly WorkflowBlock[];
  finalOutput?: z.infer<typeof WorkflowAuthoredResultReferenceSchema>;
}>;

/**
 * Structural parse only. Semantic validation (ids, references, scopes, provable
 * bounds and effective Agent resolution) is the walker in
 * `validateWorkflowDefinition`, which reparses its normalized output through
 * this schema.
 */
// Author inputs carry the same canonical definition as parsed output. Keeping
// this at the schema owner also preserves nested Action DTO correspondence.
export const WorkflowDefinitionSchema = WorkflowDefinitionBaseSchema as unknown as z.ZodMiniType<WorkflowDefinitionV1, WorkflowDefinitionV1>;
/** Epoch-qualified public name; aliases the single executable owner above. */
export const WorkflowDefinitionV1Schema = WorkflowDefinitionSchema;

/**
 * Exact authored block input: canonical structured blocks plus the one
 * prompt-only shorthand normalization accepts at any block-list position.
 * Normalization expands every shorthand before canonical validation and
 * persistence, while the shared generic keeps structured ingress blocks
 * identical to executable blocks.
 */
export type WorkflowIngressBlock =
  | string
  | WorkflowLeafV1
  | (Omit<Extract<WorkflowBlock, { kind: 'parallel' }>, 'branches'> & Readonly<{
    branches: readonly (Omit<WorkflowParallelBranch, 'blocks'> & Readonly<{
      blocks: readonly WorkflowIngressBlock[];
    }>)[];
  }>)
  | (Omit<Extract<WorkflowBlock, { kind: 'loop' }>, 'body'> & Readonly<{
    body: readonly WorkflowIngressBlock[];
  }>)
  | (Omit<Extract<WorkflowBlock, { kind: 'if' }>, 'then' | 'otherwise'> & Readonly<{
    then: readonly WorkflowIngressBlock[];
    otherwise: readonly WorkflowIngressBlock[];
  }>);

export const WorkflowIngressBlockSchema = lazyZodSchema(() => createWorkflowBlockSchema<WorkflowIngressBlock>('ingress'));

export const WorkflowIngressSchema = lazyZodSchema(() => z.strictObject({
  version: z.optional(z.literal(1)),
  inputs: z.optional(z.array(WorkflowInputDefinitionSchema)),
  // The normalization owner treats null defaults as omitted authoring input.
  defaults: z.optional(z.nullable(WorkflowStepSelectionV1Schema)),
  roles: z.optional(z.array(WorkflowRoleV1Schema)),
  blocks: z.array(WorkflowIngressBlockSchema).check(z.minLength(1)),
  finalOutput: zMini.optional(WorkflowAuthoredResultReferenceSchema),
}));
export type WorkflowIngressV1 = z.infer<typeof WorkflowIngressSchema>;
/** Epoch-neutral alias consumed by the workflow Action request schemas. */
export type WorkflowIngress = WorkflowIngressV1;

/**
 * Host-only ingress context. A trusted Action adapter supplies the calling
 * Session's canonical current Agent and machine; the normalizer consults them
 * only when neither the step nor the workflow default supplies a value, and
 * never persists them as caller-authored JSON. This is not wire content and
 * cannot be caller-forged.
 */
export const WorkflowIngressContextV1Schema = lazyZodSchema(() => z.strictObject({
  agentTarget: zMini.optional(SessionAuthoringSelectionFieldsV1.agentTarget),
  machineId: z.optional(z.string().check(z.minLength(1))),
  directory: z.optional(z.string().check(z.minLength(1))),
}));
export type WorkflowIngressContextV1 = z.infer<typeof WorkflowIngressContextV1Schema>;

export const WORKFLOW_VALIDATION_ISSUE_CODES = [
  'invalid_version',
  'unknown_field',
  'invalid_id',
  'duplicate_id',
  'missing_reference',
  'invalid_reference_scope',
  'invalid_input',
  'missing_required_input',
  'invalid_result_contract',
  'invalid_condition',
  'invalid_repetition',
  'invalid_max_concurrent',
  'unsupported_persisted_attachment',
  'conversation_workspace_mismatch',
  'target_unavailable',
] as const;
export type WorkflowValidationIssueCode = (typeof WORKFLOW_VALIDATION_ISSUE_CODES)[number];

export const WorkflowValidationIssueV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.enum(WORKFLOW_VALIDATION_ISSUE_CODES),
  path: z.string(), message: z.string(), blockId: z.optional(z.string()),
  severity: z.enum(['error', 'warning']),
}));

export type WorkflowValidationIssue = Readonly<{
  code: WorkflowValidationIssueCode;
  /** JSON-pointer-like location of the exact block or field, e.g. `/blocks/1/input/0`. */
  path: string;
  message: string;
  blockId?: string;
  severity: 'error' | 'warning';
}>;

export type WorkflowTargetValidationState = 'not_requested' | 'checked' | 'unavailable';

export type WorkflowValidationResult = Readonly<{
  valid: boolean;
  normalizedDefinition?: WorkflowDefinitionV1;
  issues: readonly WorkflowValidationIssue[];
  targetValidation: WorkflowTargetValidationState;
}>;

export type { JsonValue };
