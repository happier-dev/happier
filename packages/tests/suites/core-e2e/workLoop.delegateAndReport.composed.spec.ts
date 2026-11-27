import { join } from 'node:path';
import { expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareActionCompletionV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { startActivityWebhookCaptureServer } from '../../src/testkit/activityWebhookCapture';
import { buildCanonicalWebhookAccountSettings } from '../../src/testkit/activityWebhookSettings';
import { createIsolatedFakeClaudeControlShim, readFakeClaudeLogEvents, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const nativeTurnWaitMs = 60_000;

it('admits a delegate and wakes the lead once with its settled Run report', async ({ onTestFailed }) => {
  let checkpoint = 'start the disposable Postgres Home';
  onTestFailed(() => { console.info(`Work Loop fixture checkpoint: ${checkpoint}`); });
  const testDir = run.testDir('work-loop-delegate-and-report');
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  let alerts: Awaited<ReturnType<typeof startActivityWebhookCaptureServer>> | undefined;
  let failure: unknown;
  try {
    const home = await startProjectDaemonFixture({
      testDir, dbProvider: 'postgres', serverEnv: { DATABASE_URL: database.homeDatabaseUrl, SERVER_ROLE: 'api' },
      personActionSurface: 'coreAction',
    });
    fixture = home;
    const account = await home.createAccount('work-loop-lead');
    const webhook = alerts = await startActivityWebhookCaptureServer();
    await upsertEncryptedAccountSettingsV2({
      baseUrl: home.server.baseUrl, token: account.auth.token,
      material: { type: 'dataKey', machineKey: account.auth.accountMachineKey },
      settings: buildCanonicalWebhookAccountSettings({ webhookUrl: webhook.url }),
    });
    const native = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'native'),
      captureEnvironmentKeys: [], logFullStdin: true, scenario: 'delegate-evidence-json' });
    const vendorLog = native.logPath;
    checkpoint = 'enroll the daemon and create the lead Session';
    const machine = await home.enrollDaemon(account, {
      env: { HAPPIER_CLAUDE_PATH: native.executablePath },
    });
    const { sessionId } = await home.assertKnownGoodSessionControl(account, machine);
    const executeControl = async (id: ActionId, input: unknown) => {
      const response = await account.execute(id, input, { defaultSessionId: sessionId });
      if (!response.ok) throw new Error(`${id} failed: ${response.errorCode}`);
      return response.result;
    };

    // Establish the Action → Postgres → daemon path before testing delegation.
    checkpoint = 'send and commit the ordinary control turn';
    const control = 'Work Loop control: respond to one ordinary turn.';
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', { sessionId, message: control }));
    await waitForFakeClaudeUserText(vendorLog, text => text.includes(control), { timeoutMs: nativeTurnWaitMs });
    const leadProcess = (await readFakeClaudeLogEvents(vendorLog)).find(event =>
      event.type === 'sdk_stdin' && typeof event.userText === 'string' && event.userText.includes(control))?.invocationId;
    if (typeof leadProcess !== 'string') throw new Error('The control turn did not identify its provider process');
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, sessionId))?.latestTurnStatus === 'completed',
      { context: 'ordinary Session turn is committed', timeoutMs: nativeTurnWaitMs });
    const controlTurnId = (await fetchSessionV2(home.server.baseUrl, account.auth.token, sessionId)).latestTurnId;
    checkpoint = 'observe the control Finished alert';
    expect((await webhook.nextPayload()).payload).toMatchObject({ topic: 'ready', navigation: { sessionId } });
    await executeControl('session.permission_mode.set', { sessionId, permissionMode: 'default', applyTiming: 'immediate' });

    checkpoint = 'connect the signed-in person Action client';
    await account.withPersonActionClient(async executePersonAction => {
      checkpoint = 'admit Delegate through the signed-in Action client';
      const instructions = 'Work Loop delegate: describe the file change and its check outcome.';
      const actionId = 'subagents.delegate.start';
      const result = await executePersonAction(actionId, {
        sessionId, backendTargetKeys: ['agent:claude'], instructions, permissionMode: 'default', notifyParentOnCompletion: true,
      }, { defaultSessionId: sessionId });
      const prepared = prepareActionCompletionV1(getActionSpec(actionId).completion, result);
      if (prepared.kind !== 'awaiting') {
        const code = 'errorCode' in prepared ? ` (${prepared.errorCode})` : '';
        throw new Error(`Delegate did not retain its Run: ${prepared.kind}${code}`);
      }
      expect(prepared.state.awaitedRuns).toHaveLength(1);
      const runId = prepared.state.awaitedRuns?.[0]?.runId;
      if (!runId) throw new Error('Missing admitted Run identity');
      checkpoint = 'observe the worker question before giving the answer';
      const readRun = async () => ExecutionRunGetResponseSchema.parse(
        await executeControl('execution.run.get', { sessionId, runId, includeStructured: true }),
      );
      await waitFor(async () => (await readRun()).run.attention?.kind === 'user_action_required',
        { context: 'the active delegate exposes its pending question', timeoutMs: nativeTurnWaitMs });
      const pending = (await readRun()).run;
      expect(pending.status).toBe('running');
      expect(pending.attention?.requestIds).toHaveLength(1);
      expect(webhook.pendingPayloadCount()).toBe(0);
      checkpoint = 'answer the question on the lead Session';
      expect(await executeControl('session.user_action.answer', {
        sessionId, requestId: pending.attention!.requestIds[0]!,
        answers: [{ question: 'path', answer: 'choice-1' }],
      })).toMatchObject({ ok: true });
      await waitFor(async () => (await readFakeClaudeLogEvents(vendorLog))
        .filter(event => event.type === 'work_loop_question_answer' && event.accepted === true).length === 1,
      { context: 'the answer reaches the worker once', timeoutMs: nativeTurnWaitMs });
      checkpoint = 'read the settled Delegate evidence';
      await waitFor(async () => {
        const response = await executePersonAction('execution.run.get', { sessionId, runId, includeStructured: true },
          { defaultSessionId: sessionId });
        if (!response.ok) throw new Error(`execution.run.get failed: ${response.errorCode}`);
        const observation = ExecutionRunGetResponseSchema.parse(response.result);
        if (observation.run.status === 'running') return false;
        expect(observation.run.status).toBe('succeeded');
        expect(observation.structuredMeta?.kind).toBe('delegate_output.v1');
        expect(observation.structuredMeta?.payload).toMatchObject({ workerReport: {
          deliverables: [{ kind: 'check_outcome', name: 'worker verification', outcome: 'passed' }],
        } });
        return true;
      }, { context: 'the admitted delegate publishes its result', timeoutMs: nativeTurnWaitMs });
    });
    checkpoint = 'observe the lead wake and its committed turn';
    await waitForFakeClaudeUserText(vendorLog, text => text.includes('FAKE_DELEGATE_SUMMARY_'),
      { invocationId: leadProcess, timeoutMs: nativeTurnWaitMs });
    await waitFor(async () => {
      const lead = await fetchSessionV2(home.server.baseUrl, account.auth.token, sessionId);
      return lead.latestTurnId !== controlTurnId && lead.latestTurnStatus === 'completed';
    }, { context: 'lead completes the worker report turn', timeoutMs: nativeTurnWaitMs });
    const events = await readFakeClaudeLogEvents(vendorLog);
    const wakes = events.filter(event => event.type === 'sdk_stdin' && event.invocationId === leadProcess
      && typeof event.userText === 'string' && event.userText.includes('FAKE_DELEGATE_SUMMARY_'));
    expect(wakes).toHaveLength(1);
    checkpoint = 'observe Finished delivery after the lead handles the result';
    expect((await webhook.nextPayload()).payload).toMatchObject({ topic: 'ready', navigation: { sessionId } });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    if (fixture) {
      try { await fixture.stop(); } catch (error) { errors.push(error); }
    }
    try { await alerts?.stop(); } catch (error) { errors.push(error); }
    try { await database.stop(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new AggregateError(failure ? [failure, ...errors] : errors, 'Work Loop journey cleanup failed');
    }
  }
}, 480_000);
