import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowDefinitionGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import {
  WorkflowStartersListResultV1Schema,
  WorkflowStartersResolveResultV1Schema,
} from '@happier-dev/protocol/workflows/builtins/starterActionsV1';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';

const dirs = createRunDirs({ runLabel: 'work-loop-incident-task-spine' });
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
let account: Awaited<ReturnType<Awaited<ReturnType<typeof startProjectDaemonFixture>>['createAccount']>>;
let starterKeys: readonly string[];

beforeAll(async () => {
  database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startProjectDaemonFixture({
    testDir: dirs.testDir('incident'), dbProvider: 'postgres', daemonAuthentication: 'existing-terminal',
    personActionSurface: 'coreAction',
    serverEnv: {
      DATABASE_URL: database.homeDatabaseUrl,
      SERVER_ROLE: 'api',
      HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
    },
  });
  account = await fixture.createAccount('work-loop-incident');
  const response = await account.executeAsPerson('workflow.starters.list', {});
  if (!response.ok) throw createActionExecuteFailureError(response);
  starterKeys = WorkflowStartersListResultV1Schema.parse(response.result).examples.map(starter => starter.key);
}, 360_000);

afterAll(async () => {
  try { await fixture?.stop(); } finally { await database?.stop(); }
});

it('offers maintenance starters through the signed-in Workflow Action', () => {
  expect(starterKeys).toEqual(expect.arrayContaining(['daily-self-repair', 'repo-hygiene-sweep']));
});

it('resolves the incident and labelled queue starters and persists the incident draft', () => account.withPersonActionClient(async execute => {
  expect(starterKeys).toEqual(expect.arrayContaining(['fix-an-incident', 'work-a-labelled-queue']));
  async function resolveStarter(key: string) {
    const response = await execute('workflow.starters.resolve', { key });
    if (!response.ok) throw createActionExecuteFailureError(response);
    return WorkflowStartersResolveResultV1Schema.parse(response.result);
  }
  const queue = await resolveStarter('work-a-labelled-queue');
  const incident = await resolveStarter('fix-an-incident');
  expect(queue).toMatchObject({ status: 'ready', example: { eventSeed: {
    eventRef: { pluginId: 'happier.triage', localId: 'task-labeled' },
    initialFilter: { v: 1, all: [{ op: 'contains', field: '/labels', value: 'agent-ok' }] },
  } } });
  expect(incident).toMatchObject({ status: 'ready', example: { definition: {
    inputs: expect.arrayContaining([expect.objectContaining({ name: 'taskId', required: true })]),
    finalOutput: { producer: { blockId: 'work' }, path: ['open-pr', 'pullRequest', 'url'] },
  } } });
  if (incident.status !== 'ready') throw new Error('Incident starter did not resolve');
  // Save the exact built-in through signed Action ingress. Reference and Action
  // input validation on that path can reject a draft that resolved successfully.
  const definitionId = randomUUID();
  const actionId = 'workflow.definition.create';
  const saved = await execute(actionId, {
    definitionId, definition: incident.example.definition,
    metadata: { title: 'Fix an incident' },
  }, { presentUserConfirmation: { actionId } });
  if (!saved.ok) throw createActionExecuteFailureError(saved);
  const loaded = await execute('workflow.definition.get', { definitionId });
  if (!loaded.ok) throw createActionExecuteFailureError(loaded);
  const definition = WorkflowDefinitionGetResultV1Schema.parse(loaded.result);
  expect(definition.definitionId).toBe(definitionId);
  expect(definition.definition).toEqual(incident.example.definition);
}));

it.todo('settles the first Run at PR opened and reuses its Machine slot while the claimed Task is in review');
it.todo('correlates a deployed PR to its Task and Sentry issue before resolving or reopening the incident');
