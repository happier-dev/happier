import { join } from 'node:path';
import { expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { NOTIFICATION_NOTIFY_ME_ACTION_ID } from '@happier-dev/protocol/actions/notificationConfigurationActionIds';
import { NotificationsNotifyMeResultV1Schema } from '@happier-dev/protocol/account/notifications/notifyMeV1';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { FollowListActionOutputV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { SetOtherAccountFollowResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, SessionFollowPersonalProgressResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SessionFollowRunOccurrenceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createIsolatedFakeClaudeControlShim, readFakeClaudeLogEvents, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

it('observes a Run question, refuses the retired answer and delivers a Run Follow intent once', async () => {
  const testDir = createRunDirs({ runLabel: 'core' }).testDir('work-loop-questions-and-attention');
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  let failure: unknown;
  try {
    const home = await startProjectDaemonFixture({
      testDir, dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
      serverEnv: { DATABASE_URL: database.homeDatabaseUrl },
    });
    fixture = home;
    const account = await home.createAccount('work-loop-questions');
    const root = repoRootDir();
    const native = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'native'),
      captureEnvironmentKeys: [], logFullStdin: true, scenario: 'work-loop-question' });
    const machine = await home.enrollDaemon(account, {
      env: { HAPPIER_CLAUDE_PATH: native.executablePath },
      cliLaunchSpec: { command: process.execPath, cwd: root,
        args: ['--import', join(root, 'packages/cli-common/registerSourceRuntime.mjs'), join(root, 'apps/cli/src/index.ts')] },
    });
    const { sessionId } = await home.assertKnownGoodSessionControl(account, machine);
    const call = (id: ActionId, input: unknown) => account.execute(id, input, { defaultSessionId: sessionId });
    const execute = async (id: ActionId, input: unknown) => {
      const result = await call(id, input);
      if (!result.ok) throw new Error(`${id} refused: ${result.errorCode}`);
      return result.result;
    };

    const control = 'Work Loop control: answer a normal turn.';
    SessionMessageSendResultV1Schema.parse(await execute('session.message.send', { sessionId, message: control }));
    await waitForFakeClaudeUserText(native.logPath, text => text.includes(control));
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, sessionId))?.latestTurnStatus === 'completed',
      { context: 'the control turn commits through the enrolled daemon' });
    await execute('session.permission_mode.set', { sessionId, permissionMode: 'default', applyTiming: 'immediate' });

    const start = async (label: string) => ExecutionRunStartResponseSchema.parse(await execute('execution.run.start', {
      sessionId, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: `Work Loop Run question: ${label}`, modelSelection: null, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
    })).runId;
    const waitForQuestion = async (runId: string) => {
      const outcome = await call('execution.run.wait', { sessionId, runId, condition: 'needs_attention', timeoutSeconds: 30 });
      const observed = ExecutionRunGetResponseSchema.parse(await execute('execution.run.get', { sessionId, runId }));
      expect(outcome, `Run snapshot: ${JSON.stringify({ status: observed.run.status, permissionMode: observed.run.permissionMode, attention: observed.run.attention })}`).toMatchObject({
        ok: true, result: {
          status: 'running', disposition: 'needs_attention', result: { run: { attention: { kind: 'user_action_required' } } },
        },
      });
      expect(observed.run.attention?.requestIds).toHaveLength(1);
      return observed.run.attention!.requestIds[0]!;
    };
    const answerInput = (requestId: string) => ({
      sessionId, requestId, answers: [{ question: 'path', answer: 'choice-1' }],
    });
    const nativeAnswers = async () => (await readFakeClaudeLogEvents(native.logPath))
      .filter(event => event.type === 'work_loop_question_answer' && event.accepted === true);

    const firstRunId = await start('first');
    const firstRequestId = await waitForQuestion(firstRunId);
    expect(await execute('session.user_action.answer', answerInput(firstRequestId))).toMatchObject({ ok: true });
    await waitFor(async () => (await nativeAnswers()).length === 1, { context: 'first answer reaches Claude once' });

    const secondRunId = await start('replacement');
    const secondRequestId = await waitForQuestion(secondRunId);
    expect(secondRequestId).not.toBe(firstRequestId);
    expect(await call('session.user_action.answer', answerInput(firstRequestId)))
      .toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
    expect(await waitForQuestion(secondRunId)).toBe(secondRequestId);
    expect(await nativeAnswers()).toHaveLength(1);

    const follow = { receiver: { kind: 'account' }, source: { kind: 'execution_run', sessionId, runId: secondRunId } } as const;
    const once = [{ kind: 'run_settled' }];
    for (const _ of [1, 2]) {
      const armed = SetOtherAccountFollowResponseV1Schema.parse(await execute('follow.set', { ...follow, once }));
      expect(armed.follow.once).toEqual(once);
    }
    expect(await execute('session.user_action.answer', answerInput(secondRequestId))).toMatchObject({ ok: true });
    await waitFor(async () => (await nativeAnswers()).length === 2, { context: 'second answer reaches Claude once' });
    await execute('execution.run.stop', { sessionId, runId: secondRunId });
    await execute('execution.run.wait', { sessionId, runId: secondRunId, condition: 'terminal', timeoutSeconds: 30 });
    const post = (path: string, body: unknown) => fetch(new URL(path, home.server.baseUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${account.auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const observation = await post(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes, { v: 1, source: follow.source });
    expect(observation.status).toBe(200);
    const occurrence = SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(await observation.json());
    if (!occurrence.ok) throw new Error(`Run Follow observation refused: ${occurrence.error}`);
    expect(occurrence.original.source).toEqual(follow.source);
    for (const alreadyRepresented of [false, true]) {
      const response = await post(SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, { original: occurrence.original });
      expect(response.status).toBe(200);
      expect(SessionFollowPersonalProgressResponseV1Schema.parse(await response.json())).toEqual({
        accepted: true, alreadyRepresented,
      });
    }
    const relations = FollowListActionOutputV1Schema.parse(await execute('follow.list', {
      receiver: follow.receiver, direction: 'following',
    }));
    expect(relations.follows).toContainEqual(expect.objectContaining({
      source: follow.source, once: null, onceDeliveries: [{ original: occurrence.original, event: occurrence.event }],
    }));

    const sent = await account.execute(NOTIFICATION_NOTIFY_ME_ACTION_ID, {
      title: 'Work Loop', message: 'An explicit send still uses the delivery Action.',
    }, { presentUserConfirmation: { actionId: NOTIFICATION_NOTIFY_ME_ACTION_ID },
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
    if (sent.ok) {
      expect(NotificationsNotifyMeResultV1Schema.parse(sent.result).attemptedChannels).toBeGreaterThan(0);
    } else {
      expect(sent).toMatchObject({ errorCode: 'notification_delivery_unavailable',
        details: { attemptedChannels: 1, deliveredChannels: 0 } });
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([fixture?.stop()]);
    try { await database.stop(); } catch (reason) { cleanup.push({ status: 'rejected', reason }); }
    const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Questions journey cleanup failed');
  }
}, 360_000);
