import { createTodoItemV1, updateTodoItemV1, transitionTodoItemV1, resolveTodoStateV1, resolveTodoReadinessV1,
  transitionTodoClaimV1, matchesTodoClaimResultReplayV1, TodoItemV1StoredSchema, TodoIndexV1StoredSchema, type TodoClaimAttemptBindingV1,
  type TodoItemV1, type TodoIndexV1, type TodoStateV1 } from './todoSessionLinkV1.js';
import { resolveAnchoredListMoveV1 } from '../actions/anchoredListOrderV1.js';
import { ACCOUNT_KV_MUTATION_BATCH_MAX } from '../account/accountJsonKv.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { TodoReorderInputV1Schema, type ListReorderOutputV1 } from '../actions/listReorderAction.js';
import { InternalTaskCreateInputSchema, InternalTaskEditInputSchema, InternalTaskTransitionInputSchema,
  InternalTaskDeleteInputSchema,
  InternalTaskReadInputSchema, InternalTaskListInputSchema, InternalTaskShareInputSchema, InternalTaskUnshareInputSchema, InternalTaskGrantsInputSchema, InternalTaskPrepareInputSchema,
  InternalTaskLabelSetColorInputSchema, InternalTaskLabelClearColorInputSchema,
  type InternalTaskActionId, type InternalTaskActionOutput, type InternalTaskScope } from '../actions/internalTaskActions.js';
import { createTaskResourceClientV1, TaskResourceClientErrorV1, type TaskResourceClientOptionsV1, type OpenedTaskResourceV1 } from './taskResourceClientV1.js';
import { internalTaskLocalRefV1, internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '../tasks/entryRefV1.js';
import { TODO_LABEL_CATALOG_KEY_V1, TodoLabelCatalogV1StoredSchema, projectTodoLabelColorsV1 } from './todoLabelColoursV1.js';
import { readTaskBlockerAddressV1, type TaskResourceAddressV1 } from './taskResourceV1.js';
import { settleTodoLinkedWorkV1, writeTodoPullRequestHandoffV1, type TodoLinkedEvidenceReaderV1 } from './todoLinkedTaskV1.js';
export * from './taskResourceClientV1.js';
export type { TodoLinkedEvidenceReaderV1 } from './todoLinkedTaskV1.js';

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
const project = ({ settledClaim: _settledClaim, ...todo }: TodoItemV1, version: number) => ({ ...todo, state: resolveTodoStateV1(todo), version });
const projectResource = (task: OpenedTaskResourceV1) => ({ ...project(task.todo, task.resource.version), ownerAccountId: task.resource.ownerAccountId, access: task.resource.access,
  ...(task.resource.ownerDisplayName === undefined ? {} : { ownerDisplayName: task.resource.ownerDisplayName }) });
/** Retain the latest membership change in the same Task envelope and CAS. */
function retainTaskLabelChange(todo: TodoItemV1, previous: TodoItemV1 | null, nextVersion: number): TodoItemV1 {
  const before = new Set(previous?.labels);
  const after = new Set(todo.labels);
  if (before.size === after.size && [...after].every(label => before.has(label))) return todo;
  return { ...todo, labelChange: { version: nextVersion, occurredAt: todo.updatedAt } };
}
type TodoBlocker = NonNullable<TodoItemV1['blockedBy']>[number];
const taskAddressKey = ({ ownerAccountId, taskId }: TaskResourceAddressV1) => JSON.stringify([ownerAccountId, taskId]);
function blockerState(states: ReadonlyMap<string, TodoStateV1>, blocker: TodoBlocker, ownerAccountId: string) {
  const address = readTaskBlockerAddressV1(blocker, ownerAccountId);
  return address ? states.get(taskAddressKey(address)) : undefined;
}
function assignmentId(todo: TodoItemV1) {
  switch (todo.assignee?.kind) {
    case 'person': return todo.assignee.accountId;
    case 'session': return todo.assignee.sessionId;
    case 'bot': return todo.assignee.botId;
    default: return todo.owner;
  }
}
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
  claimant?: TodoClaimAttemptBindingV1; linkedEvidence?: TodoLinkedEvidenceReaderV1;
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
      const { selection, parent, state, owner, label, ready } = InternalTaskListInputSchema.parse(args.input);
      const isInParentScope = (todo: TodoItemV1) => parent === undefined || todo.parentId === parent.taskId;
      const catalog = (await readLabelCatalog()).value;
      const labelCatalog = projectTodoLabelColorsV1(Object.keys(catalog.colors), catalog);
      const withColors = <T extends TodoItemV1>(todo: T) => ({ ...todo, labelColors: projectTodoLabelColorsV1(todo.labels ?? [], catalog) });
      const finishList = <T extends ReturnType<typeof project> & { ownerAccountId?: string }>(
        todos: readonly T[], index: TodoIndexV1, states: ReadonlyMap<string, TodoStateV1>,
      ) => {
        const matching = todos.filter(todo =>
          (state === undefined || state === todo.state) && (owner === undefined || owner === assignmentId(todo))
          && (label === undefined || todo.labels?.includes(label)));
        const projected = matching.map(todo => {
          const ownerAccountId = todo.ownerAccountId ?? args.scope.accountId;
          return withColors({ ...todo, readiness: resolveTodoReadinessV1(todo, blocker => blockerState(states, blocker, ownerAccountId)) });
        });
        const displayed = ready === undefined ? projected : projected.filter(todo => todo.readiness.ready === ready);
        const notReadyTasks = ready !== true ? [] : projected.flatMap(todo => todo.readiness.ready ? [] : [{
          ownerAccountId: todo.ownerAccountId ?? args.scope.accountId, taskId: todo.id, reason: todo.readiness.reason,
        }]);
        const { undoneOrder, completedOrder } = resolveTodoIndexForItemsV1(
          displayed.filter(todo => (todo.ownerAccountId ?? args.scope.accountId) === args.scope.accountId), index,
        );
        return { status: 'ok' as const, scope: args.scope, todos: displayed, undoneOrder, completedOrder, labelCatalog,
          ...(notReadyTasks.length ? { notReadyTasks } : {}) };
      };
      if (resources) {
        try {
          const result = await resources.list({ ...(selection === undefined ? {} : { selection }),
            ...(parent === undefined ? {} : { ownerAccountId: parent.ownerAccountId }) });
          const tasks = parent === undefined ? result.tasks : result.tasks.filter(task => isInParentScope(task.todo));
          const indexRow = selection === undefined && parent === undefined ? await args.port.read('todo.index') : { value: null };
          const index = indexRow.value === null ? { undoneOrder: [], completedOrder: [] } : indexSchema.parse(indexRow.value);
          const states = new Map(result.tasks.map(task => [taskAddressKey(task.resource), resolveTodoStateV1(task.todo)]));
          if (selection !== undefined || parent !== undefined) {
            const missing = new Map<string, TaskResourceAddressV1>();
            for (const task of tasks) for (const blocker of task.todo.blockedBy ?? []) {
              const address = readTaskBlockerAddressV1(blocker, task.resource.ownerAccountId);
              if (address && !states.has(taskAddressKey(address))) missing.set(taskAddressKey(address), address);
            }
            if (missing.size > 0) {
              const blockers = await resources.list({ selection: { kind: 'ids', tasks: [...missing.values()] } });
              for (const task of blockers.tasks) states.set(taskAddressKey(task.resource), resolveTodoStateV1(task.todo));
            }
          }
          args.requireCurrent();
          return { ...finishList(tasks.map(projectResource), index, states),
            ...(result.unavailableTasks.length ? { unavailableTasks: result.unavailableTasks } : {}) };
        } catch (error) { if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error; }
      }
      if (selection !== undefined || (parent !== undefined && parent.ownerAccountId !== args.scope.accountId)) {
        throw new TaskResourceClientErrorV1('task_selection_unsupported', 'failed');
      }
      const rows = await args.port.list('todo.');
      args.requireCurrent();
      const todos = rows.filter(row => row.key !== 'todo.index')
        .map(row => project(parseTodo(row.key.slice(5), row.value), row.version));
      const indexRow = parent === undefined ? rows.find(row => row.key === 'todo.index') : undefined;
      const index = indexRow ? indexSchema.parse(indexRow.value) : { undoneOrder: [], completedOrder: [] };
      const states = new Map(todos.map(todo => [taskAddressKey({ ownerAccountId: args.scope.accountId, taskId: todo.id }), todo.state]));
      return finishList(todos.filter(isInParentScope), index, states);
    }
    const createInput = args.actionId === 'tasks.internal.create' ? InternalTaskCreateInputSchema.safeParse(args.input) : null;
    if (createInput && !createInput.success) return { status: 'refused', reason: 'invalid_input' };
    const create = createInput?.data ?? null;
    if (create && 'plan' in create) {
      const { source, sessionId, tasks, approvalProfileId } = create.plan;
      if (tasks.length === 0) return { status: 'refused', reason: 'invalid_input' };
      // The graph and its private order share the existing atomic KV request.
      if (tasks.length + 1 > ACCOUNT_KV_MUTATION_BATCH_MAX) return { status: 'refused', reason: 'task_plan_batch_too_large' };
      const taskIds = new Map(tasks.map(({ id }) => [id, `plan-${computeCanonicalDomainSeparatedDigest(
        'happier.task.plan.v1', [sessionId, source.kind, source.id, id],
      )}`]));
      const now = Date.now();
      const mutations: AccountJsonKvMutation[] = tasks.map(task => {
        const id = taskIds.get(task.id)!;
        const baseFromTaskId = task.baseFromTaskId === undefined ? undefined : taskIds.get(task.baseFromTaskId)!;
        const todo = createTodoItemV1({ id, title: task.title, createdBy: args.scope.accountId,
          ...(task.details === undefined ? {} : { notes: task.details }),
          ...(task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy.map(blocker => taskIds.get(blocker)!) }),
        }, now);
        if (approvalProfileId !== undefined || baseFromTaskId !== undefined) {
          todo.planWorker = {
            ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
            ...(baseFromTaskId === undefined ? {} : { baseFromTaskId }),
          };
        }
        return { key: `todo.${id}`, value: todo, version: -1 };
      });
      const indexRow = await args.port.read('todo.index');
      const index = indexRow.value === null ? { undoneOrder: [], completedOrder: [] } : indexSchema.parse(indexRow.value);
      mutations.push({ key: 'todo.index', version: indexRow.version,
        value: { ...index, undoneOrder: [...index.undoneOrder, ...taskIds.values()] } });
      args.requireCurrent();
      writing = true;
      const written = await args.port.mutate(mutations);
      writing = false;
      if (!written.success) return { status: 'refused', reason: written.errors.some(row => row.key !== 'todo.index')
        ? 'task_already_exists' : 'task_conflict' };
      const writtenKeys = new Set(written.results.map(row => row.key));
      if (mutations.some(row => !writtenKeys.has(row.key))) return { status: 'uncertain', reason: 'task_receipt_incomplete' };
      return { status: 'plan_applied', scope: args.scope,
        tasks: Array.from(taskIds, ([planTaskId, taskId]) => ({ planTaskId, taskId })) };
    }
    const edit = args.actionId === 'tasks.internal.edit' ? InternalTaskEditInputSchema.parse(args.input) : null;
    const transition = args.actionId === 'tasks.internal.transition' ? InternalTaskTransitionInputSchema.parse(args.input) : null;
    const remove = args.actionId === 'tasks.internal.delete' ? InternalTaskDeleteInputSchema.parse(args.input) : null;
    const read = args.actionId === 'tasks.internal.read' ? InternalTaskReadInputSchema.parse(args.input) : null;
    const share = args.actionId === 'tasks.internal.share' ? InternalTaskShareInputSchema.parse(args.input) : null;
    const unshare = args.actionId === 'tasks.internal.unshare' ? InternalTaskUnshareInputSchema.parse(args.input) : null;
    const grants = args.actionId === 'tasks.internal.grants' ? InternalTaskGrantsInputSchema.parse(args.input) : null;
    const prepare = args.actionId === 'tasks.internal.prepare' ? InternalTaskPrepareInputSchema.parse(args.input) : null;
    const addressed = edit ?? transition ?? remove ?? read ?? share ?? unshare ?? grants ?? prepare;
    const scoped = edit ?? transition ?? remove ?? share ?? unshare ?? prepare;
    if (scoped?.scope && (scoped.scope.serverId !== args.scope.serverId || scoped.scope.accountId !== args.scope.accountId)) return { status: 'refused', reason: 'task_scope_mismatch' };
    const taskId = addressed?.taskId ?? args.createId();
    if (taskId === 'index') return { status: 'refused', reason: 'invalid_task_id' };
    const key = `todo.${taskId}`;
    const ownerAccountId = addressed?.ownerAccountId ?? args.scope.accountId;
    const expectedVersion = edit?.expectedVersion ?? transition?.expectedVersion;
    if (transition?.claim && expectedVersion === undefined) return { status: 'refused', reason: 'invalid_input' };
    const replay = transition?.claim?.kind === 'result' && args.claimant && expectedVersion !== undefined
      ? { state: transition.state, claim: transition.claim, claimant: args.claimant, expectedVersion } : null;
    const alreadySettled = (todo: TodoItemV1, version: number) => replay !== null && matchesTodoClaimResultReplayV1({ ...replay, todo, version });
    const replayFromRow = (row: Pick<AccountJsonKvRow, 'value' | 'version'>) => {
      if (!replay) return null;
      const committed = TodoItemV1StoredSchema.safeParse(row.value);
      return committed.success && committed.data.id === taskId && alreadySettled(committed.data, row.version)
        ? { status: 'applied' as const, scope: args.scope, todo: project(committed.data, row.version) } : null;
    };
    if (remove) {
      if (!resources) return { status: 'refused', reason: 'task_resource_unsupported' };
      await resources.remove({ ownerAccountId, taskId });
      return { status: 'deleted', scope: args.scope, taskId };
    }
    const createFields = create ? { ...create.fields, createdBy: create.fields.createdBy ?? args.scope.accountId,
      parentId: taskParentId(create.fields.parentId, args.scope.accountId, args.scope.accountId),
      blockedBy: taskBlockers(create.fields.blockedBy, args.scope.accountId, args.scope.accountId) } : null;
    const editFields = edit ? { ...edit.fields, parentId: taskParentId(edit.fields.parentId, ownerAccountId, args.scope.accountId),
      blockedBy: taskBlockers(edit.fields.blockedBy, ownerAccountId, args.scope.accountId) } : null;
    const applyMutation = async (existing: TodoItemV1, version: number, useResources: boolean) => {
      const now = Date.now();
      if (editFields) return { ok: true as const, todo: retainTaskLabelChange(updateTodoItemV1(existing, editFields, now), existing, version + 1) };
      if (!transition?.claim) return { ok: true as const, todo: transitionTodoItemV1(existing, transition!.state, now) };
      const { claim, state } = transition;
      if (claim.kind === 'merge' || claim.kind === 'deployment') return settleTodoLinkedWorkV1({
        todo: existing, state, claim, serverId: args.scope.serverId, now, evidence: args.linkedEvidence,
      });
      let readiness;
      if (claim.kind === 'take') {
        const addresses = (existing.blockedBy ?? []).flatMap(blocker => {
          const address = readTaskBlockerAddressV1(blocker, ownerAccountId);
          return address ? [address] : [];
        });
        const states = new Map<string, TodoStateV1>();
        if (addresses.length && resources && useResources) {
          const { tasks } = await resources.list({ selection: { kind: 'ids', tasks: addresses } });
          for (const task of tasks) states.set(taskAddressKey(task.resource), resolveTodoStateV1(task.todo));
        } else if (addresses.some(address => address.ownerAccountId === args.scope.accountId)) {
          const keys = new Set(addresses.filter(address => address.ownerAccountId === args.scope.accountId).map(address => `todo.${address.taskId}`));
          for (const row of await args.port.list('todo.')) if (keys.has(row.key)) {
            const taskId = row.key.slice(5);
            states.set(taskAddressKey({ ownerAccountId: args.scope.accountId, taskId }), resolveTodoStateV1(parseTodo(taskId, row.value)));
          }
        }
        readiness = resolveTodoReadinessV1(existing, blocker => blockerState(states, blocker, ownerAccountId));
      }
      const result = transitionTodoClaimV1(existing, state, claim, args.claimant, readiness, now);
      if (!result.ok || claim.kind !== 'result' || !args.claimant) return result;
      const settled = claim.finish ? await writeTodoPullRequestHandoffV1({ todo: result.todo, claimant: args.claimant,
        finish: claim.finish, branch: claim.branch, evidence: args.linkedEvidence }) : result;
      if (!settled.ok) return settled;
      return { ok: true as const, todo: { ...settled.todo, settledClaim: { attempt: args.claimant, expectedVersion: version } } };
    };
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
        if (expectedVersion !== undefined && expectedVersion !== current.resource.version) {
          if (alreadySettled(current.todo, current.resource.version)) return { status: 'applied', scope: args.scope, todo: projectResource(current) };
          return { status: 'refused', reason: 'task_version_conflict' };
        }
        // Owner transitions that change the terminal bucket retain the atomic task+private-index writer.
        const changesBucket = transition !== null
          && current.todo.done !== (transition.state === 'completed' || transition.state === 'canceled');
        if (current.resource.ownerAccountId !== args.scope.accountId || current.dataKey || (expectedVersion !== undefined && !changesBucket)) {
          const next = await applyMutation(current.todo, current.resource.version, true);
          if (!next.ok) return { status: 'refused', reason: next.reason };
          writing = true; const result = await resources.save(current, next.todo, expectedVersion); writing = false;
          return { status: 'applied', scope: args.scope, todo: projectResource(result) };
        }
      } catch (error) {
        if (writing && replay && error instanceof TaskResourceClientErrorV1 && error.code === 'task_version_conflict') {
          const committed = await resources.read(address).catch(() => null);
          if (committed && alreadySettled(committed.todo, committed.resource.version)) {
            return { status: 'applied', scope: args.scope, todo: projectResource(committed) };
          }
        }
        if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported') throw error;
        writing = false;
        if (address.ownerAccountId !== args.scope.accountId || share || unshare || grants || prepare) return { status: 'refused', reason: 'task_resource_unsupported' };
      }
    } else if (addressed && addressed.ownerAccountId && addressed.ownerAccountId !== args.scope.accountId) return { status: 'refused', reason: 'task_resource_unsupported' };
    if (share || unshare || grants || prepare) return { status: 'refused', reason: 'task_resource_unsupported' };
    if (read) {
      const row = await args.port.read(key); args.requireCurrent();
      if (row.value === null) return { status: 'refused', reason: 'task_deleted' };
      const todo = project(parseTodo(taskId, row.value), row.version);
      return { status: 'applied', scope: args.scope, todo: { ...todo,
        labelColors: projectTodoLabelColorsV1(todo.labels ?? [], (await readLabelCatalog()).value) } };
    }
    // Only an exact committed replay is acknowledged after a CAS conflict.
    const created = createFields ? createTodoItemV1({ ...createFields, id: taskId }, Date.now()) : null;
    args.requireCurrent();
    const [row, indexRow] = await Promise.all([
      args.port.read(key),
      created || transition ? args.port.read('todo.index') : Promise.resolve(null),
    ]);
    args.requireCurrent();
    if (created && row.value !== null) return { status: 'refused', reason: 'task_already_exists' };
    if (!created && row.value === null) return { status: 'refused', reason: 'task_deleted' };
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      return replayFromRow(row) ?? { status: 'refused', reason: 'task_version_conflict' };
    }
    const existing = row.value === null ? null : parseTodo(taskId, row.value);
    const next = created
      ? { ok: true as const, todo: retainTaskLabelChange(created, null, row.version + 1) }
      : await applyMutation(existing!, row.version, false);
    if (!next.ok) return { status: 'refused', reason: next.reason };
    const todo = next.todo;
    const mutations: AccountJsonKvMutation[] = [{ key, value: todo, version: expectedVersion ?? row.version }];
    if (indexRow !== null) {
      const index = indexRow.value === null ? { undoneOrder: [], completedOrder: [] } : indexSchema.parse(indexRow.value);
      let undoneOrder = index.undoneOrder;
      let completedOrder = index.completedOrder;
      if (created) {
        if (todo.done) completedOrder = [taskId, ...completedOrder];
        else undoneOrder = [...undoneOrder, taskId];
      }
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
    if (!result.success) {
      const conflict = expectedVersion === undefined ? undefined : result.errors.find(row => row.key === key);
      return conflict ? replayFromRow(conflict) ?? { status: 'refused', reason: 'task_version_conflict' }
        : { status: 'refused', reason: 'task_conflict' };
    }
    const written = result.results.find(row => row.key === key);
    if (!written || (indexRow !== null && !result.results.some(row => row.key === 'todo.index'))) return { status: 'uncertain', reason: 'task_receipt_incomplete' };
    return { status: 'applied', scope: args.scope, todo: project(todo, written.version) };
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
