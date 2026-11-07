import { expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { InternalTaskEditInputSchema, InternalTaskListOutputSchema } from './internalTaskActions.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

it('dispatches internal tasks without intercepting unrelated Agent Actions', async () => {
  // Only the client/daemon transport boundaries are substituted; admission and dispatch are real.
  const deps = {
    internalTaskAction: async () => ({ status: 'ok' as const,
      scope: { serverId: 'home', accountId: 'viewer' }, todos: [], undoneOrder: [], completedOrder: [] }),
    machineAgentInstallRead: async () => ({ ok: true as const, events: [], steps: [], progress: [],
      nextCursor: 0, done: false, outcome: null }),
  } satisfies Partial<ActionExecutorDeps>;
  const executor = createActionExecutor(deps as ActionExecutorDeps);
  const context = { surface: 'agent', authority: 'account_automation', serverId: 'home' } as const;
  expect(await executor.execute('tasks.internal.list', {}, context)).toMatchObject({ ok: true,
    result: { status: 'ok', scope: { serverId: 'home', accountId: 'viewer' }, todos: [] } });
  expect(await executor.execute('machines.agents.install.status', { machineId: 'machine', jobId: 'install-job' }, context))
    .toEqual({ ok: true, result: { ok: true, events: [], steps: [], progress: [], nextCursor: 0, done: false, outcome: null } });
});

it('publishes the canonical personal-task Actions and removes the replaced todo Action identities', () => {
  for (const id of ['tasks.internal.list', 'tasks.internal.create', 'tasks.internal.edit', 'tasks.internal.transition', 'tasks.internal.reorder', 'tasks.internal.session.link']) {
    expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
  }
  expect(ActionIdSchema.safeParse('todos.reorder').success).toBe(false);
  expect(ActionIdSchema.safeParse('todos.session.link').success).toBe(false);
});

it('admits the shared-task read and access operations through the public Action vocabulary', () => {
  for (const id of ['tasks.internal.read', 'tasks.internal.share', 'tasks.internal.unshare', 'tasks.internal.grants', 'tasks.internal.prepare']) {
    expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
  }
});

it('keeps the authenticated viewer separate from the addressed task owner', () => {
  const input = { scope: { serverId: 'home', accountId: 'viewer' }, ownerAccountId: 'owner', taskId: 'same-id', fields: { title: 'Edited' } };
  expect(InternalTaskEditInputSchema.safeParse(input)).toMatchObject({ success: true, data: input });
  const task = { id: 'same-id', title: 'Shared', state: 'unstarted', done: false, createdAt: 1, updatedAt: 1 };
  const output = { status: 'ok', scope: input.scope, undoneOrder: [], completedOrder: [], todos: [
    { ...task, ownerAccountId: 'viewer', access: 'owner' },
    { ...task, ownerAccountId: 'owner', access: 'edit' },
  ] };
  expect(InternalTaskListOutputSchema.safeParse(output)).toMatchObject({ success: true, data: output });
});
