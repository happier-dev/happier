import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { runFreshDeploymentSourceSmoke } from '../../src/scenarios/deployments.scenario';

describe('deployment journeys through CLI Actions, PostgreSQL Home and native daemon', () => {
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let fixture: TeamSetupFFixture | undefined;
  beforeEach(async () => {
    postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'deployment-journey-')),
      dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
  });
  afterEach(async () => { try { await fixture?.stop(); } finally { await postgres?.stop(); fixture = undefined; postgres = undefined; } });
  it('fresh Account creates and reads its first Source and enrolls a working daemon', async () => {
    if (!fixture) throw new Error('Deployment journey fixture did not start');
    await runFreshDeploymentSourceSmoke(fixture);
  });
});
