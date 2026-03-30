import { describe, expect, it } from 'vitest';

import { isDaemonProcessArgv } from './configuration';
import { parseCliArgs } from './cli/parseArgs';

describe('isDaemonProcessArgv', () => {
  it('treats daemon start as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'start'])).toBe(true);
  });

  it('treats daemon start-sync as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'start-sync'])).toBe(true);
  });

  it('treats bun-wrapped daemon start-sync as a daemon process after argv normalization', () => {
    const { args } = parseCliArgs([
      '/Users/test/.happier/runtime/current/cli/package-dist/index.mjs',
      'daemon',
      'start-sync',
    ]);
    expect(isDaemonProcessArgv(args)).toBe(true);
  });

  it('does not treat other commands as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'logs'])).toBe(false);
    expect(isDaemonProcessArgv(['session', 'list'])).toBe(false);
  });
});
