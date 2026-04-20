import type { RpcAckResponseEmitter, RpcTargetSelectionResult } from "./_types";
import { selectRpcTarget } from "./rpcTargetSelection";

export async function waitForRpcTargetAvailability(params: Readonly<{
    graceMs: number;
    pollMs: number;
    discoverTargets: () => Promise<RpcAckResponseEmitter[]>;
    excludedSocketId?: string;
}>): Promise<RpcTargetSelectionResult> {
    let selection = selectRpcTarget({
        targets: await params.discoverTargets(),
        excludedSocketId: params.excludedSocketId,
    });
    if (selection.type !== "not-available") {
        return selection;
    }

    if (params.graceMs <= 0) {
        return selection;
    }

    const deadline = Date.now() + params.graceMs;
    while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(params.pollMs, remainingMs)));
        selection = selectRpcTarget({
            targets: await params.discoverTargets(),
            excludedSocketId: params.excludedSocketId,
        });
        if (selection.type !== "not-available") {
            return selection;
        }
    }

    return selection;
}
