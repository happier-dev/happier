import { afterEach, beforeEach, describe, it } from 'vitest';
import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { runAgentAskDeploymentRegression, runTeamDeploymentTemplateRegression } from '../../src/scenarios/deploymentRegressions.scenario';
import { startDeploymentProvidersHttp } from '../../src/testkit/deploymentProvidersHttp';
import { prepareFreshDeploymentProviderAccount, runDeploymentProviderJourney, runNeonDeploymentDataJourney,
  type PreparedDeploymentProviderAccount } from '../../src/scenarios/deploymentProviders.scenario';
import { prepareOwnServerDeploymentJourney, runOwnServerDeploymentJourney,
  type PreparedOwnServerDeploymentJourney } from '../../src/scenarios/deploymentOwnServer.scenario';
import { runFreshDeploymentSourceSmoke } from '../../src/scenarios/deployments.scenario';

const run = createRunDirs({ runLabel: 'deployment-journey' });

describe('deployment journeys through CLI Actions, PostgreSQL Home and native daemon', () => {
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let fixture: TeamSetupFFixture | undefined;
  beforeEach(async context => {
    postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    fixture = await startTeamSetupFFixture({ testDir: run.testDir(context.task.name),
      dbProvider: 'postgres', serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
  });
  afterEach(async () => { try { await fixture?.stop(); } finally { await postgres?.stop(); fixture = undefined; postgres = undefined; } });
  it.each(['vercel', 'cloudflare'] as const)('%s Connect to deployment settlement, Domain Add/Verify and teardown proof', async provider => {
    if (!fixture) throw new Error('Deployment journey fixture did not start');
    const boundary = await startDeploymentProvidersHttp();
    try { await runDeploymentProviderJourney(fixture, provider, boundary); }
    finally { await boundary.stop(); }
  });
  describe('Neon', () => {
    let boundary: Awaited<ReturnType<typeof startDeploymentProvidersHttp>> | undefined;
    let freshAccount: PreparedDeploymentProviderAccount;
    beforeEach(async () => {
      if (!fixture) throw new Error('Deployment journey fixture did not start');
      boundary = await startDeploymentProvidersHttp();
      freshAccount = await prepareFreshDeploymentProviderAccount(fixture, 'neon', boundary);
    });
    afterEach(async () => { await boundary?.stop(); boundary = undefined; });
    it('Neon data project connects to an app and runs a database statement', async () => {
      if (!fixture || !boundary) throw new Error('Neon deployment journey fixture did not start');
      await runNeonDeploymentDataJourney(fixture, boundary, freshAccount);
    });
  });
  it('Agent Ask preserves the nested UI caller for shared secrets and Team actions', async () => {
    if (!fixture) throw new Error('Deployment journey fixture did not start');
    await runAgentAskDeploymentRegression(fixture);
  });
  it('Team template instantiate succeeds or returns its typed next Action', async () => {
    if (!fixture) throw new Error('Deployment journey fixture did not start');
    await runTeamDeploymentTemplateRegression(fixture);
  });
  describe('own-server', () => {
    let prepared: PreparedOwnServerDeploymentJourney;
    beforeEach(async () => {
      if (!fixture) throw new Error('Deployment journey fixture did not start');
      prepared = await prepareOwnServerDeploymentJourney(fixture);
    });
    it('own-server deploy settles and teardown retains verification proof', async () => {
      if (!fixture) throw new Error('Deployment journey fixture did not start');
      await runOwnServerDeploymentJourney(fixture, prepared);
    });
  });
  it('fresh Account creates and reads its first Source and enrolls a working daemon', async () => {
    if (!fixture) throw new Error('Deployment journey fixture did not start');
    await runFreshDeploymentSourceSmoke(fixture);
  });
});
