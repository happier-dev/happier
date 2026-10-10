import type { RpcAckResponseEmitter, RpcTargetSelectionResult } from "./_types";
import { selectRpcTarget } from "./rpcTargetSelection";

export async function waitForRpcTargetAvailability(params: Readonly<{
    graceMs: number;
    pollMs: number;
    discoverTargets: () => Promise<RpcAckResponseEmitter[]>;
    excludedSocketId?: string;
    /** Only accepted wake preparation extends discovery into its original caller's lifetime. */
    callerLifetime?: Readonly<{ signal: AbortSignal; isCurrent(): Promise<boolean> }>;
}>): Promise<RpcTargetSelectionResult> {
    const current = async () => !params.callerLifetime
        || !params.callerLifetime.signal.aborted && await params.callerLifetime.isCurrent() && !params.callerLifetime.signal.aborted;
    if (!await current()) return { type: 'not-available' };
    let selection = selectRpcTarget({
        targets: await params.discoverTargets(),
        excludedSocketId: params.excludedSocketId,
    });
    if (selection.type !== "not-available") {
        return selection;
    }

    if (!params.callerLifetime && params.graceMs <= 0) {
        return selection;
    }

    const deadline = Date.now() + params.graceMs;
    while (params.callerLifetime || Date.now() < deadline) {
        if (!await current()) return { type: 'not-available' };
        const remainingMs = deadline - Date.now();
        await new Promise<void>((resolve) => {
            const signal = params.callerLifetime?.signal;
            const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', settle); resolve(); };
            const timer = setTimeout(settle, params.callerLifetime ? params.pollMs : Math.min(params.pollMs, remainingMs));
            signal?.addEventListener('abort', settle, { once: true });
            if (signal?.aborted) settle();
        });
        if (!await current()) return { type: 'not-available' };
        selection = selectRpcTarget({
            targets: await params.discoverTargets(),
            excludedSocketId: params.excludedSocketId,
        });
        if (selection.type !== "not-available") {
            if (!await current()) return { type: 'not-available' };
            return selection;
        }
    }

    return selection;
}
