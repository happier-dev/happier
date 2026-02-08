import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { applyHomeIsolationEnv } from '../../src/testkit/providers/harnessEnv';

describe('providers harness', () => {
  it('isolates HOME/XDG_CONFIG_HOME to cliHome', () => {
    const cliHome = '/tmp/happier-e2e-cli-home';
    const env = applyHomeIsolationEnv({ cliHome, env: { FOO: 'bar' } });
    expect(env.FOO).toBe('bar');
    expect(env.HOME).toBe(cliHome);
    expect(env.XDG_CONFIG_HOME).toBe(join(cliHome, '.config'));
    expect(env.USERPROFILE).toBe(cliHome);
  });
});

