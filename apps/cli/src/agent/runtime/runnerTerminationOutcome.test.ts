import { describe, expect, it } from 'vitest';

import { computeRunnerTerminationOutcome } from './runnerTerminationOutcome';

/**
 * Archiving is a user-intent action, never a lifecycle consequence: a runner that
 * terminates leaves its Happier Session inactive and resumable. The termination
 * outcome therefore carries the exit code and a human-readable termination reason
 * for diagnostics, and no archive directive of any kind.
 */
describe('computeRunnerTerminationOutcome', () => {
  it('reports a normal exit without directing an archive', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'exit', code: 0 })).toEqual({
      exitCode: 0,
      terminationReason: 'Exited normally',
    });
  });

  it('reports an explicit kill without directing an archive', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'killSession' })).toEqual({
      exitCode: 0,
      terminationReason: 'Killed by user',
    });
  });

  it('reports SIGTERM and SIGINT without directing an archive', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' })).toEqual({
      exitCode: 0,
      terminationReason: 'Signal SIGTERM',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGINT' })).toEqual({
      exitCode: 0,
      terminationReason: 'Signal SIGINT',
    });
  });

  it('keeps crash exit codes non-zero so the daemon can respawn', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'unhandledRejection' })).toEqual({
      exitCode: 1,
      terminationReason: 'Unhandled rejection',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'uncaughtException' })).toEqual({
      exitCode: 1,
      terminationReason: 'Uncaught exception',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGKILL' })).toEqual({
      exitCode: 1,
      terminationReason: 'Signal SIGKILL',
    });
  });

  it('preserves a non-zero runner exit code', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'exit', code: 7 })).toEqual({
      exitCode: 7,
      terminationReason: 'Exited with code 7',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'exit', code: Number.NaN })).toEqual({
      exitCode: 1,
      terminationReason: 'Exited with code 1',
    });
  });
});
