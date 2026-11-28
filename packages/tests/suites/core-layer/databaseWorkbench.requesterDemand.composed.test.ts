import { expect, it } from 'vitest';

import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createPluginContextualResourceWatchClient } from '../../../../apps/ui/sources/components/plugins/surfaces/pluginSurfaceResourceWatch';
import { connectUiPersonActionClient } from '../../../../apps/ui/sources/dev/testkit/actionClientIntegrationTestkit';
import { machinePluginUiTargetedContributionsRead } from '../../../../apps/ui/sources/sync/ops/machineContributionRegistryProjection';
import { DATABASE_PLUGIN_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '@happier-dev/protocol/databases/databaseResourceIdentityV1';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'dbw-held-requester' });
it('reuses one native connection for its requester, refuses a second requester, and retires the exact running native read', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('held-requester') });
  try {
    const { target } = await fixture.connectDatabase(fixture.postgres.selectedDatabaseUrl, 'Requester-bound PostgreSQL');
    const other = await fixture.createAccount('held-read-second-requester');
    const otherAccountId = readAccountIdFromToken(other.credentials.token);
    if (!otherAccountId) throw new Error('The other requester needs their own Account');
    const option = { presentUserConfirmation: { actionId: 'machines.access.grant.set' } } as const;
    expect(await fixture.owner.executeReviewed('machines.access.grant.set', { ...fixture.machine.target,
      principal: { kind: 'account', accountId: otherAccountId }, level: 'view' }, option)).toMatchObject({ ok: true });
    const { machineId } = fixture.machine.target;
    const accountId = fixture.scope.accountId;
    const externalActionTarget = { kind: 'machine' as const, machineId };
    const action = { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) };
    const ui = await connectUiPersonActionClient({ ...fixture.personActionConnection,
      accountSecret: fixture.owner.auth.accountSigningSeed, presentedMachineAction: { action,
        target: { serverIdentityId: fixture.serverId, machineId } } });
    try {
      await waitFor(ui.isPresentedMachineActionReady, { context: 'selected database Action presentation' });
      const projection = await machinePluginUiTargetedContributionsRead(machineId,
        { pluginId: DATABASE_PLUGIN_ID_V1, serverId: ui.serverId });
      if (!projection.supported) throw new Error('Database projection unavailable ' + projection.reason);
      const client = createPluginContextualResourceWatchClient({ pluginId: DATABASE_PLUGIN_ID_V1,
        resource: { machineId, serverId: ui.serverId, accountId,
          expectedCallerOccurrenceId: projection.targetedContributions.target.occurrenceId,
          context: { kind: 'surface', mountInstanceKey: 'selected-database-requester' } },
        subscriptionIdPrefix: 'selected-database' });
      const watch = await client.watchResource(DATABASE_CONNECTION_RESOURCE_ID_V1, () => undefined,
        { input: { operation: 'describe', target } });
      const invocation = (sql: string) => ({
        action,
        input: { operation: 'statement.run', mode: 'read', target, subscriptionId: watch.subscriptionId, statement: { sql, parameters: [] } },
      });
      const execute = (sql: string) =>
        ui.executeConfirmed('action.invoke', invocation(sql), { externalActionTarget,
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: ui.serverId, serverIdentityId: fixture.serverId });
      try {
        const read = async () => {
          const result = await execute('SELECT pg_backend_pid()::text AS dbw_held_pid');
          if (!result.ok) throw new Error(`Held database read refused (${result.errorCode})`);
          const value = DatabaseOperationResultV1Schema.parse(result.result);
          if (!value.ok || value.operation !== 'statement.run') throw new Error('Held database read omitted its native result');
          return value.results[0]?.rows?.[0]?.cells[0];
        };
        const activeBackendPids = () => fixture.postgres.sql('dbw_neighbor',
          "SELECT coalesce(string_agg(pid::text, ',' ORDER BY pid), '') FROM pg_stat_activity WHERE datname = 'dbw_selected' AND backend_type = 'client backend'");
        const admittedBackend = await activeBackendPids();
        expect(admittedBackend).toMatch(/^\d+$/u);
        const knownGood = await read();
        expect(knownGood).toEqual({ type: 'text', value: admittedBackend });
        console.info('DBW_HELD_NATIVE_REUSE', { admittedBackend });
        const selectedReadCount = () => fixture.postgres.sql('dbw_neighbor',
          "SELECT coalesce(sum(calls), 0)::text FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'dbw_selected') AND query LIKE 'SELECT pg_backend_pid()%AS dbw_held_pid'");
        const readsBefore = await selectedReadCount();
        const refused = await other.execute('action.invoke', invocation('SELECT pg_backend_pid()::text AS dbw_held_pid'), { externalActionTarget });
        expect(refused).toMatchObject({ ok: false, errorCode: 'access_denied' });
        console.info('DBW_HELD_REQUESTER_REFUSAL', 'access_denied');
        expect(await selectedReadCount()).toBe(readsBefore);
        expect(await read()).toEqual(knownGood);
        const active = execute('SELECT pg_sleep(600) /* DBW_R018_WATCH_RETIRE */');
        const activity = () => fixture.postgres.sql('dbw_selected',
          "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state='active' AND query LIKE '%DBW_R018_WATCH_RETIRE%'");
        try {
          await waitFor(async () => await activity() === '1', { context: 'native request executing on held watch' });
          watch.dispose();
          await waitFor(async () => await activity() === '0', { context: 'no native request after held watch retired' });
          const stopped = await active;
          expect(stopped).not.toMatchObject({ ok: true, result: { ok: true } });
          expect(await execute('SELECT pg_backend_pid()::text AS dbw_held_pid'))
            .toMatchObject({ ok: false, errorCode: 'plugin_resource_demand_unavailable' });
        } finally {
          watch.dispose();
          await fixture.postgres.sql('dbw_neighbor',
            "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname = 'dbw_selected' AND state='active' AND query LIKE '%DBW_R018_WATCH_RETIRE%'");
          await active.catch(() => undefined);
        }
      } finally { watch.dispose(); }
    } finally { await ui.close(); }
  } finally { await fixture.stop(); }
}, 0);
