import { describe, expect, it } from 'vitest';

import { isPidSafeHappySessionProcess } from './pidSafety';
import { hashProcessCommand } from './sessionRegistry';

describe('isPidSafeHappySessionProcess', () => {
  it('allows command drift only when the exact process-instance fingerprint still matches', async () => {
    await expect(isPidSafeHappySessionProcess({
      pid: 42,
      expectedProcessCommandHash: hashProcessCommand('old command'),
      expectedProcessInstanceFingerprint: 'linux-proc:4200',
    }, {
      findHappyProcessByPidFn: async () => ({ pid: 42, command: 'new command', type: 'user-session' }),
      readProcessInstanceFingerprint: () => 'linux-proc:4200',
    })).resolves.toBe(true);

    await expect(isPidSafeHappySessionProcess({
      pid: 42,
      expectedProcessCommandHash: hashProcessCommand('old command'),
      expectedProcessInstanceFingerprint: 'linux-proc:4200',
    }, {
      findHappyProcessByPidFn: async () => ({ pid: 42, command: 'new command', type: 'user-session' }),
      readProcessInstanceFingerprint: () => 'linux-proc:4300',
    })).resolves.toBe(false);
  });

  it('keeps strict command matching for legacy records without a process fingerprint', async () => {
    await expect(isPidSafeHappySessionProcess({
      pid: 42,
      expectedProcessCommandHash: hashProcessCommand('old command'),
    }, {
      findHappyProcessByPidFn: async () => ({ pid: 42, command: 'new command', type: 'user-session' }),
    })).resolves.toBe(false);
  });
});
