import { describe, expect, it } from 'vitest';

import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';

describe('daemon shutdown policy', () => {
  it('exits 0 for non-exception shutdown sources', () => {
    expect(getDaemonShutdownExitCode('happier-app')).toBe(0);
    expect(getDaemonShutdownExitCode('happier-cli')).toBe(0);
    expect(getDaemonShutdownExitCode('os-signal')).toBe(0);
  });

  it('exits 1 for exception shutdown source', () => {
    expect(getDaemonShutdownExitCode('exception')).toBe(1);
  });

  it('uses a non-trivial watchdog timeout', () => {
    expect(getDaemonShutdownWatchdogTimeoutMs()).toBeGreaterThanOrEqual(5_000);
  });

  it('uses a stable watchdog timeout contract', () => {
    expect(getDaemonShutdownWatchdogTimeoutMs()).toBe(15_000);
  });

  it('keeps watchdog timeout finite and positive', () => {
    const timeoutMs = getDaemonShutdownWatchdogTimeoutMs();
    expect(Number.isFinite(timeoutMs)).toBe(true);
    expect(timeoutMs).toBeGreaterThan(0);
  });
});
