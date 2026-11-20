import { expect, it } from 'vitest';

import { AutomationEventAdmitHttpResultV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationEventActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { AutomationDatabaseSubjectV1Schema, projectAutomationDatabaseSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { DATABASE_STATS_READ_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import {
    DatabaseOperationResultV1Schema,
    DatabaseStatsOperationInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID } from '../../../plugins/database-workbench/src/insights/events';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
// Match the native Automation Run settlement window used by the pending bridge
// journey. The generic testkit wait can expire while the worker is launching.
const workflowSettlement = { timeoutMs: 90_000, intervalMs: 100, failFast: true } as const;

// D15: the source read, SDK observation admission and Workflow worker are real.
// The subject comes from projects.open's accepted target, never a fixture-only
// Environment identity. Setup/schema failures cannot count as behavior RED.
it('P4-F9-known-good-observation-run', async () => {
  const admitPath = AutomationEventActionHttpPathsV1['automation.event.admit'];
  let replayNextObservation = false;
  const replayedRunIds: string[] = [];
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-automation-f9'),
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    daemonEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    // Finite native work reaches the Home advertised in its signed connection
    // descriptor. Put the fixture transport observer on that ingress.
    guestReachableHome: { host: '127.0.0.1' },
    captureRequestBody: request => replayNextObservation && request.path === admitPath,
    async beforeForwardResponse(request): Promise<void> {
      if (!replayNextObservation || request.path !== admitPath || request.statusCode !== 200) return;
      replayNextObservation = false;
      const authorization = request.headers.authorization;
      const publisherProof = request.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1];
      if (!request.body?.complete || request.body.truncated ||
          typeof authorization !== 'string' || typeof publisherProof !== 'string') {
        throw new Error('F9 observation transport capture is incomplete');
      }
      // Model duplicate delivery by the network while the real daemon Action
      // is still awaiting its first response. Keep the signed request in memory.
      const replay = await fetchJson<unknown>(fixture.server.baseUrl + admitPath, {
        method: 'POST', headers: { authorization, 'Content-Type': 'application/json',
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherProof },
        body: request.body.text,
      });
      if (replay.status !== 200) throw new Error(`F9 duplicate observation request returned HTTP ${replay.status}`);
      for (const result of AutomationEventAdmitHttpResultV1Schema.parse(replay.data).results) {
        if (result.kind === 'rejoined') replayedRunIds.push(result.runId);
      }
    },
  });
  try {
    const target = (await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F9 selected')).target;
    const privateLiteral = 'F9_PRIVATE_SQL_LITERAL_MUST_NOT_ENTER_WORKFLOW_HISTORY';
    await fixture.postgres.sql('dbw_selected', `CREATE TABLE dbw_f9_workload (id integer, private_value text);
      INSERT INTO dbw_f9_workload VALUES (1, '${privateLiteral}');
      SELECT sum(id) FROM dbw_f9_workload WHERE private_value = '${privateLiteral}';`);
    const subject = projectAutomationDatabaseSubjectV1(AutomationDatabaseSubjectV1Schema.parse({
      kind: 'database', serverId: fixture.serverId, target: target,
    }));
    const headers = { Authorization: `Bearer ${fixture.owner.credentials.token}` };
    let materialization: { machineId: string; materializationId: string; pluginId: string } | undefined;
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture.server.baseUrl}${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginIds: [DATABASE_FINDING_EVENT_REF.pluginId] }),
      });
      expect(response.status).toBe(200);
      const snapshot = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(response.data).snapshots
        .find(row => row.machineId === fixture.machine.target.machineId);
      const installed = snapshot?.materializations.find(row => row.pluginId === DATABASE_FINDING_EVENT_REF.pluginId
        && row.enabled && row.trustState === 'trusted');
      if (!installed) return false;
      materialization = { machineId: installed.machineId, materializationId: installed.materializationId,
        pluginId: installed.pluginId };
      return true;
    }, { context: 'The installed database Event source is published by its actual daemon' });
    if (!materialization) throw new Error('Database source materialization was not published');

    async function targetCalls() {
      return fixture.postgres.sql('dbw_selected', `/* DBW_F9_NATIVE_COUNT */ SELECT coalesce(sum(calls), 0)::text
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND query NOT LIKE '%DBW_F9_NATIVE_COUNT%'`);
    }
    const callsBeforeArm = await targetCalls();
    const setup = await fixture.owner.execute('action.invoke', {
      action: { pluginId: DATABASE_FINDING_EVENT_REF.pluginId, localId: DATABASE_FINDING_SETUP_LOCAL_ID },
      input: { v: 1, subject, sourceScope: fixture.machine.target },
    }, { externalActionTarget: { kind: 'machine', machineId: fixture.machine.target.machineId },
      presentUserConfirmation: { actionId: 'action.invoke' } });
    expect(setup.ok, JSON.stringify(setup)).toBe(true);
    if (!setup.ok) throw new Error(`Database source setup refused (${setup.errorCode})`);
    const source = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
    const eventSource = { kind: 'pluginEvent', eventRef: DATABASE_FINDING_EVENT_REF,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
      maximumObservationAgeMs: null };
    const matchingFilter = { v: 1, all: [{ op: 'gte', field: '/observation/summary/records', value: 1 }] };
    const armed = await fixture.owner.executeReviewed('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1, blocks: [
        { kind: 'action', id: 'read-starters', actionId: 'workflow.starters.list', input: {} },
      ] } },
      project: { machineId: fixture.machine.target.machineId, directory: fixture.machine.workspaceDir },
      trigger: { ...eventSource, enabled: true, filter: matchingFilter },
    });
    expect(armed.ok, JSON.stringify(armed)).toBe(true);
    if (!armed.ok) throw new Error(`Database trigger refused (${armed.errorCode})`);
    const saved = WorkflowActionOutputSchemasV1['workflow.trigger.add'].parse(armed.result);
    expect(await targetCalls(), 'Arming a database source must not sample it').toBe(callsBeforeArm);

    async function readRuns() {
      const arrival = await fixture.owner.execute('workflow.run.list', { origin: 'automation' });
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`Run listing refused (${arrival.errorCode})`);
      return WorkflowActionOutputSchemasV1['workflow.run.list'].parse(arrival.result).runs.filter(row =>
        row.origin.kind === 'automation' && row.origin.automationId === saved.set.automationId);
    }
    async function observe() {
      const arrival = await fixture.executeDatabase(DATABASE_STATS_READ_ACTION_ID_V1,
        DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target: target,
          request: { kind: 'stats.read', group: 'statements', selection: { page: { rows: 80 }, order: 'totalTime' } } }));
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`Database source read refused (${arrival.errorCode})`);
      const result = DatabaseOperationResultV1Schema.parse(arrival.result);
      expect(result).toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'available', group: 'statements' } });
      expect(JSON.stringify(result)).not.toContain(privateLiteral);
    }
    expect(await readRuns()).toEqual([]);
    await observe();
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && runs[0]?.state === 'succeeded';
    }, { ...workflowSettlement, context: 'One completed database observation completes one real Workflow Run' });
    const firstRun = (await readRuns())[0]!;
    const detail = await fixture.owner.execute('workflow.run.get', { runId: firstRun.id });
    expect(detail.ok, JSON.stringify(detail)).toBe(true);
    if (!detail.ok) throw new Error(`Run detail refused (${detail.errorCode})`);
    const publicRun = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(detail.result);
    expect(publicRun.run).toMatchObject({ state: 'succeeded', origin: { kind: 'automation',
      cause: { kind: 'trigger', triggerKind: 'pluginEvent' } } });
    expect(JSON.stringify(publicRun)).not.toContain(privateLiteral);
    expect(JSON.stringify(publicRun)).not.toContain('dbw_f9_workload');
    console.info('P4-F9-known-good-observation-run passed', fixture.runtime);

    replayNextObservation = true;
    await observe();
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(2);
      return runs.length === 2 && runs.every(row => row.state === 'succeeded');
    }, { ...workflowSettlement, context: 'A distinct completed observation keeps its own occurrence identity' });
    const secondRun = (await readRuns()).find(row => row.id !== firstRun.id);
    expect(replayNextObservation, 'The real Home ingress must see the duplicate delivery').toBe(false);
    expect(replayedRunIds, 'A duplicate delivery must rejoin the identical Workflow Run').toEqual([secondRun?.id]);
    const threshold = await fixture.owner.executeReviewed('workflow.trigger.update', {
      automationId: saved.set.automationId, triggerId: saved.triggerId, expectedRevision: saved.set.revision,
      patch: { trigger: { ...eventSource,
        filter: { v: 1, all: [{ op: 'lt', field: '/observation/summary/records', value: 1 }] } } },
    });
    expect(threshold.ok, JSON.stringify(threshold)).toBe(true);
    if (!threshold.ok) throw new Error(`Threshold update refused (${threshold.errorCode})`);
    const thresholdSet = WorkflowActionOutputSchemasV1['workflow.trigger.update'].parse(threshold.result);
    await observe();
    expect(await readRuns(), 'A completed nonmatching observation must not launch a Run').toHaveLength(2);
    const disabled = await fixture.owner.executeReviewed('workflow.trigger.update', {
      automationId: saved.set.automationId, triggerId: saved.triggerId, expectedRevision: thresholdSet.set.revision,
      // Restore the matching condition while disarming, so a broken enabled
      // decision would launch a third Run and cannot hide behind the threshold.
      patch: { enabled: false, trigger: { ...eventSource, filter: matchingFilter } },
    });
    expect(disabled.ok, JSON.stringify(disabled)).toBe(true);
    await observe();
    expect(await readRuns()).toHaveLength(2);
  } finally {
    await fixture.stop();
  }
}, 0);
