import { describe, expect, it } from 'vitest';

import { applyHomeIsolationEnv } from './harnessEnv';

describe('applyHomeIsolationEnv', () => {
  it('forces daemon autostart off for provider harness runs', () => {
    const env = applyHomeIsolationEnv({ cliHome: '/tmp/cli-home', env: {} });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
  });
});

