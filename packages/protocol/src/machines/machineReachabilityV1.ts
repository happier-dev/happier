import { RPC_ERROR_CODES, readRpcErrorCode } from '../rpc/errors.js';

// Released 0.2 clients age real observations after 60s; leave delivery margin.
export const MACHINE_HEARTBEAT_INTERVAL_MS = 50_000;
/** The existing deadline tolerates three missed Machine heartbeat intervals. */
export const DEFAULT_MACHINE_PRESENCE_TIMEOUT_MS = 3 * MACHINE_HEARTBEAT_INTERVAL_MS;
export const DEFAULT_MACHINE_ONLINE_GRACE_MS = 60_000;

export type MachinePresenceV1 = Readonly<{
    active: boolean;
    activeAt?: number | null;
    revokedAt?: number | null;
    presenceProtocolVersion?: 1;
}>;

/** Home owns presence expiry independently of the daemon version. */
export function readMachinePresenceProtocolV1(machine: MachinePresenceV1): 1 | null {
    return machine.presenceProtocolVersion === 1 ? 1 : null;
}

/** Homes without the presence fact retain the incumbent heartbeat grace. */
export function isMachineOnlineV1(machine: MachinePresenceV1, nowMs = Date.now(), graceMs = DEFAULT_MACHINE_ONLINE_GRACE_MS): boolean {
    if (typeof machine.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0) return false;
    if (readMachinePresenceProtocolV1(machine) === 1 || graceMs <= 0) return machine.active === true;
    const activeAt = machine.activeAt;
    if (typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt === 0) return machine.active === true;
    return Math.max(0, nowMs - activeAt) <= graceMs;
}

/** The same owner supplies legacy refresh boundaries; Home-owned presence does not expire in clients. */
export function readMachinePresenceNextRefreshAtMsV1(machine: MachinePresenceV1, nowMs: number,
    graceMs = DEFAULT_MACHINE_ONLINE_GRACE_MS): number | null {
    if (readMachinePresenceProtocolV1(machine) === 1 || graceMs <= 0 || !isMachineOnlineV1(machine, nowMs, graceMs)) return null;
    const activeAt = machine.activeAt;
    if (typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt === 0) return null;
    const expiresAtMs = activeAt + graceMs + 1;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

export function isMachineReachableV1(input: Readonly<{
    machine: MachinePresenceV1;
    nowMs?: number;
    graceMs?: number;
    requestOutcome?: 'succeeded' | 'failed' | null;
}>): boolean {
    return isMachineOnlineV1(input.machine, input.nowMs, input.graceMs)
        && input.requestOutcome !== 'failed';
}

/**
 * Only an explicit target-unavailable verdict (the Machine row exists but no daemon of it is connected to this
 * Home) is a request-reachability failure. A missing method, a deadline or an answered error is not: none of them
 * says anything about the Machine as a whole. UI and CLI readers feed this verdict to `isMachineReachableV1`.
 */
export function isMachineRequestReachabilityFailureV1(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return false;
    if (rpcErrorCode === 'target_unavailable' || rpcErrorCode === 'machine_unavailable' || rpcErrorCode === 'machine_offline') {
        return true;
    }
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String(error.code ?? '') : '';
    // A caller deadline measures waiting, not target availability. Slow domain
    // work can exhaust it while presence and unrelated operations stay healthy.
    return code === 'target_unavailable'
        || code === 'machine_unavailable'
        || code === 'machine_offline';
}
