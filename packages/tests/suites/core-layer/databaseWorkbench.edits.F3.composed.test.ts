import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_EDITS_APPLY_ACTION_ID_V1, DatabaseEditsApplyInputV1Schema,
  DatabaseOperationResultV1Schema, type DatabaseEditsApplyInputV1 } from '@happier-dev/database-protocol';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

describe.sequential('F3 composed editor cases', () => {
  let fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>> | undefined;
  let target: DatabaseEditsApplyInputV1['target'];
  const relation = { schema: 'public', name: 'dbw_f3' };
  function currentFixture() {
    if (!fixture) throw new Error('F3 fixture has not reached G1');
    return fixture;
  }
  const update = (id: string, before: string, after: string) => ({ kind: 'update' as const,
    key: [{ column: 'id', value: { type: 'integer' as const, value: id } }],
    original: [{ column: 'note', value: { type: 'text' as const, value: before } }],
    values: [{ column: 'note', value: { kind: 'value' as const, cell: { type: 'text' as const, value: after } } }],
  });
  async function apply(changes: unknown[]) {
      const arrival = await currentFixture().executeDatabase(DATABASE_EDITS_APPLY_ACTION_ID_V1,
        DatabaseEditsApplyInputV1Schema.parse({ operation: 'edits.apply', target, relation, changes }));
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`F3 Apply refused (${arrival.errorCode})`);
      const parsed = DatabaseOperationResultV1Schema.safeParse(arrival.result);
      expect(parsed.success, JSON.stringify(arrival.result)).toBe(true);
      return DatabaseOperationResultV1Schema.parse(arrival.result);
  }
  beforeAll(async () => {
    fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-edits-f3') });
    ({ target } = await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F3 editing PostgreSQL'));
    // The fixture's terminal executor is automation (isDelegatedActionRequesterV1), and Connect
    // stores Read for agents. The person raises it to Read & write (asks first); each Apply then
    // asks, and executeReviewed approves through the person client.
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteAsk' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteAsk' } });
    await fixture.postgres.sql('dbw_selected', "CREATE TABLE dbw_f3 (id integer PRIMARY KEY, note text DEFAULT 'insert-default'); INSERT INTO dbw_f3 VALUES (1,'before'),(2,'other');");
    expect(await apply([update('1', 'before', 'committed')])).toMatchObject({ ok: true,
      operation: 'edits.apply', status: 'committed', updated: '1' });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f3 WHERE id=1')).toBe('committed');
    console.info('P3-F3-known-good-editor-write passed', fixture.runtime);
  }, 0);
  afterAll(async () => { await fixture?.stop(); }, 0);
  beforeEach(async () => {
    await currentFixture().postgres.sql('dbw_selected', "TRUNCATE dbw_f3; INSERT INTO dbw_f3 VALUES (1,'committed'),(2,'other');");
  }, 0);

  it('commits an admitted staged Apply', async () => {
    expect(await apply([update('1', 'committed', 'updated')])).toMatchObject({ ok: true,
      operation: 'edits.apply', status: 'committed', updated: '1' });
    expect(await currentFixture().postgres.sql('dbw_selected', 'SELECT note FROM dbw_f3 WHERE id=1')).toBe('updated');
  }, 0);
  it('rolls back every change on an engine failure', async () => {
    const fixture = currentFixture();
    expect(await apply([update('1', 'committed', 'must-rollback-on-engine-error'), { kind: 'insert', values: [
      { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '2' } } },
    ] }])).toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '23505' } });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f3 ORDER BY id')).toBe('committed\nother');
  }, 0);
  it('rolls back earlier changes when a row changed', async () => {
    const fixture = currentFixture();
    expect(await apply([update('1', 'committed', 'must-rollback'), update('2', 'stale', 'must-not-apply')]))
      .toMatchObject({ ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: 1, reason: 'row_changed' });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f3 ORDER BY id')).toBe('committed\nother');
  }, 0);
  it('reports a row that was removed before Apply', async () => {
    const fixture = currentFixture();
    await fixture.postgres.sql('dbw_selected', 'DELETE FROM dbw_f3 WHERE id=2');
    expect(await apply([update('2', 'other', 'gone')])).toMatchObject({ ok: false, status: 'conflict',
      code: 'database_edit_conflict', reason: 'row_missing' });
  }, 0);
  it('commits an insert and delete in one transaction', async () => {
    const fixture = currentFixture();
    await fixture.postgres.sql('dbw_selected', 'DELETE FROM dbw_f3 WHERE id=2');
    expect(await apply([{ kind: 'insert', values: [
      { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '3' } } },
      { column: 'note', value: { kind: 'value', cell: { type: 'text', value: '' } } },
    ] }, { kind: 'delete', key: [{ column: 'id', value: { type: 'integer', value: '1' } }] }]))
      .toMatchObject({ ok: true, status: 'committed', inserted: '1', deleted: '1' });
    expect(await fixture.postgres.sql('dbw_selected', "SELECT id || ':' || note FROM dbw_f3 ORDER BY id")).toBe('3:');
  }, 0);
  it('keeps explicit SQL NULL distinct from a column default', async () => {
    const fixture = currentFixture();
    expect(await apply([
      { kind: 'insert', values: [
        { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '3' } } },
        { column: 'note', value: { kind: 'value', cell: { type: 'null' } } },
      ] },
      { kind: 'insert', values: [
        { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '4' } } },
        { column: 'note', value: { kind: 'default' } },
      ] },
    ])).toMatchObject({ ok: true, operation: 'edits.apply', status: 'committed', inserted: '2' });
    expect(await fixture.postgres.sql('dbw_selected',
      "SELECT id::text || ':' || coalesce(note, '<null>') FROM dbw_f3 WHERE id >= 3 ORDER BY id"))
      .toBe('3:<null>\n4:insert-default');
  }, 0);
});
