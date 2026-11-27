import { describe, expect, it } from 'vitest';
import { ACCOUNT_KV_MUTATION_BATCH_MAX } from '../account/accountJsonKv.js';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from './todoActionOperationsV1.js';
import { createTodoItemV1 } from './todoSessionLinkV1.js';

describe('Internal Task Action revisions', () => {
  it('adopts the exact plan graph in one Task write, retaining only worker hints', async () => {
    const fixture = planGraphFixture();
    const result = await fixture.adopt({
      approvalProfileId: 'custom:lead',
      tasks: [
        { id: 'implementation', title: 'Implement', details: 'Write the change' },
        { id: 'review', title: 'Review', blockedBy: ['implementation'], baseFromTaskId: 'implementation' },
        { id: 'verify', title: 'Verify', blockedBy: ['implementation', 'review'] },
      ],
    });
    expect(result).toMatchObject({ status: 'plan_applied' });
    if (result.status !== 'plan_applied') throw new Error('Plan was not applied');
    const [implementation, review, verify] = result.tasks.map(task => task.taskId);
    expect(result.tasks.map(task => task.planTaskId)).toEqual(['implementation', 'review', 'verify']);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.rows.get('todo.index')).toMatchObject({ value: { undoneOrder: [implementation, review, verify] } });
    expect(fixture.rows.get(`todo.${implementation}`)).toMatchObject({ value: {
      title: 'Implement', notes: 'Write the change', planWorker: { approvalProfileId: 'custom:lead' },
    } });
    expect(fixture.rows.get(`todo.${review}`)).toMatchObject({ value: {
      blockedBy: [implementation], planWorker: { approvalProfileId: 'custom:lead', baseFromTaskId: implementation },
    } });
    expect(fixture.rows.get(`todo.${verify}`)).toMatchObject({ value: { blockedBy: [implementation, review] } });
    for (const task of result.tasks) expect(fixture.rows.get(`todo.${task.taskId}`)?.value).not.toHaveProperty('sessionConsents');
  });

  it.each([
    { tasks: [{ id: 'first', title: 'First', blockedBy: ['missing'] }] },
    { tasks: [{ id: 'first', title: 'First', blockedBy: ['second'] }, { id: 'second', title: 'Second', blockedBy: ['first'] }] },
    { tasks: [{ id: 'first', title: 'First', blockedBy: ['first'] }] },
    { tasks: [{ id: 'first', title: 'First' }, { id: 'first', title: 'Duplicate' }] },
    { tasks: [{ id: 'first', title: 'First', sessionConsents: ['allow-all'] }] },
  ])('refuses a malformed or cyclic plan before committing any Task (%j)', async ({ tasks }) => {
    const fixture = planGraphFixture();
    expect(await fixture.adopt({ tasks })).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect(fixture.writes).toHaveLength(0);
  });

  it('reuses the Account KV transaction boundary and never commits a partial or duplicate graph', async () => {
    const fixture = planGraphFixture();
    const tasks = Array.from({ length: ACCOUNT_KV_MUTATION_BATCH_MAX }, (_, index) => ({ id: String(index), title: `Task ${index}` }));
    expect(await fixture.adopt({ tasks })).toEqual({ status: 'refused', reason: 'task_plan_batch_too_large' });
    expect(fixture.writes).toHaveLength(0);
    const fitsOneWrite = tasks.slice(1);
    expect(await fixture.adopt({ tasks: fitsOneWrite })).toMatchObject({ status: 'plan_applied' });
    const committed = new Map(fixture.rows);
    expect(committed.size).toBe(ACCOUNT_KV_MUTATION_BATCH_MAX);
    expect(await fixture.adopt({ tasks: fitsOneWrite })).toEqual({ status: 'refused', reason: 'task_already_exists' });
    expect(fixture.rows).toEqual(committed);
  });

  it('retains the committed label membership change across equivalent edits', async () => {
    let value: unknown = null;
    let version = -1;
    const port: AccountJsonKvCollectionPort = {
      read: async (key) => key === 'todo.task' ? { value, version } : { value: null, version: 0 },
      list: async () => [],
      mutate: async mutations => {
        const row = mutations.find(mutation => mutation.key === 'todo.task')!;
        if (row.version !== version) return { success: false, errors: [{ key: row.key, value, version }] };
        value = row.value;
        version = row.version + 1;
        return { success: true, results: mutations.map(mutation => ({ key: mutation.key, version: mutation.version + 1 })) };
      },
    };
    const base = { scope: { serverId: 'home', accountId: 'account' }, port, requireCurrent() {}, createId: () => 'task' };
    await expect(executeInternalTaskAction({ ...base, actionId: 'tasks.internal.create',
      input: { fields: { title: 'Queue item' } },
    })).resolves.toMatchObject({ status: 'applied', todo: { version: 0 } });
    expect(value).not.toHaveProperty('labelChange');
    const edit = (fields: { labels?: string[]; notes?: string }, expectedVersion?: number) => executeInternalTaskAction({
      ...base, actionId: 'tasks.internal.edit', input: { taskId: 'task', ownerAccountId: 'account', expectedVersion, fields },
    });
    await expect(edit({ labels: ['first', 'second'] }, 0)).resolves.toMatchObject({
      status: 'applied', todo: { version: 1, labelChange: { version: 1, occurredAt: expect.any(Number) } },
    });
    await expect(edit({ labels: ['second', 'first'], notes: 'Revised' })).resolves.toMatchObject({
      status: 'applied', todo: { version: 2, labelChange: { version: 1 } },
    });
    expect(value).toMatchObject({ labels: ['second', 'first'], labelChange: { version: 1 } });
    await expect(edit({ labels: [] })).resolves.toMatchObject({
      status: 'applied', todo: { version: 3, labelChange: { version: 3 } },
    });
  });

  it('keeps the caller revision when the stored Task has already advanced', async () => {
    const todo = createTodoItemV1({ id: 'task', title: 'First writer' }, 1);
    const port: AccountJsonKvCollectionPort = {
      read: async key => key === 'todo.task' ? { value: todo, version: 2 } : { value: null, version: 0 },
      list: async () => [],
      mutate: async mutations => {
        if (mutations.some(mutation => mutation.key === 'todo.task' && mutation.version !== 2)) {
          return { success: false, errors: [{ key: 'todo.task', value: todo, version: 2 }] };
        }
        throw new Error('A stale writer must never replace the latest revision');
      },
    };
    const invocation = {
      scope: { serverId: 'home', accountId: 'account' }, port, requireCurrent() {}, createId: () => 'unused',
    };
    expect(await executeInternalTaskAction({ ...invocation, actionId: 'tasks.internal.read', input: { taskId: 'task' } }))
      .toMatchObject({ status: 'applied', todo: { version: 2 } });
    expect(await executeInternalTaskAction({ ...invocation, actionId: 'tasks.internal.edit',
      input: { taskId: 'task', expectedVersion: 1, fields: { title: 'Stale writer' } },
    })).toEqual({ status: 'refused', reason: 'task_version_conflict' });
  });

  it('excludes unreadable blockers and keeps result-back bound to the exact attempt', async () => {
    let todo = { ...createTodoItemV1({ id: 'task', title: 'Dependency', blockedBy: ['hidden'] }, 1),
      report: 'Prior check passed', branch: 'worker/prior-task' };
    let version = 1;
    const rows = () => [{ key: 'todo.task', value: todo, version }];
    const port: AccountJsonKvCollectionPort = {
      read: async key => rows().find(row => row.key === key) ?? { value: null, version: 0 },
      list: async () => rows(),
      mutate: async mutations => {
        const write = mutations.find(mutation => mutation.key === 'todo.task')!;
        if (write.version !== version) return { success: false, errors: rows() };
        todo = write.value as typeof todo;
        version += 1;
        return { success: true, results: mutations.map(mutation => ({ key: mutation.key, version: mutation.version + 1 })) };
      },
    };
    const base = { scope: { serverId: 'home', accountId: 'account' }, port, requireCurrent() {}, createId: () => 'unused' };
    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.list', input: { ready: true } }))
      .toMatchObject({ status: 'ok', todos: [], notReadyTasks: [{ taskId: 'task', reason: 'blocker_unreadable' }] });

    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.edit',
      input: { taskId: 'task', expectedVersion: 1, fields: { blockedBy: null } },
    })).toMatchObject({ status: 'applied' });
    const prior = { sessionId: 'worker', runId: 'old-run' };
    const take = { taskId: 'task', expectedVersion: 2, state: 'started', claim: { kind: 'take' } };
    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.transition',
      input: take,
    })).toEqual({ status: 'refused', reason: 'task_claim_lost' });
    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.transition',
      input: take, claimant: prior,
    })).toMatchObject({ status: 'applied', todo: { attemptBinding: prior, runLink: prior } });
    const release = await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.transition',
      input: { taskId: 'task', expectedVersion: 3, state: 'unstarted', claim: { kind: 'release' } },
    });
    expect(release).toMatchObject({ status: 'applied', todo: {
      state: 'unstarted', report: 'Prior check passed', branch: 'worker/prior-task', runLink: prior,
    } });
    if (release.status !== 'applied' || !('todo' in release)) throw new Error('Release was not applied');
    expect(release.todo.attemptBinding).toBeUndefined();
    const binding = { sessionId: 'worker', runId: 'new-run' };
    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.transition',
      input: { taskId: 'task', expectedVersion: 4, state: 'started', claim: { kind: 'take', attemptBinding: binding } },
    })).toMatchObject({ status: 'applied', todo: { attemptBinding: binding, runLink: binding } });
    const outcome = { taskId: 'task', expectedVersion: 5, state: 'ready_for_review', claim: { kind: 'result', branch: 'worker/task' } };
    expect(await executeInternalTaskAction({ ...base, actionId: 'tasks.internal.transition', input: outcome,
      claimant: prior,
    })).toEqual({ status: 'refused', reason: 'task_claim_lost' });
    const applied = await executeInternalTaskAction({
      ...base, actionId: 'tasks.internal.transition', input: outcome, claimant: binding,
    });
    expect(applied).toMatchObject({ status: 'applied', todo: { state: 'ready_for_review', branch: 'worker/task', runLink: binding } });
    if (applied.status !== 'applied' || !('todo' in applied)) throw new Error('Result was not applied');
    expect(applied.todo.attemptBinding).toBeUndefined();
  });

  it('hands off only the claimed Task to an open PR and completes it only after that PR is verified merged', async () => {
    const handoff = linkedTaskFixture();
    const deployTo = { environmentId: 'production', projectSourceId: 'project-source' };
    const result = { kind: 'result', report: 'Reviewed exact changes', finish: { kind: 'mark_completed_on_merge',
      prRef: handoff.prRef, sentryIssueId: 'incident-6', deployTo } };
    handoff.pr = { ...handoff.pr, url: 'https://github.com/my-org/other/pull/2' };
    await expect(handoff.transition(1, 'ready_for_review', result)).resolves.toEqual({ status: 'refused', reason: 'task_pr_mismatch' });
    expect(handoff.current()).toMatchObject({ version: 1, todo: { state: 'started', attemptBinding: handoff.attempt } });

    handoff.pr = { ...handoff.pr, ...handoff.prRef };
    await expect(handoff.transition(1, 'ready_for_review', result, { ...handoff.attempt, runId: 'stale' })).resolves
      .toEqual({ status: 'refused', reason: 'task_claim_lost' });
    await expect(handoff.transition(1, 'ready_for_review', result)).resolves.toMatchObject({ status: 'applied', todo: {
      version: 2, state: 'ready_for_review', report: 'Reviewed exact changes', handoff: { prRef: handoff.prRef },
    } });
    expect(handoff.current().todo.attemptBinding).toBeUndefined();
    expect(handoff.current().todo.runLink).toEqual(handoff.attempt);

    const merge = { kind: 'merge' };
    await expect(handoff.transition(2, 'completed', merge)).resolves.toEqual({ status: 'refused', reason: 'task_pr_not_merged' });
    handoff.pr = { ...handoff.pr, state: 'merged', mergeCommitSha: handoff.sha };
    await expect(handoff.transition(1, 'completed', merge)).resolves.toEqual({ status: 'refused', reason: 'task_version_conflict' });
    await expect(handoff.transition(2, 'completed', merge)).resolves.toMatchObject({ status: 'applied', todo: {
      version: 3, state: 'completed', handoff: { prRef: handoff.prRef, mergeCommitSha: handoff.sha },
    } });
    handoff.prAvailable = false;
    handoff.deployment = { ...deployTo, deploymentId: 'deploy-5', state: 'failed', sha: handoff.sha };
    await expect(handoff.transition(3, 'unstarted', { kind: 'deployment', deploymentId: 'deploy-5' })).resolves.toMatchObject({
      status: 'applied', todo: { version: 4, state: 'unstarted', handoff: { deploymentId: 'deploy-5', mergeCommitSha: handoff.sha } },
    });
  });

  it.each([{ status: 'succeeded', state: 'completed' }, { status: 'failed', state: 'unstarted' }] as const)(
    'applies a $status deploy only to the linked incident Task with an exact verified repository revision', async ({ status, state }) => {
      const handoff = linkedTaskFixture();
      const deployTo = { environmentId: 'production', projectSourceId: 'service-source' };
      await expect(handoff.transition(1, 'ready_for_review', { kind: 'result', finish: {
        kind: 'leave_in_review', prRef: handoff.prRef, sentryIssueId: 'incident-53', deployTo,
      } })).resolves.toMatchObject({ status: 'applied', todo: { state: 'ready_for_review', handoff: {
        taskId: 'task', sentryIssueId: 'incident-53', prRef: handoff.prRef,
      } } });
      handoff.pr = { ...handoff.pr, state: 'merged', mergeCommitSha: handoff.sha };
      await expect(handoff.transition(2, 'completed', { kind: 'merge' })).resolves.toEqual({ status: 'refused', reason: 'task_handoff_mismatch' });
      const deploy = { kind: 'deployment', deploymentId: 'deploy-6' };
      handoff.deployment = { ...deployTo, deploymentId: 'other-deploy', state: status, sha: handoff.sha };
      await expect(handoff.transition(2, state, deploy)).resolves.toEqual({ status: 'refused', reason: 'task_deployment_mismatch' });
      handoff.deployment = { ...handoff.deployment, deploymentId: 'deploy-6', sha: 'a'.repeat(40) };
      await expect(handoff.transition(2, state, deploy)).resolves.toEqual({ status: 'refused', reason: 'task_deployment_mismatch' });
      expect(handoff.current()).toMatchObject({ version: 2, todo: { state: 'ready_for_review' } });
      handoff.deployment = { ...handoff.deployment, sha: handoff.sha };
      await expect(handoff.transition(2, state, deploy)).resolves.toMatchObject({ status: 'applied', todo: { version: 3, state } });
      await expect(handoff.transition(3, state, deploy)).resolves.toEqual({ status: 'refused', reason: 'task_handoff_mismatch' });
    },
  );
});

function planGraphFixture() {
  const rows = new Map<string, { key: string; value: unknown; version: number }>();
  const writes: unknown[] = [];
  const port: AccountJsonKvCollectionPort = {
    read: async key => rows.get(key) ?? { value: null, version: -1 },
    list: async () => [...rows.values()],
    mutate: async mutations => {
      writes.push(mutations);
      const errors = mutations.flatMap(mutation => {
        const previous = rows.get(mutation.key) ?? { key: mutation.key, value: null, version: -1 };
        return mutation.version === previous.version ? [] : [previous];
      });
      if (errors.length) return { success: false, errors };
      return { success: true, results: mutations.map(mutation => {
        const row = { ...mutation, version: mutation.version + 1 };
        rows.set(row.key, row);
        return { key: row.key, version: row.version };
      }) };
    },
  };
  const adopt = (fields: { tasks: unknown; approvalProfileId?: string }) => executeInternalTaskAction({
    scope: { serverId: 'home', accountId: 'account' }, port, requireCurrent() {}, createId: () => 'unused',
    actionId: 'tasks.internal.create', input: { plan: { source: { kind: 'plan_run', id: 'run' }, sessionId: 'lead', ...fields } },
  });
  return { adopt, rows, writes };
}

function linkedTaskFixture() {
  const attempt = { sessionId: 'worker', runId: 'work-run' };
  const prRef = { url: 'https://github.com/my-org/my-repo/pull/2' };
  let todo = { ...createTodoItemV1({ id: 'task', title: 'Fix the regression' }, 1),
    state: 'started' as const, attemptBinding: attempt, runLink: attempt };
  let version = 1;
  const port: AccountJsonKvCollectionPort = {
    read: async key => key === 'todo.task' ? { value: todo, version } : { value: null, version: 0 },
    list: async () => [],
    mutate: async mutations => {
      const write = mutations.find(mutation => mutation.key === 'todo.task')!;
      if (write.version !== version) return { success: false, errors: [{ key: write.key, value: todo, version }] };
      todo = write.value as typeof todo;
      version += 1;
      return { success: true, results: mutations.map(mutation => ({ key: mutation.key, version: mutation.version + 1 })) };
    },
  };
  const evidence = {
    pr: { ...prRef, state: 'open', headBranch: 'worker/fix' } as { url: string; state: 'open' | 'merged'; headBranch: string; mergeCommitSha?: string },
    prAvailable: true,
    deployment: null as null | { deploymentId: string; environmentId: string; projectSourceId: string; state: 'succeeded' | 'failed'; sha: string },
  };
  return Object.assign(evidence, {
    attempt, prRef, sha: '9'.repeat(40), current: () => ({ version, todo }),
    transition(expectedVersion: number, state: string, claim: unknown, claimant = attempt) {
      const linkedEvidence = { readPullRequest: async ({ sessionId }: { sessionId: string }) => evidence.prAvailable && sessionId === attempt.sessionId ? evidence.pr : null,
        readDeployment: async () => evidence.deployment };
      const invocation = { scope: { serverId: 'home', accountId: 'account' }, port,
        requireCurrent() {}, createId: () => 'task', claimant, linkedEvidence };
      return executeInternalTaskAction({ ...invocation, actionId: 'tasks.internal.transition', input: { taskId: 'task', expectedVersion, state, claim } });
    },
  });
}
