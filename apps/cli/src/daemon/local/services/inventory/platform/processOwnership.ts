/**
 * Single owner for "is this listener process controllable by the daemon's own OS identity?".
 *
 * `terminate_detected` is the only affordance that signals a process the daemon did not spawn,
 * and its eligibility gate was previously vacuous: `processOwnershipConfidence` was set to
 * `medium` for every listener that had a pid, so the whole confidence ladder reduced to "the
 * listener has a pid" — and on Windows that meant a system service was a terminate candidate.
 *
 * The evidence differs per platform, so it is resolved here, once, at the OS boundary:
 *
 *  - **POSIX** compares the process's real uid with the daemon's. Exact, and free: darwin gets
 *    the uid from the `ps` call it already makes, Linux from `/proc/<pid>/status`.
 *  - **Windows** has no uid, and adding an owner lookup would mean a per-process
 *    `Invoke-CimMethod GetOwner` on every scan. `process.kill(pid, 0)` answers the question that
 *    actually matters — may this daemon terminate this process? — in-process, with no subprocess
 *    and no locale dependency: libuv opens the target with `PROCESS_TERMINATE`, so a service the
 *    daemon may not signal reports access denied.
 *
 * `undefined` means the platform could not establish ownership. It is deliberately distinct from
 * `'other'`: the scanner maps it to `medium`, which the terminate gate refuses.
 */
export type LocalServiceProcessOwnership = 'self' | 'other';

/** The daemon's own POSIX real uid, or `undefined` on a platform without one. */
export function resolveDaemonPosixUserId(): string | undefined {
    const uid = process.getuid?.();
    return typeof uid === 'number' ? String(uid) : undefined;
}

export function classifyPosixProcessOwnership(
    processUserId: string | undefined,
    daemonUserId: string | undefined,
): LocalServiceProcessOwnership | undefined {
    if (!processUserId || !daemonUserId) return undefined;
    return processUserId === daemonUserId ? 'self' : 'other';
}

export type ProcessSignalAccessProbe = (pid: number) => void;

/**
 * Windows ownership evidence: whether the daemon may open the process for termination.
 * `ESRCH` (the process is gone) is reported as `undefined` rather than `'other'` — absence is
 * not evidence of another owner, and the caller's stale row will disappear on the next scan.
 */
export function probeWindowsProcessOwnership(
    pid: number,
    probe: ProcessSignalAccessProbe = (target) => {
        process.kill(target, 0);
    },
): LocalServiceProcessOwnership | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
        probe(pid);
        return 'self';
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // libuv maps the Windows `OpenProcess` access denial to EACCES; POSIX reports EPERM.
        if (code === 'EACCES' || code === 'EPERM') return 'other';
        return undefined;
    }
}
