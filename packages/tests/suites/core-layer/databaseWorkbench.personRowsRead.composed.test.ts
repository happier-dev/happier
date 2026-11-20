import { expect, it } from 'vitest';

import {
  DATABASE_ACCESS_SET_ACTION_ID_V1,
  DATABASE_PLUGIN_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseRowsReadInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

it('a signed-in Person can press the Machine Rows Read Action with agent access set to None', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-person-rows-read') });
  try {
    const target = fixture.targets.selected;
    const access = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'none' });
    expect(access).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
    const input = DatabaseRowsReadInputV1Schema.parse({
      operation: 'rows.read', target, relation: { schema: 'public', name: 'sentinel' },
      columns: ['id', 'target'], order: [], page: { rows: 1 },
    });
    const action = { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1) };
    const machineId = fixture.machine.target.machineId;
    const result = await fixture.owner.executeAsPerson('action.invoke', { action, input }, {
      externalActionTarget: { kind: 'machine', machineId },
    }, { action, machineId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(DatabaseOperationResultV1Schema.parse(result.result)).toMatchObject({
      ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] },
    });
  } finally {
    await fixture.stop();
  }
}, 0);
