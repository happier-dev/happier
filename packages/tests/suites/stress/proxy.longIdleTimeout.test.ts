import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runLongIdleProxyScenario } from '../../src/testkit/stress/scenarios/runLongIdleProxyScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: long-idle proxy timeout', () => {
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

  it('proves an unsafe proxy timeout drops idle realtime connections while a safe timeout preserves them', async () => {
    if (!target) return;
    await runLongIdleProxyScenario({
      run,
      target,
      config,
      token,
    });
  });
});
