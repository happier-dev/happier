import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runReconnectChaosScenario } from '../../src/testkit/stress/scenarios/runReconnectChaosScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: seeded reconnection chaos', () => {
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

  it('injects seeded disconnects/reconnects and asserts transcript convergence invariants', async () => {
    if (!target) throw new Error('stress target was not started');
    await runReconnectChaosScenario({
      run,
      target,
      config,
      token,
    });
  });
});
