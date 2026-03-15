import { describe, expect, it } from 'vitest';

import { ensureDaemonPath } from './ensureDaemonPath';

describe('ensureDaemonPath', () => {
  it('populates a reasonable PATH on darwin even when PATH is empty', () => {
    const env: NodeJS.ProcessEnv = { PATH: '', HOME: '/Users/test' };
    const res = ensureDaemonPath({ env, platform: 'darwin', execPath: '/opt/homebrew/bin/node' });
    expect(res.changed).toBe(true);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).toContain('/opt/homebrew/sbin');
    expect(env.PATH).toContain('/usr/local/sbin');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.PATH).toContain('/Users/test/.local/bin');
    expect(env.PATH).toContain('/Users/test/bin');
  });

  it('populates a reasonable PATH on linux even when PATH is empty', () => {
    const env: NodeJS.ProcessEnv = { PATH: '', HOME: '/home/test' };
    const res = ensureDaemonPath({ env, platform: 'linux', execPath: '/usr/bin/node' });
    expect(res.changed).toBe(true);
    expect(env.PATH).toContain('/usr/local/sbin');
    expect(env.PATH).toContain('/usr/local/bin');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.PATH).toContain('/home/test/.local/bin');
    expect(env.PATH).toContain('/home/test/bin');
  });

  it('is idempotent for an already-normalized PATH', () => {
    const env: NodeJS.ProcessEnv = { PATH: '', HOME: '/home/test' };
    ensureDaemonPath({ env, platform: 'linux', execPath: '/usr/bin/node' });
    const before = env.PATH;
    const res = ensureDaemonPath({ env, platform: 'linux', execPath: '/usr/bin/node' });
    expect(res.changed).toBe(false);
    expect(env.PATH).toBe(before);
  });
});
