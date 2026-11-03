import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { TodoCreateInputV1Schema, TodoItemPatchV1Schema, TodoItemV1Schema, TodoStateV1Schema } from '../todos/todoSessionLinkV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { TodoLabelColorV1Schema, TodoLabelColorTokenV1Schema } from '../todos/todoLabelColoursV1.js';

export const INTERNAL_TASK_ACTION_IDS = ['tasks.internal.list', 'tasks.internal.create', 'tasks.internal.edit', 'tasks.internal.transition',
  'tasks.internal.labels.setColor', 'tasks.internal.labels.clearColor'] as const;
export type InternalTaskActionId = typeof INTERNAL_TASK_ACTION_IDS[number];
export const InternalTaskScopeSchema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) }));
export const InternalTaskSnapshotSchema = lazyZodSchema(() => z.extend(TodoItemV1Schema, { state: TodoStateV1Schema,
  labelColors: z.optional(z.array(TodoLabelColorV1Schema)) }));
export const InternalTaskListInputSchema = lazyZodSchema(() => z.strictObject({}));
export const InternalTaskLabelClearColorInputSchema = lazyZodSchema(() => z.strictObject({
  scope: InternalTaskScopeSchema, name: z.string().check(z.minLength(1)),
}));
export const InternalTaskLabelSetColorInputSchema = lazyZodSchema(() => z.extend(InternalTaskLabelClearColorInputSchema, {
  colorToken: TodoLabelColorTokenV1Schema,
}));
export const InternalTaskCreateInputSchema = lazyZodSchema(() => z.strictObject({ fields: z.omit(TodoCreateInputV1Schema, { id: true }) }));
export const InternalTaskEditInputSchema = lazyZodSchema(() => z.strictObject({ scope: InternalTaskScopeSchema, taskId: z.string().check(z.minLength(1)), fields: TodoItemPatchV1Schema }));
export const InternalTaskTransitionInputSchema = lazyZodSchema(() => z.strictObject({ scope: InternalTaskScopeSchema, taskId: z.string().check(z.minLength(1)), state: TodoStateV1Schema }));
const unavailable = z.strictObject({ status: z.literal('unavailable') });
const failed = z.strictObject({ status: z.literal('failed'), reason: z.string() });
const refused = z.strictObject({ status: z.literal('refused'), reason: z.string() });
export const InternalTaskListOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), scope: InternalTaskScopeSchema, todos: z.array(InternalTaskSnapshotSchema), undoneOrder: z.array(z.string()), completedOrder: z.array(z.string()),
    labelCatalog: z.optional(z.array(TodoLabelColorV1Schema)) }),
  unavailable, failed, refused,
]));
export const InternalTaskMutationOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), todo: InternalTaskSnapshotSchema }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export type InternalTaskListOutput = z.infer<typeof InternalTaskListOutputSchema>;
export type InternalTaskMutationOutput = z.infer<typeof InternalTaskMutationOutputSchema>;
export type InternalTaskScope = z.infer<typeof InternalTaskScopeSchema>;
export const InternalTaskLabelColorOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), scope: InternalTaskScopeSchema, labelCatalog: z.array(TodoLabelColorV1Schema) }),
  unavailable, failed, refused, z.strictObject({ status: z.literal('uncertain'), reason: z.string() }),
]));
export type InternalTaskActionOutput = InternalTaskListOutput | InternalTaskMutationOutput
  | z.infer<typeof InternalTaskLabelColorOutputSchema>;
const shared = { safety: 'safe', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  originalExecution: { accountRoot: 'allowed' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false } } as const;
export const INTERNAL_TASK_ACTION_SPECS = [
  { ...shared, id: 'tasks.internal.labels.setColor', title: 'Set personal task label colour', description: 'Choose a theme colour for this Account’s task label without changing task records.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskLabelSetColorInputSchema, outputSchema: InternalTaskLabelColorOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_labels_set_color' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'labels', 'set-color'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.labels.clearColor', title: 'Clear personal task label colour', description: 'Return this Account’s task label to the neutral theme colour.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskLabelClearColorInputSchema, outputSchema: InternalTaskLabelColorOutputSchema,
    bindings: { mcpToolName: 'tasks_internal_labels_clear_color' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'labels', 'clear-color'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.list', title: 'List personal Happier tasks', description: 'Read the authenticated Account task records and current ordering.',
    sideEffectClass: 'read', approval: { result: 'none' }, inputSchema: InternalTaskListInputSchema, outputSchema: InternalTaskListOutputSchema,
    inputHints: { fields: [] },
    bindings: { mcpToolName: 'tasks_internal_list' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'list'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.create', title: 'Create personal Happier task', description: 'Create one task in the authenticated Account. An uncertain result must not be replayed blindly.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskCreateInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'fields', title: 'Task fields', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_create' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'create'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.edit', title: 'Edit personal Happier task', description: 'Apply supported fields to the current task, preserving concurrent fields and Session links.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskEditInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json', required: true },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'fields', title: 'Fields to change', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'tasks_internal_edit' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'edit'], visibility: 'canonical' }] } },
  { ...shared, id: 'tasks.internal.transition', title: 'Change personal Happier task state', description: 'Apply the task state through its canonical completion and ordering owner.',
    sideEffectClass: 'write', approval: { result: 'required' }, inputSchema: InternalTaskTransitionInputSchema, outputSchema: InternalTaskMutationOutputSchema,
    inputHints: { fields: [
      { path: 'scope', title: 'Task Home and Account', widget: 'json', required: true },
      { path: 'taskId', title: 'Task', widget: 'text', required: true },
      { path: 'state', title: 'State', widget: 'select', required: true, options: [{ value: 'backlog', label: 'Backlog' }, { value: 'unstarted', label: 'Unstarted' }, { value: 'started', label: 'Started' }, { value: 'completed', label: 'Completed' }, { value: 'canceled', label: 'Canceled' }] },
    ] },
    bindings: { mcpToolName: 'tasks_internal_transition' }, cli: { acceptsServerId: true, commands: [{ path: ['tasks', 'internal', 'transition'], visibility: 'canonical' }] } },
] as const satisfies readonly PreNormalizedActionSpec[];

export const InternalTaskActionIdSchema = lazyZodSchema(() => z.enum(INTERNAL_TASK_ACTION_IDS));
