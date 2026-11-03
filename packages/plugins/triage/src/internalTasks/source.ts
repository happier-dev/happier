import type { TriageDataActionContext } from '../actions/dataContext.js';

import { isPluginActionApprovalRequestCreated, type ActionApprovalRequestCreatedResult, type PluginActionInputById, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  projectTriageDisplayTextV1,
  type TriageConfiguredSourceInstanceV1, type TriageEntryRefV1, type TriageEntryStateV1,
  type TriageGetInputV1, type TriageGetResultV1, type TriageScanInputV1, type TriageScanResultV1,
  type TriageSourceEntryLocalRefV1, type TriageSourceInstanceDraftV1, type TriageTaskFieldsV1,
  type TriageTaskCreateInputV1, type TriageTaskEditInputV1, type TriageTaskTransitionInputV1,
  type TriageTaskWriteResultV1, type TriageSourceLinkSessionInputV1, type TriageSourceLinkSessionResultV1,
  type TriageSourceReadSessionLinksInputV1, type TriageSourceReadSessionLinksResultV1,
} from '@happier-dev/triage-protocol/v1';

import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1, isInternalTaskReferenceV1 } from './identity.js';
export { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from './identity.js';

/** This adapter owns the built-in source, never the Account todo model or CAS. */
export const INTERNAL_TASK_DRAFT_V1 = {
  v: 1, binding: { purpose: 'tasks', source: 'accountData' }, localInstanceKey: 'personal', keyStability: 'stable',
  configuration: { v: 1, token: 'happier-tasks-v1' }, locator: { v: 1, displayLabel: 'Happier tasks' },
} as const satisfies TriageSourceInstanceDraftV1;

type TaskList = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>;
type Task = TaskList['todos'][number];
type TaskFields = PluginActionInputById['tasks.internal.edit']['fields'];
const UNAVAILABLE = { class: 'transient', code: 'accountDataUnavailable' } as const;
const INVALID_ADDRESS = { class: 'unsupportedContract', code: 'invalidTaskAddress' } as const;

export const INTERNAL_TASK_STATES_V1 = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export function internalTaskStateV1(state: Task['state']): TriageEntryStateV1 {
  return state === 'completed' || state === 'canceled'
    ? { presentation: state === 'completed' ? 'resolved' : 'closed', nativeLabel: state === 'completed' ? 'Completed' : 'Canceled', completionReason: state }
    : { presentation: 'active', stage: state, nativeLabel: state === 'backlog' ? 'Backlog' : state === 'started' ? 'Started' : 'Unstarted' };
}

function taskRef(id: string): TriageEntryRefV1 { return { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(id) }; }
export function isInternalTaskConfiguredInstanceV1(instance: TriageConfiguredSourceInstanceV1): boolean {
  return instance.instance.source.pluginId === INTERNAL_TASK_SOURCE_V1.pluginId && instance.instance.source.localId === INTERNAL_TASK_SOURCE_V1.localId
    && instance.binding.purpose === INTERNAL_TASK_DRAFT_V1.binding.purpose && 'source' in instance.binding && instance.binding.source === 'accountData'
    && instance.localInstanceKey === INTERNAL_TASK_DRAFT_V1.localInstanceKey && instance.configuration.token === INTERNAL_TASK_DRAFT_V1.configuration.token;
}
function admitsRef(ref: TriageSourceEntryLocalRefV1): boolean { return ref.kindId === 'task' && ref.collisionScope === 'personal'; }

function taskDueDate(task: Task): string | null {
  return task.dueAt === undefined ? null : new Date(task.dueAt).toISOString();
}

async function readTasks(context: TriageDataActionContext): Promise<TaskList | null> {
  try {
    const result = await context.services.actions.execute('tasks.internal.list', {}, { signal: context.signal });
    return !isPluginActionApprovalRequestCreated(result) && result.status === 'ok' ? result : null;
  } catch (error) { if (context.signal.aborted) throw error; return null; }
}

function observation(task: Task, list: TaskList,
  children: readonly Task[] = list.todos.filter(candidate => candidate.parentId === task.id),
): Extract<TriageGetResultV1, { kind: 'present' }> {
  const title = projectTriageDisplayTextV1(task.title);
  const dueDate = taskDueDate(task);
  return {
    kind: 'present', localRef: internalTaskLocalRefV1(task.id), locator: { v: 1, displayPath: title.value || task.id, routingToken: task.id },
    snapshot: { v: 1, title: title.value || task.id, scopeLabel: 'Personal', scopeDisplayName: 'Happier',
      state: internalTaskStateV1(task.state), createdAtMs: task.createdAt, facts: [],
      ...(task.labels === undefined ? {} : { labels: task.labels }),
      ...(task.labelColors === undefined ? {} : { labelColors: task.labelColors }),

      ...(dueDate === null ? {} : { dueDate }),
      ...(task.state === 'completed' && task.completedAt !== undefined ? { completedAtMs: task.completedAt } : {}),
      relations: { ...(task.parentId === undefined ? {} : { parent: taskRef(task.parentId) }), blockedBy: (task.blockedBy ?? []).map(taskRef),
        children: { total: children.length, completed: children.filter(child => child.done).length, entries: children.map(child => taskRef(child.id)), complete: true } },
      ...(title.truncated ? { projectionTruncated: true } : {}),
    },
    viewer: { involvement: [...(task.owner === undefined || task.owner === list.scope.accountId ? ['assignee' as const] : []),
      ...(task.createdBy === list.scope.accountId ? ['author' as const] : [])], sourceAttention: { level: 'none' } }, sourceUpdatedAtMs: task.updatedAt,
  };
}

export async function scanInternalTasks(input: TriageScanInputV1, context: TriageDataActionContext): Promise<TriageScanResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance)) return { kind: 'failed', failure: INVALID_ADDRESS };
  const list = await readTasks(context);
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
  const byId = new Map(list.todos.map(task => [task.id, task]));
  const ids = [...new Set([...list.undoneOrder, ...list.completedOrder, ...list.todos.map(task => task.id)])].filter(id => {
    const task = byId.get(id);
    return task !== undefined && (completedSinceMs === undefined || task.state !== 'completed'
      || task.completedAt !== undefined && task.completedAt >= completedSinceMs);
  });
  const start = after === undefined ? 0 : ids.indexOf(after) + 1;
  if (after !== undefined && start === 0) return { kind: 'failed', failure: { class: 'transient', code: 'taskOrderChanged' } };
  const pageIds = ids.slice(start, start + limit);
  const childrenByParent = new Map<string, Task[]>(pageIds.map(id => [id, []]));
  if (pageIds.length > 0) for (const task of list.todos) {
    const parentId = task.parentId;
    if (parentId !== undefined) childrenByParent.get(parentId)?.push(task);
  }
  const page = pageIds.flatMap(id => {
    const task = byId.get(id);
    return task ? [observation(task, list, childrenByParent.get(id))] : [];
  });
  return start + limit >= ids.length
    ? { kind: 'complete', observations: page, evidence: { kind: 'walkFinished' } }
    : { kind: 'page', observations: page, evidence: { kind: 'partial', reason: 'pageLimit' },
      continuation: { v: 1, token: JSON.stringify({ after: ids[start + limit - 1], limit,
        ...(completedSinceMs === undefined ? {} : { completedSinceMs }) }) } };
}

export async function getInternalTask(input: TriageGetInputV1, context: TriageDataActionContext): Promise<TriageGetResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'unresolved', localRef: input.localRef, failure: INVALID_ADDRESS };
  const list = await readTasks(context);
  if (list === null) return { kind: 'unresolved', localRef: input.localRef, failure: UNAVAILABLE };
  const task = list.todos.find(candidate => candidate.id === input.localRef.entryId);
  if (!task) return { kind: 'absent', localRef: input.localRef };
  return { ...observation(task, list), taskFields: {
    title: task.title, body: task.notes ?? '', assigneeIds: task.owner === undefined ? [] : [task.owner],
    labelIds: [...(task.labels ?? [])], dueDate: taskDueDate(task),
    parent: task.parentId === undefined ? null : taskRef(task.parentId), blockedBy: (task.blockedBy ?? []).map(taskRef),
  } };
}

function fieldsFrom(fields: TriageTaskFieldsV1): TaskFields | null {
  const supported = ['title', 'body', 'assigneeIds', 'labelIds', 'dueDate', 'parent', 'blockedBy'];
  if (Object.keys(fields).some(field => !supported.includes(field)) || (fields.assigneeIds?.length ?? 0) > 1
    || (fields.parent != null && !isInternalTaskReferenceV1(fields.parent)) || fields.blockedBy?.some(ref => !isInternalTaskReferenceV1(ref))) return null;
  const dueAt = fields.dueDate == null ? fields.dueDate : Date.parse(fields.dueDate);
  if (typeof dueAt === 'number' && !Number.isFinite(dueAt)) return null;
  return {
    ...(fields.title === undefined ? {} : { title: fields.title }), ...(fields.body === undefined ? {} : { notes: fields.body }),
    ...(fields.assigneeIds === undefined ? {} : { owner: fields.assigneeIds[0] ?? null }),
    ...(fields.labelIds === undefined ? {} : { labels: [...fields.labelIds] }), ...(dueAt === undefined ? {} : { dueAt }),
    ...(fields.parent === undefined ? {} : { parentId: fields.parent === null ? null : fields.parent.entryId }),
    ...(fields.blockedBy === undefined ? {} : { blockedBy: fields.blockedBy.map(ref => ref.entryId) }),
  };
}

type HostWriteResult = PluginActionResultById['tasks.internal.edit'];
async function invokeWrite(operation: () => Promise<HostWriteResult | ActionApprovalRequestCreatedResult>, list: TaskList,
  context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  try { return writeResult(await operation(), list); }
  catch (error) { if (context.signal.aborted) throw error; return { kind: 'uncertain', failure: UNAVAILABLE }; }
}
function writeResult(result: HostWriteResult | ActionApprovalRequestCreatedResult, list: TaskList): TriageTaskWriteResultV1 {
  if (isPluginActionApprovalRequestCreated(result)) return { kind: 'refused', reason: 'approvalRequired' };
  if (result.status === 'applied') return { kind: 'applied', observation: observation(result.todo, { ...list, todos: list.todos.filter(task => task.id !== result.todo.id).concat(result.todo) }) };
  if (result.status === 'uncertain') return { kind: 'uncertain', failure: UNAVAILABLE };
  if (result.status === 'refused') return { kind: 'refused', reason: result.reason };
  return { kind: 'failed', failure: UNAVAILABLE };
}

export async function createInternalTask(input: TriageTaskCreateInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || input.kindId !== 'task') return { kind: 'refused', reason: 'unsupportedKind' };
  const fields = fieldsFrom(input.fields);
  if (!fields) return { kind: 'refused', reason: 'unsupportedField' };
  const list = await readTasks(context);
  if (!list) return { kind: 'failed', failure: UNAVAILABLE };
  return invokeWrite(() => context.services.actions.execute('tasks.internal.create', { fields: {
    title: input.fields.title, ...(fields.notes == null ? {} : { notes: fields.notes }),
    ...(fields.owner == null ? {} : { owner: fields.owner }), ...(fields.dueAt == null ? {} : { dueAt: fields.dueAt }),
    ...(fields.parentId == null ? {} : { parentId: fields.parentId }), ...(fields.blockedBy == null ? {} : { blockedBy: fields.blockedBy }),
    ...(fields.labels == null ? {} : { labels: fields.labels }), createdBy: list.scope.accountId,
  } }, { signal: context.signal }), list, context);
}

export async function editInternalTask(input: TriageTaskEditInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'refused', reason: 'unsupportedKind' };
  const fields = fieldsFrom(input.fields);
  if (!fields) return { kind: 'refused', reason: 'unsupportedField' };
  const list = await readTasks(context);
  if (!list) return { kind: 'failed', failure: UNAVAILABLE };
  return invokeWrite(() => context.services.actions.execute('tasks.internal.edit', { scope: list.scope, taskId: input.localRef.entryId, fields }, { signal: context.signal }), list, context);
}

export async function transitionInternalTask(input: TriageTaskTransitionInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { kind: 'refused', reason: 'unsupportedKind' };
  const state = INTERNAL_TASK_STATES_V1.find(candidate => candidate === input.transitionId);
  if (!state) return { kind: 'refused', reason: 'unsupportedTransition' };
  const list = await readTasks(context);
  if (!list) return { kind: 'failed', failure: UNAVAILABLE };
  return invokeWrite(() => context.services.actions.execute('tasks.internal.transition', { scope: list.scope, taskId: input.localRef.entryId, state }, { signal: context.signal }), list, context);
}

export async function linkInternalTaskSession(input: TriageSourceLinkSessionInputV1, context: TriageDataActionContext): Promise<TriageSourceLinkSessionResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || !admitsRef(input.localRef)) return { status: 'failed' };
  const list = await readTasks(context);
  if (!list) return { status: 'failed' };
  const result = await context.services.actions.execute('tasks.internal.session.link', { scope: list.scope, taskId: input.localRef.entryId,
    session: { ...list.scope, sessionId: input.sessionId }, linked: input.linked }, { signal: context.signal });
  return !isPluginActionApprovalRequestCreated(result) && (result.status === 'linked' || result.status === 'unlinked') ? { status: result.status } : { status: 'failed' };
}

export async function readInternalTaskSessionLinks(input: TriageSourceReadSessionLinksInputV1, context: TriageDataActionContext): Promise<TriageSourceReadSessionLinksResultV1> {
  if (!isInternalTaskConfiguredInstanceV1(input.instance) || (input.localRef !== undefined && !admitsRef(input.localRef))) return { kind: 'failed', failure: INVALID_ADDRESS };
  const list = await readTasks(context);
  if (!list) return { kind: 'failed', failure: UNAVAILABLE };
  const links: Extract<TriageSourceReadSessionLinksResultV1, { kind: 'complete' }>['links'][number][] = [];
  for (const task of list.todos) {
    if (input.localRef !== undefined && input.localRef.entryId !== task.id) continue;
    const seen = new Set<string>();
    for (const [key, link] of Object.entries(task.linkedSessions ?? {})) {
      if (link.session !== undefined && (link.session.serverId !== list.scope.serverId || link.session.accountId !== list.scope.accountId)) continue;
      const sessionId = link.session?.sessionId ?? key;
      if ((input.sessionId !== undefined && input.sessionId !== sessionId) || seen.has(sessionId)) continue;
      seen.add(sessionId);
      links.push({ localRef: internalTaskLocalRefV1(task.id), sessionId, linkedAtMs: link.linkedAt,
        displayPath: projectTriageDisplayTextV1(task.title).value || task.id });
    }
  }
  return { kind: 'complete', links };
}
