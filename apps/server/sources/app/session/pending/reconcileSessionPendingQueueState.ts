import { inTx } from "@/storage/inTx";

export type ReconciledSessionPendingQueueState = Readonly<{
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    didRepair: boolean;
}>;

type PendingStateInput = Readonly<{
    sessionId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
}>;

export async function reconcileSessionPendingQueueState(
    params: PendingStateInput,
): Promise<ReconciledSessionPendingQueueState> {
    return await inTx(async (tx) => {
        const pendingCount = await tx.sessionPendingMessage.count({
            where: { sessionId: params.sessionId, status: "queued" },
        });
        const blockedCount = await tx.sessionPendingMessage.count({
            where: { sessionId: params.sessionId, status: "queued", deliveryState: "blocked" },
        });

        const current = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        if (pendingCount === current.pendingCount && blockedCount === current.pendingBlockedCount) {
            return {
                pendingCount: current.pendingCount,
                pendingBlockedCount: current.pendingBlockedCount,
                pendingVersion: current.pendingVersion,
                didRepair: false,
            };
        }

        const repair = await tx.session.updateMany({
            where: {
                id: params.sessionId,
                pendingCount: current.pendingCount,
                pendingBlockedCount: current.pendingBlockedCount,
                pendingVersion: current.pendingVersion,
            },
            data: { pendingCount, pendingBlockedCount: blockedCount, pendingVersion: { increment: 1 } },
        });

        if (repair.count <= 0) {
            const latest = await tx.session.findUniqueOrThrow({
                where: { id: params.sessionId },
                select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
            });

            return {
                pendingCount: latest.pendingCount,
                pendingBlockedCount: latest.pendingBlockedCount,
                pendingVersion: latest.pendingVersion,
                didRepair: false,
            };
        }

        const repaired = await tx.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        return {
            pendingCount: repaired.pendingCount,
            pendingBlockedCount: repaired.pendingBlockedCount,
            pendingVersion: repaired.pendingVersion,
            didRepair: true,
        };
    });
}
