import { describe, expect, it } from 'vitest';
import { InternalTaskListOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from './configuration.js';
import { getInternalTasks } from './source.js';

describe('internal task source batch projection', () => {
  it('keeps owners, shared access and unavailable child membership distinct in one admitted list', async () => {
    const scope = { serverId: 'home', accountId: 'viewer' };
    const instance = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
    const task = { id: 'same-id', title: 'Mine', state: 'unstarted', done: false, createdAt: 1, updatedAt: 2 };
    const list = InternalTaskListOutputSchema.parse({ status: 'ok', scope, undoneOrder: ['same-id'], completedOrder: [],
      todos: [task, { ...task, id: 'child', parentId: task.id },
        { ...task, ownerAccountId: 'other', title: 'Shared', access: 'view', linkedSessions: {
          legacy: { title: 'Owner private work', linkedAt: 1 },
          current: { title: 'Current Home work', linkedAt: 2, session: { ...scope, sessionId: 'visible-session' } },
          foreign: { title: 'Other Home', linkedAt: 3, session: { ...scope, serverId: 'foreign', sessionId: 'hidden-session' } },
        } }],
      unavailableTasks: [{ ownerAccountId: 'other', taskId: 'unavailable', error: 'task_content_unavailable', reason: 'recipient_key_pending' }],
    });
    let lists = 0;
    // Host Action transport is the boundary. The source's join, task content
    // projection and same-Home qualified link rules stay real.
    const context = { signal: new AbortController().signal, services: { actions: { execute: async (id: string) => {
      expect(id).toBe('tasks.internal.list'); lists++; return list;
    } } } } as unknown as Parameters<typeof getInternalTasks>[1];
    const refs = [
      { kindId: 'task', collisionScope: 'personal', entryId: task.id },
      { kindId: 'task', collisionScope: 'account:other', entryId: task.id },
      { kindId: 'task', collisionScope: 'account:other', entryId: 'unavailable' },
      { kindId: 'task', collisionScope: 'account:denied', entryId: task.id },
    ];
    const results = await getInternalTasks(refs.map(localRef => ({ v: 1, instance, localRef })), context);
    expect(lists).toBe(1);
    expect(results[0]?.observation).toMatchObject({ kind: 'present', snapshot: { title: 'Mine', relations: { children: {
      total: 1, completed: 0, complete: true, entries: [{ entryId: 'child', collisionScope: 'personal' }],
    } } } });
    expect(results[1]?.observation).toMatchObject({ kind: 'present', snapshot: { title: 'Shared',
      taskCapabilities: { editFields: [], transitions: [] } } });
    const shared = results[1]!.observation;
    if (shared.kind !== 'present') throw new Error('Expected shared task');
    expect(shared.snapshot.relations).not.toHaveProperty('children');
    expect(results[1]!.sessionLinks).toEqual({ kind: 'complete', links: [{ localRef: refs[1], sessionId: 'visible-session',
      linkedAtMs: 2, displayPath: 'Shared' }] });
    expect(results[2]).toMatchObject({ observation: { kind: 'unresolved', failure: { code: 'accountDataUnavailable', detail: expect.any(String) } },
      sessionLinks: { kind: 'partial', links: [], unavailableRefs: [refs[2]] } });
    expect(results[3]?.observation).toMatchObject({ kind: 'unresolved', failure: { class: 'permission', code: 'task_not_found' } });
  });
});
