import { describe, expect, it } from 'vitest';

import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';

describe('resolveDaemonOwnershipConflictExitCode', () => {
  it('exits cleanly for background-service ownership conflicts', () => {
    expect(resolveDaemonOwnershipConflictExitCode('background-service')).toBe(0);
  });

  it('fails closed for non-service ownership conflicts', () => {
    expect(resolveDaemonOwnershipConflictExitCode('manual')).toBe(1);
    expect(resolveDaemonOwnershipConflictExitCode('self-restart')).toBe(1);
    expect(resolveDaemonOwnershipConflictExitCode('installer')).toBe(1);
    expect(resolveDaemonOwnershipConflictExitCode('unknown')).toBe(1);
  });
});
