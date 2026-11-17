import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_ROWS_READ_ACTION_ID_V1, DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
  DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseRowsReadInputV1Schema } from '../../../database-protocol/src/databaseOperations';
import { DatabaseTargetsConnectResultV1Schema } from '../../../database-protocol/src/databaseTargetActions';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

async function prepare() {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-agent-f10') });
  try {
    const session = await fixture.assertKnownGoodSessionControl(fixture.owner, fixture.machine);
    const saved = await fixture.owner.execute('secrets.create', {
      name: 'F10 native target', kind: 'other', value: fixture.postgres.selectedDatabaseUrl,
    }, { presentUserConfirmation: { actionId: 'secrets.create' } });
    if (!saved.ok) throw new Error(`F10 secret creation refused (${saved.errorCode})`);
    const secret = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(saved.result);
    const { source: _source, ...scope } = fixture.targets.selected;
    const connected = await fixture.executeDatabase(DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
      { scope, savedSecretRef: secret.secretRef, label: 'F10 selected native database' });
    if (!connected.ok) throw new Error(`F10 Connect refused (${connected.errorCode})`);
    const descriptor = DatabaseTargetsConnectResultV1Schema.parse(connected.result);
    const input = DatabaseRowsReadInputV1Schema.parse({ operation: 'rows.read', target: descriptor.target,
      relation: { schema: 'public', name: 'sentinel' }, columns: ['id', 'target'], order: [], page: { rows: 1 } });
    const control = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok) throw new Error(`F10 person control refused (${control.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(control.result)).toMatchObject({ ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] } });
    const agentContext = { surface: 'agent', authority: 'account_automation', defaultSessionId: session.sessionId } as const;
    const access = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1,
      { target: descriptor.target, agentAccess: 'read' });
    expect(access).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
    const agentControl = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input, agentContext);
    expect(agentControl.ok, JSON.stringify(agentControl)).toBe(true);
    if (!agentControl.ok) throw new Error(`F10 agent read control refused (${agentControl.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(agentControl.result)).toMatchObject({ ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] } });
    console.info('F10-known-good-person-and-agent-read-and-Agent-turn passed', fixture.runtime);
    return { fixture, input, agentContext, target: descriptor.target };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

describe.sequential('F10 real agent database access', () => {
  let prepared: Awaited<ReturnType<typeof prepare>>;
  beforeAll(async () => { prepared = await prepare(); }, 0);
  afterAll(async () => { await prepared?.fixture.stop(); }, 0);

  it('Read performs native EXPLAIN ANALYZE', async () => {
    const { fixture, target, agentContext } = prepared;
    const result = await fixture.executeDatabase(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, {
      operation: 'statement.explain', target, mode: 'analyze', accessMode: 'read',
      statement: { sql: 'SELECT target FROM public.sentinel WHERE id = 1', parameters: [] },
    }, agentContext);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(DatabaseOperationResultV1Schema.parse(result.result))
      .toMatchObject({ ok: true, operation: 'statement.explain' });
  }, 0);

  it('Read refuses a write and leaves native data unchanged', async () => {
    const { fixture, target, agentContext } = prepared;
    const denied = await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, {
      operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
      statements: [{ sql: "UPDATE public.sentinel SET target = 'forbidden-agent-write' WHERE id = 1", parameters: [] }],
    }, agentContext);
    expect(denied).toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1')).toBe('dbw_selected');
  }, 0);

  it('None refuses the agent while the person remains usable', async () => {
    const { fixture, target, input, agentContext } = prepared;
    const changed = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'none' });
    expect(changed).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
    const denied = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input, agentContext);
    expect(denied).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
    const recovered = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    if (recovered.ok) expect(DatabaseOperationResultV1Schema.parse(recovered.result)).toMatchObject({ ok: true, operation: 'rows.read' });
  }, 0);
});
