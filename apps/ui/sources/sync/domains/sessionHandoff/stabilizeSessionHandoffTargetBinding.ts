type SessionActivityLike = Readonly<{
    active?: boolean;
}> | null | undefined;

type StabilizeSessionHandoffTargetBindingResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string }>;

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function stabilizeSessionHandoffTargetBinding(params: Readonly<{
    readSession: () => SessionActivityLike;
    readTargetMachineId: () => string | null;
    reapplyOptimisticBinding: () => void;
    targetMachineId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    requiredStablePolls?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>): Promise<StabilizeSessionHandoffTargetBindingResult> {
    const expectedTargetMachineId = normalizeId(params.targetMachineId);
    if (!expectedTargetMachineId) {
        return { ok: true };
    }

    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 5_000;
    const pollIntervalMs = typeof params.pollIntervalMs === 'number' && params.pollIntervalMs > 0 ? params.pollIntervalMs : 250;
    const requiredStablePolls =
        typeof params.requiredStablePolls === 'number' && params.requiredStablePolls > 0
            ? Math.max(1, Math.floor(params.requiredStablePolls))
            : 2;
    const now = params.now ?? Date.now;
    const sleep = params.sleep ?? defaultSleep;

    let stablePollCount = 0;
    const startedAt = now();
    while (now() - startedAt < timeoutMs) {
        const observedTargetMachineId = normalizeId(params.readTargetMachineId());
        const sessionActive = params.readSession()?.active === true;
        if (sessionActive && observedTargetMachineId === expectedTargetMachineId) {
            stablePollCount += 1;
            if (stablePollCount >= requiredStablePolls) {
                return { ok: true };
            }
        } else {
            stablePollCount = 0;
            params.reapplyOptimisticBinding();
        }

        await sleep(pollIntervalMs);
    }

    return {
        ok: false,
        error: 'Timed out waiting for session handoff target session binding to stabilize',
    };
}
