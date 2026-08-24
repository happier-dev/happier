/**
 * Canonical answer to "is this pid still there?".
 *
 * Before this owner existed the repository carried **more than a dozen hand-rolled `isPidAlive`
 * helpers implementing four different decision rules**, and every one of them collapsed a state
 * that must not be collapsed:
 *
 *  - bare `catch { return false }` — any error means dead;
 *  - `code === 'EPERM'` — access denied means alive on POSIX, but **EACCES was missed**, and
 *    libuv maps the Windows `OpenProcess` access denial to EACCES;
 *  - `code !== 'ESRCH'` — anything that is not "no such process" means alive;
 *  - `EPERM || EACCES` — the corrected rule.
 *
 * They were not four requirements. They were one question answered with four degrees of
 * correctness about a single case: **a process we may not signal still exists.** Reading that as
 * dead fails open, and the consumers where it fails open are the dangerous ones — a Windows
 * custody check reporting `stopped` for a process still running, and a replication lease or a
 * plugin-store lock being stolen from a live holder.
 *
 * So the contract is three-valued, because the two honest answers to "is it gone?" are yes and
 * no, and the third answer — *we were not allowed to look* — is neither. Both sides of it are
 * already consumed today: a lease may only be stolen from a process **provably absent**
 * (`isPidProvablyAbsent`), while a termination may only be reported complete when the process is
 * **not present** in any sense (`isPidPresent`). Those are different questions and they need
 * different helpers; a boolean forces one of them to be wrong.
 *
 * This owner lives in `@happier-dev/cli-common` rather than in the CLI because the family spans
 * `apps/cli`, `apps/server`, `packages/plugin-sdk` and `packages/tests`; a CLI-local owner is
 * unreachable from three of those and the divergent rules survived there.
 */
export type ProcessLiveness =
  /** Signalable: the process exists and we may signal it. */
  | 'alive'
  /** ESRCH, or a pid that cannot name a process. Proven gone. */
  | 'absent'
  /** EPERM/EACCES, or an errno we cannot interpret: it exists, or we could not find out. */
  | 'access_denied';

export type ProcessSignalProbe = (pid: number, signal: 0) => void;

function defaultProbe(pid: number, signal: 0): void {
  process.kill(pid, signal);
}

/**
 * `pid_t` is a signed 32-bit integer, and Node refuses anything outside that range with
 * `ERR_INVALID_ARG_TYPE` rather than an OS errno (measured: `process.kill(2 ** 31, 0)` throws it,
 * `process.kill(2 ** 31 - 1, 0)` reaches the OS and returns ESRCH). A value that cannot name a
 * process is `absent`, not `access_denied` — a stale state file holding `Number.MAX_SAFE_INTEGER`
 * describes a daemon that is gone, and the four predecessor rules disagreed about it: the
 * bare-catch and EPERM-only rules said dead, the not-ESRCH rule said alive.
 */
const MAX_PROCESS_ID = 2_147_483_647;

function canNameAProcess(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= MAX_PROCESS_ID;
}

/**
 * `signal 0` performs no kill but reports whether the pid can be addressed.
 *
 * Pids that cannot name a process are refused rather than probed: `kill(0, …)` addresses the
 * caller's whole process **group**, so passing an unvalidated pid here would ask a question about
 * ourselves and read the answer as being about the target.
 */
export function probeProcessLiveness(
  pid: number,
  probe: ProcessSignalProbe = defaultProbe,
): ProcessLiveness {
  if (!canNameAProcess(pid)) return 'absent';
  try {
    probe(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') return 'absent';
    // EPERM (POSIX) and EACCES (libuv's mapping of the Windows access denial) both mean the
    // process is there. Any other errno means the probe itself failed, which is equally not
    // evidence of absence — so it resolves the same way and never as `absent`.
    return 'access_denied';
  }
}

/**
 * True unless the process is proven gone. Use for "may I report this terminated / may I treat
 * this slot as free" — the safe direction is to say it is still present.
 */
export function isPidPresent(pid: number, probe?: ProcessSignalProbe): boolean {
  return probeProcessLiveness(pid, probe) !== 'absent';
}

/**
 * True only when the process is proven gone. Use for "may I take something away from this pid" —
 * stealing a lease, reclaiming an owner slot. Access-denied is deliberately **not** enough.
 */
export function isPidProvablyAbsent(pid: number, probe?: ProcessSignalProbe): boolean {
  return probeProcessLiveness(pid, probe) === 'absent';
}
