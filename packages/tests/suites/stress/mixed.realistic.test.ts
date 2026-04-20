import { afterAll, beforeAll, describe, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runStressTasksWithConcurrencyLimit } from '../../src/testkit/stress/scenarios/runStressTasksWithConcurrencyLimit';
import { runMixedRealisticScenario } from '../../src/testkit/stress/scenarios/runMixedRealisticScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: mixed realistic workload', () => {
  let target: StartedStressTarget | undefined;
  let auths: Awaited<ReturnType<typeof createTestAuth>>[] = [];

  beforeAll(async () => {
    const startedTarget = await startStressTarget({
      config,
      testDir: run.testDir('target'),
    });
    target = startedTarget;
    const authIndexes = Array.from({ length: Math.max(1, config.load.users) }, (_, index) => index);
    auths = await runStressTasksWithConcurrencyLimit(
      authIndexes,
      Math.min(32, authIndexes.length),
      async () => await createTestAuth(startedTarget.baseUrl),
    );
  });

  afterAll(async () => {
    await stopStressTarget(target);
  });

  it('combines presence, reconnect, message, and rpc pressure under one representative workload', async () => {
    if (!target) throw new Error('stress target was not started');
    await runMixedRealisticScenario({
      run,
      target,
      config,
      auths,
    });
  });
});
