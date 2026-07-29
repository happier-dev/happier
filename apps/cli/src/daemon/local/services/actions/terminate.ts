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
 *  - **Never pid 0/1.** Signalling pid 0 hits the caller's whole process group; pid 1 is
 *    init. Both are refused (`unsafe_pid`).
 *  - **Graceful-then-force.** POSIX sends SIGTERM (to the process group for run-wrapper
 *    children, direct pid otherwise), waits a grace window, then SIGKILL if still alive.
 *    Windows runs `taskkill /T` (subtree) then `/F` (force).
 *  - **Post-release verification.** After signalling we poll the listener until the port is
 *    released (or a *different* pid has rebound it); if our pid still holds it we report
 *    `port_not_released` rather than claiming a success we cannot prove.
 *
 * The OS-facing operations (signal, liveness, listener probe, wait) are injected through
 * {@link TerminateProcessControl} — a system boundary (process signals, `/proc`/`lsof`,
 * `taskkill`) — so this orchestration is deterministically testable and the runtime supplies
 * the real adapter.
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

export type TerminateListenerProbeInput = Readonly<{ host: string; port: number }>;

export type TerminateProcessSignalInput = Readonly<{
    pid: number;
    signal: 'SIGTERM' | 'SIGKILL';
    /** When true, signal the whole process group (POSIX run-wrapper children). */
    group: boolean;
}>;

export type TerminateWindowsTreeInput = Readonly<{ pid: number; force: boolean }>;

export type TerminateProcessControl = Readonly<{
    platform: 'posix' | 'windows';
    /** Re-resolve which pid currently holds the `(host, port)` listener, or null if free. */
    probeListener(input: TerminateListenerProbeInput): Promise<TerminateProcessIdentity | null>;
    isProcessAlive(pid: number): Promise<boolean>;
    signal(input: TerminateProcessSignalInput): Promise<void>;
    terminateWindowsTree(input: TerminateWindowsTreeInput): Promise<void>;
    wait(ms: number): Promise<void>;
}>;

export type TerminateDetectedServiceConfig = Readonly<{
    /** Grace window after SIGTERM / `taskkill /T` before forcing. */
    graceMs?: number;
    /** Per-attempt delay while verifying the port was released. */
    verifyPollMs?: number;
    /** Number of post-kill port-release verification attempts. */
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

/**
 * A run-wrapper (e.g. `npm run dev` → child server) appears in the inventory with a process
 * lineage of more than one pid, so SIGTERM must reach the whole group to stop the actual
 * server rather than only the wrapper. A bare process (single-pid lineage) is signalled
 * directly.
 */
function isRunWrapped(entry: NormalizedLocalServiceInventoryEntry): boolean {
    const lineage = entry.provenance?.process?.lineagePids ?? [];
    return lineage.length > 1;
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

export function createTerminateDetectedService(
    control: TerminateProcessControl,
    config: TerminateDetectedServiceConfig = {},
): TerminateDetectedService {
    const graceMs = config.graceMs ?? DEFAULT_GRACE_MS;
    const verifyPollMs = config.verifyPollMs ?? DEFAULT_VERIFY_POLL_MS;
    const verifyAttempts = config.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS;

    return async ({ entry }) => {
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
        // anything that is not still the same pid we were asked to terminate.
        const current = await control.probeListener(probeInput);
        if (!current) {
            // The listener is already gone — nothing to signal, idempotently succeeded.
            return { status: 'succeeded' };
        }
        if (!identityMatches(expected, current)) {
            return { status: 'denied', reasonCode: 'identity_changed' };
        }

        const group = control.platform === 'posix' && isRunWrapped(entry);

        try {
            if (control.platform === 'windows') {
                await control.terminateWindowsTree({ pid, force: false });
                await control.wait(graceMs);
                if (await control.isProcessAlive(pid)) {
                    await control.terminateWindowsTree({ pid, force: true });
                }
            } else {
                await control.signal({ pid, signal: 'SIGTERM', group });
                await control.wait(graceMs);
                if (await control.isProcessAlive(pid)) {
                    await control.signal({ pid, signal: 'SIGKILL', group });
                }
            }
        } catch {
            return { status: 'failed', reasonCode: 'terminate_signal_failed' };
        }

        // Post-release verification: confirm OUR pid no longer holds the listener. A different
        // pid rebinding the port (or the port going free) both count as released.
        for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
            const after = await control.probeListener(probeInput);
            if (!after || after.pid !== pid) {
                return { status: 'succeeded' };
            }
            await control.wait(verifyPollMs);
        }

        return { status: 'failed', reasonCode: 'port_not_released' };
    };
}
