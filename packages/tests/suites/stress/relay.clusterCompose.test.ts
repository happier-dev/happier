import { afterAll, beforeAll, describe, it } from 'vitest';

import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import {
  assertRelayClusterComposeConfig,
  runRelayClusterComposeScenario,
} from '../../src/testkit/stress/scenarios/runRelayClusterComposeScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: relay cluster compose', () => {
  let target: StartedStressTarget | undefined;
  let auth: TestAuth | undefined;

  beforeAll(async () => {
    assertRelayClusterComposeConfig(config);
    target = await startStressTarget({
      config,
      testDir: run.testDir('target'),
    });
    auth = await createTestAuth(target.baseUrl);
  });

  afterAll(async () => {
    await stopStressTarget(target);
  });

  it('keeps relay ownership replica-local while Redis coordinates admission across abrupt restarts', async () => {
    if (!target || !auth) {
      throw new Error('Relay cluster compose setup did not produce an attested target and auth');
    }
    await runRelayClusterComposeScenario({
      run,
      target,
      config,
      auth,
    });
  });
});
