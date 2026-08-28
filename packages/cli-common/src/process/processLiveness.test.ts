import { describe, expect, it, vi } from 'vitest';

import {
  isPidPresent,
  isPidProvablyAbsent,
  probeProcessGroupLiveness,
  probeProcessLiveness,
  type ProcessLiveness,
} from './processLiveness.js';

/**
 * The contract that replaced six hand-rolled `isPidAlive` helpers and four decision rules.
 *
 * The case every one of them got wrong in at least one place: a process we may not signal still
 * exists. It must never resolve to `absent`, because `absent` is what authorises taking something
 * away — reporting a kill complete, or stealing a lease.
 */
function throwing(code: string | undefined): (pid: number, signal: 0) => void {
  return () => {
    throw code === undefined
      ? new Error('probe exploded')
      : Object.assign(new Error(`probe failed: ${code}`), { code });
  };
}

describe('probeProcessLiveness', () => {
  it('reports a signalable process as alive', () => {
    expect(probeProcessLiveness(4_321, () => {})).toBe<ProcessLiveness>('alive');
  });

  it('reports ESRCH as absent — the only proof of absence', () => {
    expect(probeProcessLiveness(4_321, throwing('ESRCH'))).toBe<ProcessLiveness>('absent');
  });

  it('reports BOTH access errnos as access_denied, never absent', () => {
    // EPERM is POSIX; libuv maps the Windows `OpenProcess` denial to EACCES. Five of the six
    // predecessors handled at most one of these, and three handled neither.
    for (const code of ['EPERM', 'EACCES']) {
      expect(probeProcessLiveness(4_321, throwing(code))).toBe<ProcessLiveness>('access_denied');
    }
  });

  it('never reports absent for an errno it cannot interpret', () => {
    // The bare-`catch` rule turned every one of these into "dead".
    for (const code of ['EINVAL', 'EIO', undefined]) {
      expect(probeProcessLiveness(4_321, throwing(code))).not.toBe<ProcessLiveness>('absent');
    }
  });

  it('refuses a pid that cannot name a process instead of probing it', () => {
    // `kill(0, …)` addresses the caller's OWN process group, so probing an unvalidated pid
    // would answer a question about ourselves. `pid_t` is int32, and a stale daemon state
    // file holding `Number.MAX_SAFE_INTEGER` is a real case: Node rejects it with
    // `ERR_INVALID_ARG_TYPE`, which is not evidence of a live process.
    const probe = vi.fn();
    for (const pid of [0, -1, -4_321, 1.5, Number.NaN, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect(probeProcessLiveness(pid, probe)).toBe<ProcessLiveness>('absent');
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('still probes the largest pid the OS can actually issue', () => {
    // The bound must exclude only what cannot name a process: 2**31-1 reaches the OS.
    const probe = vi.fn();
    expect(probeProcessLiveness(2_147_483_647, probe)).toBe<ProcessLiveness>('alive');
    expect(probe).toHaveBeenCalledWith(2_147_483_647, 0);
  });
});

describe('probeProcessGroupLiveness', () => {
  it('addresses the exact positive process-group id through its negative POSIX kill target', () => {
    const probe = vi.fn();

    expect(probeProcessGroupLiveness(4_321, probe)).toBe<ProcessLiveness>('alive');
    expect(probe).toHaveBeenCalledWith(-4_321, 0);
  });

  it('reports only ESRCH as absent and fails closed for denied or unknown probes', () => {
    expect(probeProcessGroupLiveness(4_321, throwing('ESRCH'))).toBe<ProcessLiveness>('absent');
    for (const code of ['EPERM', 'EACCES', 'EIO', undefined]) {
      expect(probeProcessGroupLiveness(4_321, throwing(code))).toBe<ProcessLiveness>('access_denied');
    }
  });

  it('refuses a group id that cannot name a process group instead of addressing the caller group', () => {
    const probe = vi.fn();
    // Group id 1 is also invalid for this helper: translating it to the POSIX kill address -1
    // would address every signalable process rather than process group 1.
    for (const processGroupId of [0, 1, -1, -4_321, 1.5, Number.NaN, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect(probeProcessGroupLiveness(processGroupId, probe)).toBe<ProcessLiveness>('absent');
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('isPidPresent / isPidProvablyAbsent', () => {
  it('disagree exactly on the access-denied case, which is the whole point', () => {
    const denied = throwing('EACCES');

    // Present: do not report a termination complete.
    expect(isPidPresent(4_321, denied)).toBe(true);
    // Not provably absent: do not steal its lease.
    expect(isPidProvablyAbsent(4_321, denied)).toBe(false);
  });

  it('agree on a genuinely absent process', () => {
    const gone = throwing('ESRCH');

    expect(isPidPresent(4_321, gone)).toBe(false);
    expect(isPidProvablyAbsent(4_321, gone)).toBe(true);
  });

  it('agree on a live process', () => {
    expect(isPidPresent(4_321, () => {})).toBe(true);
    expect(isPidProvablyAbsent(4_321, () => {})).toBe(false);
  });
});
