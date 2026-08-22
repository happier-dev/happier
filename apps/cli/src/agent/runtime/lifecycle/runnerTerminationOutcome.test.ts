import { describe, expect, it } from 'vitest';

import { computeRunnerTerminationOutcome } from './runnerTerminationOutcome';

describe('computeRunnerTerminationOutcome', () => {
  it('treats unhandled rejections as non-zero exits', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'unhandledRejection' })).toEqual({
      exitCode: 1,
      terminationReason: 'Unhandled rejection',
    });
  });

  it('treats uncaught exceptions as non-zero exits', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'uncaughtException' })).toEqual({
      exitCode: 1,
      terminationReason: 'Uncaught exception',
    });
  });

  it('exits cleanly on SIGTERM and SIGINT', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' })).toEqual({
      exitCode: 0,
      terminationReason: 'Signal SIGTERM',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGINT' })).toEqual({
      exitCode: 0,
      terminationReason: 'Signal SIGINT',
    });
  });

  it('reports an unexpected signal as a failed exit', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGHUP' })).toEqual({
      exitCode: 1,
      terminationReason: 'Signal SIGHUP',
    });
  });

  it('preserves runner exit codes', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'exit', code: 0 })).toEqual({
      exitCode: 0,
      terminationReason: 'Exited normally',
    });
    expect(computeRunnerTerminationOutcome({ kind: 'exit', code: 7 })).toEqual({
      exitCode: 7,
      terminationReason: 'Exited with code 7',
    });
  });

  // Archiving is a user-intent action, never a lifecycle consequence. A runner that
  // terminates leaves its Happier Session inactive and resumable; if termination
  // produced an archive decision, `requestInactiveSessionResume` would reject the
  // Session with `session_archived` and the user would see it vanish unexplained.
  it.each([
    { label: 'a normal exit', event: { kind: 'exit', code: 0 } as const },
    { label: 'SIGTERM', event: { kind: 'signal', signal: 'SIGTERM' } as const },
    { label: 'SIGINT', event: { kind: 'signal', signal: 'SIGINT' } as const },
    { label: 'an explicit kill-session stop', event: { kind: 'killSession' } as const },
    { label: 'a crash', event: { kind: 'uncaughtException' } as const },
  ])('never produces an archive decision for %s', ({ event }) => {
    expect(computeRunnerTerminationOutcome(event)).not.toHaveProperty('archive');
    expect(computeRunnerTerminationOutcome(event)).not.toHaveProperty('archiveReason');
  });
});
