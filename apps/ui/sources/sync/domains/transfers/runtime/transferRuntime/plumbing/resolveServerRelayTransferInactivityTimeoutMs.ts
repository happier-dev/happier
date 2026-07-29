const DEFAULT_SERVER_RELAY_TRANSFER_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const SERVER_RELAY_TRANSFER_INACTIVITY_TIMEOUT_HARD_MAX_MS = 30 * 60_000;

export function resolveServerRelayTransferInactivityTimeoutMs(
    timeoutMs: number | null | undefined,
): number {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return DEFAULT_SERVER_RELAY_TRANSFER_INACTIVITY_TIMEOUT_MS;
    }
    return Math.min(
        SERVER_RELAY_TRANSFER_INACTIVITY_TIMEOUT_HARD_MAX_MS,
        Math.max(1, Math.floor(timeoutMs)),
    );
}
