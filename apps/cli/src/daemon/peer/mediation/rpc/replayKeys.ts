export type PeerMachineRpcReplayKeyCache = Readonly<{
    claim(input: Readonly<{
        grantId: string;
        replayKey: string;
        expiresAtMs: number;
    }>): boolean;
}>;

export type CreatePeerMachineRpcReplayKeyCacheOptions = Readonly<{
    nowMs: () => number;
}>;

function cacheKey(input: Readonly<{ grantId: string; replayKey: string }>): string {
    return `${input.grantId}\0${input.replayKey}`;
}

export function createPeerMachineRpcReplayKeyCache(
    options: CreatePeerMachineRpcReplayKeyCacheOptions,
): PeerMachineRpcReplayKeyCache {
    const expiresAtByKey = new Map<string, number>();

    return {
        claim(input) {
            const nowMs = options.nowMs();
            for (const [key, expiresAtMs] of expiresAtByKey) {
                if (expiresAtMs <= nowMs) {
                    expiresAtByKey.delete(key);
                }
            }

            const key = cacheKey(input);
            if (expiresAtByKey.has(key)) return false;
            expiresAtByKey.set(key, input.expiresAtMs);
            return true;
        },
    };
}
