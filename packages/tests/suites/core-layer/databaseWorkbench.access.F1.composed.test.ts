import { expect, it } from 'vitest';

import {
  DATABASE_ACCESS_READ_ACTION_ID_V1,
  DATABASE_ACCESS_SET_ACTION_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1,
} from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema, DatabaseRowsReadInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchAgent, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// TS.P3.F1-worktree-agent-none (D15): UI/CLI Action executor → server + PostgreSQL
// → enrolled daemon → native worktree PostgreSQL. G1 control
// P3-F1-known-good-agent-read: an agent read at the worktree's Read level
// succeeds before the owner sets None through `database.access.set`.
// Runs after PROGRAM U0 (worktree targets through the real executor).
it('TS.P3.F1: an agent reads a worktree database at Read and is refused at None', async () => {
  const testDir = run.testDir('dbw-access-f1');
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
  let agent: Awaited<ReturnType<typeof startDatabaseWorkbenchAgent>> | undefined;
  try {
    agent = await startDatabaseWorkbenchAgent(fixture, testDir);
    const target = fixture.targets.selected;
    expect(await fixture.executeDatabase(DATABASE_ACCESS_READ_ACTION_ID_V1, { target }))
      .toMatchObject({ ok: true, result: { setBy: 'machine', agentAccess: 'readWriteAsk' } });
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target, agentAccess: 'read' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
    const input = DatabaseRowsReadInputV1Schema.parse({
      operation: 'rows.read',
      target,
      relation: { schema: 'public', name: 'sentinel' },
      columns: ['id', 'target'],
      order: [],
      page: { rows: 1 },
    });

    const control = await agent.execute(DATABASE_ROWS_READ_ACTION_ID_V1, input);
    expect(control.ok, JSON.stringify(control)).toBe(true);
    if (!control.ok)
      throw new Error(`F1 G1 agent read refused (${control.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(control.result)).toMatchObject(
      { ok: true, operation: 'rows.read' },
    );
    console.info('P3-F1-known-good-agent-read passed', fixture.runtime);

    const set = await fixture.executeDatabase(
      DATABASE_ACCESS_SET_ACTION_ID_V1,
      { target, agentAccess: 'none' },
    );
    expect(set, JSON.stringify(set)).toMatchObject({ ok: true });

    expect(
      await agent.execute(DATABASE_ROWS_READ_ACTION_ID_V1, input),
    ).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
    // The person keeps reading; None binds agents only.
    const person = await fixture.executeDatabaseAsPerson(
      DATABASE_ROWS_READ_ACTION_ID_V1,
      input,
    );
    expect(person.ok, JSON.stringify(person)).toBe(true);
  } finally {
    try { await agent?.stop(); } finally { await fixture.stop(); }
  }
}, 0);
