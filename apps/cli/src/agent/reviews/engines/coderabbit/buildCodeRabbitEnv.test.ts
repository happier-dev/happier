import { describe, expect, it } from 'vitest';

import { buildCodeRabbitEnv } from './buildCodeRabbitEnv';

describe('buildCodeRabbitEnv', () => {
  it('does not override HOME and only sets CodeRabbit/XDG dirs when homeDir is provided', () => {
    const env = buildCodeRabbitEnv({
      baseEnv: { HOME: '/Users/test', PATH: '/bin' },
      homeDir: '/tmp/happier',
    });

    expect(env.HOME).toBe('/Users/test');
    expect(env.PATH).toBe('/bin');
    expect(env.CODERABBIT_HOME).toContain('/tmp/happier');
    expect(env.XDG_CONFIG_HOME).toContain('/tmp/happier');
    expect(env.XDG_CACHE_HOME).toContain('/tmp/happier');
    expect(env.XDG_STATE_HOME).toContain('/tmp/happier');
    expect(env.XDG_DATA_HOME).toContain('/tmp/happier');
  });

  it('returns base env unchanged when homeDir is empty', () => {
    const baseEnv = { HOME: '/Users/test', PATH: '/bin' };
    const env = buildCodeRabbitEnv({ baseEnv, homeDir: '   ' });
    expect(env).toEqual(baseEnv);
  });
});

