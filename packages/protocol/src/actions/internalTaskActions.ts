import { INTERNAL_TASK_ACTION_IDS } from './internalTaskActionIdsV1.js';
export { INTERNAL_TASK_ACTION_IDS } from './internalTaskActionIdsV1.js';
import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { TodoClaimMutationV1ProtocolSchema, TodoCreateInputV1Schema, TodoItemPatchV1Schema, TodoItemV1Schema,
  TodoReadinessReasonV1ProtocolSchema, TodoReadinessV1ProtocolSchema, TodoStateV1Schema } from '../todos/todoSessionLinkV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { ResourceAccessLevelV1Schema, ResourceCallerAccessV1Schema } from '../teams/resourceGrantAccessV1.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { TaskResourceUnavailableV1Schema, TaskResourceV1Schema, TaskAccessGrantRowV1Schema, TaskResourceAddressV1Schema, TaskResourceSelectionV1Schema } from '../todos/taskResourceV1.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { TodoLabelColorV1Schema, TodoLabelColorTokenV1Schema } from '../todos/todoLabelColoursV1.js';
import { PlanOutputTasksV1Schema } from '../messages/structured/planOutputV1.js';
import { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
export * from '../todos/taskResourceV1.js';

export const InternalTaskActionIdSchema = lazyZodSchema(() => z.enum(INTERNAL_TASK_ACTION_IDS));
export type InternalTaskActionId = z.infer<typeof InternalTaskActionIdSchema>;
export const InternalTaskScopeSchema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) }));
export const InternalTaskSnapshotSchema = lazyZodSchema(() => z.extend(z.omit(TodoItemV1Schema, { settledClaim: true }), { state: TodoStateV1Schema,
  version: z.optional(TaskResourceV1Schema.shape.version),
  readiness: z.optional(asProtocolZod(TodoReadinessV1ProtocolSchema)),
  ownerAccountId: z.optional(z.string().check(z.minLength(1))), access: z.optional(ResourceCallerAccessV1Schema),
  ownerDisplayName: TaskResourceV1Schema.shape.ownerDisplayName,
  labelColors: z.optional(z.array(TodoLabelColorV1Schema)) }));
const taskAddress = { taskId: z.string().check(z.minLength(1)), ownerAccountId: z.optional(z.string().check(z.minLength(1))) };
const expectedVersion = z.optional(TaskResourceV1Schema.shape.version);
export const InternalTaskListInputSchema = lazyZodSchema(() => z.strictObject({
  selection: z.optional(TaskResourceSelectionV1Schema),
  parent: z.optional(TaskResourceAddressV1Schema),
  state: z.optional(TodoStateV1Schema),
  owner: z.optional(z.string().check(z.minLength(1))),
  label: z.optional(z.string().check(z.minLength(1))),
  ready: z.optional(z.boolean()),
}));
export const InternalTaskLabelClearColorInputSchema = lazyZodSchema(() => z.strictObject({
  scope: InternalTaskScopeSchema, name: z.string().check(z.minLength(1)),
}));
export const InternalTaskLabelSetColorInputSchema = lazyZodSchema(() => z.extend(InternalTaskLabelClearColorInputSchema, {
  colorToken: TodoLabelColorTokenV1Schema,
}));
const taskParent = z.union([z.string().check(z.minLength(1)), asProtocolZod(TriageEntryRefV1Schema)]);
const singleTaskCreate = lazyZodSchema(() => z.strictObject({ fields: z.extend(z.omit(TodoCreateInputV1Schema, { id: true }), {
  parentId: z.optional(taskParent),
}) }));
export const InternalTaskPlanCreateInputSchema = lazyZodSchema(() => z.strictObject({ plan: z.strictObject({
  source: z.strictObject({ kind: z.enum(['plan_run', 'native_exit_plan']), id: z.string().check(z.minLength(1)) }),
  sessionId: z.string().check(z.minLength(1)),
  tasks: PlanOutputTasksV1Schema,
  approvalProfileId: z.optional(ApprovalProfileIdV1Schema),
}) }));
export const InternalTaskCreateInputSchema = lazyZodSchema(() => z.union([singleTaskCreate, InternalTaskPlanCreateInputSchema]));
export const InternalTaskEditInputSchema = lazyZodSchema(() => z.strictObject({ scope: z.optional(InternalTaskScopeSchema), ...taskAddress,
  expectedVersion, fields: z.extend(TodoItemPatchV1Schema, { parentId: z.optional(z.nullable(taskParent)) }) }));
export const InternalTaskTransitionInputSchema = lazyZodSchema(() => z.strictObject({ scope: z.optional(InternalTaskScopeSchema), ...taskAddress,
  expectedVersion, state: TodoStateV1Schema, claim: z.optional(asProtocolZod(TodoClaimMutationV1ProtocolSchema)) }));
export const InternalTaskDeleteInputSchema = lazyZodSchema(() => z.strictObject({ scope: z.optional(InternalTaskScopeSchema), ...taskAddress }));
export const InternalTaskReadInputSchema = lazyZodSchema(() => z.strictObject(taskAddress));
export const InternalTaskShareInputSchema = lazyZodSchema(() => z.strictObject({ scope: InternalTaskScopeSchema, ...taskAddress,
  principal: PrincipalRefV1Schema, accessLevel: ResourceAccessLevelV1Schema }));
export const InternalTaskUnshareInputSchema = lazyZodSchema(() => z.strictObject({ scope: InternalTaskScopeSchema, ...taskAddress, principal: PrincipalRefV1Schema }));
export const InternalTaskGrantsInputSchema = InternalTaskReadInputSchema;
export const InternalTaskPrepareInputSchema = lazyZodSchema(() => z.strictObject({ scope: InternalTaskScopeSchema, ...taskAddress }));
const unavailable = z.strictObject({ status: z.literal('unavailable') });
const failed = z.strictObject({ status: z.literal('failed'), reason: z.string() });
const refused = z.strictObject({ status: z.literal('refused'), reason: z.string() });
export const InternalTaskListOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), scope: InternalTaskScopeSchema, todos: z.array(InternalTaskSnapshotSchema), undoneOrder: z.array(z.string()), completedOrder: z.array(z.string()),
    unavailableTasks: z.optional(z.array(TaskResourceUnavailableV1Schema)), labelCatalog: z.optional(z.array(TodoLabelColorV1Schema)),
    notReadyTasks: z.optional(z.array(z.extend(TaskResourceAddressV1Schema, { reason: asProtocolZod(TodoReadinessReasonV1ProtocolSchema) }))) }),
  unavailable, failed, refused,
]));
export const InternalTaskMutationOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, todo: InternalTaskSnapshotSchema }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export const InternalTaskPlanCreateAppliedSchema = lazyZodSchema(() => z.strictObject({
  status: z.literal('plan_applied'), scope: InternalTaskScopeSchema,
  tasks: z.array(z.strictObject({ planTaskId: z.string().check(z.minLength(1)), taskId: taskAddress.taskId })),
}));
export const InternalTaskCreateOutputSchema = lazyZodSchema(() => z.union([InternalTaskMutationOutputSchema, InternalTaskPlanCreateAppliedSchema]));
export type InternalTaskListOutput = z.infer<typeof InternalTaskListOutputSchema>;
export type InternalTaskMutationOutput = z.infer<typeof InternalTaskMutationOutputSchema>;
export type InternalTaskScope = z.infer<typeof InternalTaskScopeSchema>;
export const InternalTaskReadOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, todo: InternalTaskSnapshotSchema }), unavailable, failed, refused,
]));
export const InternalTaskAccessOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('access'), ownerAccountId: z.string(), taskId: z.string(), access: z.nullable(ResourceCallerAccessV1Schema),
    grants: z.array(TaskAccessGrantRowV1Schema), ownerDisplayName: TaskResourceV1Schema.shape.ownerDisplayName }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export const InternalTaskPrepareOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('prepared'), appliedRecipientAccountIds: z.array(z.string()), skippedRecipientAccountIds: z.array(z.string()) }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export type InternalTaskReadOutput = z.infer<typeof InternalTaskReadOutputSchema>;
export type InternalTaskAccessOutput = z.infer<typeof InternalTaskAccessOutputSchema>;
export type InternalTaskPrepareOutput = z.infer<typeof InternalTaskPrepareOutputSchema>;
export const InternalTaskDeleteOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('deleted'), scope: InternalTaskScopeSchema, taskId: z.string().check(z.minLength(1)) }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export const InternalTaskLabelColorOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, labelCatalog: z.array(TodoLabelColorV1Schema) }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export type InternalTaskActionOutput = InternalTaskListOutput | z.infer<typeof InternalTaskCreateOutputSchema> | InternalTaskReadOutput | InternalTaskAccessOutput | InternalTaskPrepareOutput
  | z.infer<typeof InternalTaskDeleteOutputSchema>
  | z.infer<typeof InternalTaskLabelColorOutputSchema>;
const shared = { safety: 'safe', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  originalExecution: { accountRoot: 'allowed' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false } } as const;
function createInternalTaskActionSpecs() {
  return [
  { ...shared, id: 'tasks.internal.labels.setColor', title: 'Set personal task label colour', description: 'Choose a theme colour for this Account’s task label without changing task records.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskLabelSetColorInputSchema, outputSchema: InternalTaskLabelColorOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_labels_set_color' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'labels', 'set-color'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.labels.clearColor', title: 'Clear personal task label colour', description: 'Return this Account’s task label to the neutral theme colour.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskLabelClearColorInputSchema, outputSchema: InternalTaskLabelColorOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_labels_clear_color' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'labels', 'clear-color'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.read', title: 'Read Happier task', description: 'Read one owner-qualified task through its resource authority.',
    sideEffectClass: 'read', approval: { result: 'none' }, inputSchema: InternalTaskReadInputSchema, outputSchema: InternalTaskReadOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_read' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'read'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.share', title: 'Share Happier task', description: 'Grant explicit task access, including notes, links and stored linked Session titles. Sharing grants no access to the linked resources.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskShareInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_share' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'share'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.unshare', title: 'Revoke Happier task access', description: 'Remove an explicit task grant; withdrawal takes effect at the next request.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskUnshareInputSchema, outputSchema: InternalTaskAccessOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_unshare' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'unshare'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.grants', title: 'Read Happier task access', description: 'Read the admitted task grant roster.',
    sideEffectClass: 'read', approval: { result: 'none' }, inputSchema: InternalTaskGrantsInputSchema, outputSchema: InternalTaskAccessOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_grants' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'grants'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.prepare', title: 'Prepare Happier task recipient keys', description: 'Prepare encrypted task keys for currently admitted recipients through verified Account bindings.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskPrepareInputSchema, outputSchema: InternalTaskPrepareOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_prepare' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'prepare'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.list', title: 'List Happier tasks', description: 'Read personal and explicitly shared task records, with private personal ordering.',
    sideEffectClass: 'read', approval: { result: 'none' }, inputSchema: InternalTaskListInputSchema, outputSchema: InternalTaskListOutputSchema,
    inputHints: { fields: [
      { path: 'state', title: 'State', widget: 'text' },
      { path: 'owner', title: 'Assignee', widget: 'text' },
      { path: 'label', title: 'Label', widget: 'text' },
      { path: 'ready', title: 'Ready', widget: 'boolean' },
    ] },
    bindings: { mcpToolName: 'tasks_internal_list' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'list'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.create', title: 'Create personal Happier task', description: 'Create a task or adopt a structured plan’s task graph in the authenticated Account.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskCreateInputSchema, outputSchema: InternalTaskCreateOutputSchema,
    inputHints: { fields: [
      { path: 'fields', title: 'Task fields', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_create' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'create'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.edit', title: 'Edit Happier task', description: 'Apply supported fields to the addressed task, preserving concurrent fields and Session links.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskEditInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json' },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'expectedVersion', title: 'Task revision', widget: 'number' },
      { path: 'fields', title: 'Fields to change', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_edit' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'edit'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.transition', title: 'Change Happier task state', description: 'Apply the task state through its canonical completion and personal ordering owner.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskTransitionInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json' },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'expectedVersion', title: 'Task revision', widget: 'number' },
      { path: 'state', title: 'State', widget: 'select', required: true, options: [{ value: 'backlog', label: 'Backlog' }, { value: 'unstarted', label: 'Unstarted' }, { value: 'started', label: 'Started' }, { value: 'ready_for_review', label: 'Ready for review' }, { value: 'completed', label: 'Completed' }, { value: 'canceled', label: 'Canceled' }] },
      { path: 'claim', title: 'Claim operation', widget: 'json' },
    ] },
    bindings: { mcpToolName: 'tasks_internal_transition' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'transition'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.delete', title: 'Delete Happier task', description: 'Delete a task you own and retire its sharing grants.',
    safety: 'danger', sideEffectClass: 'write', approval: { result: 'required' },
    inputSchema: InternalTaskDeleteInputSchema, outputSchema: InternalTaskDeleteOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_delete' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'delete'], visibility: 'canonical' }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const INTERNAL_TASK_ACTION_SPECS: ReturnType<typeof createInternalTaskActionSpecs> = lazyActionSpecArray(createInternalTaskActionSpecs);
