import type { RpcAckResponseEmitter, RpcTargetSelectionResult } from "./_types";
import { selectRpcTarget } from "./rpcTargetSelection";
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';

export async function waitForRpcTargetAvailability(params: Readonly<{
    graceMs: number | null;
    /** Existing authority revalidation cadence, only for admitted caller lifetimes. */
    pollMs: number;
    subscribeToAvailability: (listener: () => void) => () => void;
    signal?: AbortSignal;
    discoverTargets: () => Promise<RpcAckResponseEmitter[]>;
    excludedSocketId?: string;
    answeringClient?: SocketRpcAnsweringClientV1;
    /** Only accepted wake preparation extends discovery into its original caller's lifetime. */
    callerLifetime?: Readonly<{ signal: AbortSignal; isCurrent(): Promise<boolean> }>;
}>): Promise<RpcTargetSelectionResult> {
    const signal = params.signal ?? params.callerLifetime?.signal;
    const current = async () => !signal?.aborted && (!params.callerLifetime
        || !params.callerLifetime.signal.aborted && await params.callerLifetime.isCurrent() && !params.callerLifetime.signal.aborted);
    // Subscribe before the first census so an arrival during discovery cannot be lost.
    let changed = false;
    let wake: (() => void) | undefined;
    const unsubscribe = params.subscribeToAvailability(() => { changed = true; wake?.(); });
    try {
        if (!await current()) return { type: 'not-available' };
        let selection = selectRpcTarget({
            targets: await params.discoverTargets(),
            excludedSocketId: params.excludedSocketId,
            answeringClient: params.answeringClient,
        });
        if (selection.type !== "not-available") {
            return selection;
        }

        if (!params.callerLifetime && params.graceMs !== null && params.graceMs <= 0) {
            return selection;
        }

        const deadline = params.graceMs === null ? null : Date.now() + params.graceMs;
        while (params.callerLifetime || deadline === null || Date.now() < deadline) {
            if (!await current()) return { type: 'not-available' };
            if (!changed) await new Promise<void>((resolve) => {
                const settle = () => {
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener('abort', settle);
                    wake = undefined;
                    resolve();
                };
                // The finite grace is a deadline, not a discovery tick. Admitted lifetime
                // currentness has no push source in its predicate contract; keep its existing
                // cadence without using those checks to launch another cluster census.
                const timer = !params.callerLifetime && deadline === null ? null
                    : setTimeout(settle, params.callerLifetime ? params.pollMs : Math.min(2_147_483_647, Math.max(0, deadline! - Date.now())));
                wake = settle;
                signal?.addEventListener('abort', settle, { once: true });
                if (signal?.aborted || changed) settle();
            });
            if (!await current()) return { type: 'not-available' };
            if (!params.callerLifetime && deadline !== null && Date.now() >= deadline) break;
            if (!changed) continue;
            changed = false;
            selection = selectRpcTarget({
                targets: await params.discoverTargets(),
                excludedSocketId: params.excludedSocketId,
                answeringClient: params.answeringClient,
            });
            if (selection.type !== "not-available") {
                if (!await current()) return { type: 'not-available' };
                return selection;
            }
        }

        return selection;
    } finally {
        unsubscribe();
    }
}
