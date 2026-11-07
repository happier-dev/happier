import { INTERNAL_TASK_ACTION_IDS } from './internalTaskActionIdsV1.js';
export { INTERNAL_TASK_ACTION_IDS } from './internalTaskActionIdsV1.js';
import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { TodoCreateInputV1Schema, TodoItemPatchV1Schema, TodoItemV1Schema, TodoStateV1Schema } from '../todos/todoSessionLinkV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { ResourceAccessLevelV1Schema, ResourceCallerAccessV1Schema } from '../teams/resourceGrantAccessV1.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { TaskResourceUnavailableV1Schema, TaskResourceV1Schema, TaskAccessGrantRowV1Schema } from '../todos/taskResourceV1.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { TodoLabelColorV1Schema, TodoLabelColorTokenV1Schema } from '../todos/todoLabelColoursV1.js';
export * from '../todos/taskResourceV1.js';

export const InternalTaskActionIdSchema = lazyZodSchema(() => z.enum(INTERNAL_TASK_ACTION_IDS));
export type InternalTaskActionId = z.infer<typeof InternalTaskActionIdSchema>;
export const InternalTaskScopeSchema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) }));
export const InternalTaskSnapshotSchema = lazyZodSchema(() => z.extend(TodoItemV1Schema, { state: TodoStateV1Schema,
  ownerAccountId: z.optional(z.string().check(z.minLength(1))), access: z.optional(ResourceCallerAccessV1Schema),
  ownerDisplayName: TaskResourceV1Schema.shape.ownerDisplayName,
  labelColors: z.optional(z.array(TodoLabelColorV1Schema)) }));
const taskAddress = { taskId: z.string().check(z.minLength(1)), ownerAccountId: z.optional(z.string().check(z.minLength(1))) };
export const InternalTaskListInputSchema = lazyZodSchema(() => z.strictObject({}));
export const InternalTaskLabelClearColorInputSchema = lazyZodSchema(() => z.strictObject({
  scope: InternalTaskScopeSchema, name: z.string().check(z.minLength(1)),
}));
export const InternalTaskLabelSetColorInputSchema = lazyZodSchema(() => z.extend(InternalTaskLabelClearColorInputSchema, {
  colorToken: TodoLabelColorTokenV1Schema,
}));
const taskParent = z.union([z.string().check(z.minLength(1)), asProtocolZod(TriageEntryRefV1Schema)]);
export const InternalTaskCreateInputSchema = lazyZodSchema(() => z.strictObject({ fields: z.extend(z.omit(TodoCreateInputV1Schema, { id: true }), {
  parentId: z.optional(taskParent),
}) }));
export const InternalTaskEditInputSchema = lazyZodSchema(() => z.strictObject({ scope: z.optional(InternalTaskScopeSchema), ...taskAddress,
  fields: z.extend(TodoItemPatchV1Schema, { parentId: z.optional(z.nullable(taskParent)) }) }));
export const InternalTaskTransitionInputSchema = lazyZodSchema(() => z.strictObject({ scope: z.optional(InternalTaskScopeSchema), ...taskAddress, state: TodoStateV1Schema }));
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
    unavailableTasks: z.optional(z.array(TaskResourceUnavailableV1Schema)), labelCatalog: z.optional(z.array(TodoLabelColorV1Schema)) }),
  unavailable, failed, refused,
]));
export const InternalTaskMutationOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, todo: InternalTaskSnapshotSchema }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
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
export const InternalTaskLabelColorOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, labelCatalog: z.array(TodoLabelColorV1Schema) }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export type InternalTaskActionOutput = InternalTaskListOutput | InternalTaskMutationOutput | InternalTaskReadOutput | InternalTaskAccessOutput | InternalTaskPrepareOutput
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
    inputHints: { fields: [] },
    bindings: { mcpToolName: 'tasks_internal_list' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'list'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.create', title: 'Create personal Happier task', description: 'Create one task in the authenticated Account. An uncertain result must not be replayed blindly.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskCreateInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'fields', title: 'Task fields', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_create' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'create'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.edit', title: 'Edit Happier task', description: 'Apply supported fields to the addressed task, preserving concurrent fields and Session links.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskEditInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json' },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'fields', title: 'Fields to change', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_edit' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'edit'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.transition', title: 'Change Happier task state', description: 'Apply the task state through its canonical completion and personal ordering owner.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskTransitionInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json' },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'state', title: 'State', widget: 'select', required: true, options: [{ value: 'backlog', label: 'Backlog' }, { value: 'unstarted', label: 'Unstarted' }, { value: 'started', label: 'Started' }, { value: 'completed', label: 'Completed' }, { value: 'canceled', label: 'Canceled' }] },
    ] },
    bindings: { mcpToolName: 'tasks_internal_transition' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'transition'], visibility: 'canonical' }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const INTERNAL_TASK_ACTION_SPECS: ReturnType<typeof createInternalTaskActionSpecs> = lazyActionSpecArray(createInternalTaskActionSpecs);
