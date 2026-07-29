import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_LOG_KEEP_COUNT,
  DEFAULT_SESSION_LOG_KEEP_COUNT,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
} from './logRetention';

describe('logRetention', () => {
  it('uses defaults when env keep counts are absent or invalid', () => {
    expect(resolveDaemonLogKeepCount({})).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: 'nope' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
  });

  it('accepts zero and integer env keep counts', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '2.9' })).toBe(2);
  });
});
