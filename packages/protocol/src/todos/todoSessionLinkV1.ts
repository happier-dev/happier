import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '../plugins/actions/protocolComposableSchema.js';
import { TaskResourceErrorV1Schema, TaskResourceV1Schema } from './taskResourceV1.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfileIdV1.js';
export * from './todoLabelColoursV1.js';
const scopeIdentity = z.strictObject({ serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)) });
const sessionIdentity = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scopeIdentity, { sessionId: z.string().check(z.minLength(1)) }));
const linkedSession = z.strictObject({ title: z.string(), linkedAt: z.number(), session: z.optional(sessionIdentity) });
export const TodoStateV1Schema = lazyZodSchema(() => z.enum(['backlog', 'unstarted', 'started', 'ready_for_review', 'completed', 'canceled']));
export type TodoStateV1 = z.infer<typeof TodoStateV1Schema>;
const taskIdentity = defineProtocolString({ minLength: 1 });
export const TodoClaimAttemptBindingV1ProtocolSchema = defineProtocolObject({
  sessionId: taskIdentity, runId: taskIdentity.optional(),
}, { policy: 'closed' });
export type TodoClaimAttemptBindingV1 = ReturnType<typeof TodoClaimAttemptBindingV1ProtocolSchema.parse>;
const taskPullRequest = defineProtocolObject({ url: taskIdentity }, { policy: 'closed' });
const taskDeploymentTarget = defineProtocolObject({ environmentId: taskIdentity, projectSourceId: taskIdentity }, { policy: 'closed' });
const taskFinishMode = defineProtocolUnion([
  defineProtocolLiteral('leave_in_review'), defineProtocolLiteral('mark_completed_on_merge'),
]);
const taskFinishFields = {
  kind: taskFinishMode, prRef: taskPullRequest, sentryIssueId: taskIdentity.optional(), deployTo: taskDeploymentTarget.optional(),
};
const taskFinish = defineProtocolObject(taskFinishFields, { policy: 'closed' });
const taskHandoff = defineProtocolObject({
  ...taskFinishFields, taskId: taskIdentity, attempt: TodoClaimAttemptBindingV1ProtocolSchema,
  mergeCommitSha: projectZodProtocolSchema(ScmCommitOidSchema).optional(), deploymentId: taskIdentity.optional(),
}, { policy: 'closed' });
export const TodoClaimMutationV1ProtocolSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('take'), attemptBinding: TodoClaimAttemptBindingV1ProtocolSchema.optional(),
    replaceAttempt: TodoClaimAttemptBindingV1ProtocolSchema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('release') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('result'), report: defineProtocolString().optional(),
    branch: taskIdentity.optional(), finish: taskFinish.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('merge') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('deployment'), deploymentId: taskIdentity }, { policy: 'closed' }),
]);
export type TodoClaimMutationV1 = ReturnType<typeof TodoClaimMutationV1ProtocolSchema.parse>;
export const TodoReadinessReasonV1ProtocolSchema = defineProtocolUnion([
  defineProtocolLiteral('task_terminal'), defineProtocolLiteral('task_review_pending'), defineProtocolLiteral('task_claimed'),
  defineProtocolLiteral('blocker_unreadable'), defineProtocolLiteral('blocker_not_terminal'),
]);
export const TodoReadinessV1ProtocolSchema = defineProtocolUnion([
  defineProtocolObject({ ready: defineProtocolLiteral(true) }, { policy: 'closed' }),
  defineProtocolObject({ ready: defineProtocolLiteral(false), reason: TodoReadinessReasonV1ProtocolSchema }, { policy: 'closed' }),
]);
export type TodoReadinessV1 = ReturnType<typeof TodoReadinessV1ProtocolSchema.parse>;
export const TodoAssigneeV1ProtocolSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('person'), accountId: taskIdentity }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('session'), sessionId: taskIdentity }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('bot'), botId: taskIdentity }, { policy: 'closed' }),
]);
const todoClaimAttempt = asProtocolZod(TodoClaimAttemptBindingV1ProtocolSchema);
const taskFields = {
  notes: z.optional(z.string()), owner: z.optional(z.string().check(z.minLength(1))), dueAt: z.optional(z.number()),
  assignee: z.optional(asProtocolZod(TodoAssigneeV1ProtocolSchema)),
  parentId: z.optional(z.string().check(z.minLength(1))),
  // Personal ids retain their existing stored shape; other sources keep their
  // complete canonical identity, never a provider id stripped of its scope.
  blockedBy: z.optional(z.array(z.union([z.string().check(z.minLength(1)), asProtocolZod(TriageEntryRefV1Schema)]))),
  labels: z.optional(z.array(z.string())), links: z.optional(z.array(z.strictObject({ url: z.string(), title: z.optional(z.string()) }))),
};
/** The existing todo.<id> record, including released bare Session-key links. */
export const TodoItemV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string(), done: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  completedAt: z.optional(z.number()), linkedSessions: z.optional(z.record(z.string(), linkedSession)),
  attemptBinding: z.optional(todoClaimAttempt), claimedAt: z.optional(z.number()),
  settledClaim: z.optional(z.strictObject({ attempt: todoClaimAttempt, expectedVersion: TaskResourceV1Schema.shape.version })),
  runLink: z.optional(z.strictObject({ sessionId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)) })),
  report: z.optional(z.string()), branch: z.optional(z.string().check(z.minLength(1))),
  planWorker: z.optional(z.strictObject({
    approvalProfileId: z.optional(ApprovalProfileIdV1Schema),
    baseFromTaskId: z.optional(z.string().check(z.minLength(1))),
  })),
  handoff: z.optional(asProtocolZod(taskHandoff)),
  ...taskFields, state: z.optional(TodoStateV1Schema), createdBy: z.optional(z.string().check(z.minLength(1))),
  labelChange: z.optional(z.strictObject({
    version: z.number().check(z.int(), z.nonnegative()), occurredAt: z.number().check(z.int(), z.nonnegative()),
  })),
}));
export const TodoItemV1StoredSchema = createStoredReadSchema(TodoItemV1Schema);
export type TodoItemV1 = z.infer<typeof TodoItemV1Schema>;
/** Existing todo.index order; completed tasks retain their separate newest-first list. */
export const TodoIndexV1Schema = lazyZodSchema(() => z.strictObject({
  undoneOrder: z.array(z.string()), completedOrder: z.array(z.string()),
}));
export const TodoIndexV1StoredSchema = createStoredReadSchema(TodoIndexV1Schema);
export type TodoIndexV1 = z.infer<typeof TodoIndexV1Schema>;
export const TodoCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), title: z.string(), ...taskFields,
  state: z.optional(TodoStateV1Schema),
  createdBy: z.optional(z.string().check(z.minLength(1))),
}));
export type TodoCreateInputV1 = z.infer<typeof TodoCreateInputV1Schema>;
export const TodoItemPatchV1Schema = lazyZodSchema(() => z.strictObject({
  title: z.optional(z.string()),
  ...Object.fromEntries(Object.entries(taskFields).map(([key, schema]) => [key, z.nullable(schema)])) as {
    [K in keyof typeof taskFields]: z.ZodMiniNullable<(typeof taskFields)[K]>
  },
}));
export type TodoItemPatchV1 = z.infer<typeof TodoItemPatchV1Schema>;

/** Predecessor toggles preserve unknown refinements, so done owns the terminal branch. */
export function resolveTodoStateV1(todo: Pick<TodoItemV1, 'done' | 'state'>): TodoStateV1 {
  if (todo.done) return todo.state === 'canceled' ? 'canceled' : 'completed';
  const terminal = todo.state === 'completed' || todo.state === 'canceled';
  return terminal ? 'unstarted' : (todo.state ?? 'unstarted');
}

type TodoBlocker = NonNullable<TodoItemV1['blockedBy']>[number];

/** Evaluate only admitted blocker states. Missing and unreadable blockers remain unresolved. */
export function resolveTodoReadinessV1(todo: Pick<TodoItemV1, 'done' | 'state' | 'attemptBinding' | 'blockedBy'>,
  readBlockerState: (blocker: TodoBlocker) => TodoStateV1 | undefined): TodoReadinessV1 {
  if (todo.done) return { ready: false, reason: 'task_terminal' };
  if (resolveTodoStateV1(todo) === 'ready_for_review') return { ready: false, reason: 'task_review_pending' };
  let blocked = false;
  for (const blocker of todo.blockedBy ?? []) {
    const state = readBlockerState(blocker);
    if (state === undefined) return { ready: false, reason: 'blocker_unreadable' };
    if (state !== 'completed' && state !== 'canceled') blocked = true;
  }
  if (blocked) return { ready: false, reason: 'blocker_not_terminal' };
  return todo.attemptBinding ? { ready: false, reason: 'task_claimed' } : { ready: true };
}

export type TodoClaimObservationV1 =
  | Readonly<{ kind: 'run_terminal'; sessionId: string; runId: string }>
  | Readonly<{ kind: 'host_lost'; sessionId: string; observedAt: number }>
  | Readonly<{ kind: 'question_pending'; sessionId: string; runId?: string }>;

/** The read projection never changes the durable row or treats absence as loss. */
export function deriveTodoClaimReleaseV1(claim: Pick<TodoItemV1, 'attemptBinding' | 'claimedAt'>,
  fact: TodoClaimObservationV1 | undefined): 'run_terminal' | 'host_lost' | null {
  const binding = claim.attemptBinding;
  if (!binding || !fact || fact.sessionId !== binding.sessionId) return null;
  if (fact.kind === 'run_terminal' && fact.runId === binding.runId) return 'run_terminal';
  if (fact.kind === 'host_lost' && claim.claimedAt !== undefined && fact.observedAt >= claim.claimedAt) return 'host_lost';
  return null;
}

/** Change the active attempt while retaining the last Run link and any published report or branch. */
export function transitionTodoClaimV1(todo: TodoItemV1, state: TodoStateV1,
  claim: Extract<TodoClaimMutationV1, { kind: 'take' | 'release' | 'result' }>,
  claimant: TodoClaimAttemptBindingV1 | undefined, readiness: TodoReadinessV1 | undefined, now: number):
  { ok: true; todo: TodoItemV1 } | { ok: false; reason: 'invalid_input' | 'task_claim_lost' | 'task_not_ready' } {
  if (claim.kind === 'take') {
    if (state !== 'started') return { ok: false, reason: 'invalid_input' };
    const attemptBinding = claim.attemptBinding ?? claimant;
    if (!attemptBinding) return { ok: false, reason: 'task_claim_lost' };
    if (claim.replaceAttempt && !sameTodoAttempt(claim.replaceAttempt, todo.attemptBinding)) return { ok: false, reason: 'task_claim_lost' };
    if (readiness?.ready !== true && !(claim.replaceAttempt && readiness?.reason === 'task_claimed')) {
      return { ok: false, reason: 'task_not_ready' };
    }
    return { ok: true, todo: { ...transitionTodoItemV1(todo, state, now), attemptBinding, claimedAt: now,
      assignee: { kind: 'session', sessionId: attemptBinding.sessionId },
      ...(attemptBinding.runId === undefined ? {} : { runLink: { sessionId: attemptBinding.sessionId, runId: attemptBinding.runId } }),
    } };
  }
  if (claim.kind === 'result') {
    if (state !== 'ready_for_review' && state !== 'completed') return { ok: false, reason: 'invalid_input' };
    if (!sameTodoAttempt(claimant, todo.attemptBinding)) return { ok: false, reason: 'task_claim_lost' };
  } else if (state !== 'unstarted' || !todo.attemptBinding) {
    return { ok: false, reason: 'invalid_input' };
  }
  const updated = transitionTodoItemV1(todo, state, now);
  delete updated.attemptBinding;
  delete updated.claimedAt;
  if (claim.kind === 'result') {
    if (claim.report !== undefined) updated.report = claim.report;
    if (claim.branch !== undefined) updated.branch = claim.branch;
  } else if (updated.assignee?.kind === 'session' && updated.assignee.sessionId === todo.attemptBinding?.sessionId) {
    delete updated.assignee;
  }
  return { ok: true, todo: updated };
}

function sameTodoAttempt(a: TodoClaimAttemptBindingV1 | undefined, b: TodoClaimAttemptBindingV1 | undefined): boolean {
  return a !== undefined && b !== undefined && a.sessionId === b.sessionId && a.runId === b.runId;
}

/** The committed Task proves a replay only while it is still the result revision. */
export function matchesTodoClaimResultReplayV1(input: Readonly<{
  todo: TodoItemV1; version: number; expectedVersion: number; state: TodoStateV1;
  claim: Extract<TodoClaimMutationV1, { kind: 'result' }>; claimant: TodoClaimAttemptBindingV1;
}>): boolean {
  const { todo, version, expectedVersion, state, claim, claimant } = input;
  if (version !== expectedVersion + 1 || todo.settledClaim?.expectedVersion !== expectedVersion
    || !sameTodoAttempt(todo.settledClaim.attempt, claimant) || todo.attemptBinding || resolveTodoStateV1(todo) !== state
    || (claim.report !== undefined && claim.report !== todo.report)
    || (claim.branch !== undefined && claim.branch !== todo.branch)) return false;

  const finish = claim.finish;
  const handoff = todo.handoff;
  if (finish === undefined) return handoff === undefined;
  return sameStrictJsonValue(handoff, { ...finish, taskId: todo.id, attempt: claimant }, { omitUndefinedObjectMembers: true });
}
export function createTodoItemV1(input: TodoCreateInputV1, now: number): TodoItemV1 {
  const fields = TodoCreateInputV1Schema.parse(input);
  return transitionTodoItemV1({ ...fields, state: 'unstarted', done: false,
    createdAt: now, updatedAt: now, linkedSessions: {} }, fields.state ?? 'unstarted', now);
}
export function updateTodoItemV1(todo: TodoItemV1, patch: TodoItemPatchV1, now: number): TodoItemV1 {
  const updated = { ...TodoItemV1StoredSchema.parse(todo), updatedAt: now };
  for (const [key, value] of Object.entries(TodoItemPatchV1Schema.parse(patch))) {
    if (value === undefined) continue;
    if (value === null) delete updated[key as keyof TodoItemV1];
    else Object.assign(updated, { [key]: value });
  }
  return TodoItemV1Schema.parse(updated);
}
export function transitionTodoItemV1(todo: TodoItemV1, state: TodoStateV1, now: number): TodoItemV1 {
  const updated = { ...TodoItemV1StoredSchema.parse(todo), state: TodoStateV1Schema.parse(state), updatedAt: now };
  updated.done = state === 'completed' || state === 'canceled';
  if (state !== resolveTodoStateV1(todo)) delete updated.handoff;
  if (updated.done || state === 'ready_for_review') {
    delete updated.attemptBinding;
    delete updated.claimedAt;
  }
  if (updated.done) updated.completedAt = todo.done ? (todo.completedAt ?? now) : now;
  else delete updated.completedAt;
  return TodoItemV1Schema.parse(updated);
}
export const TodoSessionLinkInputV1Schema = lazyZodSchema(() => z.strictObject({
  scope: z.optional(scopeIdentity), taskId: z.string().check(z.minLength(1)), session: z.strictObject({
    serverId: z.optional(scopeIdentity.shape.serverId), accountId: z.optional(scopeIdentity.shape.accountId),
    sessionId: z.string().check(z.minLength(1)),
  }),
  linked: z.optional(z.boolean()), ownerAccountId: z.optional(z.string().check(z.minLength(1))),
}));
export type TodoSessionLinkInputV1 = z.infer<typeof TodoSessionLinkInputV1Schema>;
export type ResolvedTodoSessionLinkInputV1 = Omit<TodoSessionLinkInputV1, 'scope' | 'session'> & Readonly<{
  scope: z.infer<typeof scopeIdentity>; session: z.infer<typeof sessionIdentity>;
}>;
const linkRefusalReason = lazyZodSchema(() => z.union([TaskResourceErrorV1Schema,
  z.enum(['task_deleted', 'task_scope_mismatch', 'invalid_input', 'task_resource_unsupported', 'recipient_key_pending', 'resource_encryption_material_unavailable', 'task_content_invalid']),
]));
type LinkRefusalReason = z.infer<typeof linkRefusalReason>;
export const TodoSessionLinkOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('linked') }),
  z.strictObject({ status: z.literal('unlinked') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('refused'), reason: linkRefusalReason }),
  z.strictObject({ status: z.literal('unknown'), reason: z.literal('task_link_failed') }),
]));
export type TodoSessionLinkOutputV1 = z.infer<typeof TodoSessionLinkOutputV1Schema>;
export class TodoSessionLinkErrorV1 extends Error {
  constructor(readonly code: LinkRefusalReason | 'task_link_failed', readonly cause?: unknown) {
    super(code); this.name = 'TodoSessionLinkError';
  }
}
/** Omitted qualifiers come only from the authenticated host invocation. Explicit Session destinations stay qualified. */
export function resolveTodoSessionLinkInputV1(input: TodoSessionLinkInputV1,
  scope: ResolvedTodoSessionLinkInputV1['scope']): ResolvedTodoSessionLinkInputV1 {
  if (input.scope && (input.scope.serverId !== scope.serverId || input.scope.accountId !== scope.accountId)) {
    throw new TodoSessionLinkErrorV1('task_scope_mismatch');
  }
  return { ...input, scope, session: { serverId: input.session.serverId ?? scope.serverId,
    accountId: input.session.accountId ?? scope.accountId, sessionId: input.session.sessionId } };
}
export type TodoSessionLinkJsonPortV1 = Readonly<{
  read: () => Promise<Readonly<{ value: unknown; version: number }>>;
  compareAndSet: (value: unknown, version: number) => Promise<
    | Readonly<{ success: true; version: number }>
    | Readonly<{ success: false; value: unknown; version: number }>>;
}>;
/** Existing length-prefixed identity; persisted keys do not change in this extraction. */
export function buildTodoSessionLinkKeyV1(session: ResolvedTodoSessionLinkInputV1['session']): string {
  return [session.serverId, session.accountId, session.sessionId].map(part => `${part.length}:${part}`).join('');
}
/** One semantic KV/CAS owner, shared by accepted creation and Action execution. Never marks Done. */
export async function applyTodoSessionLinkV1(input: ResolvedTodoSessionLinkInputV1, port: TodoSessionLinkJsonPortV1,
  options: Readonly<{ requireCurrent: () => void; title?: string; publish?: (todo: TodoItemV1, version: number) => void }>): Promise<void> {
  const check = options.requireCurrent;
  try {
    check(); let row = await port.read(); check();
    const key = buildTodoSessionLinkKeyV1(input.session);
    while (true) {
      if (row.value === null) throw new TodoSessionLinkErrorV1('task_deleted');
      const todo = TodoItemV1StoredSchema.parse(row.value);
      if (todo.id !== input.taskId) throw new TodoSessionLinkErrorV1('task_link_failed');
      check();
      const predecessor = todo.linkedSessions?.[input.session.sessionId];
      const bareMatches = input.scope.serverId === input.session.serverId
        && (input.ownerAccountId ?? input.scope.accountId) === input.session.accountId && predecessor && predecessor.session === undefined;
      const qualifiedMatches = todo.linkedSessions?.[key]?.session !== undefined;
      const linked = input.linked !== false;
      if (linked ? (qualifiedMatches || bareMatches) : (!qualifiedMatches && !bareMatches)) {
        options.publish?.(todo, row.version); return;
      }
      const linkedSessions = { ...todo.linkedSessions };
      const now = Date.now();
      if (linked) linkedSessions[key] = { title: options.title ?? todo.title, linkedAt: now, session: input.session };
      else {
        if (qualifiedMatches) delete linkedSessions[key];
        if (bareMatches) delete linkedSessions[input.session.sessionId];
      }
      const updated: TodoItemV1 = { ...todo, updatedAt: now, linkedSessions };
      check(); const result = await port.compareAndSet(updated, row.version); check();
      if (result.success) { options.publish?.(updated, result.version); return; }
      row = result;
    }
  } catch (error) {
    if (error instanceof TodoSessionLinkErrorV1) throw error;
    const refusal = linkRefusalReason.safeParse(error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);
    if (refusal.success) throw new TodoSessionLinkErrorV1(refusal.data, error);
    throw new TodoSessionLinkErrorV1('task_link_failed', error);
  }
}
export function projectTodoSessionLinkFailureV1(error: unknown): TodoSessionLinkOutputV1 {
  if (error instanceof TodoSessionLinkErrorV1 && error.code !== 'task_link_failed') return { status: 'refused', reason: error.code };
  // A failed write can have been accepted; the same intent is safe to retry.
  return { status: 'unknown', reason: 'task_link_failed' };
}
