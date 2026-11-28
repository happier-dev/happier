import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { ApprovalQueueListResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ActionApprovalRequestCreatedResultSchema, ActionOperationAcceptedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ActionOperationGetV1ResponseSchema, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { DATABASE_ACCESS_READ_ACTION_ID_V1, DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_CELL_READ_ACTION_ID_V1,
  DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_EDITS_APPLY_ACTION_ID_V1, DATABASE_RELATIONS_LIST_ACTION_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1, DATABASE_SCHEMAS_LIST_ACTION_ID_V1, DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
  DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_STRUCTURE_READ_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import {
    DatabaseEditsApplyInputV1Schema,
    DatabaseOperationResultV1Schema,
    DatabaseRowsReadInputV1Schema,
    DatabaseWriteStatementInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { DatabaseDescriptorV1Schema as DatabaseTargetsConnectResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchAgent, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

async function settleDatabaseAction(
  fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>>,
  result: ActionExecuteResult,
): Promise<ActionExecuteResult> {
  if (!result.ok) return result;
  const accepted = ActionOperationAcceptedResultSchema.safeParse(result.result);
  if (!accepted.success) return result;
  const { machineId, operationId } = accepted.data;
  const observed = await fixture.owner.execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
    ...fixture.machine.target, machineId, operationId, waitForTerminal: true,
  });
  if (!observed.ok) throw new Error(`F10 operation observation refused (${observed.errorCode})`);
  const receipt = ActionOperationGetV1ResponseSchema.parse(observed.result);
  if (receipt.kind !== 'found') throw new Error(`F10 operation ${operationId} could not be found`);
  const terminal = readActionOperationTerminalResultV1(receipt.operation);
  if (!terminal) throw new Error(`F10 operation ${operationId} did not settle (${receipt.operation.state})`);
  return terminal;
}

async function prepare() {
  const testDir = run.testDir('dbw-agent-f10');
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
  let agent: Awaited<ReturnType<typeof startDatabaseWorkbenchAgent>> | undefined;
  try {
    agent = await startDatabaseWorkbenchAgent(fixture, testDir);
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
    const access = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1,
      { target: descriptor.target, agentAccess: 'read' });
    expect(access).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
    const agentControl = await agent.execute(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(agentControl.ok, JSON.stringify(agentControl)).toBe(true);
    if (!agentControl.ok) throw new Error(`F10 agent read control refused (${agentControl.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(agentControl.result)).toMatchObject({ ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] } });
    console.info('F10-known-good-agent-read-and-Agent-turn passed', fixture.runtime);
    return { fixture, input, agent, target: descriptor.target };
  } catch (error) {
    try { await agent?.stop(); } finally { await fixture.stop(); }
    throw error;
  }
}

async function listSessionApprovals(
  fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>>,
  sessionId: string,
) {
  const listed = await fixture.owner.execute('approval.request.list', {});
  if (!listed.ok) throw new Error(`F10 approval list refused (${listed.errorCode})`);
  return ApprovalQueueListResultV1Schema.parse(listed.result).items.filter(item => item.sessionId === sessionId);
}

describe.sequential('F10 real agent database access', () => {
  let prepared: Awaited<ReturnType<typeof prepare>>;
  beforeAll(async () => { prepared = await prepare(); }, 0);
  afterAll(async () => {
    try { await prepared?.agent.stop(); } finally { await prepared?.fixture.stop(); }
  }, 0);

  it('Read performs native EXPLAIN ANALYZE', async () => {
    const { fixture, target, agent } = prepared;
    const result = await settleDatabaseAction(fixture, await agent.execute(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, {
      operation: 'statement.explain', target, mode: 'analyze', accessMode: 'read',
      statement: { sql: 'SELECT target FROM public.sentinel WHERE id = 1', parameters: [] },
    }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
      expect(deferred.success, 'Read-only EXPLAIN ANALYZE must settle without opening an approval').toBe(false);
      expect(DatabaseOperationResultV1Schema.parse(result.result))
        .toMatchObject({ ok: true, operation: 'statement.explain' });
    }
  }, 0);

  it('Read refuses a write and leaves native data unchanged', async () => {
    const { fixture, target, agent } = prepared;
    // Isolate the database's Read rule from the Account-wide Ask on SQL writes.
    const allowed = await fixture.owner.executeAsPerson('actions.policy.set', {
      actionId: DATABASE_STATEMENT_RUN_ACTION_ID_V1, audience: 'agent', mode: 'allowed',
    });
    if (!allowed.ok) throw new Error(`F10 SQL Agent Allow policy setup refused (${allowed.errorCode})`);
    const denied = await settleDatabaseAction(fixture, await agent.execute(DATABASE_STATEMENT_RUN_ACTION_ID_V1, {
      operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
      statements: [{ sql: "UPDATE public.sentinel SET target = 'forbidden-agent-write' WHERE id = 1", parameters: [] }],
    }));
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1')).toBe('dbw_selected');
    expect(denied).toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
  }, 0);

  it('None refuses the agent while the person remains usable', async () => {
    const { fixture, target, input, agent } = prepared;
    const personBefore = await fixture.executeDatabaseAsPerson(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    if (!personBefore.ok) throw new Error(`F10 person control refused (${personBefore.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(personBefore.result)).toMatchObject({ ok: true, operation: 'rows.read',
      result: { rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'dbw_selected' }] }] } });
    const { relation } = input;
    const reads = [
      { action: DATABASE_ACCESS_READ_ACTION_ID_V1, operand: { target }, result: { setBy: 'machine', agentAccess: 'read',
        access: { canRead: true, canWrite: false } } },
      { action: DATABASE_DESCRIBE_ACTION_ID_V1, operand: { operation: 'describe', target },
        result: { ok: true, operation: 'describe', descriptor: { target, engine: 'postgresql' } } },
      { action: DATABASE_SCHEMAS_LIST_ACTION_ID_V1, operand: { operation: 'schemas.list', target,
        search: 'public', page: { rows: 10 } },
        result: { ok: true, operation: 'schemas.list', schemas: [{ name: 'public' }] } },
      { action: DATABASE_RELATIONS_LIST_ACTION_ID_V1, operand: { operation: 'relations.list', target, schema: 'public',
        search: 'sentinel', page: { rows: 10 } }, result: { ok: true, operation: 'relations.list', relations: [{ relation }] } },
      { action: DATABASE_STRUCTURE_READ_ACTION_ID_V1, operand: { operation: 'relation.structure', target, relation },
        result: { ok: true, operation: 'relation.structure', structure: { relation } } },
      { action: DATABASE_CELL_READ_ACTION_ID_V1, operand: { operation: 'cell.read', target, relation, column: 'target',
        key: [{ column: 'id', value: { type: 'integer', value: '1' } }], range: { unit: 'utf8_bytes', offset: 0, length: 12 } },
        result: { ok: true, operation: 'cell.read', value: { type: 'text', value: 'dbw_selected' } } },
      { action: DATABASE_STATEMENT_RUN_ACTION_ID_V1, operand: { operation: 'statement.run', target, mode: 'read',
        statement: { sql: 'SELECT target FROM public.sentinel WHERE id = 1', parameters: [] } },
        result: { ok: true, operation: 'statement.run', results: [{ rows: [{ cells: [{ type: 'text', value: 'dbw_selected' }] }] }] } },
      { action: DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, operand: { operation: 'statement.explain', target,
        mode: 'analyze', accessMode: 'read', statement: { sql: 'SELECT target FROM public.sentinel WHERE id = 1', parameters: [] } },
        result: { ok: true, operation: 'statement.explain' } },
    ] as const;
    for (const { action, operand, result } of reads) {
      const observed = await settleDatabaseAction(fixture, await agent.execute(action, operand));
      expect(observed, action).toMatchObject({ ok: true, result });
    }

    const changed = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'none' });
    expect(changed).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
    const denied = await agent.execute(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(denied).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
    for (const { action, operand } of reads) {
      const observed = await settleDatabaseAction(fixture, await agent.execute(action, operand));
      expect(observed, action).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
    }
    const recovered = await fixture.executeDatabaseAsPerson(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    if (recovered.ok) expect(DatabaseOperationResultV1Schema.parse(recovered.result)).toMatchObject({ ok: true, operation: 'rows.read' });
  }, 0);

  it('the worktree asks-first level requires one person approval over an agent Allow before native Apply', async () => {
    const { fixture, agent } = prepared;
    const target = fixture.targets.selected;
    expect(await fixture.executeDatabase(DATABASE_ACCESS_READ_ACTION_ID_V1, { target }))
      .toMatchObject({ ok: true, result: { setBy: 'machine', agentAccess: 'readWriteAsk' } });
    const relation = { schema: 'public', name: 'dbw_f10_approval' };
    await fixture.postgres.sql('dbw_selected',
      "CREATE TABLE dbw_f10_approval (id integer PRIMARY KEY, note text NOT NULL); INSERT INTO dbw_f10_approval VALUES (1, 'before');");
    const input = DatabaseEditsApplyInputV1Schema.parse({ operation: 'edits.apply', target, relation,
      changes: [{ kind: 'update', key: [{ column: 'id', value: { type: 'integer', value: '1' } }],
        original: [{ column: 'note', value: { type: 'text', value: 'before' } }],
        values: [{ column: 'note', value: { kind: 'value', cell: { type: 'text', value: 'approved' } } }] }],
    });
    const allowed = await fixture.owner.executeAsPerson('actions.policy.set', {
      actionId: DATABASE_EDITS_APPLY_ACTION_ID_V1, audience: 'agent', mode: 'allowed',
    });
    if (!allowed.ok) throw new Error(`F10 Agent Allow policy setup refused (${allowed.errorCode})`);
    const approvals = () => listSessionApprovals(fixture, agent.sessionId);
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteNoApproval' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteNoApproval' } });
    const control = await settleDatabaseAction(fixture, await agent.execute(DATABASE_EDITS_APPLY_ACTION_ID_V1, input));
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok) throw new Error(`F10 no-approval native Apply control refused (${control.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(control.result))
      .toMatchObject({ ok: true, operation: 'edits.apply', status: 'committed', updated: '1' });
    expect(await approvals()).toHaveLength(0);
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f10_approval WHERE id = 1')).toBe('approved');
    console.info('F10-known-good-worktree-agent-Apply-without-Ask passed', fixture.runtime);

    await fixture.postgres.sql('dbw_selected', "UPDATE dbw_f10_approval SET note = 'before' WHERE id = 1");
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteAsk' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteAsk' } });
    // Ruling B (2026-11-20): the Agent gets the operation receipt at once; the live-only
    // Ask waits inside that operation until the person decides in the Inbox.
    const askReceipt = await agent.execute(DATABASE_EDITS_APPLY_ACTION_ID_V1, input);
    if (!askReceipt.ok) throw new Error(`F10 asks-first Apply refused (${askReceipt.errorCode})`);
    const held = ActionOperationAcceptedResultSchema.parse(askReceipt.result);
    let artifactId = '';
    await waitFor(async () => {
      const open = (await approvals()).find(item => item.status === 'open');
      artifactId = open?.artifactId ?? '';
      return artifactId.length > 0;
    }, { context: 'F10 asks-first Ask in the Inbox' });
    const waiting = await fixture.owner.execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
      ...fixture.machine.target, machineId: held.machineId, operationId: held.operationId,
    });
    if (!waiting.ok) throw new Error(`F10 held operation read refused (${waiting.errorCode})`);
    expect(ActionOperationGetV1ResponseSchema.parse(waiting.result)).toMatchObject({ kind: 'found', operation: {
      progress: { phase: 'waiting_for_approval' } } });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f10_approval WHERE id = 1')).toBe('before');
    expect(await approvals()).toMatchObject([{ artifactId, status: 'open' }]);
    const decided = await fixture.owner.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' });
    expect(decided).toMatchObject({ ok: true });
    const applied = await settleDatabaseAction(fixture, askReceipt);
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    if (applied.ok) expect(DatabaseOperationResultV1Schema.parse(applied.result))
      .toMatchObject({ ok: true, operation: 'edits.apply', status: 'committed', updated: '1' });
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f10_approval WHERE id = 1')).toBe('approved');
    expect((await approvals()).filter(item => item.artifactId === artifactId)).toHaveLength(1);

    await fixture.postgres.sql('dbw_selected', "UPDATE dbw_f10_approval SET note = 'before' WHERE id = 1");
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'none' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
    expect(await settleDatabaseAction(fixture, await agent.execute(DATABASE_EDITS_APPLY_ACTION_ID_V1, input)))
      .toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
    expect((await approvals()).filter(item => item.status === 'open')).toHaveLength(0);
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f10_approval WHERE id = 1')).toBe('before');
  }, 0);

  it('asks once for three ordered statements and rolls back an allowed batch when its second statement fails', async () => {
    const { fixture, agent } = prepared;
    const target = fixture.targets.selected;
    await fixture.postgres.sql('dbw_selected', 'CREATE TABLE dbw_f10_ordered (id integer PRIMARY KEY, note text)');
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteAsk' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteAsk' } });
    expect(await fixture.owner.executeAsPerson('actions.policy.set', {
      actionId: DATABASE_STATEMENT_RUN_ACTION_ID_V1, audience: 'agent', mode: 'allowed',
    })).toMatchObject({ ok: true });
    const read = () => fixture.postgres.sql('dbw_selected', 'SELECT note FROM dbw_f10_ordered WHERE id = 1');
    const existing = new Set((await listSessionApprovals(fixture, agent.sessionId)).map(item => item.artifactId));
    const newApprovals = async () => (await listSessionApprovals(fixture, agent.sessionId))
      .filter(item => !existing.has(item.artifactId));
    const executeBatch = (statements: string[]) => agent.execute(
      DATABASE_STATEMENT_RUN_ACTION_ID_V1,
      DatabaseWriteStatementInputV1Schema.parse({
        operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
        statements: statements.map(sql => ({ sql, parameters: [] })),
      }),
    );

    const pending = await executeBatch([
      "INSERT INTO dbw_f10_ordered VALUES (1, 'first')",
      "UPDATE dbw_f10_ordered SET note = 'second' WHERE id = 1",
      'SELECT note FROM dbw_f10_ordered WHERE id = 1',
    ]);
    if (!pending.ok) throw new Error(`F10 ordered write refused (${pending.errorCode})`);
    ActionOperationAcceptedResultSchema.parse(pending.result);
    await waitFor(async () => (await newApprovals()).some(item => item.status === 'open'), {
      context: 'F10 ordered write Ask in the Inbox',
    });
    const opened = await newApprovals();
    expect(opened).toMatchObject([{ status: 'open' }]);
    expect(await read()).toBe('');
    const { artifactId } = opened[0]!;
    expect(await fixture.owner.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    const applied = await settleDatabaseAction(fixture, pending);
    if (!applied.ok) throw new Error(`F10 ordered write could not settle (${applied.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(applied.result)).toMatchObject({ ok: true, operation: 'statement.run', results: [
      { affectedRows: '1' },
      { affectedRows: '1' },
      { rows: [{ cells: [{ type: 'text', value: 'second' }] }] },
    ] });
    expect(await read()).toBe('second');
    expect(await newApprovals()).toMatchObject([{ artifactId }]);

    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'readWriteNoApproval' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteNoApproval' } });
    const rolledBack = await settleDatabaseAction(fixture, await executeBatch([
      "UPDATE dbw_f10_ordered SET note = 'must-rollback' WHERE id = 1",
      "INSERT INTO dbw_f10_ordered VALUES (1, 'duplicate')",
      "UPDATE dbw_f10_ordered SET note = 'must-not-run' WHERE id = 1",
    ]));
    if (!rolledBack.ok) throw new Error(`F10 rollback result could not settle (${rolledBack.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(rolledBack.result))
      .toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '23505', statementIndex: 1 } });
    expect(await read()).toBe('second');
    expect(await newApprovals()).toMatchObject([{ artifactId }]);
  }, 0);
});
