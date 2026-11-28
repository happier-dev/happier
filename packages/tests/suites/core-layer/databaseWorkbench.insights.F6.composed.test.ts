import { expect, it } from 'vitest';

import { ActionOperationAcceptedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ActionOperationGetV1ResponseSchema, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    DATABASE_STATS_ENABLE_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import {
    DatabaseActivityCancelInputV1Schema,
    DatabaseFindingBaselineV1Schema,
    DatabaseFindingReadResultV1Schema,
    DatabaseFindingsListResultV1Schema,
    DatabaseOperationResultV1Schema,
    DatabaseStatementExplainInputV1Schema,
    DatabaseStatsOperationInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import { DatabaseStatsReasonV1Schema, type DatabaseStatsReadV1 } from '@happier-dev/plugin-sdk/database';
import { type DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchAgent, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

// D15: one real CLI → Postgres Home → daemon → selected native target journey.
// No refusal/unavailable assertion is reached until this flow's G1 passes.
it('P4-F6-known-good-stats', async () => {
  const testDir = run.testDir('dbw-insights-f6');
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
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

    const explainMissingRelation = await fixture.executeDatabase(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
      DatabaseStatementExplainInputV1Schema.parse({ operation: 'statement.explain', target: targets.selected,
        statement: { sql: 'SELECT id FROM dbw_f6_missing', parameters: [] }, mode: 'plan', accessMode: 'read' }));
    if (!explainMissingRelation.ok) throw new Error(`Explain Action refused (${explainMissingRelation.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(explainMissingRelation.result)).toMatchObject({
      ok: false, status: 'failed', code: 'database_engine_error', cause: { source: 'engine', code: '42P01' },
    });

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

    // Two test-owned PostgreSQL connections make the blocker and its waiter
    // observable through the same selected Activity read used by Refresh.
    const psql = (sql: string) => fixture.postgres.sql('dbw_selected', sql);
    const holder = Promise.allSettled([psql(`SET application_name = 'dbw_f6_blocker';
      SELECT pg_advisory_lock(743026); SELECT pg_sleep(120);`)]);
    let waiter: Promise<PromiseSettledResult<string>[]> | undefined;
    let cancelTarget: { key: string; queryStartedAt: string } | undefined;
    try {
      let blockerPid = '';
      await waitFor(async () => {
        blockerPid = await psql("SELECT pid FROM pg_stat_activity WHERE application_name = 'dbw_f6_blocker' AND wait_event = 'PgSleep'");
        return Boolean(blockerPid);
      }, { context: 'F6 fixture blocker holds its advisory lock' });
      waiter = Promise.allSettled([psql(`SET application_name = 'dbw_f6_waiter';
        SELECT pg_advisory_lock(743026);`)]);
      let waiterPid = '';
      await waitFor(async () => {
        waiterPid = await psql("SELECT pid FROM pg_stat_activity WHERE application_name = 'dbw_f6_waiter' AND wait_event_type = 'Lock'");
        return Boolean(waiterPid);
      }, { context: 'F6 fixture waiter is blocked' });
      const refreshed = await read(targets.selected,
        { kind: 'stats.read', group: 'activity', selection: { activityKey: waiterPid, page: { rows: 1 } } });
      if (refreshed.status !== 'available' || refreshed.group !== 'activity') throw new Error('Selected Activity Refresh unavailable');
      expect(refreshed.data).toMatchObject([{ key: waiterPid, state: 'active', waitClass: 'Lock', blockingKeys: [blockerPid] }]);
      const queryStartedAt = refreshed.data[0]?.queryStartedAt;
      if (!queryStartedAt) throw new Error('Selected blocker row omitted the exact query start');
      cancelTarget = { key: waiterPid, queryStartedAt };
    } finally {
      await psql("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = 'dbw_f6_blocker'");
      await Promise.all([holder, waiter]);
    }
    if (!cancelTarget) throw new Error('Selected waiter was not observed');
    const cancelInput = DatabaseActivityCancelInputV1Schema.parse({
      operation: 'activity.cancel', target: targets.selected,
      activityKey: cancelTarget.key, queryStartedAt: cancelTarget.queryStartedAt,
    });
    async function observeOperation(result: ActionExecuteResult): Promise<ActionExecuteResult> {
      if (!result.ok) return result;
      const accepted = ActionOperationAcceptedResultSchema.safeParse(result.result);
      if (!accepted.success) return result;
      const { machineId, operationId } = accepted.data;
      const observed = await fixture.owner.execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
        ...fixture.machine.target, machineId, operationId, waitForTerminal: true,
      });
      if (!observed.ok) throw new Error(`F6 operation observation refused (${observed.errorCode})`);
      const receipt = ActionOperationGetV1ResponseSchema.parse(observed.result);
      const terminal = receipt.kind === 'found' ? readActionOperationTerminalResultV1(receipt.operation) : undefined;
      if (!terminal) throw new Error('F6 operation did not settle');
      return terminal;
    }
    const ended = await observeOperation(await fixture.executeDatabaseAsPerson(DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1, cancelInput));
    if (!ended.ok) throw new Error(`Reviewed Activity Cancel refused (${ended.errorCode}): ${ended.error}`);
    expect(DatabaseOperationResultV1Schema.parse(ended.result)).toMatchObject({
      ok: true, operation: 'activity.cancel', status: 'activity_ended',
    });

    const access = await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1,
      { target: targets.selected, agentAccess: 'read' });
    expect(access).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
    const allowed = await fixture.owner.executeAsPerson('actions.policy.set', {
      actionId: DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1, audience: 'agent', mode: 'allowed',
    });
    if (!allowed.ok) throw new Error(`F6 Agent Cancel policy setup refused (${allowed.errorCode})`);
    const agent = await startDatabaseWorkbenchAgent(fixture, testDir);
    try {
      expect(await agent.execute(DATABASE_TARGETS_LIST_ACTION_ID_V1, { scope: fixture.scope }))
        .toMatchObject({ ok: true, result: { targets: expect.arrayContaining([expect.objectContaining({ target: targets.selected })]) } });
      const statsInput = DatabaseStatsOperationInputV1Schema.parse({
        operation: 'stats.read', target: targets.selected, request,
      });
      const agentRead = await agent.execute(DATABASE_STATS_READ_ACTION_ID_V1, statsInput);
      if (!agentRead.ok) throw new Error(`F6 selected Agent Stats control refused (${agentRead.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(agentRead.result)).toMatchObject({
        ok: true, operation: 'stats.read', observation: { status: 'available', scope: { database: 'dbw_selected' } },
      });
      const adviceInput = DatabaseStatsOperationInputV1Schema.parse({
        operation: 'stats.read', target: targets.selected, request: {
          kind: 'stats.read', group: 'indexAdvice', selection: { statementKey: workload.key },
        },
      });
      const agentAdvice = await agent.execute(DATABASE_STATS_READ_ACTION_ID_V1, adviceInput);
      if (!agentAdvice.ok) throw new Error(`F6 Agent index advice refused (${agentAdvice.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(agentAdvice.result)).toMatchObject({
        ok: true, operation: 'stats.read', observation: {
          group: 'indexAdvice', status: 'unavailable', reason: 'hypopg_missing',
        },
      });
      const findingsInput = { target: targets.selected, request: {
        ...request, selection: { ...request.selection, statementKey: workload.key },
      } };
      const listResult = await agent.execute(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1, findingsInput);
      if (!listResult.ok) throw new Error(`F6 Agent findings list refused (${listResult.errorCode})`);
      const findings = DatabaseFindingsListResultV1Schema.parse(listResult.result);
      if (!findings.ok) throw new Error(`F6 Agent findings list unavailable (${findings.code})`);
      const selected = findings.findings.find(row => row.recordKey === workload.key);
      if (!selected) throw new Error('F6 Agent findings list lost the native workload');
      const detailInput = { ...findingsInput, recordKey: selected.recordKey };
      const detailResult = await agent.execute(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, detailInput);
      if (!detailResult.ok) throw new Error(`F6 Agent finding detail refused (${detailResult.errorCode})`);
      const detail = DatabaseFindingReadResultV1Schema.parse(detailResult.result);
      if (!detail.ok) throw new Error(`F6 Agent finding detail unavailable (${detail.code})`);
      expect(detail.finding.normalizedShape).toContain('dbw_f6_selected');
      const baseline = DatabaseFindingBaselineV1Schema.parse({ ...findings.observation,
        summary: selected.summary, basis: detail.finding.verification.basis });
      const briefInput = { ...detailInput, baseline };
      expect(await agent.execute(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, briefInput))
        .toMatchObject({ ok: true, result: { ok: true, brief: { evidence: { items: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining(baseline.evidenceIdentity) }),
        ]) } } } });
      expect(await observeOperation(await agent.execute(DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1, cancelInput)))
        .toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
      expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, {
        target: targets.selected, agentAccess: 'readWriteNoApproval',
      })).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteNoApproval' } });
      const agentEnded = await observeOperation(await agent.execute(DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1, cancelInput));
      if (!agentEnded.ok) throw new Error(`Authorized Agent Activity Cancel refused (${agentEnded.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(agentEnded.result)).toMatchObject({
        ok: true, operation: 'activity.cancel', status: 'activity_ended',
      });
      expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: targets.selected, agentAccess: 'none' }))
        .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
      expect(await agent.execute(DATABASE_STATS_READ_ACTION_ID_V1, statsInput))
        .toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
      for (const [action, input] of [
        [DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1, findingsInput],
        [DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1, detailInput],
        [DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, briefInput],
      ] as const) {
        expect(await agent.execute(action, input), action).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
      }
      expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: targets.selected, agentAccess: 'read' }))
        .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
      console.info('P4-F6-external-blocker-and-vanished-cancel passed', fixture.runtime);

      expect(await read(targets.noExtension)).toMatchObject({ status: 'unavailable', group: 'statements',
        reason: DatabaseStatsReasonV1Schema.parse('extension_missing') });
      expect(await fixture.owner.executeAsPerson('actions.policy.set', {
        actionId: DATABASE_STATS_ENABLE_ACTION_ID_V1, audience: 'agent', mode: 'allowed',
      })).toMatchObject({ ok: true });
      const enableInput = { operation: 'stats.enable', target: targets.noExtension };
      expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: targets.noExtension, agentAccess: 'read' }))
        .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
      expect(await observeOperation(await agent.execute(DATABASE_STATS_ENABLE_ACTION_ID_V1, enableInput)))
        .toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
      const enabledExtensionCount = () => fixture.postgres.sql('dbw_no_extension',
        "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'");
      expect(await enabledExtensionCount()).toBe('0');
      expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, {
        target: targets.noExtension, agentAccess: 'readWriteNoApproval',
      })).toMatchObject({ ok: true, result: { ok: true, agentAccess: 'readWriteNoApproval' } });
      expect(await observeOperation(await agent.execute(DATABASE_STATS_ENABLE_ACTION_ID_V1, enableInput)))
        .toMatchObject({ ok: true, result: { ok: true, operation: 'stats.enable', status: 'enabled' } });
      expect(await enabledExtensionCount()).toBe('1');
    } finally {
      await agent.stop();
    }

    expect(await read(targets.selected)).toMatchObject({ status: 'available', group: 'statements' });
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
