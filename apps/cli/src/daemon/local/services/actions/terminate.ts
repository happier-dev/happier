import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { LocalServiceActionExecutionOutcome } from './executor';

/**
 * Terminate a user-detected (non-managed) local service process (LSV-2 / LSV-5).
 *
 * This is the only local-services affordance that signals a process the daemon did NOT
 * spawn, so it is deliberately conservative:
 *
 *  - **Identity-tuple TOCTOU revalidation.** The inventory entry the UI/agent referenced was
 *    captured at scan time; between scan and kill the port could have been rebound by an
 *    unrelated process. Before signalling we re-resolve which pid currently holds the
 *    `(address, port)` listener and refuse (`identity_changed`) if it is not the same pid
 *    (and, when scan-time identity had one, the same process start time). We never signal
 *    a pid we did not just re-confirm owns the port.
 *  - **A degraded scan is never read as "already gone".** The re-resolution is three-valued:
 *    a listener scan that failed resolves to `indeterminate`, and we refuse
 *    (`listener_state_unverifiable`) rather than claiming an idempotent success we cannot
 *    prove. The pre-signal probe additionally requires a snapshot generated at or after the
 *    request, so coalescing onto an in-flight scan cannot revalidate against stale identity.
 *  - **Never pid 0/1.** Signalling pid 0 hits the caller's whole process group; pid 1 is
 *    init. Both are refused (`unsafe_pid`).
 *  - **Graceful-then-force over the real process tree.** POSIX signals the listener pid and
 *    its resolved descendants individually (SIGTERM, grace window, then SIGKILL); Windows runs
 *    `taskkill /T` (subtree) then `/F` (force). We never address a process *group*: the
 *    listener pid of a run-wrapped dev server (`npm run dev` -> node) is not a group leader, so
 *    `kill(-pid)` raises ESRCH and signals nothing, and `kill(-pgid)` would reach unrelated
 *    members of the launching shell's group. The descendant set is resolved before SIGTERM and
 *    re-resolved before SIGKILL, unioned: pids orphaned onto init by the SIGTERM stay covered by
 *    the first set, and a worker the service spawned during the grace window is caught by the
 *    second. If the process table cannot be read we refuse (`process_tree_unresolved`) rather
 *    than signalling the listener alone — killing the parent frees the port, so a partial tree
 *    kill would report success while leaving the user's children running, which is the exact
 *    class of lie this lane exists to remove.
 *  - **Post-release verification, with the failure named.** After signalling we poll liveness
 *    and confirm the port was released (or rebound by a *different* pid). If our pid still
 *    holds it we distinguish `port_not_released` (we did signal it and it survived) from
 *    `terminate_no_process_signaled` (every pid we addressed was already gone, so our targeting
 *    was wrong) — the second is what an ESRCH swallowed as success used to hide behind the
 *    first for six seconds.
 *
 * The OS-facing operations (signal, descendant resolution, liveness, listener probe, wait) are
 * injected through {@link TerminateProcessControl} — a system boundary (process signals,
 * `/proc`/`ps`/`lsof`, `taskkill`) — so this orchestration is deterministically testable and the
 * runtime supplies the real adapter.
 */

export type TerminateProcessIdentity = Readonly<{
    pid: number;
    /** OS process start time, when resolvable, to harden the tuple against pid reuse. */
    startTime?: number;
    /** Redacted recovered process command, when resolvable from the same inventory scanner. */
    command?: string;
    /** Recovered process working directory, when resolvable from the same inventory scanner. */
    cwd?: string;
}>;

export type TerminateListenerProbeInput = Readonly<{
    host: string;
    port: number;
    /**
     * Reject a listener observation generated before this timestamp. The probe shares the
     * inventory's single-flight refresh, so without this a caller can be handed a snapshot
     * that pre-dates its own request and revalidate identity against stale facts.
     */
    notBefore?: number;
}>;

/**
 * Three-valued listener re-resolution. `free` means the scan was authoritative and nothing
 * holds the port; `indeterminate` means the scan could not establish that — the two must never
 * collapse, because the destructive action treats `free` as an idempotent success.
 */
export type TerminateListenerProbeResult =
    | Readonly<{ status: 'held'; identity: TerminateProcessIdentity }>
    | Readonly<{ status: 'free' }>
    | Readonly<{ status: 'indeterminate' }>;

export type TerminateProcessSignalInput = Readonly<{
    pid: number;
    signal: 'SIGTERM' | 'SIGKILL';
    /** The listener pid's real descendants, signalled individually alongside it. */
    descendantPids: readonly number[];
}>;

/**
 * Outcome of one signal round. ESRCH is classified rather than swallowed: on an individual pid
 * it means that process already exited (benign), but when *every* addressed pid raises it we
 * signalled nothing at all and must say so.
 */
export type TerminateProcessSignalOutcome =
    | Readonly<{ status: 'delivered'; deliveredPids: readonly number[] }>
    | Readonly<{ status: 'no_process_signaled' }>
    | Readonly<{ status: 'permission_denied' }>
    | Readonly<{ status: 'failed' }>;

/**
 * Descendant resolution is three-valued for the same reason the listener probe is: "no children"
 * and "we could not look" must not collapse, because one is safe to act on and the other is not.
 */
export type TerminateDescendantResolution =
    | Readonly<{ status: 'resolved'; pids: readonly number[] }>
    | Readonly<{ status: 'unavailable' }>;

export type TerminateWindowsTreeInput = Readonly<{ pid: number; force: boolean }>;

export type TerminateProcessControl = Readonly<{
    platform: 'posix' | 'windows';
    /** Re-resolve which pid currently holds the `(host, port)` listener. */
    probeListener(input: TerminateListenerProbeInput): Promise<TerminateListenerProbeResult>;
    /**
     * Transitive descendants of `pid`. `unavailable` means the process table could not be read;
     * the caller must refuse rather than half-kill the tree. Windows resolves to an empty set —
     * `taskkill /T` owns the subtree there.
     */
    resolveDescendantPids(pid: number): Promise<TerminateDescendantResolution>;
    isProcessAlive(pid: number): Promise<boolean>;
    signal(input: TerminateProcessSignalInput): Promise<TerminateProcessSignalOutcome>;
    terminateWindowsTree(input: TerminateWindowsTreeInput): Promise<void>;
    wait(ms: number): Promise<void>;
}>;

export type TerminateDetectedServiceConfig = Readonly<{
    /** Grace window after SIGTERM / `taskkill /T` before forcing. */
    graceMs?: number;
    /** Per-attempt delay while verifying the port was released. */
    verifyPollMs?: number;
    /** Number of post-kill liveness attempts before the final authoritative listener probe. */
    verifyAttempts?: number;
}>;

export type TerminateDetectedServiceInput = Readonly<{
    request: LocalServiceActionRequestV1;
    entry: NormalizedLocalServiceInventoryEntry;
    now: number;
}>;

export type TerminateDetectedService = (
    input: TerminateDetectedServiceInput,
) => Promise<LocalServiceActionExecutionOutcome>;

const DEFAULT_GRACE_MS = 4_000;
const DEFAULT_VERIFY_POLL_MS = 200;
const DEFAULT_VERIFY_ATTEMPTS = 10;

function isUnsafePid(pid: number): boolean {
    return !Number.isInteger(pid) || pid <= 1;
}

function identityMatches(
    expected: TerminateProcessIdentity,
    actual: TerminateProcessIdentity,
): boolean {
    if (actual.pid !== expected.pid) return false;
    if (typeof expected.startTime === 'number') {
        if (actual.startTime !== expected.startTime) return false;
    }
    if (expected.command && actual.command && expected.command !== actual.command) {
        return false;
    }
    if (expected.cwd && actual.cwd && expected.cwd !== actual.cwd) {
        return false;
    }
    return true;
}

/** The port is released once nothing holds it, or a *different* pid rebound it. */
function isPortReleased(probe: TerminateListenerProbeResult, pid: number): boolean {
    if (probe.status === 'free') return true;
    return probe.status === 'held' && probe.identity.pid !== pid;
}

function signalFailureReasonCode(
    outcome: TerminateProcessSignalOutcome,
): string | null {
    if (outcome.status === 'permission_denied') return 'terminate_permission_denied';
    if (outcome.status === 'failed') return 'terminate_signal_failed';
    return null;
}

export function createTerminateDetectedService(
    control: TerminateProcessControl,
    config: TerminateDetectedServiceConfig = {},
): TerminateDetectedService {
    const graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    const verifyPollMs = config.verifyPollMs ?? DEFAULT_VERIFY_POLL_MS;
    const verifyAttempts = config.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS;

    return async ({ entry, now }) => {
        const pid = entry.provenance?.process?.pid;
        if (typeof pid !== 'number') {
            return { status: 'denied', reasonCode: 'process_identity_unavailable' };
        }
        if (isUnsafePid(pid)) {
            return { status: 'denied', reasonCode: 'unsafe_pid' };
        }

        const probeInput: TerminateListenerProbeInput = { host: entry.address.host, port: entry.port };
        const expected: TerminateProcessIdentity = {
            pid,
            ...(typeof entry.provenance?.process?.processStartTimeMs === 'number'
                ? { startTime: entry.provenance.process.processStartTimeMs }
                : {}),
            ...(entry.provenance?.process?.command ? { command: entry.provenance.process.command } : {}),
            ...(entry.provenance?.process?.cwd ? { cwd: entry.provenance.process.cwd } : {}),
        };

        // TOCTOU revalidation: the port may have been rebound since the scan. Refuse to signal
        // anything that is not still the same pid we were asked to terminate, and refuse just as
        // hard when the scan could not tell us.
        const current = await control.probeListener({ ...probeInput, notBefore: now });
        if (current.status === 'indeterminate') {
            return { status: 'failed', reasonCode: 'listener_state_unverifiable' };
        }
        if (current.status === 'free') {
            // The listener is already gone — nothing to signal, idempotently succeeded.
            return { status: 'succeeded' };
        }
        if (!identityMatches(expected, current.identity)) {
            return { status: 'denied', reasonCode: 'identity_changed' };
        }

        let descendantPids: readonly number[] = [];
        if (control.platform === 'posix') {
            const resolved = await control.resolveDescendantPids(pid);
            if (resolved.status === 'unavailable') {
                return { status: 'failed', reasonCode: 'process_tree_unresolved' };
            }
            descendantPids = resolved.pids;
        }

        let deliveredAnySignal = false;
        try {
            if (control.platform === 'windows') {
                await control.terminateWindowsTree({ pid, force: false });
                deliveredAnySignal = true;
                await control.wait(graceMs);
                if (await control.isProcessAlive(pid)) {
                    await control.terminateWindowsTree({ pid, force: true });
                }
            } else {
                const terminated = await control.signal({ pid, signal: 'SIGTERM', descendantPids });
                const terminateFailure = signalFailureReasonCode(terminated);
                if (terminateFailure) {
                    return { status: 'failed', reasonCode: terminateFailure };
                }
                deliveredAnySignal = terminated.status === 'delivered';
                await control.wait(graceMs);
                if (await control.isProcessAlive(pid)) {
                    // Surviving the grace window is exactly the case where the service may have
                    // spawned more children during it, so re-resolve — and union, because the
                    // first round's pids may since have been orphaned onto init and would no
                    // longer appear as descendants.
                    const escalation = await control.resolveDescendantPids(pid);
                    if (escalation.status === 'unavailable') {
                        return { status: 'failed', reasonCode: 'process_tree_unresolved' };
                    }
                    descendantPids = [...new Set([...descendantPids, ...escalation.pids])];
                    const killed = await control.signal({ pid, signal: 'SIGKILL', descendantPids });
                    const killFailure = signalFailureReasonCode(killed);
                    if (killFailure) {
                        return { status: 'failed', reasonCode: killFailure };
                    }
                    deliveredAnySignal = deliveredAnySignal || killed.status === 'delivered';
                }
            }
        } catch {
            return { status: 'failed', reasonCode: 'terminate_signal_failed' };
        }

        // Post-release verification. Liveness is free, so poll that and spend a listener probe
        // only once the process is gone; the machine-wide scan behind a probe is the expensive
        // part and a single terminate used to issue up to eleven of them.
        for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
            if (!(await control.isProcessAlive(pid))) {
                const after = await control.probeListener(probeInput);
                if (isPortReleased(after, pid)) {
                    return { status: 'succeeded' };
                }
            }
            await control.wait(verifyPollMs);
        }

        const final = await control.probeListener(probeInput);
        if (isPortReleased(final, pid)) {
            return { status: 'succeeded' };
        }
        if (final.status === 'indeterminate') {
            return { status: 'failed', reasonCode: 'port_release_unverified' };
        }
        return deliveredAnySignal
            ? { status: 'failed', reasonCode: 'port_not_released' }
            : { status: 'failed', reasonCode: 'terminate_no_process_signaled' };
    };
}
