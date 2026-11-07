import type { TriageDataActionContext } from '../actions/dataContext.js';

import { isPluginActionApprovalRequestCreated, type ActionApprovalRequestCreatedResult, type PluginActionInputById, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  projectTriageDisplayTextV1,
  type TriageConfiguredSourceInstanceV1, type TriageEntryRefV1, type TriageEntryStateV1,
  type TriageGetInputV1, type TriageGetResultV1, type TriageScanInputV1, type TriageScanResultV1,
  type TriageSourceEntryLocalRefV1, type TriageTaskFieldsV1,
  type TriageTaskCreateInputV1, type TriageTaskEditInputV1, type TriageTaskTransitionInputV1,
  type TriageTaskWriteResultV1, type TriageSourceLinkSessionInputV1, type TriageSourceLinkSessionResultV1,
  type TriageSourceReadSessionLinksInputV1, type TriageSourceReadSessionLinksResultV1,
} from '@happier-dev/triage-protocol/v1';

import { INTERNAL_TASK_SOURCE_V1, INTERNAL_TASK_SOURCE_LABEL_V1, internalTaskLocalRefV1, internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1 } from './identity.js';
export { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from './identity.js';
import { isInternalTaskConfiguredInstanceV1 } from './configuration.js';
export { INTERNAL_TASK_DRAFT_V1, isInternalTaskConfiguredInstanceV1 } from './configuration.js';

export type TaskList = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>;
type TaskRead = Extract<PluginActionResultById['tasks.internal.read'], { status: 'applied' | 'refused' }>;
type Task = TaskList['todos'][number];
type TaskFields = PluginActionInputById['tasks.internal.edit']['fields'];
type TaskReadContext = Pick<TriageDataActionContext, 'signal'> & Readonly<{ services: Pick<TriageDataActionContext['services'], 'actions'> }>;
const UNAVAILABLE = { class: 'transient', code: 'accountDataUnavailable' } as const;
const INVALID_ADDRESS = { class: 'unsupportedContract', code: 'invalidTaskAddress' } as const;

export const INTERNAL_TASK_STATES_V1 = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
/** Fields this adapter maps to internal task writes; the contribution advertises this same subset. */
export const INTERNAL_TASK_EDIT_FIELDS_V1 = Object.freeze(['title', 'body', 'assigneeIds', 'labelIds', 'dueDate', 'parent', 'blockedBy'] as const);
export function internalTaskStateV1(state: Task['state']): TriageEntryStateV1 {
  return state === 'completed' || state === 'canceled'
    ? { presentation: state === 'completed' ? 'resolved' : 'closed', nativeLabel: state === 'completed' ? 'Done' : 'Canceled', completionReason: state }
    : { presentation: 'active', stage: state, nativeLabel: state === 'backlog' ? 'Backlog' : state === 'started' ? 'In progress' : 'To do' };
}

function ownerOf(task: Task, list: Pick<TaskList, 'scope'>): string { return task.ownerAccountId ?? list.scope.accountId; }
function assigneeOf(task: Task, list: Pick<TaskList, 'scope'>): string { return task.owner ?? task.createdBy ?? ownerOf(task, list); }
function taskKey(id: string, ownerAccountId: string): string { return JSON.stringify([ownerAccountId, id]); }
function taskRef(id: string, ownerAccountId: string, viewerAccountId: string): TriageEntryRefV1 {
  return { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(id, ownerAccountId === viewerAccountId ? undefined : ownerAccountId) };
}
function blockerRef(blocker: NonNullable<Task['blockedBy']>[number], ownerAccountId: string, viewerAccountId: string): TriageEntryRefV1 {
  if (typeof blocker === 'string') return taskRef(blocker, ownerAccountId, viewerAccountId);
  // Stored personal references, like bare ids, were authored in the task owner's Account.
  return isInternalTaskReferenceV1(blocker) && blocker.collisionScope === 'personal'
    ? taskRef(blocker.entryId, ownerAccountId, viewerAccountId) : blocker;
}
function admitsRef(ref: TriageSourceEntryLocalRefV1): boolean { return internalTaskOwnerAccountIdV1(ref, '') !== null; }

function taskDueDate(task: Task): string | null {
  return task.dueAt === undefined ? null : new Date(task.dueAt).toISOString();
}

async function readTasks(context: TaskReadContext): Promise<TaskList | null> {
  try {
    const result = await context.services.actions.execute('tasks.internal.list', {}, { signal: context.signal });
    return !isPluginActionApprovalRequestCreated(result) && result.status === 'ok' ? result : null;
  } catch (error) { if (context.signal.aborted) throw error; return null; }
}
export { readTasks as readInternalTaskList };

async function readTask(localRef: TriageSourceEntryLocalRefV1, context: TaskReadContext): Promise<TaskRead | null> {
  try {
    const ownerAccountId = localRef.collisionScope === 'personal' ? undefined : internalTaskOwnerAccountIdV1(localRef, '')!;
    const result = await context.services.actions.execute('tasks.internal.read', { taskId: localRef.entryId,
      ...(ownerAccountId === undefined ? {} : { ownerAccountId }) }, { signal: context.signal });
    return !isPluginActionApprovalRequestCreated(result) && (result.status === 'applied' || result.status === 'refused') ? result : null;
  } catch (error) { if (context.signal.aborted) throw error; return null; }
}

/** All projections join owner-relative parent ids; unreadable siblings leave membership unknown. */
function indexChildren(list: TaskList, parents: readonly Task[]): ReadonlyMap<string, readonly Task[]> {
  const unavailableOwners = new Set(list.unavailableTasks?.map(task => task.ownerAccountId));
  const childrenByParent = new Map<string, Task[]>(parents
    .filter(task => !unavailableOwners.has(ownerOf(task, list)))
    .map(task => [taskKey(task.id, ownerOf(task, list)), []]));
  if (parents.length > 0) for (const task of list.todos) {
    const parentId = task.parentId;
    if (parentId !== undefined) childrenByParent.get(taskKey(parentId, ownerOf(task, list)))?.push(task);
  }
  return childrenByParent;
}

function observation(task: Task, list: Pick<TaskList, 'scope'>, children?: readonly Task[],
): Extract<TriageGetResultV1, { kind: 'present' }> {
  const title = projectTriageDisplayTextV1(task.title);
  const dueDate = taskDueDate(task);
  const ownerAccountId = ownerOf(task, list);
  const assignee = assigneeOf(task, list);
  const assigneeLabel = assignee === ownerAccountId ? task.ownerDisplayName : assignee;
  const ref = (id: string) => taskRef(id, ownerAccountId, list.scope.accountId);
  return {
    kind: 'present', localRef: internalTaskLocalRefV1(task.id, ownerAccountId === list.scope.accountId ? undefined : ownerAccountId),
    locator: { v: 1, displayPath: title.value || task.id, routingToken: task.id },
    snapshot: { v: 1, title: title.value || task.id, scopeLabel: INTERNAL_TASK_SOURCE_LABEL_V1, scopeDisplayName: INTERNAL_TASK_SOURCE_LABEL_V1,
      scopeUnitId: ownerAccountId === list.scope.accountId ? 'mine' : 'shared',
      state: internalTaskStateV1(task.state), createdAtMs: task.createdAt, facts: [],
      ...(task.labels === undefined ? {} : { labels: task.labels }),
      ...(task.labelColors === undefined ? {} : { labelColors: task.labelColors }),
      ...(task.access === 'view' ? { taskCapabilities: { editFields: [], transitions: [] } } : {}),
      assigneeLabel: assigneeLabel == null ? null : projectTriageDisplayTextV1(assigneeLabel).value || null,
      ...(dueDate === null ? {} : { dueDate }),
      ...(task.state === 'completed' && task.completedAt !== undefined ? { completedAtMs: task.completedAt } : {}),
      relations: { ...(task.parentId === undefined ? {} : { parent: ref(task.parentId) }),
        blockedBy: (task.blockedBy ?? []).map(blocker => blockerRef(blocker, ownerAccountId, list.scope.accountId)),
        ...(children === undefined ? {} : { children: { total: children.length, completed: children.filter(child => child.done).length,
          entries: children.map(child => ref(child.id)), complete: true } }) },
      ...(title.truncated ? { projectionTruncated: true } : {}),
    },
    viewer: { involvement: [...(assignee === list.scope.accountId ? ['assignee' as const] : []),
      ...(task.createdBy === list.scope.accountId ? ['author' as const] : [])], sourceAttention: { level: 'none' } }, sourceUpdatedAtMs: task.updatedAt,
  };
}

export async function scanInternalTasks(input: TriageScanInputV1, context: TriageDataActionContext): Promise<TriageScanResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance)) return { kind: 'failed', failure: INVALID_ADDRESS };
  const list = await readTasks(context);
  return projectInternalTaskScan(input, list);
}

/** Scan, order and links consume this operation's already authorized Task inventory. */
export function projectInternalTaskScan(input: TriageScanInputV1, list: TaskList | null): TriageScanResultV1 {
  if (list === null) return { kind: 'failed', failure: UNAVAILABLE };
  const completedSinceMs = input.completed?.kindIds.includes('task') ? input.completed.sinceMs : undefined;
  let after: string | undefined;
  let limit: number;
  if (input.page.kind === 'initial') limit = input.page.limit;
  else {
    try {
      const cursor: unknown = JSON.parse(input.page.continuation.token);
      if (typeof cursor !== 'object' || cursor === null || !('after' in cursor) || typeof cursor.after !== 'string'
        || !('limit' in cursor) || typeof cursor.limit !== 'number' || !Number.isSafeInteger(cursor.limit) || cursor.limit < 1
        || ('completedSinceMs' in cursor ? cursor.completedSinceMs : undefined) !== completedSinceMs
        || Object.keys(cursor).some(key => key !== 'after' && key !== 'limit' && key !== 'completedSinceMs')) return { kind: 'failed', failure: INVALID_ADDRESS };
      after = cursor.after; limit = cursor.limit;
    } catch { return { kind: 'failed', failure: INVALID_ADDRESS }; }
  }
  const keyOf = (task: Task) => taskKey(task.id, ownerOf(task, list));
  const byId = new Map(list.todos.map(task => [keyOf(task), task]));
  const shared = list.todos.filter(task => ownerOf(task, list) !== list.scope.accountId).sort((left, right) =>
    Number(left.done) - Number(right.done) || left.createdAt - right.createdAt
      || ownerOf(left, list).localeCompare(ownerOf(right, list)) || left.id.localeCompare(right.id));
  const ids = [...new Set([...list.undoneOrder.map(id => taskKey(id, list.scope.accountId)),
    ...list.completedOrder.map(id => taskKey(id, list.scope.accountId)),
    ...list.todos.filter(task => ownerOf(task, list) === list.scope.accountId).map(keyOf), ...shared.map(keyOf)])].filter(id => {
    const task = byId.get(id);
    return task !== undefined && (completedSinceMs === undefined || task.state !== 'completed'
      || task.completedAt !== undefined && task.completedAt >= completedSinceMs);
  });
  const start = after === undefined ? 0 : ids.indexOf(after) + 1;
  if (after !== undefined && start === 0) return { kind: 'failed', failure: { class: 'transient', code: 'taskOrderChanged' } };
  const pageIds = ids.slice(start, start + limit);
  const childrenByParent = indexChildren(list, pageIds.map(id => byId.get(id)!));
  const page = pageIds.flatMap(id => {
    const task = byId.get(id);
    return task ? [observation(task, list, childrenByParent.get(id))] : [];
  });
  const unavailableCount = list.unavailableTasks?.length ?? 0;
  return start + limit >= ids.length
    ? { kind: 'complete', observations: page, evidence: unavailableCount === 0 ? { kind: 'walkFinished' }
      : { kind: 'partial', reason: 'taskContentUnavailable' } }
    : { kind: 'page', observations: page, evidence: { kind: 'partial', reason: 'pageLimit' },
      continuation: { v: 1, token: JSON.stringify({ after: ids[start + limit - 1], limit,
        ...(completedSinceMs === undefined ? {} : { completedSinceMs }) }) } };
}

export async function getInternalTask(input: TriageGetInputV1, context: TriageDataActionContext): Promise<TriageGetResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'unresolved', localRef: input.localRef, failure: INVALID_ADDRESS };
  const result = await readTask(input.localRef, context);
  if (result === null) return { kind: 'unresolved', localRef: input.localRef, failure: UNAVAILABLE };
  if (result.status === 'refused') return { kind: 'unresolved', localRef: input.localRef, failure: { class: 'permission', code: result.reason } };
  const task = result.todo;
  const owner = ownerOf(task, result);
  // The exact read owns task content/access. One existing list read supplies the inverse parent relation.
  const relations = await readTasks(context);
  const children = relations === null ? undefined : indexChildren(relations, [task]).get(taskKey(task.id, owner));
  return taskGetResult(task, result, input.localRef, children);
}

function taskGetResult(task: Task, list: Pick<TaskList, 'scope'>, localRef: TriageSourceEntryLocalRefV1,
  children?: readonly Task[]): TriageGetResultV1 {
  const owner = ownerOf(task, list);
  return { ...observation(task, list, children), localRef, taskFields: {
    title: task.title, body: task.notes ?? '', assigneeIds: [assigneeOf(task, list)],
    labelIds: [...(task.labels ?? [])], dueDate: taskDueDate(task),
    parent: task.parentId === undefined ? null : taskRef(task.parentId, owner, list.scope.accountId),
    blockedBy: (task.blockedBy ?? []).map(blocker => blockerRef(blocker, owner, list.scope.accountId)),
  } };
}

export type InternalTaskBatchResultV1 = Readonly<{
  observation: TriageGetResultV1;
  sessionLinks: TriageSourceReadSessionLinksResultV1;
}>;

/** One operation's authorized inventory serves every selected task and its links. */
export async function getInternalTasks(inputs: readonly TriageGetInputV1[], context: TaskReadContext,
  admittedList?: TaskList | null): Promise<readonly InternalTaskBatchResultV1[]> {
  if (inputs.length === 0) return [];
  const list = admittedList === undefined ? await readTasks(context) : admittedList;
  const byId = new Map(list?.todos.map(task => [taskKey(task.id, ownerOf(task, list)), task]));
  const unavailable = new Map(list?.unavailableTasks?.map(task => [taskKey(task.taskId, task.ownerAccountId), task]));
  const selected = inputs.map(input => list === null ? undefined
    : byId.get(taskKey(input.localRef.entryId, internalTaskOwnerAccountIdV1(input.localRef, list.scope.accountId) ?? '')));
  const children = list === null ? new Map<string, readonly Task[]>()
    : indexChildren(list, selected.filter((task): task is Task => task !== undefined));
  return inputs.map((input, index): InternalTaskBatchResultV1 => {
    if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return {
      observation: { kind: 'unresolved', localRef: input.localRef, failure: INVALID_ADDRESS },
      sessionLinks: { kind: 'failed', failure: INVALID_ADDRESS },
    };
    if (list === null) return {
      observation: { kind: 'unresolved', localRef: input.localRef, failure: UNAVAILABLE },
      sessionLinks: { kind: 'failed', failure: UNAVAILABLE },
    };
    const task = selected[index];
    const key = taskKey(input.localRef.entryId, internalTaskOwnerAccountIdV1(input.localRef, list.scope.accountId)!);
    const missing = unavailable.get(key);
    return {
      observation: task === undefined
        ? { kind: 'unresolved', localRef: input.localRef, failure: missing === undefined
          ? { class: 'permission', code: 'task_not_found' } : UNAVAILABLE }
        : taskGetResult(task, list, input.localRef, children.get(key)),
      sessionLinks: projectInternalTaskSessionLinks(input, { scope: list.scope, todos: task === undefined ? [] : [task],
        ...(missing === undefined ? {} : { unavailableTasks: [missing] }) }),
    };
  });
}

function fieldsFrom(fields: TriageTaskFieldsV1): TaskFields | null {
  const supported: readonly string[] = INTERNAL_TASK_EDIT_FIELDS_V1;
  if (Object.keys(fields).some(field => !supported.includes(field)) || (fields.assigneeIds?.length ?? 0) > 1
    || (fields.parent != null && !isInternalTaskReferenceV1(fields.parent))) return null;
  const dueAt = fields.dueDate == null ? fields.dueDate : Date.parse(fields.dueDate);
  if (typeof dueAt === 'number' && !Number.isFinite(dueAt)) return null;
  return {
    ...(fields.title === undefined ? {} : { title: fields.title }), ...(fields.body === undefined ? {} : { notes: fields.body }),
    ...(fields.assigneeIds === undefined ? {} : { owner: fields.assigneeIds[0] ?? null }),
    ...(fields.labelIds === undefined ? {} : { labels: [...fields.labelIds] }), ...(dueAt === undefined ? {} : { dueAt }),
    ...(fields.parent === undefined ? {} : { parentId: fields.parent }),
    ...(fields.blockedBy === undefined ? {} : { blockedBy: [...fields.blockedBy] }),
  };
}

type HostWriteResult = PluginActionResultById['tasks.internal.edit'];
async function invokeWrite(operation: () => Promise<HostWriteResult | ActionApprovalRequestCreatedResult>,
  context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  try { return writeResult(await operation()); }
  catch (error) { if (context.signal.aborted) throw error; return { kind: 'uncertain', failure: UNAVAILABLE }; }
}
function writeResult(result: HostWriteResult | ActionApprovalRequestCreatedResult): TriageTaskWriteResultV1 {
  if (isPluginActionApprovalRequestCreated(result)) return { kind: 'refused', reason: 'approvalRequired' };
  if (result.status === 'applied') return { kind: 'applied', observation: observation(result.todo, result) };
  if (result.status === 'uncertain') return { kind: 'uncertain', failure: UNAVAILABLE };
  if (result.status === 'refused') return { kind: 'refused', reason: result.reason };
  return { kind: 'failed', failure: UNAVAILABLE };
}

export async function createInternalTask(input: TriageTaskCreateInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || input.kindId !== 'task') return { kind: 'refused', reason: 'unsupportedKind' };
  const state = INTERNAL_TASK_STATES_V1.find(candidate => candidate === input.initialStatusId);
  if (input.initialStatusId !== undefined && state === undefined) return { kind: 'refused', reason: 'unsupportedTransition' };
  const fields = fieldsFrom(input.fields);
  if (!fields) return { kind: 'refused', reason: 'unsupportedField' };
  return invokeWrite(() => context.services.actions.execute('tasks.internal.create', { fields: {
    title: input.fields.title, ...(fields.notes == null ? {} : { notes: fields.notes }),
    ...(fields.owner == null ? {} : { owner: fields.owner }), ...(fields.dueAt == null ? {} : { dueAt: fields.dueAt }),
    ...(fields.parentId == null ? {} : { parentId: fields.parentId }), ...(fields.blockedBy == null ? {} : { blockedBy: fields.blockedBy }),
    ...(fields.labels == null ? {} : { labels: fields.labels }),
    ...(state === undefined ? {} : { state }),
  } }, { signal: context.signal }), context);
}

export async function editInternalTask(input: TriageTaskEditInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'refused', reason: 'unsupportedKind' };
  const ownerAccountId = input.localRef.collisionScope === 'personal' ? undefined : internalTaskOwnerAccountIdV1(input.localRef, '')!;
  const fields = fieldsFrom(input.fields);
  if (!fields) return { kind: 'refused', reason: 'unsupportedField' };
  return invokeWrite(() => context.services.actions.execute('tasks.internal.edit', { taskId: input.localRef.entryId,
    ...(ownerAccountId === undefined ? {} : { ownerAccountId }), fields }, { signal: context.signal }), context);
}

export async function transitionInternalTask(input: TriageTaskTransitionInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'refused', reason: 'unsupportedKind' };
  if ((input.fieldValues?.length ?? 0) > 0) return { kind: 'refused', reason: 'unsupportedField' };
  const state = INTERNAL_TASK_STATES_V1.find(candidate => candidate === input.transitionId);
  if (!state) return { kind: 'refused', reason: 'unsupportedTransition' };
  const ownerAccountId = input.localRef.collisionScope === 'personal' ? undefined : internalTaskOwnerAccountIdV1(input.localRef, '')!;
  return invokeWrite(() => context.services.actions.execute('tasks.internal.transition', { taskId: input.localRef.entryId,
    ...(ownerAccountId === undefined ? {} : { ownerAccountId }), state }, { signal: context.signal }), context);
}

export async function linkInternalTaskSession(input: TriageSourceLinkSessionInputV1, context: TriageDataActionContext): Promise<TriageSourceLinkSessionResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { status: 'failed' };
  const ownerAccountId = input.localRef.collisionScope === 'personal' ? undefined : internalTaskOwnerAccountIdV1(input.localRef, '')!;
  const result = await context.services.actions.execute('tasks.internal.session.link', { taskId: input.localRef.entryId,
    ...(ownerAccountId === undefined ? {} : { ownerAccountId }),
    session: { sessionId: input.sessionId }, linked: input.linked }, { signal: context.signal });
  return !isPluginActionApprovalRequestCreated(result) && (result.status === 'linked' || result.status === 'unlinked') ? { status: result.status } : { status: 'failed' };
}

export async function readInternalTaskSessionLinks(input: TriageSourceReadSessionLinksInputV1, context: TaskReadContext,
  admittedList?: TaskList | null): Promise<TriageSourceReadSessionLinksResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || (input.localRef !== undefined && !admitsRef(input.localRef))) return { kind: 'failed', failure: INVALID_ADDRESS };
  let list: Pick<TaskList, 'scope' | 'todos' | 'unavailableTasks'> | null;
  if (input.localRef === undefined) list = admittedList === undefined ? await readTasks(context) : admittedList;
  else {
    const read = await readTask(input.localRef, context);
    if (read?.status === 'refused') return { kind: 'failed', failure: { class: 'permission', code: read.reason } };
    list = read === null ? null : { scope: read.scope, todos: [read.todo] };
  }
  if (!list) return { kind: 'failed', failure: UNAVAILABLE };
  return projectInternalTaskSessionLinks(input, list);
}

export function projectInternalTaskSessionLinks(input: Pick<TriageSourceReadSessionLinksInputV1, 'localRef' | 'sessionId'>,
  list: Pick<TaskList, 'scope' | 'todos' | 'unavailableTasks'>): TriageSourceReadSessionLinksResultV1 {
  const links: Extract<TriageSourceReadSessionLinksResultV1, { kind: 'complete' }>['links'][number][] = [];
  for (const task of list.todos) {
    const ownerAccountId = ownerOf(task, list);
    if (input.localRef !== undefined && (input.localRef.entryId !== task.id
      || internalTaskOwnerAccountIdV1(input.localRef, list.scope.accountId) !== ownerAccountId)) continue;
    const seen = new Set<string>();
    for (const [key, link] of Object.entries(task.linkedSessions ?? {})) {
      // A shared task carries its author's qualified links. Session access is
      // decided by the Session owner when read/opened, not by the linking Account.
      if (link.session !== undefined && link.session.serverId !== list.scope.serverId) continue;
      if (link.session === undefined && ownerAccountId !== list.scope.accountId) continue;
      const sessionId = link.session?.sessionId ?? key;
      if ((input.sessionId !== undefined && input.sessionId !== sessionId) || seen.has(sessionId)) continue;
      seen.add(sessionId);
      links.push({ localRef: internalTaskLocalRefV1(task.id, ownerAccountId === list.scope.accountId ? undefined : ownerAccountId), sessionId, linkedAtMs: link.linkedAt,
        displayPath: projectTriageDisplayTextV1(task.title).value || task.id });
    }
  }
  const unavailableRefs = list.unavailableTasks?.map(task => internalTaskLocalRefV1(task.taskId,
    task.ownerAccountId === list.scope.accountId ? undefined : task.ownerAccountId)) ?? [];
  return unavailableRefs.length === 0 ? { kind: 'complete', links } : { kind: 'partial', links, unavailableRefs };
}
