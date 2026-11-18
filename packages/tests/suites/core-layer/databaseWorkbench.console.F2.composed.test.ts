import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionOperationCancelV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
  DatabaseOperationResultV1Schema, DatabaseReadStatementInputV1Schema,
  DatabaseStatementExplainInputV1Schema, DatabaseWriteStatementInputV1Schema,
  type DatabaseReadStatementInputV1 } from '@happier-dev/database-protocol';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe.sequential('F2 composed Console cases', () => {
  let fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>> | undefined;
  let target: DatabaseReadStatementInputV1['target'];
  function currentFixture() {
    if (!fixture) throw new Error('F2 fixture has not reached G1');
    return fixture;
  }
  async function read(sql: string, demand?: DatabaseReadStatementInputV1['demand'],
    parameters: DatabaseReadStatementInputV1['statement']['parameters'] = []) {
      const fixture = currentFixture();
      const arrival = await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1,
        DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', target, mode: 'read',
          statement: { sql, parameters }, ...(demand ? { demand } : {}) }));
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`F2 Action refused (${arrival.errorCode})`);
      return DatabaseOperationResultV1Schema.parse(arrival.result);
  }
  beforeAll(async () => {
    fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-console-f2') });
    ({ target } = await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F2 Console PostgreSQL'));
    // Connect stores Read for agents. This fixture executor is automation, so the
    // person raises the target to Read & write (asks first) before write cases.
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteAsk' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteAsk' } });
    // G1: same executor, Home/Postgres and daemon as the failure below.
    expect(await read("SELECT current_database(), 9007199254740993::bigint, NULL::text, ''::text"))
      .toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [{ cells: [
        { type: 'text', value: 'dbw_selected' }, { type: 'integer', value: '9007199254740993' },
        { type: 'null' }, { type: 'text', value: '' },
      ] }] }] });
    console.info('P1-F2-known-good-console passed', fixture.runtime);
  }, 0);
  afterAll(async () => { await fixture?.stop(); }, 0);

  it('preserves exact selected SQL cells through the real executor', async () => {
    expect(await read("SELECT 9007199254740993::bigint, NULL::text, ''::text"))
      .toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [{ cells: [
        { type: 'integer', value: '9007199254740993' }, { type: 'null' }, { type: 'text', value: '' },
      ] }] }] });
  }, 0);
  it('binds typed parameters without interpreting SQL-looking text and redacts confidential echoes', async () => {
    const sqlText = "'); SELECT 42; --";
    // SEC-CLOSE-165 preserves confidential parameter redaction. Derived booleans
    // prove native binding without asking the executor to disclose those values.
    const sql = 'SELECT $1::text, $2::bigint, $3::text, $4::text, length($1::text)::integer, $2::bigint > 9007199254740992, $3::text IS NULL, $4::text = \'\'';
    const { projectConsoleParameterSlots } = await import('../../../plugins/database-workbench/src/ui/consoleSelection');
    const [slots] = projectConsoleParameterSlots(sql, { start: 0, end: 0 }, 'read', 'postgresql');
    expect(slots?.map(slot => [slot.placeholder, slot.defaultInput.type])).toEqual([
      ['$1', 'text'], ['$2', 'text'], ['$3', 'text'], ['$4', 'text'],
    ]);
    const chosen: DatabaseReadStatementInputV1['statement']['parameters'] = [
      { type: 'text', value: sqlText }, { type: 'integer', value: '9007199254740993' },
      { type: 'null' }, { type: 'text', value: '' },
    ];
    expect(await read(sql, undefined, slots!.map(slot => chosen[slot.index - 1]!))).toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [{ cells: [
      { type: 'text', value: '[REDACTED]' }, { type: 'text', value: '[REDACTED]' },
      { type: 'null' }, { type: 'text', value: '' },
      { type: 'integer', value: String(sqlText.length) },
      { type: 'boolean', value: true }, { type: 'boolean', value: true }, { type: 'boolean', value: true },
    ] }] }] });
  }, 0);
  it('pages duplicate labels without losing column positions', async () => {
    const pagedSql = 'SELECT ordinal AS duplicate, ordinal::text AS duplicate FROM generate_series(1, 2) AS ordinal ORDER BY ordinal';
    const firstPage = await read(pagedSql, { rows: 1 });
    expect(firstPage).toMatchObject({ ok: true, operation: 'statement.run', results: [{
      columns: [{ name: 'duplicate' }, { name: 'duplicate' }],
      rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: '1' }] }],
      completeness: { complete: false, reason: 'page', continuation: { kind: 'rerun' } },
    }] });
    if (!firstPage.ok || firstPage.operation !== 'statement.run') throw new Error('F2 console page unavailable');
    const completeness = firstPage.results[0]?.completeness;
    if (!completeness || completeness.complete || completeness.continuation?.kind !== 'rerun') {
      throw new Error('F2 console omitted its next-page demand');
    }
    expect(await read(pagedSql, completeness.continuation.demand)).toMatchObject({ ok: true,
      operation: 'statement.run', results: [{ rows: [{ cells: [
        { type: 'integer', value: '2' }, { type: 'text', value: '2' },
      ] }], completeness: { complete: true } }] });
  }, 0);
  it('explains, returns native error position, and recovers', async () => {
    const fixture = currentFixture();
    const explain = await fixture.executeDatabase(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
      DatabaseStatementExplainInputV1Schema.parse({ operation: 'statement.explain', target,
        statement: { sql: 'SELECT 1', parameters: [] }, mode: 'plan', accessMode: 'read' }));
    expect(explain.ok, JSON.stringify(explain)).toBe(true);
    if (!explain.ok) throw new Error(`F2 Explain refused (${explain.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(explain.result)).toMatchObject({ ok: true, operation: 'statement.explain' });
    expect(await read('SELECT FROM WHERE')).toMatchObject({ ok: false, status: 'failed',
      cause: { source: 'engine', code: '42601', position: expect.any(Number) } });
    expect(await read('SELECT 1 AS recovered')).toMatchObject({ ok: true, operation: 'statement.run' });
  }, 0);
  it('commits ordered writes and rolls back a later engine failure', async () => {
    const fixture = currentFixture();
    await fixture.postgres.sql('dbw_selected', 'CREATE TABLE dbw_console_write (id integer PRIMARY KEY, note text)');
    async function write(statements: string[]) {
      const arrival = await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1,
        DatabaseWriteStatementInputV1Schema.parse({ operation: 'statement.run', target, mode: 'write',
          executionMode: 'transaction', statements: statements.map(sql => ({ sql, parameters: [] })) }));
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`F2 console write refused (${arrival.errorCode})`);
      return DatabaseOperationResultV1Schema.parse(arrival.result);
    }
    expect(await write(["INSERT INTO dbw_console_write VALUES (1, 'first')",
      "UPDATE dbw_console_write SET note = 'second' WHERE id=1"]))
      .toMatchObject({ ok: true, operation: 'statement.run', results: [{ affectedRows: '1' }, { affectedRows: '1' }] });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_console_write WHERE id=1')).toBe('second');
    console.info('P1-F2-known-good-console-write passed', fixture.runtime);
    expect(await write(["UPDATE dbw_console_write SET note = 'must-rollback' WHERE id=1",
      "INSERT INTO dbw_console_write VALUES (1, 'duplicate')"]))
      .toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '23505', statementIndex: 1 } });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_console_write WHERE id=1')).toBe('second');
  }, 0);
  it('cancels the exact admitted operation, removes its native query, and recovers', async () => {
    const fixture = currentFixture();
    const waiter = new AbortController();
    const actionRequestId = randomUUID();
    const active = fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1,
      DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', target, mode: 'read',
        // Longer than the canonical observation wait: natural completion must
        // not stand in for native cancellation.
        statement: { sql: 'SELECT pg_sleep(600) /* DBW_F2_CANCEL */', parameters: [] } }),
      { signal: waiter.signal, actionRequestId });
    try {
      await waitFor(async () => Number(await fixture.postgres.sql('dbw_selected',
        "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state='active' AND query LIKE '%DBW_F2_CANCEL%'")) > 0,
      { context: 'F2 native query active before Cancel' });
      const listed = await fixture.owner.execute('action.operations.list', fixture.machine.target);
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) throw new Error(`F2 operation list refused (${listed.errorCode})`);
      const operations = ActionOperationListV1ResponseSchema.parse(listed.result).items
        .filter(operation => operation.requestId === actionRequestId);
      expect(operations).toHaveLength(1);
      const operation = operations[0];
      if (!operation) throw new Error('F2 active query omitted its exact operation receipt');
      expect(operation.cancellation).toBe('supported');
      const cancelled = await fixture.owner.execute('action.operations.cancel', {
        ...fixture.machine.target, operationId: operation.operationId,
      });
      expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
      if (!cancelled.ok) throw new Error(`F2 operation Cancel refused (${cancelled.errorCode})`);
      expect(ActionOperationCancelV1ResponseSchema.parse(cancelled.result)).toEqual({ kind: 'requested' });
      await waitFor(async () => Number(await fixture.postgres.sql('dbw_selected',
        "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state='active' AND query LIKE '%DBW_F2_CANCEL%'")) === 0,
      { context: 'F2 explicit operation Cancel removes the native active query' });
      await active;
    } finally { waiter.abort(); await active.catch(() => undefined); }
    expect(await read('SELECT 1 AS after_cancel')).toMatchObject({ ok: true, operation: 'statement.run' });
  }, 0);
});
