import { describe, expect, it } from 'vitest';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';

describe('buildSpawnChildProcessEnv', () => {
  it('merges process env with extra env and strips nested Claude Code variables', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'parent' },
      extraEnv: { CUSTOM: 'x' },
    });

    expect(env.PATH).toBe('/bin');
    expect(env.CUSTOM).toBe('x');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});

