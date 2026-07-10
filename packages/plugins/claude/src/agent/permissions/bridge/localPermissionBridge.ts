export const CLAUDE_LOCAL_PERMISSION_BRIDGE_OPT_IN_ARRIVAL_TIMEOUT_MS = 5_000;

export class ClaudeLocalPermissionBridgeOptInTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super('Timed out waiting for Claude local permission bridge opt-in');
        this.name = 'ClaudeLocalPermissionBridgeOptInTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

export async function waitForClaudeLocalPermissionBridgeOptIn<TValue>(params: Readonly<{
    arrival: Promise<TValue>;
    timeoutMs?: number;
}>): Promise<TValue> {
    const timeoutMs = normalizeOptInArrivalTimeoutMs(params.timeoutMs);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        // L-25 ALLOWLIST: localPermissionBridge non-interactive opt-in arrival latency
        timeoutHandle = setTimeout(() => {
            reject(new ClaudeLocalPermissionBridgeOptInTimeoutError(timeoutMs));
        }, timeoutMs);
        unrefTimeout(timeoutHandle);
    });

    try {
        return await Promise.race([params.arrival, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

function normalizeOptInArrivalTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) {
        return CLAUDE_LOCAL_PERMISSION_BRIDGE_OPT_IN_ARRIVAL_TIMEOUT_MS;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('Claude local permission bridge opt-in timeout must be a positive finite number');
    }
    return Math.trunc(timeoutMs);
}

function unrefTimeout(timeoutHandle: ReturnType<typeof setTimeout>): void {
    (timeoutHandle as Readonly<{ unref?: () => void }>).unref?.();
}
