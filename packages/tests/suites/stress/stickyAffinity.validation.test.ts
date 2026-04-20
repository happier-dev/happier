import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runStickyAffinityValidationScenario } from '../../src/testkit/stress/scenarios/runStickyAffinityValidationScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: sticky affinity validation', () => {
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

  it('proves sticky polling continuity and the non-sticky failure mode with generated gateway variants', async () => {
    if (!target) return;
    await runStickyAffinityValidationScenario({
      run,
      target,
      config,
      token,
    });
  });
});
