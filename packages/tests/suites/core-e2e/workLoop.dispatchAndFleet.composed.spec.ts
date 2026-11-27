import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { connectUiPersonActionClient, readUiChannelProviderProjection } from '@happier-tests/ui-action-client';
import {
  CONVERSATION_CORE_PLUGIN_ID_V1, CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationBindingCreateResultV1Schema, ConversationBindingResolveResultV1Schema,
  ConversationConnectionCreateResultV1Schema, ConversationConnectionListResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { PluginTargetedContributionSelectionV1Schema } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionExecuteResultSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { InternalTaskMutationOutputSchema, InternalTaskReadOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { AutomationV3RunListResponseSchema, AutomationV3RunMutationResponseSchema, AutomationV3SettingsSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createIsolatedFakeClaudeControlShim, FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS, fakeClaudeFixturePath, readFakeClaudeLogEvents, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startChannelTransportBoundary } from '../../src/testkit/providers/channelTransportBoundary';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const dirs = createRunDirs({ runLabel: 'work-loop-dispatch-and-fleet' });
const claimPath = '/v3/automations/runs/claim';
const features = { HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;

beforeAll(async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({
    testDir: dirs.testDir('dispatch'), dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
    personActionSurface: 'coreAction', advertiseRequestObservationEndpoint: true,
    requestObservation: { captureRequestBody: request => request.path === claimPath },
    serverEnv: { DATABASE_URL: database.homeDatabaseUrl, ...features },
  });
}, 360_000);

afterAll(async () => {
  try { await fixture?.stop(); } finally { await database?.stop(); }
});

it('admits a second scheduled Workflow on a one-slot Machine while the first is parked and keeps its Task claim', async () => {
  if (!fixture) throw new Error('Dispatch fixture did not start');
  const account = await fixture.createAccount('work-loop-dispatch');
  const settings = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/settings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxActiveRunsPerMachine: 1, runRetention: 'keepForever' }),
  });
  expect(settings.status).toBe(200);
  expect(AutomationV3SettingsSchema.parse(settings.data).maxActiveRunsPerMachine).toBe(1);
  const machine = await fixture.enrollDaemon(account, { env: { ...features, HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath() } });
  const act = async (id: ActionId, input: unknown) => {
    const response = await account.execute(id, input, { presentUserConfirmation: { actionId: id } });
    if (!response.ok) throw createActionExecuteFailureError(response);
    return response.result;
  };
  const document = (text: string) => ({ text, references: [], attachments: [] });
  const definition: WorkflowDefinitionV1 = {
    version: 1, inputs: [], defaults: {
      conversation: { kind: 'fresh' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    },
    blocks: [
      { kind: 'wait', id: 'confirm', document: document('Confirm the next step') },
      { kind: 'step', id: 'continue', inputMode: 'none', document: document(''),
        input: [], result: { kind: 'text' } },
    ],
  };
  const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
    definitionId: randomUUID(), metadata: { title: 'Park and continue' }, definition,
  }));
  const trigger = WorkflowTriggerWriteResultV1Schema.parse(await act('workflow.trigger.add', {
    workflow: saved.definitionId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'schedule', enabled: true,
      schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
  }));
  const { automationId } = trigger.set;
  const start = async () => AutomationV3RunMutationResponseSchema.parse(await act('workflow.trigger.run_now', { automationId })).run;
  const waitForPerson = async (runId: string) => {
    const held = WorkflowRunWaitResultV1Schema.parse(await act('workflow.run.wait', { runId, conditions: ['attention'], timeoutSeconds: 60 }));
    expect(held, JSON.stringify(held)).toMatchObject({
      observation: 'needs_attention', run: { id: runId, heldCount: 1, invocationAttentionRequired: true },
    });
  };
  const { sessionId } = await createSession(fixture.server.baseUrl, account.auth.token);
  const item = InternalTaskMutationOutputSchema.parse(await act('tasks.internal.create', {
    fields: { title: 'The item owned by the first Run' },
  }));
  if (item.status !== 'applied') throw new Error(`Task create returned ${item.status}`);
  // Capture the real queued Run ID for a person-approved Task Take before the worker can park it.
  await machine.daemon.stop();
  const first = await start();
  expect(first.state).toBe('queued');
  const attemptBinding = { sessionId, runId: first.id };
  const claimed = InternalTaskMutationOutputSchema.parse(await act('tasks.internal.transition', {
    taskId: item.todo.id, expectedVersion: item.todo.version, state: 'started', claim: { kind: 'take', attemptBinding },
  }));
  if (claimed.status !== 'applied') throw new Error(`Pre-park Task Take returned ${claimed.status}`);
  expect(claimed.todo.attemptBinding).toEqual(attemptBinding);
  await machine.restart();
  await waitForPerson(first.id);
  const second = await start();
  expect(second.id).not.toBe(first.id);
  await waitForPerson(second.id);
  await waitForPerson(first.id);
  const parked = InternalTaskReadOutputSchema.parse(await act('tasks.internal.read', { taskId: item.todo.id }));
  expect(parked).toMatchObject({ status: 'applied', todo: { version: claimed.todo.version, state: 'started', attemptBinding } });
}, 360_000);

it('starts a Workflow when the direct Task edit Action commits a matching label', async () => {
  const home = fixture;
  if (!home) throw new Error('Dispatch fixture did not start');
  const account = await home.createAccount('work-loop-task-events');
  const machine = await home.enrollDaemon(account, { env: { ...features, HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath() } });
  const project = { machineId: machine.target.machineId, directory: machine.workspaceDir };
  const context = { externalActionTarget: { kind: 'machine' as const, machineId: project.machineId, project } };
  const act = async (id: ActionId, input: unknown, actionContext?: typeof context) => {
    const response = await account.execute(id, input, { ...actionContext, presentUserConfirmation: { actionId: id } });
    if (!response.ok) throw createActionExecuteFailureError(response);
    return response.result;
  };
  const created = InternalTaskMutationOutputSchema.parse(await act('tasks.internal.create', { fields: { title: 'Labelled queue item' } }));
  if (created.status !== 'applied') throw new Error(`Task create returned ${created.status}`);
  const task = { ownerAccountId: created.scope.accountId, taskId: created.todo.id };
  const eventRef = { pluginId: 'happier.triage', localId: 'task-labeled' };
  const catalog = WorkflowEventsListOutputV1Schema.parse(await act('workflow.events.list', machine.target));
  const event = catalog.events.find(({ event }) => event.identity.pluginId === eventRef.pluginId && event.identity.localId === eventRef.localId);
  if (!event?.observationBinding) throw new Error('Task label Event is unavailable on the enrolled Machine');
  const source = PluginEventAutomationSetupResultV1Schema.parse(await act('action.invoke', {
    action: event.setupAction.identity, expectedContributorOccurrenceId: event.setupAction.occurrenceId,
    input: { v: 1, serverId: home.serverId },
  }, context));
  const linked = await account.executeAsPerson('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1, blocks: [
      { kind: 'wait', id: 'confirm', document: { text: 'Review the labelled Task', references: [], attachments: [] } },
    ] },
    },
    project,
    trigger: {
      kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
      filter: { v: 1, all: [{ op: 'contains', field: '/labels', value: 'agent-ok' }] }, maximumObservationAgeMs: null,
      subject: { kind: 'plugin', serverId: home.serverId, pluginId: eventRef.pluginId, subjectKindId: 'task', identity: task },
    },
  });
  if (!linked.ok) throw createActionExecuteFailureError(linked);
  const trigger = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  const { automationId } = trigger.set;
  const sourceStatus = async () => {
    const linked = WorkflowTriggerListResultV1Schema.parse(await act('workflow.trigger.list', { automationId, triggerId: trigger.triggerId }));
    const row = linked.sets.flatMap(set => set.triggers).find(row => row.id === trigger.triggerId);
    return row?.kind === 'pluginEvent' ? row.sourceStatus : null;
  };
  await waitFor(async () => (await sourceStatus())?.state === 'observing', {
    context: 'The Task label Event is observing before native Task edits', failFast: true,
  });
  const skippedBeforeEdit = (await sourceStatus())?.skippedCount ?? 0;
  const history = async () => WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { automationId })).runs;
  expect(await history()).toHaveLength(0);
  const edit = async (expectedVersion: number | undefined, labels: string[]) => {
    const edited = InternalTaskMutationOutputSchema.parse(await act('tasks.internal.edit', {
      ...task, scope: created.scope, expectedVersion, fields: { labels },
    }));
    if (edited.status !== 'applied') throw new Error(`Task edit did not commit: ${JSON.stringify(edited)}`);
    expect(edited.todo.labels).toEqual(expect.arrayContaining(labels));
    expect(edited.todo.labelChange).toMatchObject({ version: edited.todo.version });
    return edited.todo.version;
  };
  const nearMatchVersion = await edit(created.todo.version, ['agent-okay']);
  await waitFor(async () => (await sourceStatus())?.skippedCount === skippedBeforeEdit + 1, {
    context: 'The bound source observes and skips the near-matching Task label', failFast: true,
  });
  expect(await history()).toHaveLength(0);
  await edit(nearMatchVersion, ['reviewed', 'agent-ok']);
  await waitFor(async () => (await history()).length > 0, { context: 'The committed Task label admits its bound Workflow' });
  expect(await history()).toHaveLength(1);
}, 360_000);

it.todo('starts one Workflow per migrated Sentry, telemetry and health occurrence');
async function runHistory(baseUrl: string, token: string, automationId: string) {
  const response = await fetchJson<unknown>(`${baseUrl}/v3/automations/${automationId}/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return AutomationV3RunListResponseSchema.parse(response.data).runs;
}

it('claims authored High work before older Normal work, then releases a capped Run', async () => {
  const home = fixture;
  if (!home) throw new Error('Dispatch fixture did not start');
  const account = await home.createAccount('work-loop-rule-dispatch');
  const testDir = dirs.testDir('rule-dispatch-provider');
  const release = join(testDir, 'release');
  const provider = await createIsolatedFakeClaudeControlShim({
    testDir, scenario: 'daemon-runtime-continuity', runtimeContinuityReleaseFile: release,
    captureEnvironmentKeys: [], logFullStdin: false,
  });
  const daemonEnv = {
    ...features, HAPPIER_CLAUDE_PATH: provider.executablePath, HAPPIER_CLAUDE_CONFIG_DIR: provider.configDir,
  };
  const machine = await home.enrollDaemon(account, { env: daemonEnv });
  const waitingMachine = await home.enrollDaemon(account, { env: daemonEnv });
  const settings = await fetchJson<unknown>(`${home.server.baseUrl}/v3/automations/settings`, {
    method: 'PUT', headers: { Authorization: `Bearer ${account.auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxActiveRunsPerMachine: 2, runRetention: 'keepForever' }),
  });
  expect(settings.status).toBe(200);
  const person = async (id: ActionId, input: unknown) => {
    const result = await account.execute(id, input, { presentUserConfirmation: { actionId: id } });
    if (!result.ok) throw createActionExecuteFailureError(result);
    return result.result;
  };
  const add = async (text: string, dispatch?: { priority: 'normal'; maxActiveRuns: number }) =>
    WorkflowTriggerWriteResultV1Schema.parse(await person('workflow.trigger.add', {
      ...dispatch,
      target: { kind: 'inline', definition: { version: 1, defaults: {
        conversation: { kind: 'fresh' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      }, blocks: [{ kind: 'step', id: 'work',
        document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }] } },
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'schedule', enabled: true,
        schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
    })).set;
  const normal = await add('Normal backlog');
  const draft = await add('DAEMON_RUNTIME_CONTINUITY_HOLD_HIGH', { priority: 'normal', maxActiveRuns: 2 });
  expect(draft.maxActiveRuns).toBe(2);
  const high = WorkflowTriggerWriteResultV1Schema.parse(await person('workflow.trigger.update', {
    automationId: draft.automationId, expectedRevision: draft.revision, patch: { priority: 'high', maxActiveRuns: 1 },
  })).set;
  expect(high).toMatchObject({ priority: 'high', maxActiveRuns: 1 });

  const enqueue = async (automationId: string) => AutomationV3RunMutationResponseSchema.parse(
    await person('workflow.trigger.run_now', { automationId }),
  ).run;
  const history = (automationId: string) => runHistory(home.server.baseUrl, account.auth.token, automationId);
  await machine.daemon.stop();
  const older = await enqueue(normal.automationId);
  const firstHigh = await enqueue(high.automationId);
  expect([older.state, firstHigh.state]).toEqual(['queued', 'queued']);
  await machine.restart();
  let secondHighId: string;
  try {
    await waitFor(async () => (await readFakeClaudeLogEvents(provider.logPath)).some(
      event => event.type === 'runtime_continuity_provider_effect_entered',
    ), { context: 'High Run holds one live execution slot at the provider boundary', timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS * 2 });
    await waitFor(async () => (await history(normal.automationId)).some(
      run => run.id === older.id && run.state === 'succeeded',
    ), { context: 'The uncapped Normal Run can claim the other execution slot', timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS });
    const first = (await history(high.automationId)).find(run => run.id === firstHigh.id);
    expect(first?.claimedAt).not.toBeNull();
    const normalRun = (await history(normal.automationId)).find(run => run.id === older.id);
    expect(first?.claimedAt).toBeLessThan(normalRun?.claimedAt ?? 0);
    // The next occurrence inherits the new Machine placement. Releasing the
    // first executor's local slot cannot wake this daemon.
    const moved = WorkflowTriggerWriteResultV1Schema.parse(await person('workflow.trigger.update', {
      automationId: high.automationId, expectedRevision: high.revision,
      patch: { project: { machineId: waitingMachine.target.machineId, directory: waitingMachine.workspaceDir } },
    })).set;
    expect(moved).toMatchObject({ priority: 'high', maxActiveRuns: 1 });
    const requestProxy = home.requestProxy;
    if (!requestProxy) throw new Error('Claim request observation is unavailable');
    requestProxy.clear();
    const secondHigh = await enqueue(high.automationId);
    secondHighId = secondHigh.id;
    expect(secondHigh).toMatchObject({ state: 'queued', attempt: 0 });
    await waitFor(() => requestProxy.entries().some(request => request.path === claimPath
      && request.statusCode === 200 && request.endedAtMs !== null && request.body?.complete
      && JSON.parse(request.body.text).machineId === waitingMachine.target.machineId),
    { context: 'The other Machine receives a claim response while the High Run is active' });
    expect((await history(high.automationId)).find(run => run.id === secondHighId))
      .toMatchObject({ state: 'queued', attempt: 0 });
  } finally {
    await writeFile(release, '');
  }
  const released = WorkflowRunWaitResultV1Schema.parse(await person('workflow.run.wait', {
    runId: secondHighId, conditions: ['terminal'], timeoutSeconds: 60,
  }));
  expect(released).toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
  expect((await history(high.automationId)).find(run => run.id === secondHighId))
    .toMatchObject({ claimedByMachineId: waitingMachine.target.machineId });
}, 360_000);
it('skips paused Bot schedules, Events and Channels input, refuses child starts, and resumes fresh work', async () => {
  const home = fixture;
  if (!home) throw new Error('Dispatch fixture did not start');
  const account = await home.createAccount('work-loop-bot-pause');
  const provider = await createIsolatedFakeClaudeControlShim({
    testDir: dirs.testDir('bot-pause-provider'), captureEnvironmentKeys: [], logFullStdin: true,
  });
  const slack = await startBotSlackPeer();
  try {
    await exerciseBotIntake(home, account, provider, slack);
  } finally {
    await slack.stop();
  }
}, 360_000);

async function exerciseBotIntake(
  home: NonNullable<typeof fixture>,
  account: Awaited<ReturnType<NonNullable<typeof fixture>['createAccount']>>,
  provider: Awaited<ReturnType<typeof createIsolatedFakeClaudeControlShim>>,
  slack: Awaited<ReturnType<typeof startBotSlackPeer>>,
) {
  const machine = await home.enrollDaemon(account, { env: {
    ...features, ...slack.env, NODE_OPTIONS: `${home.sourceOptions} ${slack.env.NODE_OPTIONS}`,
    HAPPIER_CLAUDE_PATH: provider.executablePath, HAPPIER_CLAUDE_CONFIG_DIR: provider.configDir,
  } });
  const person = async (id: ActionId, input: unknown) => {
    const result = await account.execute(id, input, { presentUserConfirmation: { actionId: id } });
    if (!result.ok) throw createActionExecuteFailureError(result);
    return result.result;
  };
  const updatedAtMs = Date.now();
  const bot = SessionSpawnNewActionResultV1Schema.parse(await person('session.spawn_new', {
    executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    permissionMode: 'default', approvalProfileId: null,
    configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
      permissionIntent: { value: 'default', updatedAtMs }, options: {} },
    connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
  }));
  if (bot.type !== 'success') throw new Error(`Bot Session did not settle (${JSON.stringify(bot)})`);
  const [pausedEvent, freshEvent] = await Promise.all([
    createSession(home.server.baseUrl, account.auth.token),
    createSession(home.server.baseUrl, account.auth.token),
  ]);
  const setPause = (pausedAt: number | null) =>
    person('session.bot.set', { sessionId: bot.sessionId, bot: { kind: 'bot' }, pausedAt });
  const link = async (trigger: unknown) => WorkflowTriggerWriteResultV1Schema.parse(await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: bot.sessionId },
    target: { kind: 'inline', definition: { version: 1, blocks: [
      { kind: 'wait', id: 'review', document: { text: 'Review incoming work', references: [], attachments: [] } },
    ] } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger,
  })).set.automationId;
  await bindSlackToBot(home, account, machine, bot.sessionId);
  await setPause(Date.now());
  const pausedInput = slack.message(`paused-channel-${randomUUID()}`);
  await slack.send(pausedInput);
  const schedule = await link({ kind: 'schedule', enabled: true,
    schedule: { kind: 'interval', scheduleExpr: null, everyMs: 10_000, timezone: null } });
  const lifecycle = await link({ kind: 'sessionLifecycle', enabled: true, events: ['sessionArchived'],
    policy: { kind: 'everyMatch' } });
  await person('session.archive', { sessionId: pausedEvent.sessionId });
  const history = (id: string) => runHistory(home.server.baseUrl, account.auth.token, id);
  await waitFor(async () => (await history(schedule)).some(
    run => run.state === 'skipped' && run.errorCode === 'bot_paused',
  ), { context: 'The running scheduler records skipped Bot work', timeoutMs: 30_000 });
  const pausedScheduleIds = (await history(schedule)).filter(run => run.state === 'skipped').map(run => run.id);
  const [skipped] = await history(lifecycle);
  expect(skipped).toMatchObject({ state: 'skipped', errorCode: 'bot_paused', attempt: 0 });

  const requestId = randomUUID();
  const message = `SESSION_MCP_ACTION_JSON:${JSON.stringify({
    requestId, actionId: 'session.spawn_new', input: {
      executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    },
  })}`;
  await person('session.message.send', { sessionId: bot.sessionId, message });
  let outcome: unknown;
  await waitFor(async () => {
    const event = (await readFakeClaudeLogEvents(provider.logPath)).find(
      row => row.type === 'session_mcp_action_result' && row.requestId === requestId,
    );
    outcome = event?.result;
    return event !== undefined;
  }, { context: 'The running Bot Agent receives a typed refusal for its child start', timeoutMs: FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS });
  expect(ActionExecuteResultSchema.parse(outcome)).toMatchObject({ ok: false, errorCode: 'bot_paused' });

  await setPause(null);
  await slack.send(pausedInput);
  const freshInput = slack.message(`fresh-channel-${randomUUID()}`);
  await slack.send(freshInput);
  await waitForFakeClaudeUserText(provider.logPath, text => text.includes(freshInput.text));
  const delivered = await readFakeClaudeLogEvents(provider.logPath);
  expect(JSON.stringify(delivered)).not.toContain(pausedInput.text);
  await person('session.archive', { sessionId: pausedEvent.sessionId });
  expect((await history(lifecycle)).map(run => run.id)).toEqual([skipped?.id]);
  await person('session.archive', { sessionId: freshEvent.sessionId });
  await waitFor(async () => (await history(lifecycle)).some(
    run => run.id !== skipped?.id && run.attempt > 0,
  ), { context: 'Only the fresh Event reaches the daemon after Resume' });
  expect(await history(lifecycle)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: skipped?.id, state: 'skipped', errorCode: 'bot_paused', attempt: 0 }),
  ]));
  expect(await history(lifecycle)).toHaveLength(2);
  await waitFor(async () => (await history(schedule)).some(
    run => !pausedScheduleIds.includes(run.id) && run.attempt > 0,
  ), { context: 'A fresh scheduled occurrence reaches the daemon after Resume', timeoutMs: 30_000 });
  expect((await history(schedule)).filter(run => pausedScheduleIds.includes(run.id)))
    .toEqual(expect.arrayContaining(pausedScheduleIds.map(id =>
      expect.objectContaining({ id, state: 'skipped', errorCode: 'bot_paused', attempt: 0 }),
    )));
}

async function startBotSlackPeer() {
  let socket: WebSocket | undefined;
  const acknowledgements = new Set<string>();
  const boundary = await startChannelTransportBoundary({
    testDir: dirs.testDir('bot-pause-slack'),
    connected(peer) {
      socket = peer;
      peer.on('message', bytes => {
        const frame = JSON.parse(String(bytes));
        if (typeof frame.envelope_id === 'string') acknowledgements.add(frame.envelope_id);
      });
      peer.send(JSON.stringify({ type: 'hello', connection_info: { app_id: 'A1' } }));
    },
    respond(request) {
      const url = new URL(request.path, 'https://slack.com');
      const method = url.pathname.split('/').at(-1);
      if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U0', bot_id: 'B1', user: 'dispatch-bot' };
      if (method === 'bots.info') return { ok: true, bot: { id: 'B1', user_id: 'U0', app_id: 'A1', name: 'dispatch-bot' } };
      if (method === 'apps.connections.open') return { ok: true, url: 'wss://socket.slack.com/dispatch' };
      if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', name: 'dispatch', is_im: false,
        is_mpim: false, is_private: false, is_archived: false } };
      if (method === 'users.info') return { ok: true, user: { id: url.searchParams.get('user'), team_id: 'T1',
        is_bot: false, deleted: false, name: 'dispatch-sender' } };
      if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: '1700000001.000001' };
      throw new Error(`Unexpected Slack operation ${request.method} ${url.pathname}`);
    },
  });
  return { ...boundary,
    message: (text: string) => ({ text, eventId: randomUUID(), timestamp: (Date.now() / 1000).toFixed(3) }),
    async send(input: { text: string; eventId: string; timestamp: string }) {
      await waitFor(() => socket?.readyState === 1, { context: 'The bound Slack socket is ready', timeoutMs: 30_000 });
      const envelopeId = randomUUID();
      socket?.send(JSON.stringify({ type: 'events_api', envelope_id: envelopeId, payload: {
        type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: input.eventId, event: {
          type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: input.text, ts: input.timestamp,
        },
      } }));
      await waitFor(() => acknowledgements.has(envelopeId), { context: 'Slack receives acknowledgement after ingress', timeoutMs: 30_000 });
    },
  };
}

async function bindSlackToBot(
  home: NonNullable<typeof fixture>,
  account: Awaited<ReturnType<NonNullable<typeof fixture>['createAccount']>>,
  machine: Awaited<ReturnType<NonNullable<typeof fixture>['enrollDaemon']>>,
  sessionId: string,
) {
  const provider = { pluginId: 'happier.channel.slack', localId: 'slack-bot' };
  const ref = { service: provider, accountId: randomUUID() };
  const metadata = { displayName: 'Dispatch fixture Bot', scopes: [], providerIdentity: { accountId: ref.accountId } };
  const authenticationModeId = 'bot-tokens';
  const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId,
    payload: { v: 1, values: { botToken: 'xoxb-fin-test-only', appToken: 'xapp-fin-test-only' } }, metadata, now: Date.now() });
  const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
    material: { type: 'dataKey', machineKey: account.credentials.encryption.machineKey }, payload, randomBytes });
  const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref, authenticationModeId, content,
    metadata, expectedCredentialRevision: null, directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 });
  const imported = await fetchJson<unknown>(`${home.server.baseUrl}/v4/connect/qualified/credential`, {
    method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation),
  });
  expect(imported.status).toBe(200);
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(imported.data);
  const ui = await connectUiPersonActionClient({ ...home.personActionConnection, accountSecret: account.auth.accountSigningSeed });
  try {
    await waitFor(() => ui.isMachineActive(machine.target.machineId), { context: 'Channels setup observes the enrolled Machine' });
    const projection = await readUiChannelProviderProjection(machine.target.machineId,
      { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, serverId: ui.serverId });
    if (!projection.supported || !('targetedContributions' in projection)) throw new Error('Channels provider projection unavailable');
    const observed = projection.targetedContributions;
    const setup = observed.points.flatMap(point => point.protocols.flatMap(protocol => protocol.contributions
      .filter(contribution => contribution.contributor.pluginId === provider.pluginId)
      .flatMap(contribution => contribution.operations))).find(operation => operation.role === 'setup');
    if (!setup) throw new Error('Slack provider setup unavailable');
    const providerSelection = PluginTargetedContributionSelectionV1Schema.parse({
      target: { pluginId: observed.target.pluginId, sourceCustody: observed.target.sourceCustody }, point: setup.point,
      contributor: { pluginId: setup.contributor.pluginId, contributionId: setup.contributor.contributionId,
        sourceCustody: setup.contributor.sourceCustody },
    });
    async function invoke(localId: string, input: unknown) {
      const result = await account.execute('action.invoke', {
        action: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId }, input,
      }, { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
        kind: 'machine', machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      } });
      if (!result.ok) throw createActionExecuteFailureError(result);
      return result.result;
    }
    const connection = ConversationConnectionCreateResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
      { providerSelection, providerSetupInput: { credentialRef: ref }, credentialRef: ref, selectedTransport: 'socket' }));
    if (connection.kind !== 'created') throw new Error(`Slack connection refused: ${connection.kind}`);
    const connections = ConversationConnectionListResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionList, {}));
    const current = connections.connections.find(item => item.connectionId === connection.connectionId);
    if (!current) throw new Error('Created Slack connection is absent from the Account list');
    const resolved = ConversationBindingResolveResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
      { kind: 'endpoint', connectionId: connection.connectionId, expectedConnectionRevision: current.revision, query: 'C1' }));
    if (resolved.kind !== 'endpointCandidates' || !resolved.candidates[0]) throw new Error('Slack endpoint unavailable');
    const { kind, audience, id } = resolved.candidates[0];
    const binding = ConversationBindingCreateResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
      { connectionId: connection.connectionId, expectedConnectionRevision: current.revision,
        endpointSelection: { query: 'C1', selected: { kind, audience, id } },
        principalSelection: { query: 'U1', selected: [{ id: 'slack:T1:user:U1', kind: 'human' }] },
        target: { kind: 'session', sessionId, policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } }, inputMode: 'allAllowedMessages', enabled: true }));
    expect(binding.kind).toBe('created');
  } finally {
    await ui.close();
  }
}
