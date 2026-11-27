import { expect, it } from 'vitest';
import { DATABASE_ACCESS_READ_ACTION_ID_V1, DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, DatabaseAccessSetInputV1Schema, DatabaseAccessSetResultV1Schema, DatabaseAccessReadInputV1Schema, DatabaseAccessReadResultV1Schema } from '@happier-dev/database-protocol';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// P3: the manual association owns this deliberate choice.
it('F5 saves a database agent access choice and reads it back through the same admitted target', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-access-f5') });
  try {
    const { target } = await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F5 access PostgreSQL');
    const read = await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, {
      operation: 'statement.run', mode: 'read', target, statement: { sql: 'SELECT current_database()', parameters: [] },
    });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (!read.ok) throw new Error(`F5 control refused (${read.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(read.result)).toMatchObject({ ok: true, results: [{ rows: [
      { cells: [{ type: 'text', value: 'dbw_selected' }] },
    ] }] });
    console.info('P3-F5-known-good-target-read passed', fixture.runtime);
    for (const agentAccess of ['none', 'read'] as const) {
      const changed = await fixture.executeDatabaseAsPerson(DATABASE_ACCESS_SET_ACTION_ID_V1,
        DatabaseAccessSetInputV1Schema.parse({ target, agentAccess }));
      expect(changed.ok, JSON.stringify(changed)).toBe(true);
      if (!changed.ok) throw new Error(`F5 access Save refused (${changed.errorCode})`);
      expect(DatabaseAccessSetResultV1Schema.parse(changed.result)).toEqual({ ok: true, agentAccess });
      const saved = await fixture.executeDatabaseAsPerson(DATABASE_ACCESS_READ_ACTION_ID_V1,
        DatabaseAccessReadInputV1Schema.parse({ target }));
      expect(saved.ok, JSON.stringify(saved)).toBe(true);
      if (!saved.ok) throw new Error(`F5 access read refused (${saved.errorCode})`);
      expect(DatabaseAccessReadResultV1Schema.parse(saved.result)).toMatchObject({ setBy: 'machine', agentAccess });
      const repeated = await fixture.executeDatabaseAsPerson(DATABASE_ACCESS_SET_ACTION_ID_V1,
        DatabaseAccessSetInputV1Schema.parse({ target, agentAccess }));
      expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
      if (!repeated.ok) throw new Error(`F5 repeated Save refused (${repeated.errorCode})`);
      expect(DatabaseAccessSetResultV1Schema.parse(repeated.result)).toEqual({ ok: true, agentAccess });
    }
  } finally { await fixture.stop(); }
}, 0);
