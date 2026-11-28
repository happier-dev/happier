import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import {
  DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, DATABASE_CAPTURE_RESOURCE_REF_V1, DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
  DatabaseCaptureConfigureResultV1Schema, DatabaseCaptureStatusResultV1Schema, databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { AutomationEventActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import { DATABASE_PLUGIN_ID_V1, DATABASE_ROWS_READ_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseRowsReadInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseDescriptorV1Schema as DatabaseTargetsConnectResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { installDatabaseCapturePluginFixture, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// The native read is the control; a broken activation/fixture cannot prove disable.
it('F12-known-good-enabled-workbench then disable and re-enable through lifecycle Actions', async () => {
  const testDir = run.testDir('dbw-lifecycle-f12');
  const moduleImportJournal = join(testDir, 'workbench-module-imports.txt');
  const fixture = await startDatabaseWorkbenchInsightsFixture({
    testDir,
    workbenchModuleImportJournal: moduleImportJournal,
    guestReachableHome: { host: '127.0.0.1' },
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    daemonEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
  });
  try {
    const machineId = fixture.machine.target.machineId;
    const project = { serverId: fixture.serverId, machineId, projectId: fixture.targets.selected.projectKey };
    const captureSource = { kind: 'worktree', ...project, workspaceId: fixture.targets.selected.workspace.workspaceId };
    await installDatabaseCapturePluginFixture({ testDir, daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken });
    function capture(actionId: typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 | typeof DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
      input: unknown) {
      return fixture.owner.executeReviewed('action.invoke', {
        action: { pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: databaseActionLocalIdV1(actionId) }, input,
      }, { externalActionTarget: { kind: 'machine', machineId }, presentUserConfirmation: { actionId: 'action.invoke' } });
    }
    const configuredCapture = await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled: true });
    if (!configuredCapture.ok) throw new Error(`F12 Capture configuration refused (${configuredCapture.errorCode})`);
    expect(DatabaseCaptureConfigureResultV1Schema.parse(configuredCapture.result)).toMatchObject({ ok: true, enabled: true });

    const saved = await fixture.owner.execute('secrets.create', {
      name: 'F12 native target', kind: 'other', value: fixture.postgres.selectedDatabaseUrl,
    }, { presentUserConfirmation: { actionId: 'secrets.create' } });
    if (!saved.ok) throw new Error(`F12 secret creation refused (${saved.errorCode})`);
    const secret = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(saved.result);
    const { source: _source, ...scope } = fixture.targets.selected;
    const connected = await fixture.executeDatabase(DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
      { scope, savedSecretRef: secret.secretRef, label: 'F12 selected native database' });
    if (!connected.ok) throw new Error(`F12 Connect refused (${connected.errorCode})`);
    const descriptor = DatabaseTargetsConnectResultV1Schema.parse(connected.result);
    const input = DatabaseRowsReadInputV1Schema.parse({ operation: 'rows.read', target: descriptor.target,
      relation: { schema: 'public', name: 'sentinel' }, columns: ['id', 'target'], order: [], page: { rows: 1 } });
    async function readControl() {
      const arrival = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input);
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`F12 control refused (${arrival.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(arrival.result)).toMatchObject({ ok: true, operation: 'rows.read',
        result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] } });
    }
    // Count completed statements from another database so the census cannot
    // increment the database it is measuring.
    function selectedStatementCount() {
      return fixture.postgres.sql('dbw_neighbor', `SELECT coalesce(sum(calls), 0)::text
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'dbw_selected')`);
    }
    const beforeControl = BigInt(await selectedStatementCount());
    await readControl();
    expect(BigInt(await selectedStatementCount())).toBeGreaterThan(beforeControl);
    expect(await readFile(moduleImportJournal, 'utf8')).toMatch(/^\d+\n/m);
    console.info('F12-known-good-enabled-workbench passed', fixture.runtime);
    const lifecycleInput = { pluginId: DATABASE_PLUGIN_ID_V1, machineId, scope: 'machine' };
    const disabled = await fixture.owner.executeReviewed('plugins.disable', lifecycleInput);
    expect(disabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    const beforeDisabledStartup = await selectedStatementCount();
    const importsBeforeDisabledStartup = await readFile(moduleImportJournal, 'utf8');
    fixture.takeRequestObservations();
    const enabledPid = fixture.machine.daemon.state.pid;
    await fixture.machine.restart();
    const disabledPid = fixture.machine.daemon.state.pid;
    expect(disabledPid).not.toBe(enabledPid);
    const refused = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    // Disabling the Workbench removes its Action from Machine dispatch.
    expect(refused).toMatchObject({ ok: false, errorCode: 'contributed_action_unavailable' });
    const captureStatus = await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source: captureSource });
    if (!captureStatus.ok) throw new Error(`F12 Capture status refused (${captureStatus.errorCode})`);
    expect(DatabaseCaptureStatusResultV1Schema.parse(captureStatus.result)).toMatchObject({ ok: true, enabled: true });
    expect(await readFile(moduleImportJournal, 'utf8')).toBe(importsBeforeDisabledStartup);
    expect(await selectedStatementCount()).toBe(beforeDisabledStartup);
    expect(fixture.readActionOccurrences()).toHaveLength(0);
    expect(fixture.takeRequestObservations().filter(request =>
      request.path === AutomationEventActionHttpPathsV1['automation.event.admit'])).toHaveLength(0);
    expect(await fixture.postgres.sql('happier',
      "SELECT count(*) FROM pg_stat_activity WHERE datname = 'dbw_selected'"))
      .toBe('0');
    // Feature lifecycle must never remove or alter target data.
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1')).toBe('dbw_selected');
    const enabled = await fixture.owner.executeReviewed('plugins.enable', lifecycleInput);
    expect(enabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    const beforeReenabled = BigInt(await selectedStatementCount());
    await readControl();
    expect(BigInt(await selectedStatementCount())).toBeGreaterThan(beforeReenabled);
    expect((await readFile(moduleImportJournal, 'utf8')).length).toBeGreaterThan(importsBeforeDisabledStartup.length);
    console.info('F12 disabled restart census passed', {
      enabledPid, disabledPid, moduleImports: 0, selectedStatements: 0, eventAdmissions: 0, captureEnabled: true,
    });
  } finally {
    await fixture.stop();
  }
}, 0);
