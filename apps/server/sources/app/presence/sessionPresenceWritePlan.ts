import type { Prisma } from "@prisma/client";
import type { PrimaryTurnStatusV1 } from "@happier-dev/protocol";

const TERMINAL_TURN_STATUSES: readonly PrimaryTurnStatusV1[] = ["completed", "cancelled", "failed"];

export function createSessionPresenceUpdateManyArgs(params: Readonly<{
    sessionId: string;
    timestamp: number;
    thinking: boolean | null;
}>): Prisma.SessionUpdateManyArgs[] {
    const observedAt = new Date(params.timestamp);
    const baseWrite: Prisma.SessionUpdateManyArgs = {
        where: { id: params.sessionId },
        data: {
            lastActiveAt: observedAt,
            active: true,
        },
    };

    if (params.thinking === null) {
        return [baseWrite];
    }

    if (params.thinking === false) {
        return [{
            where: { id: params.sessionId },
            data: {
                lastActiveAt: observedAt,
                active: true,
                thinking: false,
                thinkingAt: observedAt,
            },
        }];
    }

    return [
        baseWrite,
        {
            where: {
                id: params.sessionId,
                latestTurnStatus: { in: [...TERMINAL_TURN_STATUSES] },
                thinking: true,
            },
            data: { thinking: false },
        },
        {
            where: {
                id: params.sessionId,
                OR: [
                    { latestTurnStatus: null },
                    { latestTurnStatus: { notIn: [...TERMINAL_TURN_STATUSES] } },
                ],
            },
            data: {
                thinking: true,
                thinkingAt: observedAt,
            },
        },
    ];
}
