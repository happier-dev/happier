import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  InternalTaskDeleteOutputSchema,
  InternalTaskListOutputSchema,
  InternalTaskMutationOutputSchema,
  InternalTaskReadOutputSchema,
} from '@happier-dev/protocol/actions/internalTaskActions';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession, fetchMessagesPage, maxMessageSeq } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const testDir = createRunDirs({ runLabel: 'work-loop-durable-tasks' }).testDir('ready-claim-result');
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
let ui: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
let claimRace: { path: string; writes: number; gate: PromiseWithResolvers<void> } | undefined;

beforeAll(async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({ testDir, dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
    serverEnv: { DATABASE_URL: database.homeDatabaseUrl, SERVER_ROLE: 'api' },
    personActionSurface: 'coreAction', observeActionRequests: true, advertiseRequestObservationEndpoint: true,
    beforeHttpRequest: async request => {
      const race = claimRace;
      if (!race || request.method !== 'PUT' || request.path !== race.path) return;
      race.writes += 1;
      if (race.writes === 2) race.gate.resolve();
      await race.gate.promise;
    } });
}, 360_000);

afterAll(async () => {
  claimRace?.gate.resolve();
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop(), () => database?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Durable Tasks journey cleanup failed');
});

it('admits one claimant per revision, rejects an evicted result and leaves unknown blockers out of Ready', async () => {
  const home = fixture;
  if (!home) throw new Error('Task fixture did not start');
  const account = await home.createAccount('durable-triage-tasks');
  const root = repoRootDir();
  const native = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'native'),
    captureEnvironmentKeys: [], logFullStdin: true, scenario: 'delegate-json' });
  const machine = await home.enrollDaemon(account, {
    env: { HAPPIER_CLAUDE_PATH: native.executablePath },
    cliLaunchSpec: {
      command: process.execPath,
      args: ['--import', join(root, 'packages/cli-common/registerSourceRuntime.mjs'), join(root, 'apps/cli/src/index.ts')],
      cwd: root,
    },
  });
  const lead = await home.assertKnownGoodSessionControl(account, machine);
  const transcript = { baseUrl: home.server.baseUrl, token: account.auth.token, sessionId: lead.sessionId };
  const beforeTurn = maxMessageSeq((await fetchMessagesPage({ ...transcript, afterSeq: 0 })).messages);
  const control = await account.execute('session.message.send', {
    sessionId: lead.sessionId, message: 'Durable Tasks control turn',
  });
  if (!control.ok) throw new Error(`Session control refused (${control.errorCode})`);
  SessionMessageSendResultV1Schema.parse(control.result);
  await waitForFakeClaudeUserText(native.logPath, text => text.includes('Durable Tasks control turn'));
  await waitFor(async () => (await fetchMessagesPage({ ...transcript, afterSeq: beforeTurn, role: 'agent' }))
    .messages.length > 0, { context: 'ordinary Session reply is committed to Postgres' });
  const worker = await createSession(home.server.baseUrl, account.auth.token);

  const client = await connectUiTriageActionClient({
    ...home.personActionConnection, accountSecret: account.auth.accountSigningSeed, withAccountLifecycle: true,
  });
  ui = client;
  await waitFor(() => client.isAccountReady(), { context: 'durable Tasks Account readiness' });
  const execute = (actionId: ActionId, input: unknown) => client.executeConfirmed(actionId, input, {
    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: client.serverId, serverIdentityId: home.serverId,
  });
  const invoke = async (actionId: ActionId, input: unknown) => {
    const result = await execute(actionId, input);
    if (!result.ok) throw createActionExecuteFailureError(result);
    return result.result;
  };

  const title = 'Concurrent claim';
  const createTask = async (fields: { title: string; blockedBy?: string[] }) => {
    const created = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.create', { fields }));
    if (created.status !== 'applied') throw new Error(`Task creation settled as ${created.status}`);
    return created;
  };
  const created = await createTask({ title });
  const taskId = created.todo.id;
  const read = InternalTaskReadOutputSchema.parse(await invoke('tasks.internal.read', { taskId }));
  expect(read).toMatchObject({ status: 'applied', todo: { id: taskId, title } });
  if (read.status !== 'applied') throw new Error('Task control read failed');

  const listed = await invoke('action.invoke', {
    action: { pluginId: 'happier.triage', localId: 'tasks/list-v1' },
    input: { v: 1, sources: { kind: 'allConfigured' }, limit: 20, order: 'newest', tasks: { completedSinceMs: 0 } },
  });
  expect(listed).toMatchObject({ window: { rows: expect.arrayContaining([
    expect.objectContaining({ observation: expect.objectContaining({
      outcome: expect.objectContaining({ kind: 'present', snapshot: expect.objectContaining({ title, assigneeLabel: null }) }),
    }) }),
  ]) } });

  const expectedVersion = read.todo.version;
  expect(expectedVersion).toEqual(expect.any(Number));
  const cliRead = await account.execute('tasks.internal.read', { taskId });
  expect(cliRead).toMatchObject({ ok: true, result: { status: 'applied', todo: { version: expectedVersion } } });
  const attempts = [{ sessionId: lead.sessionId, runId: randomUUID() }, { sessionId: worker.sessionId, runId: randomUUID() }];
  const take = (attemptBinding: typeof attempts[number]) => ({
    taskId, expectedVersion, state: 'started', claim: { kind: 'take', attemptBinding },
  });
  const race = { path: `/v1/tasks/${created.scope.accountId}/${taskId}`, writes: 0, gate: Promise.withResolvers<void>() };
  claimRace = race;
  // Hold both real HTTP writes after their reads so the losing Action sees the server's CAS refusal.
  const results = await Promise.all([
    execute('tasks.internal.transition', take(attempts[0]!)).finally(() => race.gate.resolve()),
    account.execute('tasks.internal.transition', take(attempts[1]!)).finally(() => race.gate.resolve()),
  ]);
  claimRace = undefined;
  expect.soft(home.takeRequestObservations().filter(request => request.method === 'PUT' && request.path === race.path)
    .map(request => request.statusCode).sort()).toEqual([200, 409]);
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({ ok: true, result: expect.objectContaining({ status: 'applied' }) }),
    expect.objectContaining({ ok: false, errorCode: 'task_version_conflict' }),
  ]));
  const winnerIndex = results.findIndex(result => result.ok);
  const winner = results[winnerIndex];
  if (!winner?.ok) throw new Error('Claim did not settle');
  const claimed = InternalTaskMutationOutputSchema.parse(winner.result);
  if (claimed.status !== 'applied') throw new Error('Claim did not apply');
  const evicted = attempts[winnerIndex]!;
  const current = attempts[1 - winnerIndex]!;
  expect(claimed.todo).toMatchObject({ attemptBinding: evicted, runLink: evicted });
  const released = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.transition', {
    taskId, expectedVersion: claimed.todo.version, state: 'unstarted', claim: { kind: 'release' },
  }));
  if (released.status !== 'applied') throw new Error('Release did not apply');
  expect(released.todo.attemptBinding).toBeUndefined();
  expect(released.todo.runLink).toEqual(evicted);
  const retaken = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.transition', {
    ...take(current), expectedVersion: released.todo.version,
  }));
  if (retaken.status !== 'applied') throw new Error('Re-Take did not apply');
  expect(retaken.todo.attemptBinding).toEqual(current);
  const resultInput = { taskId, expectedVersion: retaken.todo.version, state: 'ready_for_review',
    claim: { kind: 'result', report: 'Verified by the claimant', branch: 'work/claim' } };
  // Test the host-side Action executor with an admitted context. The fixture
  // Run IDs do not have live approval origins in the public terminal router.
  const createRunActions = () => createActionExecutor(createCliActionDeps({
    token: account.credentials.token, credentials: account.credentials, sessionId: lead.sessionId,
    mode: account.credentials.encryption === null ? 'plain' : 'e2ee', ctx: null,
    serverId: home.serverId, serverHttpBaseUrl: home.actionServerApiUrl,
  }));
  const runActions = createRunActions();
  const settle = (attempt: typeof current, executor = runActions) => executor.execute('tasks.internal.transition', resultInput, {
    surface: 'agent', authority: 'account_automation', bypassApprovals: true,
    serverId: home.serverId, defaultSessionId: attempt.sessionId, runtimeAccountId: created.scope.accountId,
    approvalProfileId: null,
    actionCaller: { kind: 'session', sessionId: attempt.sessionId, starterDepth: 0, turnDepth: 0 },
    runtimeRunId: attempt.runId,
  });
  expect(await settle(evicted)).toMatchObject({ ok: false, errorCode: 'task_claim_lost' });
  const wrongRun = await settle({ ...current, runId: evicted.runId });
  expect(wrongRun, JSON.stringify(wrongRun)).toMatchObject({ ok: false, errorCode: 'task_claim_lost' });
  const settled = await settle(current);
  expect(settled).toMatchObject({ ok: true, result: {
    status: 'applied', todo: { state: 'ready_for_review', runLink: current, report: resultInput.claim.report, branch: 'work/claim' },
  } });
  // Recreate the Action executor so replay depends on persisted Task state.
  // The existing fixture still supplies synthetic Run IDs.
  const replay = createRunActions();
  expect(await settle(current, replay)).toEqual(settled);
  expect(await settle(evicted, replay)).toMatchObject({ ok: false, errorCode: 'task_version_conflict' });

  const blocker = await createTask({ title: 'Blocking predecessor' });
  const waiting = await createTask({ title: 'Waiting on predecessor', blockedBy: [blocker.todo.id] });
  const unknown = await createTask({ title: 'Unresolved blocker', blockedBy: [randomUUID()] });
  const readReady = async () => {
    const list = InternalTaskListOutputSchema.parse(await invoke('tasks.internal.list', { ready: true }));
    if (list.status !== 'ok') throw new Error(`Ready list settled as ${list.status}`);
    return list;
  };
  const before = await readReady();
  expect(before.todos.map(todo => todo.id)).not.toContain(waiting.todo.id);
  expect(before.todos.map(todo => todo.id)).not.toContain(unknown.todo.id);
  expect(before.notReadyTasks).toContainEqual({
    ownerAccountId: unknown.scope.accountId, taskId: unknown.todo.id, reason: 'blocker_unreadable',
  });
  expect(await invoke('tasks.internal.transition', {
    taskId: blocker.todo.id, state: 'completed', expectedVersion: blocker.todo.version,
  })).toMatchObject({ status: 'applied' });
  expect((await readReady()).todos.map(todo => todo.id)).toContain(waiting.todo.id);
  expect(InternalTaskDeleteOutputSchema.parse(await invoke('tasks.internal.delete', { taskId }))).toMatchObject({
    status: 'deleted', taskId,
  });
  expect(await invoke('tasks.internal.read', { taskId })).toMatchObject({ status: 'refused', reason: 'task_not_found' });
}, 360_000);
