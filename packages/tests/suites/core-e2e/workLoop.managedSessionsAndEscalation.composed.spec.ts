import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol';
import { ActionExecuteResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionManagerSetResultV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionNeedsYouRaiseOutputV1Schema } from '@happier-dev/protocol/sessions/permissions/questionV1';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { startActivityWebhookCaptureServer, type CapturedActivityWebhookRequest } from '../../src/testkit/activityWebhookCapture';
import { buildCanonicalWebhookAccountSettings } from '../../src/testkit/activityWebhookSettings';
import { createIsolatedFakeClaudeControlShim, readFakeClaudeLogEvents, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const nativeTurnWaitMs = 60_000;

function buildParentChildWebhookSettings(webhookUrl: string) {
  const base = buildCanonicalWebhookAccountSettings({ webhookUrl }) as Record<string, any>;
  return {
    ...base,
    notificationChannelsV1: base.notificationChannelsV1.map((channel: Record<string, any>) => ({
      ...channel,
      topics: {
        ...channel.topics,
        ready: true,
        permissionRequest: false,
        userActionRequest: true,
      },
    })),
  };
}

it('routes Child questions and finishes to a live Parent with zero premature human push, and escalates both when Parent goes offline', async ({ onTestFailed }) => {
  let checkpoint = 'start the disposable Postgres Home';
  onTestFailed(() => { console.info(`Work Loop Parent<->Child fixture checkpoint: ${checkpoint}`); });
  const testDir = run.testDir('work-loop-managed-sessions-escalation');
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  let alerts: Awaited<ReturnType<typeof startActivityWebhookCaptureServer>> | undefined;
  let failure: unknown;
  try {
    const home = await startProjectDaemonFixture({
      testDir,
      dbProvider: 'postgres',
      daemonAuthentication: 'existing-terminal',
      serverEnv: { DATABASE_URL: database.homeDatabaseUrl, SERVER_ROLE: 'api' },
      personActionSurface: 'coreAction',
    });
    fixture = home;
    const account = await home.createAccount('work-loop-parent-child');
    const webhook = alerts = await startActivityWebhookCaptureServer();
    await upsertEncryptedAccountSettingsV2({
      baseUrl: home.server.baseUrl,
      token: account.auth.token,
      material: { type: 'dataKey', machineKey: account.auth.accountMachineKey },
      settings: buildParentChildWebhookSettings(webhook.url),
    });

    const native = await createIsolatedFakeClaudeControlShim({
      testDir: join(testDir, 'native'),
      captureEnvironmentKeys: [],
      logFullStdin: true,
    });
    const vendorLog = native.logPath;

    checkpoint = 'enroll the daemon and start the Parent (Lead) Session';
    const machine = await home.enrollDaemon(account, {
      env: { HAPPIER_CLAUDE_PATH: native.executablePath },
    });
    const { sessionId: parentSessionId } = await home.assertKnownGoodSessionControl(account, machine);

    const executeControl = async (id: ActionId, input: unknown, defaultSessionId = parentSessionId) => {
      const response = await account.execute(id, input, {
        defaultSessionId,
        presentUserConfirmation: { actionId: id },
      });
      if (!response.ok) throw createActionExecuteFailureError(response);
      return response.result;
    };

    const waitForMcpActionResult = async (requestId: string, context: string) => {
      let outcome: unknown;
      await waitFor(async () => {
        const event = (await readFakeClaudeLogEvents(vendorLog)).find(
          row => row.type === 'session_mcp_action_result' && row.requestId === requestId,
        );
        if (!event) return false;
        outcome = event.result;
        return true;
      }, { context, timeoutMs: nativeTurnWaitMs });
      return ActionExecuteResultSchema.parse(outcome);
    };

    const drainQueuedWebhooks = async (): Promise<CapturedActivityWebhookRequest[]> => {
      const drained: CapturedActivityWebhookRequest[] = [];
      while (webhook.pendingPayloadCount() > 0) {
        drained.push(await webhook.nextPayload(1_000));
      }
      return drained;
    };

    // Establish Parent process identity and confirm the control turn + Finished alert.
    checkpoint = 'run Parent control turn';
    const parentControl = 'Work Loop parent control: confirm lead session.';
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', {
      sessionId: parentSessionId, message: parentControl,
    }));
    await waitForFakeClaudeUserText(vendorLog, text => text.includes(parentControl), { timeoutMs: nativeTurnWaitMs });
    const parentProcess = (await readFakeClaudeLogEvents(vendorLog)).find(event =>
      event.type === 'sdk_stdin' && typeof event.userText === 'string' && event.userText.includes(parentControl))?.invocationId;
    if (typeof parentProcess !== 'string') throw new Error('Parent control turn did not identify its provider process');
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId))?.latestTurnStatus === 'completed',
      { context: 'Parent control turn commits', timeoutMs: nativeTurnWaitMs });
    expect((await webhook.nextPayload()).payload).toMatchObject({ topic: 'ready', navigation: { sessionId: parentSessionId } });
    await executeControl('session.permission_mode.set', {
      sessionId: parentSessionId, permissionMode: 'default', applyTiming: 'immediate',
    });

    // Spawn the separate Child (Worker) Session and assign it to the Parent Session.
    checkpoint = 'spawn Child (Worker) Session and assign Parent manager';
    const updatedAtMs = Date.now();
    const spawnedChild = SessionSpawnNewActionResultV1Schema.parse(await executeControl('session.spawn_new', {
      executionTarget: machine.target,
      directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      permissionMode: 'default',
      approvalProfileId: null,
      configuration: {
        mode: { value: null, updatedAtMs },
        model: { value: null, updatedAtMs, selectionSource: 'explicit' },
        permissionIntent: { value: 'default', updatedAtMs },
        options: {},
      },
      connectedServices: { v: 2, bindingsByServiceId: {} },
      terminal: { mode: 'plain' },
    }));
    if (spawnedChild.type !== 'success') throw new Error(`Child Session spawn failed: ${JSON.stringify(spawnedChild)}`);
    const childSessionId = spawnedChild.sessionId;
    expect(childSessionId).not.toBe(parentSessionId);

    const assigned = SessionManagerSetResultV1Schema.parse(await executeControl('session.manager.set', {
      sessionId: childSessionId,
      managerSessionId: parentSessionId,
      expectedManagerSessionId: null,
    }));
    expect(assigned).toMatchObject({ ok: true, sessionId: childSessionId, managerSessionId: parentSessionId });

    // =========================================================================
    // Scenario A: Child raises a question -> Parent receives & answers -> Child resumes
    // =========================================================================
    checkpoint = 'Scenario A: Child raises a question via session.needs_you.raise';
    const q1McpId = `child-raise-q1-${randomUUID()}`;
    const q1Prompt = 'Which target should the worker deploy to?';
    const q1Message = `SESSION_MCP_ACTION_JSON:${JSON.stringify({
      requestId: q1McpId,
      actionId: 'session.needs_you.raise',
      input: {
        sessionId: childSessionId,
        mode: 'wait',
        type: 'decision',
        lasting: false,
        title: 'Deploy target',
        questions: [{ id: 'deploy-target', type: 'text', prompt: q1Prompt }],
      },
    })}`;
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', {
      sessionId: childSessionId, message: q1Message,
    }, childSessionId));

    const q1RaisedOutcome = await waitForMcpActionResult(q1McpId, 'Child session.needs_you.raise completes');
    expect(q1RaisedOutcome.ok, `Child question raise failed: ${JSON.stringify(q1RaisedOutcome)}`).toBe(true);
    if (!q1RaisedOutcome.ok) throw new Error(`Child question raise failed: ${q1RaisedOutcome.errorCode}`);
    const q1Raised = SessionNeedsYouRaiseOutputV1Schema.parse(q1RaisedOutcome.result);
    if ('withdrawn' in q1Raised) throw new Error('Expected active question requestId');
    const q1RequestId = q1Raised.requestId;

    const childProcess = (await readFakeClaudeLogEvents(vendorLog)).find(event =>
      event.type === 'sdk_stdin' && typeof event.userText === 'string' && event.userText.includes(q1McpId))?.invocationId;
    if (typeof childProcess !== 'string') throw new Error('Child Session turn did not identify its provider process');
    expect(childProcess).not.toBe(parentProcess);

    checkpoint = 'Scenario A: verify live Parent wakes with Child question and zero premature human push';
    await waitForFakeClaudeUserText(
      vendorLog,
      text => text.includes(q1RequestId) || text.includes(q1Prompt),
      { invocationId: parentProcess, timeoutMs: nativeTurnWaitMs },
    );
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId))?.latestTurnStatus === 'completed',
      { context: 'Parent processes the Child question wake', timeoutMs: nativeTurnWaitMs });

    // Consume the ready webhook from Parent's own Q1-woken turn and verify ZERO Child alerts reached the human.
    const scenarioAWebhooks = [
      await webhook.nextPayload(nativeTurnWaitMs),
      ...(await drainQueuedWebhooks()),
    ];
    for (const captured of scenarioAWebhooks) {
      expect(captured.payload.topic).not.toBe('user_action_request');
      if ('navigation' in captured.payload && 'sessionId' in captured.payload.navigation) {
        expect(captured.payload.navigation.sessionId).not.toBe(childSessionId);
      }
    }

    checkpoint = 'Scenario A: Parent answers the Child question via session.user_action.answer';
    const parentStdinsBeforeAnswer = (await readFakeClaudeLogEvents(vendorLog)).filter(
      event => event.type === 'sdk_stdin' && event.invocationId === parentProcess,
    ).length;
    const parentAnswerMcpId = `parent-answer-q1-${randomUUID()}`;
    const q1AnswerValue = 'staging-eu';
    const parentAnswerMessage = `SESSION_MCP_ACTION_JSON:${JSON.stringify({
      requestId: parentAnswerMcpId,
      actionId: 'session.user_action.answer',
      input: {
        sessionId: childSessionId,
        requestId: q1RequestId,
        answers: [{ question: 'deploy-target', values: [q1AnswerValue] }],
      },
    })}`;
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', {
      sessionId: parentSessionId, message: parentAnswerMessage,
    }));

    const parentAnswerOutcome = await waitForMcpActionResult(parentAnswerMcpId, 'Parent session.user_action.answer completes');
    expect(parentAnswerOutcome.ok, `Parent answer failed: ${JSON.stringify(parentAnswerOutcome)}`).toBe(true);

    checkpoint = 'Scenario A: verify Child receives the Parent answer and resumes';
    await waitForFakeClaudeUserText(
      vendorLog,
      text => text.includes(q1RequestId) && text.includes(q1AnswerValue),
      { invocationId: childProcess, timeoutMs: nativeTurnWaitMs },
    );
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, childSessionId))?.latestTurnStatus === 'completed',
      { context: 'Child completes its resumed turn after Parent answer', timeoutMs: nativeTurnWaitMs });
    // Wait for Follow to deliver Child's resumed-turn finish to Parent and for Parent to settle before Scenario B.
    await waitFor(async () => {
      const parentStdins = (await readFakeClaudeLogEvents(vendorLog)).filter(
        event => event.type === 'sdk_stdin' && event.invocationId === parentProcess,
      ).length;
      const parent = await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId);
      return parentStdins >= parentStdinsBeforeAnswer + 2 && parent.latestTurnStatus === 'completed';
    }, { context: 'Parent settles after Child resumed turn in Scenario A', timeoutMs: nativeTurnWaitMs });
    // Consume Parent's two Scenario A ready webhooks (answer turn + Follow-woken turn), asserting none are for Child.
    const postAWebhooks = [
      await webhook.nextPayload(nativeTurnWaitMs),
      await webhook.nextPayload(nativeTurnWaitMs),
      ...(await drainQueuedWebhooks()),
    ];
    for (const captured of postAWebhooks) {
      expect(captured.payload.topic).not.toBe('user_action_request');
      if ('navigation' in captured.payload && 'sessionId' in captured.payload.navigation) {
        expect(captured.payload.navigation.sessionId).not.toBe(childSessionId);
      }
    }

    // =========================================================================
    // Scenario B: Child finishes -> wakes live Parent once (0 premature human push),
    //             then Parent finishes -> 1 human Finished (ready) alert
    // =========================================================================
    checkpoint = 'Scenario B: Child executes and finishes a work turn';
    const childBeforeB = await fetchSessionV2(home.server.baseUrl, account.auth.token, childSessionId);
    const parentBeforeB = await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId);
    const parentStdinsBeforeB = (await readFakeClaudeLogEvents(vendorLog)).filter(
      event => event.type === 'sdk_stdin' && event.invocationId === parentProcess,
    ).length;

    const childTaskB = `Work Loop child task B: worker report ${randomUUID()}.`;
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', {
      sessionId: childSessionId, message: childTaskB,
    }, childSessionId));

    await waitForFakeClaudeUserText(vendorLog, text => text.includes(childTaskB), {
      invocationId: childProcess, timeoutMs: nativeTurnWaitMs,
    });
    await waitFor(async () => {
      const child = await fetchSessionV2(home.server.baseUrl, account.auth.token, childSessionId);
      return child.latestTurnId !== childBeforeB.latestTurnId && child.latestTurnStatus === 'completed';
    }, { context: 'Child completes Scenario B work turn', timeoutMs: nativeTurnWaitMs });

    checkpoint = 'Scenario B: verify Follow wakes live Parent once and Parent emits the sole human Finished alert';
    await waitFor(async () => {
      const parentStdins = (await readFakeClaudeLogEvents(vendorLog)).filter(
        event => event.type === 'sdk_stdin' && event.invocationId === parentProcess,
      );
      return parentStdins.length > parentStdinsBeforeB;
    }, { context: 'Follow wakes live Parent after Child finishes', timeoutMs: nativeTurnWaitMs });

    await waitFor(async () => {
      const parent = await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId);
      return parent.latestTurnId !== parentBeforeB.latestTurnId && parent.latestTurnStatus === 'completed';
    }, { context: 'Parent completes its Follow-woken turn', timeoutMs: nativeTurnWaitMs });

    const parentWakesForB = (await readFakeClaudeLogEvents(vendorLog)).filter(
      event => event.type === 'sdk_stdin' && event.invocationId === parentProcess,
    ).slice(parentStdinsBeforeB);
    expect(parentWakesForB).toHaveLength(1);

    const scenarioBAlert = await webhook.nextPayload(nativeTurnWaitMs);
    expect(scenarioBAlert.payload).toMatchObject({
      topic: 'ready',
      navigation: { sessionId: parentSessionId },
    });
    expect(await drainQueuedWebhooks()).toEqual([]);

    // =========================================================================
    // Scenario C: Dead-lead / offline Parent escalation (question pass-up + finish pass-up)
    // =========================================================================
    checkpoint = 'Scenario C: Child raises Q2 while Parent is still live';
    const q2McpId = `child-raise-q2-${randomUUID()}`;
    const q2Prompt = 'Should the worker keep the rollback snapshot?';
    const q2Message = `SESSION_MCP_ACTION_JSON:${JSON.stringify({
      requestId: q2McpId,
      actionId: 'session.needs_you.raise',
      input: {
        sessionId: childSessionId,
        mode: 'wait',
        type: 'decision',
        lasting: false,
        title: 'Rollback snapshot',
        questions: [{ id: 'rollback-snapshot', type: 'text', prompt: q2Prompt }],
      },
    })}`;
    SessionMessageSendResultV1Schema.parse(await executeControl('session.message.send', {
      sessionId: childSessionId, message: q2Message,
    }, childSessionId));

    const q2RaisedOutcome = await waitForMcpActionResult(q2McpId, 'Child Q2 session.needs_you.raise completes');
    expect(q2RaisedOutcome.ok, `Child Q2 raise failed: ${JSON.stringify(q2RaisedOutcome)}`).toBe(true);
    if (!q2RaisedOutcome.ok) throw new Error(`Child Q2 raise failed: ${q2RaisedOutcome.errorCode}`);
    const q2Raised = SessionNeedsYouRaiseOutputV1Schema.parse(q2RaisedOutcome.result);
    if ('withdrawn' in q2Raised) throw new Error('Expected active Q2 requestId');
    const q2RequestId = q2Raised.requestId;

    // Wait for live Parent to receive Q2 first (confirming it was initially routed to Parent, not human).
    await waitForFakeClaudeUserText(
      vendorLog,
      text => text.includes(q2RequestId) || text.includes(q2Prompt),
      { invocationId: parentProcess, timeoutMs: nativeTurnWaitMs },
    );
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId))?.latestTurnStatus === 'completed',
      { context: 'Parent completes its Q2 wake turn before going offline', timeoutMs: nativeTurnWaitMs });
    // Consume Parent's ready alert from Q2 wake; verify no human user_action_request was sent yet.
    const preOfflineAlerts = [
      await webhook.nextPayload(nativeTurnWaitMs),
      ...(await drainQueuedWebhooks()),
    ];
    for (const captured of preOfflineAlerts) {
      expect(captured.payload.topic).not.toBe('user_action_request');
    }

    const compatHeaders = {
      Authorization: `Bearer ${account.auth.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
    };
    const childBeforeStopRaw = await fetchJson<any>(`${home.server.baseUrl}/v2/sessions/${childSessionId}`, { headers: compatHeaders });

    checkpoint = 'Scenario C: stop Parent Session so it goes offline';
    await executeControl('session.stop', { sessionId: parentSessionId });
    await waitFor(async () => (await fetchSessionV2(home.server.baseUrl, account.auth.token, parentSessionId))?.active === false,
      { context: 'Parent Session transitions to offline (active=false)', timeoutMs: nativeTurnWaitMs });

    checkpoint = 'Scenario C: verify pending Q2 escalates to human webhook (user_action_request)';
    let escalatedQuestion: CapturedActivityWebhookRequest | undefined;
    try {
      await waitFor(async () => {
        const next = await webhook.nextPayload(5_000);
        if (next.payload.topic === 'user_action_request'
          && 'navigation' in next.payload && 'sessionId' in next.payload.navigation
          && next.payload.navigation.sessionId === childSessionId) {
          escalatedQuestion = next;
          return true;
        }
        return false;
      }, { context: 'Offline Parent escalates pending Child question to human webhook', timeoutMs: 30_000 });
    } catch (error) {
      const [childRaw, parentRaw] = await Promise.all([
        fetchJson<any>(`${home.server.baseUrl}/v2/sessions/${childSessionId}`, { headers: compatHeaders }),
        fetchJson<any>(`${home.server.baseUrl}/v2/sessions/${parentSessionId}`, { headers: compatHeaders }),
      ]);
      const childSnap = childRaw.data?.session;
      const parentSnap = parentRaw.data?.session;
      let logMatches: string[] = [];
      try {
        const logsDir = join(machine.homeDir, 'logs');
        const files = await readdir(logsDir);
        for (const file of files) {
          if (!file.endsWith('.log')) continue;
          const text = await readFile(join(logsDir, file), 'utf8');
          const lines = text.split('\n').filter(line =>
            /permissionRequestPush|activityNotifications|question-manager-offline|Pending question|Follow request|NotificationChannelCatalog|webhook|push|pass-up|user_action/i.test(line),
          );
          if (lines.length > 0) logMatches.push(`=== ${file} (${lines.length} matches) ===\n${lines.slice(-40).join('\n')}`);
        }
      } catch (logErr) {
        logMatches.push(`log read error: ${String(logErr)}`);
      }
      console.info('Scenario C diagnostics:', JSON.stringify({
        parentActive: parentSnap?.active,
        childActive: childSnap?.active,
        childManager: childSnap?.manager,
        childLatestTurnStatus: childSnap?.latestTurnStatus,
        childPendingUserActionRequestCount: childSnap?.pendingUserActionRequestCount,
        childAgentStateVersionBeforeStop: childBeforeStopRaw.data?.session?.agentStateVersion,
        childAgentStateVersionAfterStop: childSnap?.agentStateVersion,
        childEncryptionMode: childSnap?.encryptionMode,
        childAgentStateRaw: childSnap?.encryptionMode === 'plain' ? childSnap?.agentState : `<encrypted len=${String(childSnap?.agentState ?? '').length}>`,
        pendingWebhookCount: webhook.pendingPayloadCount(),
      }));
      if (logMatches.length > 0) console.info('Scenario C CLI logs:\n' + logMatches.join('\n'));
      throw error;
    }
    expect(escalatedQuestion?.payload).toMatchObject({
      topic: 'user_action_request',
      navigation: { sessionId: childSessionId },
      request: { requestId: q2RequestId, kind: 'user_action' },
    });

    checkpoint = 'Scenario C: human answers escalated Q2 and Child finishes with offline-lead ready escalation';
    const childBeforeC2Raw = await fetchJson<any>(`${home.server.baseUrl}/v2/sessions/${childSessionId}`, {
      headers: compatHeaders,
    });
    const childBeforeC2TurnId = childBeforeC2Raw.data?.session?.latestTurnId ?? null;
    const q2AnswerValue = 'keep-snapshot';
    expect(await executeControl('session.user_action.answer', {
      sessionId: childSessionId,
      requestId: q2RequestId,
      answers: [{ question: 'rollback-snapshot', values: [q2AnswerValue] }],
    }, childSessionId)).toMatchObject({ ok: true });

    await waitForFakeClaudeUserText(
      vendorLog,
      text => text.includes(q2RequestId) && text.includes(q2AnswerValue),
      { invocationId: childProcess, timeoutMs: nativeTurnWaitMs },
    );
    await waitFor(async () => {
      const child = await fetchSessionV2(home.server.baseUrl, account.auth.token, childSessionId);
      return child.latestTurnId !== childBeforeC2TurnId && child.latestTurnStatus === 'completed';
    }, { context: 'Child completes its resumed turn while Parent is offline', timeoutMs: nativeTurnWaitMs });

    const offlineFinishAlert = await webhook.nextPayload(nativeTurnWaitMs);
    expect(offlineFinishAlert.payload).toMatchObject({
      topic: 'ready',
      navigation: { sessionId: childSessionId },
    });
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
      throw new AggregateError(failure ? [failure, ...errors] : errors, 'Work Loop Parent<->Child cleanup failed');
    }
  }
}, 600_000);
