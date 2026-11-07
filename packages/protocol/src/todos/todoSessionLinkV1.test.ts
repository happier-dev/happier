import { describe, expect, it } from 'vitest';

import {
  applyTodoSessionLinkV1, buildTodoSessionLinkKeyV1, TodoItemV1Schema, TodoItemV1StoredSchema,
  TodoSessionLinkInputV1Schema, type TodoItemV1,
  createTodoItemV1, updateTodoItemV1, transitionTodoItemV1, resolveTodoStateV1,
  projectTodoSessionLinkFailureV1,
  resolveTodoSessionLinkInputV1,
} from './todoSessionLinkV1.js';

describe('stored Todo session linking', () => {
  it('defaults omitted Session qualifiers even when an adapter supplies optional undefined properties', () => {
    const scope = { serverId: 'home', accountId: 'viewer' };
    const input = TodoSessionLinkInputV1Schema.parse({ taskId: 'task', session: {
      sessionId: 'accepted', serverId: undefined, accountId: undefined,
    } });
    expect(resolveTodoSessionLinkInputV1(input, scope)).toEqual({ scope, taskId: 'task', session: { ...scope, sessionId: 'accepted' } });
  });
  it('keeps the task owner separate from the viewer when interpreting predecessor bare Session links', async () => {
    const input = { scope: { serverId: 'home', accountId: 'viewer' }, ownerAccountId: 'owner', taskId: 'task',
      session: { serverId: 'home', accountId: 'viewer', sessionId: 'existing' } };
    expect(TodoSessionLinkInputV1Schema.safeParse(input).success).toBe(true);
    let published: TodoItemV1 | undefined;
    await applyTodoSessionLinkV1(input, {
      read: async () => ({ value: predecessor, version: 1 }),
      compareAndSet: async () => ({ success: true, version: 2 }),
    }, { requireCurrent: () => {}, publish: todo => { published = todo; } });
    expect(published?.linkedSessions).toMatchObject({ existing: predecessor.linkedSessions.existing,
      [buildTodoSessionLinkKeyV1(input.session)]: { session: input.session } });
  });

  it('preserves a next-request task denial instead of reporting an uncertain link write', async () => {
    const input = { scope: { serverId: 'home', accountId: 'viewer' }, taskId: 'task',
      session: { serverId: 'home', accountId: 'viewer', sessionId: 'existing' } };
    try {
      await applyTodoSessionLinkV1(input, {
        read: async () => { throw Object.assign(new Error('task_not_found'), { code: 'task_not_found' }); },
        compareAndSet: async () => { throw new Error('denied read cannot write'); },
      }, { requireCurrent: () => {} });
      throw new Error('Denied read must fail');
    } catch (error) { expect(projectTodoSessionLinkFailureV1(error)).toEqual({ status: 'refused', reason: 'task_not_found' }); }
  });
  // Vector from the clean live 0.2 todoOps.ts producer contract at
  // f16a3759a3944bc4be4bbb7e14a3e6a01397f7b5 (addTodo/toggleTodo/updateTodoLinkedSessions).
  const predecessor = { id: 'task', title: 'Task', done: false, createdAt: 1, updatedAt: 2,
    linkedSessions: { existing: { title: 'Existing', linkedAt: 2 } } };

  it('retains qualified blockers beside personal ids and validates them through the shared identity owner', () => {
    const external = { source: { pluginId: 'acme.tracker', localId: 'issues' },
      kindId: 'issue', collisionScope: 'project-1', entryId: 'blocker' };
    const created = createTodoItemV1({ id: 'new', title: 'New', blockedBy: ['blocker', external] }, 10);
    expect(created.blockedBy).toEqual(['blocker', external]);
    expect(TodoItemV1Schema.parse(JSON.parse(JSON.stringify(created)))).toEqual(created);
    expect(updateTodoItemV1(created, { title: 'Edited' }, 11).blockedBy).toEqual(['blocker', external]);
    expect(transitionTodoItemV1(created, 'completed', 12).blockedBy).toEqual(['blocker', external]);
    const retained = { ...created, retired: true, blockedBy: ['blocker', {
      ...external, retired: true, source: { ...external.source, retired: true },
    }] };
    expect(TodoItemV1StoredSchema.parse(retained)).toEqual(created);
    expect(TodoItemV1Schema.safeParse(retained).success).toBe(false);
    for (const blocker of [
      { ...external, entryId: '' }, { ...external, source: { pluginId: 'acme.tracker' } },
      { ...external, sourceInstanceId: 'not-identity' },
    ]) expect(TodoItemV1Schema.safeParse({ ...created, blockedBy: [blocker] }).success).toBe(false);
    expect(TodoItemV1StoredSchema.safeParse({ ...created, blockedBy: [{ ...external, entryId: '' }] }).success).toBe(false);
    expect(TodoItemV1StoredSchema.parse(predecessor)).toEqual(predecessor);
  });

  it('retains predecessor records and projects task state into the existing done fields', () => {
    expect(TodoItemV1Schema.parse(predecessor)).toEqual(predecessor);
    expect(resolveTodoStateV1(predecessor)).toBe('unstarted');
    expect(resolveTodoStateV1({ ...predecessor, done: true })).toBe('completed');
    const fields = { id: 'new', title: 'New', notes: 'Details', owner: 'account', dueAt: 20,
      parentId: 'parent', blockedBy: ['blocker'], labels: ['bug'], links: [{ url: 'https://example.com', title: 'Context' }],
      createdBy: 'author' };
    const created = createTodoItemV1(fields, 10);
    expect(created).toMatchObject({ ...fields, state: 'unstarted', done: false, createdAt: 10, updatedAt: 10 });
    expect(TodoItemV1Schema.parse(created)).toEqual(created);
    const canceled = transitionTodoItemV1(created, 'canceled', 12);
    expect(canceled).toMatchObject({ state: 'canceled', done: true, completedAt: 12, updatedAt: 12 });
    expect(resolveTodoStateV1(canceled)).toBe('canceled');
    expect(transitionTodoItemV1(canceled, 'completed', 13).completedAt).toBe(12);
    const reopened = transitionTodoItemV1(canceled, 'started', 14);
    expect(reopened).toMatchObject({ state: 'started', done: false, updatedAt: 14 });
    expect(resolveTodoStateV1(reopened)).toBe('started');
    expect(reopened).not.toHaveProperty('completedAt');
    expect(updateTodoItemV1(created, { notes: null, parentId: null, blockedBy: [], title: 'Edited' }, 15)).toEqual({
      ...created, notes: undefined, parentId: undefined, blockedBy: [], title: 'Edited', updatedAt: 15,
    });
    expect(() => updateTodoItemV1(created, { dueAt: 'tomorrow' } as unknown as Parameters<typeof updateTodoItemV1>[1], 15)).toThrow();
    const unexpected = { ...fields, retired: true };
    expect(() => createTodoItemV1(unexpected, 15)).toThrow();
  });

  it('projects predecessor toggle writes that retain a stale task-state refinement', () => {
    const started = transitionTodoItemV1(predecessor, 'started', 3);
    // Exact updatedTodo spread/overrides from the clean predecessor writer:
    // ../0.2/apps/ui/sources/sync/domains/todos/todoOps.ts:409-414 at the pinned HEAD above.
    const completedByPredecessor = { ...started, done: !started.done, updatedAt: 4,
      completedAt: !started.done ? 4 : undefined };
    expect(TodoItemV1Schema.parse(completedByPredecessor)).toEqual(completedByPredecessor);
    expect(resolveTodoStateV1(completedByPredecessor)).toBe('completed');
    for (const terminal of ['completed', 'canceled'] as const) {
      const current = transitionTodoItemV1(predecessor, terminal, 3);
      const reopenedByPredecessor = { ...current, done: !current.done, updatedAt: 4,
        completedAt: !current.done ? 4 : undefined };
      expect(TodoItemV1Schema.parse(reopenedByPredecessor)).toEqual(reopenedByPredecessor);
      expect(resolveTodoStateV1(reopenedByPredecessor)).toBe('unstarted');
    }
  });

  it('unlinks both matching formats after a CAS conflict without losing fields or other accounts links', async () => {
    const session = { serverId: 'home', accountId: 'account', sessionId: 'existing' };
    const foreign = { ...session, accountId: 'other-account' };
    const key = buildTodoSessionLinkKeyV1(session);
    const otherKey = buildTodoSessionLinkKeyV1(foreign);
    const todo = { ...predecessor, notes: 'Keep notes', state: 'started',
      linkedSessions: { ...predecessor.linkedSessions, [key]: { title: 'Qualified', linkedAt: 3, session },
        [otherKey]: { title: 'Other account', linkedAt: 3, session: foreign } } };
    let published: TodoItemV1 | undefined;
    const written: unknown[] = [];
    await applyTodoSessionLinkV1({ scope: { serverId: 'home', accountId: 'account' }, taskId: 'task', session, linked: false }, {
      read: async () => ({ value: todo, version: 1 }),
      compareAndSet: async (value, version) => {
        written.push(value);
        return version === 1 ? { success: false, value: { ...todo, notes: 'Concurrent notes' }, version: 2 }
          : { success: true, version: 3 };
      },
    }, { requireCurrent: () => {}, publish: value => { published = value; } });
    expect(written).toHaveLength(2);
    expect(published).toMatchObject({ notes: 'Concurrent notes', state: 'started', done: false });
    expect(published?.linkedSessions).toEqual({ [otherKey]: todo.linkedSessions[otherKey] });
  });

  it('does not unlink a bare Session key from a different Account scope', async () => {
    let published: TodoItemV1 | undefined;
    await applyTodoSessionLinkV1({ scope: { serverId: 'home', accountId: 'account' }, taskId: 'task',
      session: { serverId: 'home', accountId: 'other-account', sessionId: 'existing' }, linked: false }, {
      read: async () => ({ value: predecessor, version: 1 }),
      compareAndSet: async () => { throw new Error('Unrelated links must not be written'); },
    }, { requireCurrent: () => {}, publish: value => { published = value; } });
    expect(published).toEqual(predecessor);
  });

  it('links retained rows with retired fields and writes only the canonical shape after a CAS retry', async () => {
    const session = { serverId: 'home', accountId: 'account', sessionId: 'new-session' };
    const input = { scope: { serverId: 'home', accountId: 'account' }, taskId: 'task', session };
    const todo = { id: 'task', title: 'Task', done: false, createdAt: 1, updatedAt: 2,
      retired: true, linkedSessions: { previous: { title: 'Previous', linkedAt: 1, retired: true } } };
    const retried = { ...todo, linkedSessions: { ...todo.linkedSessions,
      concurrent: { title: 'Concurrent', linkedAt: 2, retired: true,
        session: { serverId: 'home', accountId: 'account', sessionId: 'concurrent', retired: true } } } };
    const written: unknown[] = [];
    let published: TodoItemV1 | undefined;
    await applyTodoSessionLinkV1(input, {
      read: async () => ({ value: todo, version: 1 }),
      compareAndSet: async (value, version) => {
        written.push(value);
        return version === 1 ? { success: false, value: retried, version: 2 }
          : { success: true, version: 3 };
      },
    }, { requireCurrent: () => {}, publish: value => { published = value; } });
    expect(written).toHaveLength(2);
    expect(published?.done).toBe(false);
    expect(published?.linkedSessions).toMatchObject({
      previous: { title: 'Previous', linkedAt: 1 },
      concurrent: { title: 'Concurrent', linkedAt: 2, session: { serverId: 'home', accountId: 'account', sessionId: 'concurrent' } },
      [buildTodoSessionLinkKeyV1(session)]: { title: 'Task', session },
    });
    expect(TodoItemV1Schema.safeParse(published).success).toBe(true);
    expect(published).not.toHaveProperty('retired');
    expect(published?.linkedSessions?.previous).not.toHaveProperty('retired');
    expect(published?.linkedSessions?.concurrent.session).not.toHaveProperty('retired');
    expect(TodoItemV1Schema.safeParse(todo).success).toBe(false);
    expect(TodoSessionLinkInputV1Schema.safeParse({ ...input, retired: true }).success).toBe(false);
  });

  it('still refuses malformed known stored fields', async () => {
    await expect(applyTodoSessionLinkV1({ scope: { serverId: 'home', accountId: 'account' }, taskId: 'task',
      session: { serverId: 'home', accountId: 'account', sessionId: 'new-session' } }, {
      read: async () => ({ value: { id: 'task', title: 'Task', done: 'false', createdAt: 1, updatedAt: 2, retired: true }, version: 1 }),
      compareAndSet: async () => { throw new Error('Malformed rows must not be written'); },
    }, { requireCurrent: () => {} })).rejects.toMatchObject({ code: 'task_link_failed' });
  });
});
