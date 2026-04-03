import { describe, expect, it } from 'vitest';

import { wrapCommandForPseudoTty } from '../../src/testkit/process/wrapCommandForPseudoTty';

describe('wrapCommandForPseudoTty', () => {
  it('wraps the command with script when a pseudo TTY is required', () => {
    const wrapped = wrapCommandForPseudoTty({
      platform: 'darwin',
      scriptPath: '/usr/bin/script',
      command: 'yarn',
      args: ['-s', 'workspace', '@happier-dev/cli', 'dev', 'claude'],
      needsTty: true,
    });

    expect(wrapped).toEqual({
      command: '/usr/bin/script',
      args: ['-q', '/dev/null', 'yarn', '-s', 'workspace', '@happier-dev/cli', 'dev', 'claude'],
    });
  });
});

