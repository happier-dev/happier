import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MACHINE_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { MACHINE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { resolveCliHomeStoragePaths } from '../../../../apps/cli/src/configuration/homeStoragePaths';
import { decodeStoredCredentials } from '../../../../apps/cli/src/persistence';

import { enrollProjectDaemonHome } from '../../src/testkit/daemon/projectDaemon';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { waitForRegexInFile } from '../../src/testkit/waitForRegexInFile';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'core' });

describe('Remove machine signs out a paired computer', () => {
  it('signs out the removed computer and preserves access from another paired computer', async () => {
    const testDir = run.testDir('machine-remove-signs-out');
    const postgres = await startDatabaseWorkbenchPostgres();
    try {
      const fixture = await startTeamSetupFFixture({
        testDir, dbProvider: 'postgres', advertiseRequestObservationEndpoint: true,
        serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl },
      });
      try {
        const owner = await fixture.createAccount('owner');
        const outsider = await fixture.createAccount('outsider');
        const removed = await fixture.enrollDaemon(owner, { env: { HAPPIER_LOG_LEVEL: 'debug' } });
        const retained = await fixture.enrollDaemon(owner);
        const machineId = removed.target.machineId;
        const pairedCredential = decodeStoredCredentials(JSON.parse(await readFile(
          join(resolveCliHomeStoragePaths(removed.homeDir).serversDir, removed.cliServerId, 'access.key'), 'utf8',
        )));
        if (!pairedCredential) throw new Error('Terminal pairing omitted its persisted credential');
        await postgres.sql('happier', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
        const countBindingReads = async () => Number(await postgres.sql('happier', `
          SELECT COALESCE(SUM(calls), 0) FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND query ~* '^SELECT' AND query LIKE '%"terminalAuthRequestId" = %'
            AND query NOT LIKE '%"revokedAt"%'
        `));
        const beforeRegistration = await countBindingReads();
        const registered = await registerMachineIdentity({
          baseUrl: fixture.actionServerApiUrl, token: pairedCredential.token, machineId,
        });
        expect(registered.status).toBe(200);
        // The existing auth lookup selects revocation state. An already-bound registration adds no query.
        expect(await countBindingReads() - beforeRegistration).toBe(0);

        const invoke = (cliHomeDir: string, label: string, action: string, input: unknown) => runCliJson({
          testDir, cliHomeDir, label, serverUrl: fixture.actionServerApiUrl,
          webappUrl: fixture.server.baseUrl, env: { ...process.env, NODE_OPTIONS: fixture.sourceOptions },
          launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true }, acceptedExitCodes: [1],
          args: ['actions', 'invoke', action, '--input-json', JSON.stringify(input), '--yes', '--json'],
        });
        await fixture.assertKnownGoodMachineControl(owner, removed);
        await fixture.assertKnownGoodMachineControl(owner, retained);
        expect(await invoke(removed.homeDir, 'removed-before', MACHINE_LIST_ACTION_ID_V1, { serverId: fixture.serverId }))
          .toMatchObject({ ok: true });
        const revokePath = `/v1/machines/${machineId}/revoke`;
        const outsiderRevoke = await fetch(new URL(revokePath, fixture.actionServerApiUrl), {
          method: 'POST', headers: { Authorization: `Bearer ${outsider.auth.token}` },
        });
        expect(outsiderRevoke.status).toBe(404);
        expect(await outsiderRevoke.json()).toEqual({ error: 'machine_not_found' });

        const beforeRemoval = fixture.requestProxy?.entries().length ?? 0;
        const revoked = await invoke(retained.homeDir, 'remove', MACHINE_REMOVE_ACTION_ID_V1, { serverId: fixture.serverId, machineId });
        expect(revoked).toMatchObject({ ok: true, data: { ok: true, machineAlreadyRevoked: false } });
        expect(fixture.requestProxy?.entries().slice(beforeRemoval).filter(request => request.method === 'POST'
          && request.path === revokePath)).toMatchObject([{ statusCode: 200 }]);
        const daemonLogPath = removed.daemon.state.daemonLogPath;
        if (!daemonLogPath) throw new Error('Removed daemon did not publish its log path');
        await waitForRegexInFile({ path: daemonLogPath, regex: /\[API MACHINE\] Auth failed/,
          context: 'removed daemon settles in terminal authentication failure' });
        expect(await invoke(removed.homeDir, 'removed-after', MACHINE_LIST_ACTION_ID_V1, { serverId: fixture.serverId }))
          .toMatchObject({ ok: false, error: { code: 'action_home_signed_out' } });
        expect(await invoke(retained.homeDir, 'retained-after', MACHINE_LIST_ACTION_ID_V1, { serverId: fixture.serverId }))
          .toMatchObject({ ok: true });

        await removed.daemon.stop();
        const repaired = await enrollProjectDaemonHome({
          testDir: join(testDir, 'repair'), homeDir: removed.homeDir, account: owner,
          serverUrl: fixture.actionServerApiUrl, serverId: fixture.serverId, sourceOptions: fixture.sourceOptions,
        });
        expect(repaired.machineId).not.toBe(machineId);
        expect(await invoke(removed.homeDir, 'repaired', MACHINE_LIST_ACTION_ID_V1, { serverId: fixture.serverId }))
          .toMatchObject({ ok: true });
        const revokedAgain = await invoke(retained.homeDir, 'remove-repaired', MACHINE_REMOVE_ACTION_ID_V1, {
          serverId: fixture.serverId, machineId: repaired.machineId,
        });
        expect(revokedAgain).toMatchObject({ ok: true, data: { ok: true, machineAlreadyRevoked: false } });
        expect(await invoke(removed.homeDir, 'repaired-then-removed', MACHINE_LIST_ACTION_ID_V1, { serverId: fixture.serverId }))
          .toMatchObject({ ok: false, error: { code: 'action_home_signed_out' } });
      } finally {
        await fixture.stop();
      }
    } finally {
      await postgres.stop();
    }
  }, 0);
});
