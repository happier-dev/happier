import type { RpcAckResponseEmitter, RpcTargetSelectionResult } from "./_types";

export function selectRpcTarget(params: Readonly<{
    targets: RpcAckResponseEmitter[];
    excludedSocketId?: string;
}>): RpcTargetSelectionResult {
    const distinctTargets = [...params.targets].sort((left, right) => left.id.localeCompare(right.id));
    const eligibleTargets =
        typeof params.excludedSocketId === "string" && params.excludedSocketId.length > 0
            ? distinctTargets.filter((target) => target.id !== params.excludedSocketId)
            : distinctTargets;

    if (eligibleTargets.length === 0) {
        const callerWasPresent = typeof params.excludedSocketId === "string"
            && distinctTargets.some((target) => target.id === params.excludedSocketId);
        return callerWasPresent ? { type: "self-call" } : { type: "not-available" };
    }

    return {
        type: "target",
        target: eligibleTargets[0],
        hadMultipleTargets: eligibleTargets.length > 1 || distinctTargets.length > 1,
    };
}
