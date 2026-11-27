import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { InternalTaskMutationOutputSchema, InternalTaskReadOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { AutomationV3RunMutationResponseSchema, AutomationV3SettingsSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const dirs = createRunDirs({ runLabel: 'work-loop-dispatch-and-fleet' });
const features = { HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;

beforeAll(async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({
    testDir: dirs.testDir('dispatch'), dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
    personActionSurface: 'coreAction',
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
it.todo('claims a High-priority incident before the older backlog and applies only explicitly set rule limits');
it.todo('records bot_paused for skipped occurrences and admits only new occurrences after resume');
