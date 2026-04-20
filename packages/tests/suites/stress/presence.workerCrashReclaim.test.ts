import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runPresenceWorkerCrashScenario } from '../../src/testkit/stress/scenarios/runPresenceWorkerCrashScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: presence worker crash reclaim', () => {
  let target: StartedStressTarget | undefined;
  let token: string;

  beforeAll(async () => {
    if (config.targetMode !== 'full-compose') {
      return;
    }
    target = await startStressTarget({
      config,
      testDir: run.testDir('target'),
    });
    const auth = await createTestAuth(target.baseUrl);
    token = auth.token;
  });

  afterAll(async () => {
    await stopStressTarget(target);
  });

  it('crashes the worker during presence churn and verifies reclaim plus backlog drain after restart', async () => {
    if (!target) return;
    await runPresenceWorkerCrashScenario({
      run,
      target,
      config,
      token,
    });
  });
});
