import { z } from 'zod';
const scopeIdentity = z.object({ serverId: z.string().min(1), accountId: z.string().min(1) }).strict();
const sessionIdentity = scopeIdentity.extend({ sessionId: z.string().min(1) }).strict();
const linkedSession = z.object({ title: z.string(), linkedAt: z.number(), session: sessionIdentity.optional() }).strict();
/** The existing todo.<id> record, including released bare Session-key links. */
export const TodoItemV1Schema = z.object({
  id: z.string().min(1), title: z.string(), done: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  completedAt: z.number().optional(), linkedSessions: z.record(z.string(), linkedSession).optional(),
}).strict();
export type TodoItemV1 = z.infer<typeof TodoItemV1Schema>;
export const TodoSessionLinkInputV1Schema = z.object({
  scope: scopeIdentity, taskId: z.string().min(1), session: sessionIdentity,
}).strict();
export type TodoSessionLinkInputV1 = z.infer<typeof TodoSessionLinkInputV1Schema>;
export const TodoSessionLinkOutputV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('linked') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('refused'), reason: z.enum(['task_deleted', 'task_scope_mismatch', 'invalid_input']) }).strict(),
  z.object({ status: z.literal('unknown'), reason: z.literal('task_link_failed') }).strict(),
]);
export type TodoSessionLinkOutputV1 = z.infer<typeof TodoSessionLinkOutputV1Schema>;
export class TodoSessionLinkErrorV1 extends Error {
  constructor(readonly code: 'task_deleted' | 'task_scope_mismatch' | 'task_link_failed', readonly cause?: unknown) {
    super(code); this.name = 'TodoSessionLinkError';
  }
}
export type TodoSessionLinkJsonPortV1 = Readonly<{
  read: () => Promise<Readonly<{ value: unknown; version: number }>>;
  compareAndSet: (value: unknown, version: number) => Promise<
    | Readonly<{ success: true; version: number }>
    | Readonly<{ success: false; value: unknown; version: number }>>;
}>;
/** Existing length-prefixed identity; persisted keys do not change in this extraction. */
export function buildTodoSessionLinkKeyV1(session: TodoSessionLinkInputV1['session']): string {
  return [session.serverId, session.accountId, session.sessionId].map(part => `${part.length}:${part}`).join('');
}
/** One semantic KV/CAS owner, shared by accepted creation and Action execution. Never marks Done. */
export async function applyTodoSessionLinkV1(input: TodoSessionLinkInputV1, port: TodoSessionLinkJsonPortV1,
  options: Readonly<{ requireCurrent: () => void; title?: string; publish?: (todo: TodoItemV1, version: number) => void }>): Promise<void> {
  const check = options.requireCurrent;
  try {
    check(); let row = await port.read(); check();
    const key = buildTodoSessionLinkKeyV1(input.session);
    while (true) {
      if (row.value === null) throw new TodoSessionLinkErrorV1('task_deleted');
      const todo = TodoItemV1Schema.parse(row.value);
      if (todo.id !== input.taskId) throw new TodoSessionLinkErrorV1('task_link_failed');
      check();
      const predecessor = todo.linkedSessions?.[input.session.sessionId];
      if (todo.linkedSessions?.[key]?.session || (input.scope.serverId === input.session.serverId
        && input.scope.accountId === input.session.accountId && predecessor && predecessor.session === undefined)) {
        options.publish?.(todo, row.version); return;
      }
      const updated: TodoItemV1 = { ...todo, updatedAt: Date.now(), linkedSessions: { ...todo.linkedSessions,
        [key]: { title: options.title ?? todo.title, linkedAt: Date.now(), session: input.session } } };
      check(); const result = await port.compareAndSet(updated, row.version); check();
      if (result.success) { options.publish?.(updated, result.version); return; }
      row = result;
    }
  } catch (error) {
    if (error instanceof TodoSessionLinkErrorV1) throw error;
    throw new TodoSessionLinkErrorV1('task_link_failed', error);
  }
}
export function projectTodoSessionLinkFailureV1(error: unknown): TodoSessionLinkOutputV1 {
  if (error instanceof TodoSessionLinkErrorV1 && error.code !== 'task_link_failed') return { status: 'refused', reason: error.code };
  // A failed write can have been accepted; the same intent is safe to retry.
  return { status: 'unknown', reason: 'task_link_failed' };
}
