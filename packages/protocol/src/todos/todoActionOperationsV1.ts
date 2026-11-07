import { createTodoItemV1, updateTodoItemV1, transitionTodoItemV1, resolveTodoStateV1, TodoItemV1StoredSchema, TodoIndexV1StoredSchema, type TodoItemV1, type TodoIndexV1 } from './todoSessionLinkV1.js';
import { resolveAnchoredListMoveV1 } from '../actions/anchoredListOrderV1.js';
import { TodoReorderInputV1Schema, type ListReorderOutputV1 } from '../actions/listReorderAction.js';
import { InternalTaskCreateInputSchema, InternalTaskEditInputSchema, InternalTaskTransitionInputSchema,
  InternalTaskReadInputSchema, InternalTaskShareInputSchema, InternalTaskUnshareInputSchema, InternalTaskGrantsInputSchema, InternalTaskPrepareInputSchema,
  InternalTaskLabelSetColorInputSchema, InternalTaskLabelClearColorInputSchema,
  type InternalTaskActionId, type InternalTaskActionOutput, type InternalTaskScope } from '../actions/internalTaskActions.js';
import { createTaskResourceClientV1, TaskResourceClientErrorV1, type TaskResourceClientOptionsV1, type OpenedTaskResourceV1 } from './taskResourceClientV1.js';
import { internalTaskLocalRefV1, internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '../tasks/entryRefV1.js';
import { TODO_LABEL_CATALOG_KEY_V1, TodoLabelCatalogV1StoredSchema, projectTodoLabelColorsV1 } from './todoLabelColoursV1.js';
export * from './taskResourceClientV1.js';

export type AccountJsonKvRow = Readonly<{ key: string; value: unknown; version: number }>;
export type AccountJsonKvMutation = Readonly<{ key: string; value: unknown; version: number }>;
/** Host-owned Account-mode admission surrounds this opaque JSON transport. */
export type AccountJsonKvCollectionPort = Readonly<{
  read: (key: string) => Promise<Readonly<{ value: unknown; version: number }>>;
  list: (prefix: string) => Promise<readonly AccountJsonKvRow[]>;
  mutate: (mutations: readonly AccountJsonKvMutation[]) => Promise<
    | Readonly<{ success: true; results: readonly Readonly<{ key: string; version: number }>[] }>
    | Readonly<{ success: false; errors: readonly AccountJsonKvRow[] }>>;
}>;
const indexSchema = TodoIndexV1StoredSchema;
const project = (todo: TodoItemV1) => ({ ...todo, state: resolveTodoStateV1(todo) });
const projectResource = (task: OpenedTaskResourceV1) => ({ ...project(task.todo), ownerAccountId: task.resource.ownerAccountId, access: task.resource.access,
  ...(task.resource.ownerDisplayName === undefined ? {} : { ownerDisplayName: task.resource.ownerDisplayName }) });
/** Resource state may advance independently of the owner's private presentation order. */
export function resolveTodoIndexForItemsV1(todos: readonly TodoItemV1[], index: TodoIndexV1): TodoIndexV1 {
  const items = new Map(todos.map(todo => [todo.id, todo]));
  const undoneOrder = index.undoneOrder.filter(id => items.get(id)?.done === false);
  const completedOrder = index.completedOrder.filter(id => items.get(id)?.done === true);
  const ordered = new Set([...undoneOrder, ...completedOrder]);
  const completed: TodoItemV1[] = [];
  for (const todo of todos) if (!ordered.has(todo.id)) {
    if (todo.done) completed.push(todo); else undoneOrder.push(todo.id);
  }
  return { undoneOrder, completedOrder: [...completed.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)).map(todo => todo.id), ...completedOrder] };
}
const parseTodo = (id: string, value: unknown) => {
  const todo = TodoItemV1StoredSchema.parse(value);
  if (todo.id !== id) throw new Error('task_content_invalid');
  return todo;
};
function failureReason(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'task_storage_unavailable';
}
function taskParentId(parent: string | TriageEntryRefV1 | undefined, ownerAccountId: string, viewerAccountId: string): string | undefined;
function taskParentId(parent: string | TriageEntryRefV1 | null | undefined, ownerAccountId: string, viewerAccountId: string): string | null | undefined;
function taskParentId(parent: string | TriageEntryRefV1 | null | undefined, ownerAccountId: string, viewerAccountId: string): string | null | undefined {
  if (typeof parent !== 'object' || parent === null) return parent;
  if (!isInternalTaskReferenceV1(parent) || internalTaskOwnerAccountIdV1(parent, viewerAccountId) !== ownerAccountId) {
    throw new TaskResourceClientErrorV1('unsupportedField');
  }
  return parent.entryId;
}
function taskBlockers(blockers: TodoItemV1['blockedBy'], ownerAccountId: string, viewerAccountId: string): TodoItemV1['blockedBy'];
function taskBlockers(blockers: TodoItemV1['blockedBy'] | null, ownerAccountId: string, viewerAccountId: string): TodoItemV1['blockedBy'] | null;
function taskBlockers(blockers: TodoItemV1['blockedBy'] | null, ownerAccountId: string, viewerAccountId: string): TodoItemV1['blockedBy'] | null {
  return blockers?.map(ref => {
    if (typeof ref === 'string' || !isInternalTaskReferenceV1(ref)) return ref;
    const blockerOwner = internalTaskOwnerAccountIdV1(ref, viewerAccountId)!;
    return blockerOwner === ownerAccountId ? ref.entryId : { ...ref, ...internalTaskLocalRefV1(ref.entryId, blockerOwner) };
  }) ?? blockers;
}
export async function executeInternalTaskAction(args: Readonly<{
  actionId: InternalTaskActionId; input: unknown; scope: InternalTaskScope; port: AccountJsonKvCollectionPort;
  requireCurrent: () => void; createId: () => string; resources?: TaskResourceClientOptionsV1;
}>): Promise<InternalTaskActionOutput> {
  let writing = false;
  try {
    args.requireCurrent();
    const resources = args.resources ? createTaskResourceClientV1(args.resources) : null;
    const readLabelCatalog = async () => {
      const row = await args.port.read(TODO_LABEL_CATALOG_KEY_V1);
      args.requireCurrent();
      return { ...row, value: row.value === null ? { v: 1 as const, colors: {} } : TodoLabelCatalogV1StoredSchema.parse(row.value) };
    };
    if (args.actionId === 'tasks.internal.labels.setColor' || args.actionId === 'tasks.internal.labels.clearColor') {
      const set = args.actionId === 'tasks.internal.labels.setColor' ? InternalTaskLabelSetColorInputSchema.parse(args.input) : null;
      const input = set ?? InternalTaskLabelClearColorInputSchema.parse(args.input);
      if (input.scope.serverId !== args.scope.serverId || input.scope.accountId !== args.scope.accountId) return { status: 'refused', reason: 'task_scope_mismatch' };
      const current = await readLabelCatalog();
      const colors = set ? { ...current.value.colors, [set.name]: set.colorToken } : { ...current.value.colors };
      if (!set) delete colors[input.name];
      writing = true;
      const result = await args.port.mutate([{ key: TODO_LABEL_CATALOG_KEY_V1, value: { v: 1, colors }, version: current.version }]);
      writing = false;
      if (!result.success) return { status: 'refused', reason: 'task_conflict' };
      if (!result.results.some(row => row.key === TODO_LABEL_CATALOG_KEY_V1)) return { status: 'uncertain', reason: 'task_receipt_incomplete' };
      return { status: 'applied', scope: args.scope, labelCatalog: projectTodoLabelColorsV1(Object.keys(colors), { v: 1, colors }) };
    }
    if (args.actionId === 'tasks.internal.list') {
      const catalog = (await readLabelCatalog()).value;
      const labelCatalog = projectTodoLabelColorsV1(Object.keys(catalog.colors), catalog);
      const withColors = <T extends TodoItemV1>(todo: T) => ({ ...todo, labelColors: projectTodoLabelColorsV1(todo.labels ?? [], catalog) });
      if (resources) {
        try {
          const result = await resources.list();
          const indexRow = await args.port.read('todo.index');
          args.requireCurrent();
          const index = indexRow.value === null ? { undoneOrder: [], completedOrder: [] } : indexSchema.parse(indexRow.value);
          const { undoneOrder, completedOrder } = resolveTodoIndexForItemsV1(result.tasks.filter(task => task.resource.ownerAccountId === args.scope.accountId).map(task => task.todo), index);
          return { status: 'ok', scope: args.scope, todos: result.tasks.map(task => withColors(projectResource(task))), undoneOrder, completedOrder, labelCatalog,
            ...(result.unavailableTasks.length ? { unavailableTasks: result.unavailableTasks } : {}) };
        } catch (error) { if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error; }
      }
      const rows = await args.port.list('todo.');
      args.requireCurrent();
      const todos = rows.filter(row => row.key !== 'todo.index').map(row => project(parseTodo(row.key.slice(5), row.value)));
      const indexRow = rows.find(row => row.key === 'todo.index');
      const index = indexRow ? indexSchema.parse(indexRow.value) : { undoneOrder: [], completedOrder: [] };
      const { undoneOrder, completedOrder } = resolveTodoIndexForItemsV1(todos, index);
      return { status: 'ok', scope: args.scope, todos: todos.map(withColors), undoneOrder, completedOrder, labelCatalog };
    }
    const create = args.actionId === 'tasks.internal.create' ? InternalTaskCreateInputSchema.parse(args.input) : null;
    const edit = args.actionId === 'tasks.internal.edit' ? InternalTaskEditInputSchema.parse(args.input) : null;
    const transition = args.actionId === 'tasks.internal.transition' ? InternalTaskTransitionInputSchema.parse(args.input) : null;
    const read = args.actionId === 'tasks.internal.read' ? InternalTaskReadInputSchema.parse(args.input) : null;
    const share = args.actionId === 'tasks.internal.share' ? InternalTaskShareInputSchema.parse(args.input) : null;
    const unshare = args.actionId === 'tasks.internal.unshare' ? InternalTaskUnshareInputSchema.parse(args.input) : null;
    const grants = args.actionId === 'tasks.internal.grants' ? InternalTaskGrantsInputSchema.parse(args.input) : null;
    const prepare = args.actionId === 'tasks.internal.prepare' ? InternalTaskPrepareInputSchema.parse(args.input) : null;
    const addressed = edit ?? transition ?? read ?? share ?? unshare ?? grants ?? prepare;
    const scoped = edit ?? transition ?? share ?? unshare ?? prepare;
    if (scoped?.scope && (scoped.scope.serverId !== args.scope.serverId || scoped.scope.accountId !== args.scope.accountId)) return { status: 'refused', reason: 'task_scope_mismatch' };
    const taskId = addressed?.taskId ?? args.createId();
    if (taskId === 'index') return { status: 'refused', reason: 'invalid_task_id' };
    const key = `todo.${taskId}`;
    const ownerAccountId = addressed?.ownerAccountId ?? args.scope.accountId;
    const createFields = create ? { ...create.fields,
      parentId: taskParentId(create.fields.parentId, args.scope.accountId, args.scope.accountId),
      blockedBy: taskBlockers(create.fields.blockedBy, args.scope.accountId, args.scope.accountId) } : null;
    const editFields = edit ? { ...edit.fields, parentId: taskParentId(edit.fields.parentId, ownerAccountId, args.scope.accountId),
      blockedBy: taskBlockers(edit.fields.blockedBy, ownerAccountId, args.scope.accountId) } : null;
    if (addressed && resources) {
      const address = { ownerAccountId: addressed.ownerAccountId ?? args.scope.accountId, taskId };
      try {
        if (grants) return { status: 'access', ...await resources.grants(address) };
        if (unshare) { writing = true; const result = await resources.unshare(address, unshare.principal); writing = false; return { status: 'access', ...result }; }
        if (prepare) { writing = true; const result = await resources.prepare(address); writing = false; return { status: 'prepared', ...result }; }
        if (share) { writing = true; const result = await resources.share(address, share.principal, share.accessLevel); writing = false; return { status: 'applied', scope: args.scope, todo: projectResource(result) }; }
        const current = await resources.read(address);
        if (read) return { status: 'applied', scope: args.scope, todo: { ...projectResource(current),
          labelColors: projectTodoLabelColorsV1(current.todo.labels ?? [], (await readLabelCatalog()).value) } };
        // Only the owner's unpromoted row retains the existing atomic task+private-index writer.
        if (current.resource.ownerAccountId !== args.scope.accountId || current.dataKey) {
          const todo = editFields ? updateTodoItemV1(current.todo, editFields, Date.now()) : transitionTodoItemV1(current.todo, transition!.state, Date.now());
          writing = true; const result = await resources.save(current, todo); writing = false;
          return { status: 'applied', scope: args.scope, todo: projectResource(result) };
        }
      } catch (error) {
        if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error;
        writing = false;
        if (address.ownerAccountId !== args.scope.accountId || share || unshare || grants || prepare) return { status: 'refused', reason: 'task_resource_unsupported' };
      }
    } else if (addressed && addressed.ownerAccountId && addressed.ownerAccountId !== args.scope.accountId) return { status: 'refused', reason: 'task_resource_unsupported' };
    if (share || unshare || grants || prepare) return { status: 'refused', reason: 'task_resource_unsupported' };
    if (read) {
      const row = await args.port.read(key); args.requireCurrent();
      if (row.value === null) return { status: 'refused', reason: 'task_deleted' };
      const todo = project(parseTodo(taskId, row.value));
      return { status: 'applied', scope: args.scope, todo: { ...todo,
        labelColors: projectTodoLabelColorsV1(todo.labels ?? [], (await readLabelCatalog()).value) } };
    }
    // A known CAS conflict is refused; a lost response exits uncertain.
    const created = createFields ? createTodoItemV1({ ...createFields, id: taskId }, Date.now()) : null;
    args.requireCurrent();
    const [row, indexRow] = await Promise.all([
      args.port.read(key),
      created || transition ? args.port.read('todo.index') : Promise.resolve(null),
    ]);
    args.requireCurrent();
    if (created && row.value !== null) return { status: 'refused', reason: 'task_already_exists' };
    if (!created && row.value === null) return { status: 'refused', reason: 'task_deleted' };
    const existing = row.value === null ? null : parseTodo(taskId, row.value);
    const todo = created ?? (editFields ? updateTodoItemV1(existing!, editFields, Date.now()) : transitionTodoItemV1(existing!, transition!.state, Date.now()));
    const mutations: AccountJsonKvMutation[] = [{ key, value: todo, version: row.version }];
    if (indexRow !== null) {
      const index = indexRow.value === null ? { undoneOrder: [], completedOrder: [] } : indexSchema.parse(indexRow.value);
      let undoneOrder = index.undoneOrder;
      let completedOrder = index.completedOrder;
      if (created) undoneOrder = [...undoneOrder, taskId];
      else if (existing!.done !== todo.done) {
        undoneOrder = undoneOrder.filter(id => id !== taskId);
        completedOrder = completedOrder.filter(id => id !== taskId);
        if (todo.done) completedOrder = [taskId, ...completedOrder];
        else undoneOrder = [...undoneOrder, taskId];
      }
      mutations.push({ key: 'todo.index', value: { ...index, undoneOrder, completedOrder }, version: indexRow.version });
    }
    args.requireCurrent();
    writing = true;
    const result = await args.port.mutate(mutations);
    writing = false;
    if (!result.success) return { status: 'refused', reason: 'task_conflict' };
    if (mutations.some(mutation => !result.results.some(row => row.key === mutation.key))) return { status: 'uncertain', reason: 'task_receipt_incomplete' };
    return { status: 'applied', scope: args.scope, todo: project(todo) };
  } catch (error) {
    if (error instanceof TaskResourceClientErrorV1) return { status: error.outcome === 'uncertain' && (args.actionId === 'tasks.internal.list' || args.actionId === 'tasks.internal.read') ? 'failed' : error.outcome, reason: error.code };
    return { status: writing ? 'uncertain' : 'failed', reason: failureReason(error) };
  }
}

export class InternalTaskReorderError extends Error {
  constructor(readonly code: 'todo_reorder_stale' | 'todo_reorder_conflict' | 'todo_reorder_scope_changed') { super(code); }
}
type InternalTaskReorderArgs = Readonly<{
  input: unknown; scope: InternalTaskScope; port: AccountJsonKvCollectionPort; requireCurrent: () => void;
  resources?: TaskResourceClientOptionsV1;
  onApplied?: (undoneOrder: string[], version: number) => void;
}>;
export async function applyInternalTaskReorder(args: InternalTaskReorderArgs): Promise<void> {
    const input = TodoReorderInputV1Schema.parse(args.input);
    if (input.scope.serverId !== args.scope.serverId || input.scope.accountId !== args.scope.accountId) throw new InternalTaskReorderError('todo_reorder_scope_changed');
    args.requireCurrent();
    const row = await args.port.read('todo.index');
    args.requireCurrent();
    if (row.value === null) throw new InternalTaskReorderError('todo_reorder_stale');
    const index = indexSchema.parse(row.value);
    const resources = args.resources ? createTaskResourceClientV1(args.resources) : null;
    const undoneOrder = resolveAnchoredListMoveV1(index.undoneOrder, input.sourceId, input.position);
    if (!undoneOrder) throw new InternalTaskReorderError('todo_reorder_stale');
    for (const id of new Set([input.sourceId, ...(input.position.anchorId === null ? [] : [input.position.anchorId])])) {
      const taskRow = await (async () => {
        if (resources) {
          try { const task = await resources.read({ ownerAccountId: args.scope.accountId, taskId: id }); return { value: task.todo, version: task.resource.version }; }
          catch (error) { if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error; }
        }
        return args.port.read(`todo.${id}`);
      })();
      args.requireCurrent();
      if (taskRow.value === null || parseTodo(id, taskRow.value).done) throw new InternalTaskReorderError('todo_reorder_stale');
    }
    if (undoneOrder.every((id, offset) => id === index.undoneOrder[offset])) return;
    args.requireCurrent();
    const result = await args.port.mutate([{ key: 'todo.index', value: { ...index, undoneOrder }, version: row.version }]);
    if (!result.success) throw new InternalTaskReorderError('todo_reorder_conflict');
    const receipt = result.results.find(row => row.key === 'todo.index');
    if (!receipt) throw new Error('task_receipt_incomplete');
    args.onApplied?.(undoneOrder, receipt.version);
}
export async function executeInternalTaskReorder(args: InternalTaskReorderArgs): Promise<ListReorderOutputV1> {
  let writing = false;
  try {
    await applyInternalTaskReorder({ ...args, port: { ...args.port, mutate: mutations => { writing = true; return args.port.mutate(mutations); } } });
    return { status: 'applied' };
  } catch (error) {
    if (error instanceof InternalTaskReorderError) return { status: 'refused', reason: error.code };
    return { status: writing ? 'unknown' : 'refused', reason: failureReason(error) };
  }
}
