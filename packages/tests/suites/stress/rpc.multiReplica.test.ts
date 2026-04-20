import { afterAll, beforeAll, describe, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { readStressConfig } from '../../src/testkit/stress/config/readStressConfig';
import { runRpcMultiReplicaScenario } from '../../src/testkit/stress/scenarios/runRpcMultiReplicaScenario';
import { stopStressTarget } from '../../src/testkit/stress/scenarios/stressScenarioRuntime';
import { startStressTarget } from '../../src/testkit/stress/targets/startStressTarget';
import type { StartedStressTarget } from '../../src/testkit/stress/targets/stressTargetTypes';

const run = createRunDirs({ runLabel: 'stress' });
const config = readStressConfig();

describe('stress: rpc multi-replica', () => {
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

  it('drives concurrent rpc listeners and validates stable routing under the configured topology', async () => {
    if (!target) throw new Error('stress target was not started');
    await runRpcMultiReplicaScenario({
      run,
      target,
      config,
      token,
    });
  });
});
