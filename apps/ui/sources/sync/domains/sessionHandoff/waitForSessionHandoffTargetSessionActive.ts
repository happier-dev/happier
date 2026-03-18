type SessionActivityLike = Readonly<{
    active?: boolean;
}> | null | undefined;

export type WaitForSessionHandoffTargetSessionActiveResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string }>;

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForSessionHandoffTargetSessionActive(params: Readonly<{
    sessionId: string;
    ensureSessionVisible: (sessionId: string) => Promise<void>;
    readSession: () => SessionActivityLike;
    readTargetMachineId?: () => string | null;
    targetMachineId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>): Promise<WaitForSessionHandoffTargetSessionActiveResult> {
    const now = params.now ?? Date.now;
    const sleep = params.sleep ?? defaultSleep;
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
    const pollIntervalMs = typeof params.pollIntervalMs === 'number' && params.pollIntervalMs > 0 ? params.pollIntervalMs : 500;
    const startedAt = now();
    const expectedTargetMachineId = typeof params.targetMachineId === 'string' ? params.targetMachineId.trim() : '';

    while (now() - startedAt < timeoutMs) {
        await params.ensureSessionVisible(params.sessionId);
        const targetMachineId = params.readTargetMachineId?.() ?? null;
        const machineBindingReady =
            expectedTargetMachineId.length === 0 ||
            (typeof targetMachineId === 'string' && targetMachineId.trim() === expectedTargetMachineId);
        if (params.readSession()?.active === true && machineBindingReady) {
            return { ok: true };
        }
        await sleep(pollIntervalMs);
    }

    return {
        ok: false,
        error: 'Timed out waiting for session handoff target session to become active',
    };
}
