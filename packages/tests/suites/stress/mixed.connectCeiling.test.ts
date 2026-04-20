import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runMixedConnectCeilingScenario } from '../../src/testkit/stress/scenarios/runMixedConnectCeilingScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: mixed connect ceiling workload', () => {
  let target: StartedStressTarget | undefined;

  beforeAll(async () => {
    target = await startStressTarget({
      config,
      testDir: run.testDir('target'),
    });
  });

  afterAll(async () => {
    await stopStressTarget(target);
  });

  it('measures connect convergence under sharded mixed workload setup', async () => {
    if (!target) throw new Error('stress target was not started');
    await runMixedConnectCeilingScenario({
      run,
      target,
      config,
    });
  });
});
