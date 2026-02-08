import { describe, expect, it } from 'vitest';

import { applyHomeIsolationEnv } from '../../src/testkit/providers/harnessEnv';

describe('applyHomeIsolationEnv', () => {
  it('sets HOME/XDG/USERPROFILE in env mode', () => {
    const env = applyHomeIsolationEnv({
      cliHome: '/tmp/cli-home',
      env: { HOME: '/Users/example', XDG_CONFIG_HOME: '/Users/example/.config', USERPROFILE: 'C:\\Users\\example', FOO: 'bar' },
      mode: 'env',
    });

    expect(env.FOO).toBe('bar');
    expect(env.HOME).toBe('/tmp/cli-home');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/cli-home/.config');
    expect(env.USERPROFILE).toBe('/tmp/cli-home');
  });

  it('does not override HOME in host auth mode', () => {
    const env = applyHomeIsolationEnv({
      cliHome: '/tmp/cli-home',
      env: { HOME: '/Users/example', XDG_CONFIG_HOME: '/Users/example/.config' },
      mode: 'host',
    });

    expect(env.HOME).toBe('/Users/example');
    expect(env.XDG_CONFIG_HOME).toBe('/Users/example/.config');
    expect(env.USERPROFILE).toBeUndefined();
  });
});
