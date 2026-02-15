import { describe, expect, it } from 'vitest';

import { computeRunnerTerminationOutcome } from '@/agent/runtime/runnerTerminationOutcome';

describe('computeRunnerTerminationOutcome', () => {
  it('treats unhandled rejections as non-archiving, non-zero exits', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'unhandledRejection' })).toEqual(
      expect.objectContaining({ exitCode: 1, archive: false }),
    );
  });

  it('archives on SIGTERM with exit code 0', () => {
    expect(computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' })).toEqual(
      expect.objectContaining({ exitCode: 0, archive: true }),
    );
  });
});
