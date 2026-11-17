import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { runAccountErasureJourney } from '../../src/scenarios/accountErasure.scenario';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';

it('J6 self and Home-administrator erasure distinguish retryable refusal, retirement and completed deletion', async () => {
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  try {
    const fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'account-erasure-journey-')),
      dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
    try {
      await runAccountErasureJourney(fixture, postgres.homeDatabaseUrl);
    } finally {
      await fixture.stop();
    }
  } finally {
    await postgres.stop();
  }
}, 0);
