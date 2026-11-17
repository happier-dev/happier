import { expect, it } from 'vitest';

import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_ROWS_READ_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseRowsReadInputV1Schema } from '../../../database-protocol/src/databaseOperations';
import { DatabaseTargetsConnectResultV1Schema } from '../../../database-protocol/src/databaseTargetActions';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// The native read is the control; a broken activation/fixture cannot prove disable.
it('F12-known-good-enabled-workbench then disable and re-enable through lifecycle Actions', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-lifecycle-f12') });
  try {
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
    await readControl();
    console.info('F12-known-good-enabled-workbench passed', fixture.runtime);
    const lifecycleInput = { pluginId: DATABASE_PLUGIN_ID_V1, machineId: fixture.machine.target.machineId, scope: 'machine' };
    const disabled = await fixture.owner.execute('plugins.disable', lifecycleInput,
      { presentUserConfirmation: { actionId: 'plugins.disable' } });
    expect(disabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    const refused = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(refused).toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
    expect(await fixture.postgres.sql('happier',
      "SELECT count(*) FROM pg_stat_activity WHERE datname = 'dbw_selected'"))
      .toBe('0');
    // Feature lifecycle must never remove or alter target data.
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1')).toBe('dbw_selected');
    const enabled = await fixture.owner.execute('plugins.enable', lifecycleInput,
      { presentUserConfirmation: { actionId: 'plugins.enable' } });
    expect(enabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    await readControl();
  } finally {
    await fixture.stop();
  }
}, 0);
