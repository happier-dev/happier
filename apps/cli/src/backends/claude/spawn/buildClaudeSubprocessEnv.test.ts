import { describe, expect, it } from 'vitest';

import { buildClaudeSubprocessEnv } from './buildClaudeSubprocessEnv';

describe('buildClaudeSubprocessEnv', () => {
  it('preserves only Claude\'s exact external sandbox assertion from the runner environment', () => {
    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '1',
        UNRELATED_SECRET: 'do-not-forward',
      },
    })).toMatchObject({
      PATH: '/bin',
      IS_SANDBOX: '1',
    });

    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '0',
      },
    })).toEqual({ PATH: '/bin' });
  });
});
