export type PeerMachineRpcQuarantineKey = Readonly<{
    accountId: string;
    machineId: string;
    endpointFingerprint: string;
}>;

export type PeerMachineRpcVerificationQuarantine = Readonly<{
    recordVerificationFailure(key: PeerMachineRpcQuarantineKey): void;
    recordVerificationSuccess(key: PeerMachineRpcQuarantineKey): void;
    isQuarantined(key: PeerMachineRpcQuarantineKey): boolean;
}>;

export type CreatePeerMachineRpcVerificationQuarantineOptions = Readonly<{
    nowMs: () => number;
    threshold?: number;
    windowMs?: number;
}>;

function keyOf(input: PeerMachineRpcQuarantineKey): string {
    return [input.accountId, input.machineId, input.endpointFingerprint].join('\0');
}

export function createPeerMachineRpcVerificationQuarantine(
    options: CreatePeerMachineRpcVerificationQuarantineOptions,
): PeerMachineRpcVerificationQuarantine {
    const threshold = Math.max(1, Math.floor(options.threshold ?? 5));
    const windowMs = Math.max(1, Math.floor(options.windowMs ?? 60_000));
    const failuresByKey = new Map<string, number[]>();
    const quarantinedKeys = new Set<string>();

    return {
        recordVerificationFailure(key) {
            const normalizedKey = keyOf(key);
            const nowMs = options.nowMs();
            const windowStart = nowMs - windowMs;
            const failures = (failuresByKey.get(normalizedKey) ?? []).filter((entry) => entry >= windowStart);
            failures.push(nowMs);
            failuresByKey.set(normalizedKey, failures);
            if (failures.length >= threshold) {
                quarantinedKeys.add(normalizedKey);
            }
        },
        recordVerificationSuccess(key) {
            const normalizedKey = keyOf(key);
            failuresByKey.delete(normalizedKey);
        },
        isQuarantined(key) {
            return quarantinedKeys.has(keyOf(key));
        },
    };
}
