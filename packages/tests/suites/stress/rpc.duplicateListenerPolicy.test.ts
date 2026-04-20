import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runRpcDuplicateListenerScenario } from '../../src/testkit/stress/scenarios/runRpcDuplicateListenerScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: rpc duplicate listener policy', () => {
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

  it('classifies duplicate listener behavior and fails if routing becomes ambiguous', async () => {
    if (!target) return;
    await runRpcDuplicateListenerScenario({
      run,
      target,
      config,
      token,
    });
  });
});
