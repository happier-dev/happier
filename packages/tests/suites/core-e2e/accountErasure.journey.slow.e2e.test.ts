import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { runAccountErasureJourney } from '../../src/scenarios/accountErasure.scenario';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';

let fixture: TeamSetupFFixture | undefined;
let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
beforeAll(async () => {
  postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'account-erasure-journey-')),
    dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
});
afterAll(async () => { try { await fixture?.stop(); } finally { await postgres?.stop(); } });

it('J6 self and Home-administrator erasure distinguish retryable refusal, retirement and completed deletion', async () => {
  if (!fixture || !postgres) throw new Error('Account erasure journey fixture did not start');
  await runAccountErasureJourney(fixture, postgres.homeDatabaseUrl);
}, 0);
