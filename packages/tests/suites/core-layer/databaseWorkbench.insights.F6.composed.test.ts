import { expect, it } from 'vitest';

import { DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import {
    DatabaseOperationResultV1Schema,
    DatabaseStatementExplainInputV1Schema,
    DatabaseStatsOperationInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { DatabaseStatsReasonV1Schema, type DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import { type DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

// D15: one real CLI → Postgres Home → daemon → selected native target journey.
// No refusal/unavailable assertion is reached until this flow's G1 passes.
it('P4-F6-known-good-stats', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-insights-f6') });
  try {
    const targets = {
      selected: (await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'F6 selected')).target,
      neighbor: (await fixture.connectDatabase(fixture.postgres.neighborDatabaseUrl, 'F6 neighbor')).target,
      noExtension: (await fixture.connectDatabase(fixture.postgres.noExtensionDatabaseUrl, 'F6 no extension')).target,
    };
    const privateLiteral = 'F6_PRIVATE_LITERAL_MUST_NOT_LEAVE_ENGINE';
    await fixture.postgres.sql('dbw_selected', `CREATE TABLE dbw_f6_selected (id integer PRIMARY KEY, private_value text);
      INSERT INTO dbw_f6_selected VALUES (1, '${privateLiteral}');
      SELECT sum(id) FROM dbw_f6_selected WHERE private_value = '${privateLiteral}';`);
    await fixture.postgres.sql('dbw_neighbor', `CREATE TABLE dbw_f6_neighbor (id integer PRIMARY KEY);
      INSERT INTO dbw_f6_neighbor VALUES (99); SELECT sum(id) FROM dbw_f6_neighbor;`);
    // This proves fixture readiness, not the G1 Action control below.
    expect(await fixture.postgres.sql('dbw_selected', 'SHOW shared_preload_libraries')).toContain('pg_stat_statements');
    expect(Number(await fixture.postgres.sql('dbw_selected', `SELECT count(*) FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`))).toBeGreaterThan(0);

    const request = { kind: 'stats.read', group: 'statements',
      selection: { page: { rows: 80 }, order: 'totalTime' } } as const satisfies DatabaseStatsReadV1;
    async function read(target: DatabaseTargetV1, statsRequest: DatabaseStatsReadV1 = request) {
      const arrival = await fixture.executeDatabase(DATABASE_STATS_READ_ACTION_ID_V1,
        DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target, request: statsRequest }));
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`Stats Action refused (${arrival.errorCode})`);
      const result = DatabaseOperationResultV1Schema.parse(arrival.result);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(`Stats operation failed (${result.code})`);
      if (result.operation !== 'stats.read') throw new Error(`Unexpected stats result (${result.operation})`);
      return result.observation;
    }

    const first = await read(targets.selected);
    expect(first).toMatchObject({ status: 'available', group: 'statements', scope: { database: 'dbw_selected' } });
    if (first.status !== 'available' || first.group !== 'statements') throw new Error('G1 did not produce statement statistics');
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.every(row => row.database === 'dbw_selected')).toBe(true);
    expect(JSON.stringify(first)).not.toContain('dbw_f6_neighbor');
    expect(JSON.stringify(first)).not.toContain(privateLiteral);
    const workload = first.data.find(row => row.shape?.includes('dbw_f6_selected') && /sum/iu.test(row.shape));
    expect(workload, 'Real workload must be present, rather than only catalog/fixture queries').toBeDefined();
    if (!workload) throw new Error('Selected workload statistics are missing');

    const explained = await fixture.executeDatabase(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
      DatabaseStatementExplainInputV1Schema.parse({ operation: 'statement.explain', target: targets.selected,
        statement: { sql: 'SELECT sum(id) FROM dbw_f6_selected', parameters: [] }, mode: 'plan', accessMode: 'read' }));
    expect(explained.ok, JSON.stringify(explained)).toBe(true);
    if (!explained.ok) throw new Error(`G1 Explain refused (${explained.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(explained.result)).toMatchObject({ ok: true, operation: 'statement.explain' });
    console.info('P4-F6-known-good-stats passed', fixture.runtime);

    // Opening a statement detail must select the native identity, even when
    // its list row came from a different page. A page-only reread loses it.
    const selectedStatement = await read(targets.selected, {
      ...request, selection: { ...request.selection, statementKey: workload.key },
    });
    expect(selectedStatement).toMatchObject({ status: 'available', group: 'statements' });
    if (selectedStatement.status !== 'available' || selectedStatement.group !== 'statements') {
      throw new Error('Selected statement detail statistics unavailable');
    }
    expect(selectedStatement.data.map(row => row.key)).toEqual([workload.key]);
    expect(JSON.stringify(selectedStatement)).not.toContain(privateLiteral);

    // Distinct selected scope must survive the same real transport and engine.
    const neighbor = await read(targets.neighbor);
    expect(neighbor).toMatchObject({ status: 'available', group: 'statements', scope: { database: 'dbw_neighbor' } });
    if (neighbor.status !== 'available' || neighbor.group !== 'statements') throw new Error('Neighbor statement statistics unavailable');
    expect(neighbor.data.every(row => row.database === 'dbw_neighbor')).toBe(true);
    expect(JSON.stringify(neighbor)).not.toContain('dbw_f6_selected');

    for (const statsRequest of [
      { kind: 'stats.read', group: 'tables', selection: { schema: 'public', page: { rows: 80 } } },
      { kind: 'stats.read', group: 'indexes', selection: { relation: { schema: 'public', name: 'dbw_f6_selected' } } },
      { kind: 'stats.read', group: 'size', selection: {} },
    ] satisfies DatabaseStatsReadV1[]) {
      expect(await read(targets.selected, statsRequest)).toMatchObject({ status: 'available',
        group: statsRequest.group, scope: { database: 'dbw_selected' } });
    }

    const postgresVersion = await fixture.postgres.sql('dbw_selected', 'SHOW server_version');
    const pgStatStatementsVersion = await fixture.postgres.sql('dbw_selected',
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'");
    const backendCount = Number(await fixture.postgres.sql('dbw_selected',
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"));
    const activeBackends = Number(await fixture.postgres.sql('dbw_selected',
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'"));
    // This fixture is the sole requester of the selected database here. Home
    // persistence is a distinct database. Exclude our observer SQL, then prove
    // two observer reads leave its aggregate unchanged before attributing the
    // next delta to the one Activity Action.
    async function queryCounters() {
      const raw = await fixture.postgres.sql('dbw_selected', `/* DBW_F6_ACTIVITY_MEASUREMENT */
        SELECT coalesce(sum(calls), 0)::text, coalesce(sum(total_exec_time), 0)::text
        FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND query NOT LIKE '%DBW_F6_ACTIVITY_MEASUREMENT%'`);
      const [calls, milliseconds] = raw.split('|');
      if (!calls || !/^\d+$/u.test(calls) || !milliseconds || !Number.isFinite(Number(milliseconds))) {
        throw new Error('Native pg_stat_statements measurement did not return numeric counters');
      }
      return { calls: BigInt(calls), milliseconds: Number(milliseconds) };
    }
    let measurement: Awaited<ReturnType<typeof queryCounters>> | undefined;
    let measurementReason = 'Native pg_stat_statements measurement unavailable';
    try {
      const first = await queryCounters();
      const second = await queryCounters();
      if (first.calls === second.calls && first.milliseconds === second.milliseconds) measurement = second;
      else measurementReason = 'Observer exclusion or isolated counter stability was not established';
    } catch {
      // A measurement prerequisite is reported separately from the real
      // Activity outcome; it must never become an invented SQL count.
    }
    const activityStarted = performance.now();
    const activity = await read(targets.selected,
      { kind: 'stats.read', group: 'activity', selection: { page: { rows: 5000 } } });
    const activityElapsedMs = performance.now() - activityStarted;
    expect(activity).toMatchObject({ status: 'available', group: 'activity', scope: { database: 'dbw_selected' } });
    if (activity.status !== 'available' || activity.group !== 'activity') throw new Error('Activity unavailable');
    let sqlCount: string | null = null;
    let engineDurationMs: number | null = null;
    if (measurement) {
      try {
        const after = await queryCounters();
        if (after.calls >= measurement.calls && after.milliseconds >= measurement.milliseconds) {
          sqlCount = (after.calls - measurement.calls).toString();
          engineDurationMs = after.milliseconds - measurement.milliseconds;
          measurementReason = 'Observed selected-DB pg_stat_statements delta; observer excluded and pre-snapshots stable';
        } else measurementReason = 'Native counters changed basis during the Activity read';
      } catch { measurementReason = 'Native after snapshot unavailable'; }
    }
    console.info('P4-F6-activity-measurement', { postgresVersion, pgStatStatementsVersion, backendCount, activeBackends,
      elapsedMs: activityElapsedMs, returnedRows: activity.data.length,
      serializedBytes: Buffer.byteLength(JSON.stringify(activity)),
      sqlCount, engineDurationMs, instrumentation: measurementReason });

    // Keep the positive target enabled while testing a separate missing-extension DB.
    expect(await read(targets.noExtension)).toMatchObject({ status: 'unavailable', group: 'statements',
      reason: DatabaseStatsReasonV1Schema.parse('extension_missing') });
    expect(await fixture.postgres.sql('dbw_no_extension', "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'"))
      .toBe('0');
    expect(await read(targets.selected)).toMatchObject({ status: 'available', group: 'statements' });
    // Operator setup on the fixture, then the same public read is the Retry.
    await fixture.postgres.sql('dbw_no_extension', 'CREATE EXTENSION pg_stat_statements; SELECT 1;');
    expect(await read(targets.noExtension)).toMatchObject({ status: 'available', group: 'statements',
      scope: { database: 'dbw_no_extension' } });

    // A real login without pg_read_all_stats must not turn hidden statement
    // text into complete coverage or expose another role's workload shape.
    await fixture.postgres.sql('dbw_selected',
      "CREATE ROLE dbw_f6_restricted LOGIN PASSWORD 'fixture-only-f6-password';");
    const restrictedUrl = new URL(fixture.postgres.selectedDatabaseUrl);
    restrictedUrl.username = 'dbw_f6_restricted';
    restrictedUrl.password = 'fixture-only-f6-password';
    const restrictedTarget = (await fixture.connectDatabase(restrictedUrl.href, 'F6 restricted')).target;
    const restricted = await read(restrictedTarget);
    expect(restricted).toMatchObject({ status: 'available', group: 'statements',
      scope: { database: 'dbw_selected' }, coverage: { status: 'partial',
        reasons: expect.arrayContaining([DatabaseStatsReasonV1Schema.parse('visibility_restricted')]) } });
    if (restricted.status !== 'available' || restricted.group !== 'statements') {
      throw new Error('Restricted visibility must preserve the available partial result');
    }
    expect(restricted.data.some(row => row.shape?.includes('dbw_f6_selected'))).toBe(false);
    expect(JSON.stringify(restricted)).not.toContain(privateLiteral);
    expect(await read(targets.selected)).toMatchObject({ status: 'available', group: 'statements' });

    // Missing preload is a different native prerequisite from a missing
    // extension. Keep the positive server running and never restart it to
    // manufacture the negative condition.
    const noPreload = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    try {
      expect(await noPreload.sql('dbw_selected', 'SHOW shared_preload_libraries')).not.toContain('pg_stat_statements');
      const setupDiagnostics = `SELECT pg_postmaster_start_time()::text, current_setting('shared_preload_libraries'),
        (SELECT coalesce(json_agg(setting ORDER BY seqno)::text, '[]') FROM pg_file_settings
          WHERE name = 'shared_preload_libraries'),
        (SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements')`;
      const before = await noPreload.sql('dbw_selected', setupDiagnostics);
      expect(before.endsWith('|1'), 'The separate negative server must have the extension installed').toBe(true);
      const target = (await fixture.connectDatabase(noPreload.selectedDatabaseUrl, 'F6 no preload')).target;
      expect(await read(target)).toMatchObject({ status: 'unavailable', group: 'statements',
        reason: DatabaseStatsReasonV1Schema.parse('preload_restart_required') });
      expect(await noPreload.sql('dbw_selected', setupDiagnostics)).toBe(before);
      expect(await fixture.postgres.sql('dbw_selected', 'SHOW shared_preload_libraries')).toContain('pg_stat_statements');
      expect(await read(targets.selected)).toMatchObject({ status: 'available', group: 'statements' });
    } finally {
      await noPreload.stop();
    }
  } finally {
    await fixture.stop();
  }
}, 0);
