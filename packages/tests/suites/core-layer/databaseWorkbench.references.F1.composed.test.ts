import { expect, it } from 'vitest';

import {
  DATABASE_ROWS_READ_ACTION_ID_V1,
  DATABASE_STRUCTURE_READ_ACTION_ID_V1,
  DatabaseOperationResultV1Schema,
} from '@happier-dev/database-protocol';
import { incomingForeignKeyNavigation } from '../../../plugins/database-workbench/src/ui/location';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

it('F1 opens an incoming relationship through the existing typed rows Action', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-references-f1') });
  try {
    await fixture.postgres.sql('dbw_selected', [
      'CREATE TABLE d41_parent (tenant text, id bigint, PRIMARY KEY (tenant, id))',
      'CREATE TABLE d41_child (id int PRIMARY KEY, tenant text, owner_id bigint, CONSTRAINT dbw_references_f1_fk FOREIGN KEY (tenant, owner_id) REFERENCES d41_parent)',
      "INSERT INTO d41_parent VALUES ('alpha', 9007199254740993), ('beta', 9007199254740993)",
      "INSERT INTO d41_child VALUES (1, 'alpha', 9007199254740993), (2, 'beta', 9007199254740993)",
    ].join('; '));
    const target = fixture.targets.selected;
    const relation = { schema: 'public', name: 'd41_parent' };
    const page = { rows: 20 };
    const read = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, {
      operation: 'rows.read', target, relation, columns: ['id', 'tenant'], order: [], page,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`F1 rows control refused (${read.errorCode})`);
    const control = DatabaseOperationResultV1Schema.parse(read.result);
    if (!control.ok || control.operation !== 'rows.read') throw new Error('F1 rows control did not settle');
    const selected = control.result.rows.find(row => row.cells.some(cell => cell.type === 'text' && cell.value === 'alpha'));
    expect(selected).toBeDefined();

    const describe = await fixture.executeDatabase(DATABASE_STRUCTURE_READ_ACTION_ID_V1, {
      operation: 'relation.structure', target, relation,
    });
    expect(describe.ok).toBe(true);
    if (!describe.ok) throw new Error(`F1 Structure refused (${describe.errorCode})`);
    const detail = DatabaseOperationResultV1Schema.parse(describe.result);
    if (!detail.ok || detail.operation !== 'relation.structure') throw new Error('F1 structure did not settle');
    expect(detail.structure.incomingForeignKeys).toEqual([{
      name: 'dbw_references_f1_fk',
      source: { schema: 'public', name: 'd41_child' },
      sourceColumns: ['tenant', 'owner_id'],
      targetColumns: ['tenant', 'id'],
    }]);
    const reference = detail.structure.incomingForeignKeys![0]!;
    const navigation = incomingForeignKeyNavigation({
      targetKey: 'selected', relation, mode: 'data', columns: ['id', 'tenant'], sort: [], page: { ...page, offset: 0 }, fkTrail: [],
    }, reference, control.result.columns.map(column => column.name), selected!.cells);
    if (navigation.status !== 'ready') throw new Error(`F1 incoming reference unavailable (${navigation.reason})`);
    const opened = await fixture.executeDatabase(DATABASE_ROWS_READ_ACTION_ID_V1, {
      operation: 'rows.read', target, relation: navigation.location.relation, columns: ['id'], order: [],
      filter: navigation.location.conditions, page,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(`F1 reference read refused (${opened.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(opened.result)).toMatchObject({
      ok: true, operation: 'rows.read', result: { rows: [{ cells: [{ type: 'integer', value: '1' }] }] },
    });
    console.info('D41 F1 reference jump passed', fixture.runtime);
  } finally {
    await fixture.stop();
  }
}, 0);
