import { createTodoItemV1, updateTodoItemV1, transitionTodoItemV1, resolveTodoStateV1, TodoItemV1StoredSchema, TodoIndexV1StoredSchema, type TodoItemV1 } from './todoSessionLinkV1.js';
import { resolveAnchoredListMoveV1 } from '../actions/anchoredListOrderV1.js';
import { TodoReorderInputV1Schema, type ListReorderOutputV1 } from '../actions/listReorderAction.js';
import { InternalTaskCreateInputSchema, InternalTaskEditInputSchema, InternalTaskTransitionInputSchema,
  InternalTaskLabelSetColorInputSchema, InternalTaskLabelClearColorInputSchema,
  type InternalTaskActionId, type InternalTaskActionOutput, type InternalTaskScope } from '../actions/internalTaskActions.js';
import { TODO_LABEL_CATALOG_KEY_V1, TodoLabelCatalogV1StoredSchema, projectTodoLabelColorsV1 } from './todoLabelColoursV1.js';

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
const parseTodo = (id: string, value: unknown) => {
  const todo = TodoItemV1StoredSchema.parse(value);
  if (todo.id !== id) throw new Error('task_content_invalid');
  return todo;
};
function failureReason(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'task_storage_unavailable';
}
export async function executeInternalTaskAction(args: Readonly<{
  actionId: InternalTaskActionId; input: unknown; scope: InternalTaskScope; port: AccountJsonKvCollectionPort;
  requireCurrent: () => void; createId: () => string;
}>): Promise<InternalTaskActionOutput> {
  let writing = false;
  try {
    args.requireCurrent();
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

      const rows = await args.port.list('todo.');
      args.requireCurrent();
      const todos = rows.filter(row => row.key !== 'todo.index').map(row => project(parseTodo(row.key.slice(5), row.value)));
      const indexRow = rows.find(row => row.key === 'todo.index');
      const index = indexRow ? indexSchema.parse(indexRow.value) : { undoneOrder: [], completedOrder: [] };
      const ids = new Set(todos.map(todo => todo.id));
      const undoneOrder = index.undoneOrder.filter(id => ids.has(id));
      const completedOrder = index.completedOrder.filter(id => ids.has(id));
      const ordered = new Set([...undoneOrder, ...completedOrder]);
      for (const todo of todos) if (!ordered.has(todo.id)) (todo.done ? completedOrder : undoneOrder).push(todo.id);
      return { status: 'ok', scope: args.scope, todos: todos.map(withColors), undoneOrder, completedOrder, labelCatalog };
    }
    const create = args.actionId === 'tasks.internal.create' ? InternalTaskCreateInputSchema.parse(args.input) : null;
    const edit = args.actionId === 'tasks.internal.edit' ? InternalTaskEditInputSchema.parse(args.input) : null;
    const transition = args.actionId === 'tasks.internal.transition' ? InternalTaskTransitionInputSchema.parse(args.input) : null;
    const addressed = edit ?? transition;
    if (addressed && (addressed.scope.serverId !== args.scope.serverId || addressed.scope.accountId !== args.scope.accountId)) return { status: 'refused', reason: 'task_scope_mismatch' };
    const taskId = addressed?.taskId ?? args.createId();
    if (taskId === 'index') return { status: 'refused', reason: 'invalid_task_id' };
    const key = `todo.${taskId}`;
    // A create keeps one generated identity for known CAS conflicts. A lost response exits uncertain.
    const created = create ? createTodoItemV1({ ...create.fields, id: taskId }, Date.now()) : null;
    for (;;) {
      args.requireCurrent();
      const [row, indexRow] = await Promise.all([
        args.port.read(key),
        created || transition ? args.port.read('todo.index') : Promise.resolve(null),
      ]);
      args.requireCurrent();
      if (created && row.value !== null) return { status: 'refused', reason: 'task_already_exists' };
      if (!created && row.value === null) return { status: 'refused', reason: 'task_deleted' };
      const existing = row.value === null ? null : parseTodo(taskId, row.value);
      const todo = created ?? (edit ? updateTodoItemV1(existing!, edit.fields, Date.now()) : transitionTodoItemV1(existing!, transition!.state, Date.now()));
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
      if (!result.success) { args.requireCurrent(); continue; }
      if (mutations.some(mutation => !result.results.some(row => row.key === mutation.key))) return { status: 'uncertain', reason: 'task_receipt_incomplete' };
      return { status: 'applied', todo: project(todo) };
    }
  } catch (error) {
    return { status: writing ? 'uncertain' : 'failed', reason: failureReason(error) };
  }
}

export class InternalTaskReorderError extends Error {
  constructor(readonly code: 'todo_reorder_stale' | 'todo_reorder_conflict' | 'todo_reorder_scope_changed') { super(code); }
}
type InternalTaskReorderArgs = Readonly<{
  input: unknown; scope: InternalTaskScope; port: AccountJsonKvCollectionPort; requireCurrent: () => void;
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
    const undoneOrder = resolveAnchoredListMoveV1(index.undoneOrder, input.sourceId, input.position);
    if (!undoneOrder) throw new InternalTaskReorderError('todo_reorder_stale');
    for (const id of new Set([input.sourceId, ...(input.position.anchorId === null ? [] : [input.position.anchorId])])) {
      const taskRow = await args.port.read(`todo.${id}`);
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
