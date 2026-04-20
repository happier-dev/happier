import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runRollingRestartScenario } from '../../src/testkit/stress/scenarios/runRollingRestartScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: rolling restart', () => {
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

  it('restarts the configured service and verifies reconnect/rpc convergence afterward', async () => {
    if (!target) throw new Error('stress target was not started');
    await runRollingRestartScenario({
      run,
      target,
      config,
      token,
    });
  });
});
