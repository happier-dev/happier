import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runPresencePressureScenario } from '../../src/testkit/stress/scenarios/runPresencePressureScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: presence pressure', () => {
  let target: StartedStressTarget | undefined;
  let token: string;

  beforeAll(async () => {
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

  it('creates session and machine churn and records the resulting presence pressure summary', async () => {
    if (!target) throw new Error('stress target was not started');
    await runPresencePressureScenario({
      run,
      target,
      config,
      token,
    });
  });
});
