import { z } from 'zod';

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
  WorkflowAuthoredResultReferenceSchema,
  WorkflowBlockIdSchema,
  WorkflowConditionSchema,
  WorkflowConversationSelectionSchema,
  WorkflowInputNameSchema,
  WorkflowValueReferenceSchema,
  type WorkflowCondition,
  type WorkflowValueReference,
} from './workflowReferenceV1.js';
import { WorkflowWorkspaceSelectionSchema } from './workflowWorkspaceV1.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { WorkflowRoleV1Schema, type WorkflowRoleV1 } from '../prompts/roles/rolesV1.js';
import { WorkflowDefinitionRefV1StringSchema } from './workflowDefinitionRefV1.js';
import type { InputFieldHint } from '../inputs/inputFields.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

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

export const WorkflowInputDefinitionSchema = z.object({
  name: WorkflowInputNameSchema,
  valueType: z.enum(['string', 'number', 'boolean', 'json']),
  enum: z.array(z.string()).min(1).optional(),
  required: z.boolean(),
  default: StrictJsonValueSchema.optional(),
  description: z.string().optional(),
  optionsSourceId: z.string().min(1).optional(),
  inputType: asProtocolZod(PluginContributionIdentityV1Schema).optional(),
}).strict().superRefine((value, ctx) => {
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
});
export type WorkflowInputDefinition = z.infer<typeof WorkflowInputDefinitionSchema>;

/** Presentation adapter only: Workflow admission, defaults and references stay Workflow-owned. */
export function workflowInputToFieldHint(
  definition: WorkflowInputDefinition,
  presentation?: Readonly<{ title?: string; optionLabels?: Readonly<Record<string, string>> }>,
): InputFieldHint {
  const hasChoices = definition.enum !== undefined || definition.optionsSourceId !== undefined || definition.inputType !== undefined;
  return {
    path: definition.name,
    title: presentation?.title ?? definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    widget: hasChoices ? definition.valueType === 'json' && !definition.inputType ? 'multiselect' : 'select'
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
 * environment variables and Account/team placement are excluded from portable
 * definitions.
 */
const WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE = {
  agentTarget: SessionAuthoringSelectionFieldsV1.agentTarget.optional(),
  // The catalog entry carries a `.default(null)` for draft hydration. A workflow
  // definition must distinguish omission from an explicit null, so this consumes
  // the underlying selection schema without that default.
  modelSelection: SessionModelSelectionV1Schema.nullable().optional(),
  profileId: SessionAuthoringSelectionFieldsV1.profileId.optional(),
  permissionMode: SessionAuthoringSelectionFieldsV1.permissionMode.optional(),
  acpSessionModeId: SessionAuthoringSelectionFieldsV1.acpSessionModeId.optional(),
  sessionConfigOptionOverrides: SessionAuthoringSelectionFieldsV1.sessionConfigOptionOverrides.optional(),
  mcpSelection: SessionAuthoringSelectionFieldsV1.mcpSelection.optional(),
  // Portable definitions normalize supported V1 persistence into the strict
  // current selection so native/profile/group/team-resource intent survives
  // without carrying unknown fields into exported JSON.
  connectedServices: ConnectedServiceBindingsV2IngressSchema.nullable().optional(),
  transcriptStorage: SessionAuthoringSelectionFieldsV1.transcriptStorage.optional(),
  terminal: SessionAuthoringSelectionFieldsV1.terminal.optional(),
  windowsRemoteSessionLaunchMode: SessionAuthoringSelectionFieldsV1.windowsRemoteSessionLaunchMode.optional(),
  windowsRemoteSessionConsole: SessionAuthoringSelectionFieldsV1.windowsRemoteSessionConsole.optional(),
  windowsTerminalWindowName: SessionAuthoringSelectionFieldsV1.windowsTerminalWindowName.optional(),
  runtimeDescriptorV1: PortableRuntimeDescriptorV1Schema.nullable().optional(),
} as const;

export const WorkflowSessionAuthoringSelectionSchema = z
  .object(WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE)
  .strict();
export type WorkflowSessionAuthoringSelection = z.infer<typeof WorkflowSessionAuthoringSelectionSchema>;

/** The Session-authoring field ids a workflow definition round-trips, in editor order. */
export type WorkflowSessionAuthoringSelectionFieldId = keyof typeof WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE;
export const WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS = Object.freeze(
  Object.keys(WORKFLOW_SESSION_AUTHORING_SELECTION_SHAPE) as WorkflowSessionAuthoringSelectionFieldId[],
);

export const WorkflowStepExecutionSelectionSchema = WorkflowSessionAuthoringSelectionSchema.extend({
  conversation: WorkflowConversationSelectionSchema.optional(),
  workspace: WorkflowWorkspaceSelectionSchema.optional(),
}).strict();
export type WorkflowStepExecutionSelection = z.infer<typeof WorkflowStepExecutionSelectionSchema>;

export const WorkflowLeafExecutionTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('detached_run') }).strict(),
]);
export type WorkflowLeafExecutionTargetV1 = z.infer<typeof WorkflowLeafExecutionTargetV1Schema>;
export const WorkflowEngineSelectionV1Schema = z.union([
  z.object({ role: z.string().min(1) }).strict(),
  z.object({ agentTarget: AgentExecutionTargetV1Schema,
    modelSelection: SessionModelSelectionV1Schema.nullable().optional(), effort: z.string().min(1).optional() }).strict(),
]);
export type WorkflowEngineSelectionV1 = z.infer<typeof WorkflowEngineSelectionV1Schema>;
export const WorkflowStepSelectionV1Schema = WorkflowStepExecutionSelectionSchema.extend({
  engine: WorkflowEngineSelectionV1Schema.optional(),
  executionTarget: WorkflowLeafExecutionTargetV1Schema.optional(),
}).strict().superRefine((selection, context) => {
  if (selection.engine === undefined) return;
  for (const field of ['agentTarget', 'modelSelection'] as const) {
    if (selection[field] !== undefined) context.addIssue({ code: 'custom', path: [field], message: 'An engine arm cannot also set a flat engine field' });
  }
  if (selection.sessionConfigOptionOverrides?.overrides.reasoning_effort !== undefined) {
    context.addIssue({ code: 'custom', path: ['sessionConfigOptionOverrides', 'overrides', 'reasoning_effort'], message: 'Engine effort belongs to the engine arm' });
  }
});
export type WorkflowStepSelectionV1 = z.infer<typeof WorkflowStepSelectionV1Schema>;

export const WorkflowStepSchema = z.object({
  kind: z.literal('step'),
  id: WorkflowBlockIdSchema,
  document: WorkflowStepComposerDocumentSchema,
  execution: WorkflowStepSelectionV1Schema.optional(),
  input: z.array(WorkflowValueReferenceSchema).default([]),
  result: WorkflowResultContractSchema.default({ kind: 'text' }),
  timeoutMs: z.number().int().positive().safe().optional(),
  pauseForReview: z.boolean().optional(),
  onlyWhen: WorkflowConditionSchema.optional(),
}).strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowAgentLeafV1Schema = WorkflowStepSchema;
export type WorkflowAgentLeafV1 = WorkflowStep;
export const WorkflowActionValueReferenceV1Schema = z.union([
  WorkflowValueReferenceSchema,
  z.object({ kind: z.literal('origin_session_id') }).strict(),
]);
export type WorkflowActionValueReferenceV1 = z.infer<typeof WorkflowActionValueReferenceV1Schema>;
export const WorkflowActionFieldBindingV1Schema = z.union([
  WorkflowActionValueReferenceV1Schema,
  z.object({ kind: z.literal('list'), items: z.array(WorkflowActionValueReferenceV1Schema) }).strict(),
]);
export type WorkflowActionFieldBindingV1 = z.infer<typeof WorkflowActionFieldBindingV1Schema>;
const workflowLeafFields = { id: WorkflowBlockIdSchema, execution: WorkflowStepSelectionV1Schema.optional(), onlyWhen: WorkflowConditionSchema.optional() };
export const WorkflowActionLeafV1Schema = z.object({
  ...workflowLeafFields, kind: z.literal('action'),
  actionId: z.string().min(1).refine((id) => !id.startsWith('workflow.run.'), 'Workflow composition uses a Workflow leaf'),
  input: z.record(z.string().min(1), WorkflowActionFieldBindingV1Schema).default({}),
  timeoutMs: z.number().int().positive().safe().optional(),
  pauseForReview: z.boolean().optional(),
}).strict();
export type WorkflowActionLeafV1 = z.infer<typeof WorkflowActionLeafV1Schema>;
export const WorkflowNestedLeafV1Schema = z.object({
  ...workflowLeafFields, kind: z.literal('workflow'), workflowRef: WorkflowDefinitionRefV1StringSchema,
  input: z.record(WorkflowInputNameSchema, WorkflowValueReferenceSchema).default({}),
}).strict();
export type WorkflowNestedLeafV1 = z.infer<typeof WorkflowNestedLeafV1Schema>;
export const WorkflowWaitLeafV1Schema = z.object({
  ...workflowLeafFields, kind: z.literal('wait'), document: WorkflowStepComposerDocumentSchema,
  result: WorkflowResultContractSchema.optional(),
}).strict();
export type WorkflowWaitLeafV1 = z.infer<typeof WorkflowWaitLeafV1Schema>;
export const WorkflowLeafV1Schema = z.discriminatedUnion('kind', [WorkflowAgentLeafV1Schema, WorkflowActionLeafV1Schema, WorkflowNestedLeafV1Schema, WorkflowWaitLeafV1Schema]);
export type WorkflowLeafV1 = z.infer<typeof WorkflowLeafV1Schema>;
export const WorkflowEvaluatorLeafV1Schema = z.discriminatedUnion('kind', [WorkflowAgentLeafV1Schema, WorkflowActionLeafV1Schema]);
export type WorkflowEvaluatorLeafV1 = z.infer<typeof WorkflowEvaluatorLeafV1Schema>;

export const WORKFLOW_FAILURE_POLICIES = ['fail_stop', 'collect_outcomes'] as const;
export type WorkflowFailurePolicy = (typeof WORKFLOW_FAILURE_POLICIES)[number];

export const WORKFLOW_ITEM_EXECUTION_MODES = ['sequential', 'parallel'] as const;
export type WorkflowItemExecutionMode = (typeof WORKFLOW_ITEM_EXECUTION_MODES)[number];

export const WORKFLOW_EVALUATOR_HISTORY_MODES = ['none', 'latest', 'all'] as const;
export type WorkflowEvaluatorHistoryMode = (typeof WORKFLOW_EVALUATOR_HISTORY_MODES)[number];

export type WorkflowParallelBranch = Readonly<{ id: string; blocks: readonly WorkflowBlock[] }>;

export const WorkflowMaxIterationsV1Schema = z.union([
  z.number().int().positive().safe(),
  z.object({ kind: z.literal('input'), name: WorkflowInputNameSchema }).strict(),
]);
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
    branches: readonly WorkflowParallelBranch[];
    failurePolicy: WorkflowFailurePolicy;
    maxConcurrent?: number;
    onlyWhen?: WorkflowCondition;
  }>
  | Readonly<{
    kind: 'loop';
    id: string;
    body: readonly WorkflowBlock[];
    repetition: WorkflowRepetition;
    onlyWhen?: WorkflowCondition;
  }>
  | Readonly<{
    kind: 'if';
    id: string;
    when: WorkflowCondition;
    then: readonly WorkflowBlock[];
    otherwise: readonly WorkflowBlock[];
  }>;

export const WorkflowEvaluateRepetitionFieldsSchema = z.object({
  kind: z.literal('evaluate'),
  maxIterations: WorkflowMaxIterationsV1Schema,
  history: z.enum(WORKFLOW_EVALUATOR_HISTORY_MODES),
}).strict();

function createWorkflowRepetitionSchema(evaluator: z.ZodType) {
  return z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), count: WorkflowValueReferenceSchema }).strict(),
  z.object({
    kind: z.literal('items'),
    items: WorkflowValueReferenceSchema,
    execution: z.enum(WORKFLOW_ITEM_EXECUTION_MODES),
    failurePolicy: z.enum(WORKFLOW_FAILURE_POLICIES),
    maxConcurrent: z.number().int().positive().safe().optional(),
  }).strict(),
  z.object({
    kind: z.literal('until'),
    maxIterations: WorkflowMaxIterationsV1Schema,
    stopWhen: WorkflowConditionSchema,
  }).strict(),
  WorkflowEvaluateRepetitionFieldsSchema.extend({
    evaluator,
  }),
  ]);
}
export const WorkflowRepetitionSchema = createWorkflowRepetitionSchema(WorkflowEvaluatorLeafV1Schema) as z.ZodType<WorkflowRepetition>;

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
export const WorkflowParallelBlockFieldsSchema = z.object({
  kind: z.literal('parallel'), id: WorkflowBlockIdSchema,
  failurePolicy: z.enum(WORKFLOW_FAILURE_POLICIES),
  maxConcurrent: z.number().int().positive().safe().optional(),
  onlyWhen: WorkflowConditionSchema.optional(),
}).strict();
export const WorkflowLoopBlockFieldsSchema = z.object({
  kind: z.literal('loop'), id: WorkflowBlockIdSchema,
  repetition: WorkflowRepetitionSchema,
  onlyWhen: WorkflowConditionSchema.optional(),
}).strict();
export const WorkflowIfBlockFieldsSchema = z.object({
  kind: z.literal('if'), id: WorkflowBlockIdSchema,
  when: WorkflowConditionSchema,
}).strict();

const WorkflowParallelBranchFieldsSchema = z.object({ id: WorkflowBlockIdSchema }).strict();
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

/** One structural engine for canonical parsing, ingress and normalization. */
function createWorkflowBlockSchema<T extends WorkflowIngressBlock | WorkflowInsertBlockV1>(dialect: 'canonical' | 'ingress' | 'insert'): z.ZodType<T> {
  const allowShorthand = dialect === 'ingress';
  const optionalIds = dialect === 'insert';
  const step = optionalIds ? WorkflowStepSchema.partial({ id: true }) : WorkflowStepSchema;
  const action = optionalIds ? WorkflowActionLeafV1Schema.partial({ id: true }) : WorkflowActionLeafV1Schema;
  const workflow = optionalIds ? WorkflowNestedLeafV1Schema.partial({ id: true }) : WorkflowNestedLeafV1Schema;
  const wait = optionalIds ? WorkflowWaitLeafV1Schema.partial({ id: true }) : WorkflowWaitLeafV1Schema;
  const parallel = optionalIds ? WorkflowParallelBlockFieldsSchema.partial({ id: true }) : WorkflowParallelBlockFieldsSchema;
  const branch = optionalIds ? WorkflowParallelBranchFieldsSchema.partial({ id: true }) : WorkflowParallelBranchFieldsSchema;
  const loop = optionalIds ? WorkflowLoopBlockFieldsSchema.partial({ id: true }).extend({
    repetition: createWorkflowRepetitionSchema(z.discriminatedUnion('kind', [step, action])),
  }) : WorkflowLoopBlockFieldsSchema;
  const conditional = optionalIds ? WorkflowIfBlockFieldsSchema.partial({ id: true }) : WorkflowIfBlockFieldsSchema;
  const shallow = z.discriminatedUnion('kind', [step, action, workflow, wait,
    parallel.extend({ branches: z.array(branch.extend({ blocks: z.array(z.unknown()).min(1) })).min(1) }),
    loop.extend({ body: z.array(z.unknown()).min(1) }),
    conditional.extend({ then: z.array(z.unknown()).min(1), otherwise: z.array(z.unknown()).default([]) }),
  ]);
  const schema = z.unknown().transform((value, context): T => {
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
          context.addIssue({ code: 'custom', path: task.path, message: 'Workflow blocks cannot contain cycles' });
          failed = true;
          continue;
        }
        ancestors.add(task.value);
        pending.push({ finish: task.value });
      }
      const parsed = allowShorthand && typeof task.value === 'string'
        ? z.string().min(1).safeParse(task.value)
        : shallow.safeParse(task.value);
      if (!parsed.success) {
        failed = true;
        for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: [...task.path, ...issue.path] });
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
  });

  // Action/SDK exporters still need the recursive declaration graph. It is
  // derived from the same field owners and used only for JSON Schema projection,
  // never as a second runtime parser (the same bridge as internalProtocolZodAdapter).
  const projection = z.lazy(() => {
    const shapes = [step, action, workflow, wait,
      parallel.extend({
        branches: z.array(branch.extend({ blocks: z.array(schema).min(1) })).min(1),
      }),
      loop.extend({ body: z.array(schema).min(1) }),
      conditional.extend({ then: z.array(schema).min(1), otherwise: z.array(schema).default([]) }),
    ] as const;
    return allowShorthand ? z.union([z.string().min(1), ...shapes]) : z.discriminatedUnion('kind', shapes);
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

export const WorkflowBlockSchema = createWorkflowBlockSchema<WorkflowBlock>('canonical');
export const WorkflowInsertBlockV1Schema = createWorkflowBlockSchema<WorkflowInsertBlockV1>('insert');

export const WorkflowDefinitionBaseSchema = z.object({
  version: z.literal(1),
  inputs: z.array(WorkflowInputDefinitionSchema).default([]),
  defaults: WorkflowStepSelectionV1Schema.default({}),
  roles: z.array(WorkflowRoleV1Schema).optional(),
  blocks: z.array(WorkflowBlockSchema).min(1),
  finalOutput: WorkflowAuthoredResultReferenceSchema.optional(),
}).strict();

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
export const WorkflowDefinitionSchema = WorkflowDefinitionBaseSchema as unknown as z.ZodType<WorkflowDefinitionV1>;
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

export const WorkflowIngressBlockSchema = createWorkflowBlockSchema<WorkflowIngressBlock>('ingress');

export const WorkflowIngressSchema = z.object({
  version: z.literal(1).optional(),
  inputs: z.array(WorkflowInputDefinitionSchema).optional(),
  defaults: WorkflowStepSelectionV1Schema.optional(),
  roles: z.array(WorkflowRoleV1Schema).optional(),
  blocks: z.array(WorkflowIngressBlockSchema).min(1),
  finalOutput: WorkflowAuthoredResultReferenceSchema.optional(),
}).strict();
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
export const WorkflowIngressContextV1Schema = z.object({
  agentTarget: SessionAuthoringSelectionFieldsV1.agentTarget.optional(),
  machineId: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
}).strict();
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

export const WorkflowValidationIssueV1Schema = z.object({
  code: z.enum(WORKFLOW_VALIDATION_ISSUE_CODES),
  path: z.string(), message: z.string(), blockId: z.string().optional(),
  severity: z.enum(['error', 'warning']),
}).strict();

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
