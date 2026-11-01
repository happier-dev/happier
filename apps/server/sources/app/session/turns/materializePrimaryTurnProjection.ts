import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1, SessionTurnV1 } from "@happier-dev/protocol";

export type PrimaryTurnMaterializedProjection = Readonly<{
    latestTurnId: string | null;
    latestTurnStatus: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt: number | null;
    lastRuntimeIssue: SessionRuntimeIssueV1 | null;
}>;

/** Storage encoding shared by turn mutations and current-runtime cutover. */
export function buildPrimaryTurnProjectionWriteData(projection: PrimaryTurnMaterializedProjection): {
    latestTurnId: string | null;
    latestTurnStatus: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt: bigint | null;
    lastRuntimeIssue: string | null;
} {
    return {
        latestTurnId: projection.latestTurnId,
        latestTurnStatus: projection.latestTurnStatus,
        latestTurnStatusObservedAt: projection.latestTurnStatusObservedAt === null
            ? null : BigInt(projection.latestTurnStatusObservedAt),
        lastRuntimeIssue: projection.lastRuntimeIssue === null
            ? null : JSON.stringify(projection.lastRuntimeIssue),
    };
}

function isTerminalStatus(status: PrimaryTurnStatusV1): boolean {
    return status === "completed" || status === "cancelled" || status === "failed";
}

export function materializePrimaryTurnProjection(params: Readonly<{
    latestTurnId: string | null;
    turns: readonly SessionTurnV1[];
}>): PrimaryTurnMaterializedProjection {
    const currentTurn = params.latestTurnId
        ? params.turns.find((turn) => turn.turnId === params.latestTurnId) ?? null
        : null;
    if (!currentTurn) {
        return {
            latestTurnId: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            lastRuntimeIssue: null,
        };
    }

    return {
        latestTurnId: currentTurn.turnId,
        latestTurnStatus: currentTurn.status,
        latestTurnStatusObservedAt: isTerminalStatus(currentTurn.status)
            ? currentTurn.terminalAt ?? currentTurn.updatedAt
            : currentTurn.updatedAt,
        lastRuntimeIssue: currentTurn.status === "failed" ? currentTurn.lastRuntimeIssue ?? null : null,
    };
}
