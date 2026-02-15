import { describe, expect, it } from 'vitest';

import { isDaemonProcessArgv } from './configuration';

describe('isDaemonProcessArgv', () => {
  it('treats daemon start as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'start'])).toBe(true);
  });

  it('treats daemon start-sync as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'start-sync'])).toBe(true);
  });

  it('does not treat other commands as daemon process', () => {
    expect(isDaemonProcessArgv(['daemon', 'logs'])).toBe(false);
    expect(isDaemonProcessArgv(['session', 'list'])).toBe(false);
  });
});
