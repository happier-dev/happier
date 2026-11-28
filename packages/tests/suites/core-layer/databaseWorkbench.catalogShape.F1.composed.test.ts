import { expect, it } from 'vitest';
import {
  DATABASE_RELATIONS_LIST_ACTION_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1,
  DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
  DATABASE_STATEMENT_RUN_ACTION_ID_V1,
  type DatabaseActionIdV1,
} from '@happier-dev/database-protocol';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'dbw-p1-catalog-census' });

it('F1 catalog and F2 Console preserve selected statement counts with thousands of closed relations and a million-row target', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('selected-native-catalog') });
  try {
    const { target } = await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'Catalog scale witness');
    async function invoke(action: DatabaseActionIdV1, input: Record<string, unknown>) {
      const result = await fixture.executeDatabaseAsPerson(action, { ...input, target });
      if (!result.ok) throw new Error(`Selected catalog action refused (${result.errorCode})`);
      return DatabaseOperationResultV1Schema.parse(result.result);
    }
    const counters = async () => BigInt(await fixture.postgres.sql('dbw_neighbor',
      "SELECT coalesce(sum(calls), 0)::text FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'dbw_selected')"));
    const selectedRow = await invoke(DATABASE_ROWS_READ_ACTION_ID_V1, {
      operation: 'rows.read', relation: { schema: 'public', name: 'sentinel' },
      columns: ['target'], order: [], page: { rows: 1 },
    });
    expect(selectedRow).toMatchObject({ ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'text', value: 'dbw_selected' }] }] } });
    async function observe() {
      const before = await counters();
      const schemas = await invoke(DATABASE_SCHEMAS_LIST_ACTION_ID_V1, {
        operation: 'schemas.list', search: 'public', page: { rows: 10 },
      });
      const afterSchemas = await counters();
      const relations = await invoke(DATABASE_RELATIONS_LIST_ACTION_ID_V1, {
        operation: 'relations.list', schema: 'public', search: 'sentinel', page: { rows: 10 },
      });
      const afterRelations = await counters();
      const consoleResult = await invoke(DATABASE_STATEMENT_RUN_ACTION_ID_V1, {
        operation: 'statement.run', mode: 'read',
        statement: { sql: 'SELECT ascii(left(target, 1)) AS dbw_catalog_scale_console FROM public.sentinel WHERE id = 1', parameters: [] },
      });
      const consoleStatements = await fixture.postgres.sql('dbw_neighbor',
        "SELECT coalesce(sum(calls), 0)::text FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'dbw_selected') AND query LIKE 'SELECT % AS dbw_catalog_scale_console %'");
      expect(schemas).toMatchObject({ ok: true, operation: 'schemas.list', schemas: [{ name: 'public' }] });
      expect(relations).toMatchObject({ ok: true, operation: 'relations.list',
        relations: [{ relation: { schema: 'public', name: 'sentinel' } }] });
      expect(consoleResult).toMatchObject({ ok: true, operation: 'statement.run',
        results: [{ rows: [{ cells: [{ type: 'integer', value: '100' }] }] }] });
      return { schemaStatements: Number(afterSchemas - before), relationStatements: Number(afterRelations - afterSchemas),
        userStatementsTotal: Number(consoleStatements) };
    }
    const baseline = await observe();
    expect(baseline.userStatementsTotal).toBe(1);
    await fixture.postgres.seedScale();
    await fixture.postgres.sql('dbw_selected', `CREATE SCHEMA dbw_closed;
      DO $dbw$ BEGIN FOR i IN 1..2000 LOOP
        EXECUTE format('CREATE TABLE dbw_closed.rel_%s (id bigint, note text)', i);
      END LOOP; END $dbw$;`);
    const relations = await fixture.postgres.sql('dbw_selected',
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'dbw_closed'");
    expect(relations).toBe('2000');
    const scaled = await observe();
    expect(scaled).toEqual({ ...baseline, userStatementsTotal: 2 });
    console.info('DBW_P1_CATALOG_STATEMENTS', { baseline, scaled, closedRelations: Number(relations) });
  } finally {
    await fixture.stop();
  }
}, 0);
