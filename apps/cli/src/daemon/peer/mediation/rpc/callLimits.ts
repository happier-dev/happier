export type PeerMachineRpcCallLimitKey = Readonly<{
    accountId: string;
    machineId: string;
    endpointFingerprint: string;
    grantId: string;
}>;

export type PeerMachineRpcCallLimitScope = Readonly<{
    maxCalls: number;
    maxIdleMs: number;
}>;

export type PeerMachineRpcCallLimitAcquireResult =
    | Readonly<{ ok: true; release: () => void }>
    | Readonly<{ ok: false; reasonCode: 'direct_call_limit_exceeded' | 'grant_idle_expired' }>;

export type PeerMachineRpcCallLimiter = Readonly<{
    tryAcquire(input: Readonly<{
        key: PeerMachineRpcCallLimitKey;
        scope: PeerMachineRpcCallLimitScope;
    }>): PeerMachineRpcCallLimitAcquireResult;
}>;

export type CreatePeerMachineRpcCallLimiterOptions = Readonly<{
    nowMs: () => number;
    localPerPeerMaxConcurrentCalls?: number;
}>;

function keyOf(input: PeerMachineRpcCallLimitKey): string {
    return [
        input.accountId,
        input.machineId,
        input.endpointFingerprint,
        input.grantId,
    ].join('\0');
}

function normalizeCap(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 8;
    return Math.max(1, Math.floor(value));
}

function normalizeIdleMs(value: number): number {
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

export function createPeerMachineRpcCallLimiter(
    options: CreatePeerMachineRpcCallLimiterOptions,
): PeerMachineRpcCallLimiter {
    const activeByKey = new Map<string, number>();
    const lastActivityByKey = new Map<string, number>();

    return {
        tryAcquire(input) {
            const key = keyOf(input.key);
            const nowMs = options.nowMs();
            const maxIdleMs = normalizeIdleMs(input.scope.maxIdleMs);
            const staleCutoffMs = nowMs - (maxIdleMs * 2);
            for (const [candidateKey, lastActivity] of lastActivityByKey) {
                if (lastActivity < staleCutoffMs) {
                    lastActivityByKey.delete(candidateKey);
                }
            }
            const scopeMaxCalls = Math.max(1, Math.floor(input.scope.maxCalls));
            const cap = Math.min(scopeMaxCalls, normalizeCap(options.localPerPeerMaxConcurrentCalls));
            const active = activeByKey.get(key) ?? 0;
            const lastActivity = lastActivityByKey.get(key);

            if (lastActivity !== undefined && nowMs - lastActivity > maxIdleMs) {
                return { ok: false, reasonCode: 'grant_idle_expired' };
            }
            if (active >= cap) {
                return { ok: false, reasonCode: 'direct_call_limit_exceeded' };
            }

            activeByKey.set(key, active + 1);
            let released = false;
            return {
                ok: true,
                release: () => {
                    if (released) return;
                    released = true;
                    const nextActive = Math.max(0, (activeByKey.get(key) ?? 1) - 1);
                    if (nextActive === 0) {
                        activeByKey.delete(key);
                    } else {
                        activeByKey.set(key, nextActive);
                    }
                    lastActivityByKey.set(key, options.nowMs());
                },
            };
        },
    };
}
